/**
 * 二进制写入路由（图片编辑保存）
 *
 * 控制台改完图片要把结果写回工作区，而文本接口只收 UTF-8。
 * 这里锁住 POST /api/v1/files/binary：字节往返一致、越界/非法载荷被拒。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { createApp } from "../src/server/routes.js";
import type { TenantConfig } from "../src/server/types.js";

let root: string;
let workspace: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-bin-route-"));
  workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new Store(root);
  const tenant: TenantConfig = {
    id: "t1",
    apiKey: "key1",
    model: "m",
    provider: { apiKey: "a" },
    workspaceRoot: workspace,
  };
  store.saveTenant(tenant);
  server = createApp(store, new SessionManager(store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/files/binary", () => {
  it("按 base64 写入图片字节，并能原样下载回来", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    const res = await post("/api/v1/files/binary", {
      path: "img/logo.png",
      base64: bytes.toString("base64"),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { path: string; size: number } };
    expect(data.path).toBe("img/logo.png");
    expect(data.size).toBe(bytes.length);
    expect([...fs.readFileSync(path.join(workspace, "img", "logo.png"))]).toEqual([...bytes]);

    const dl = await fetch(`${base}/api/v1/files/download?path=img%2Flogo.png`, {
      headers: { Authorization: "Bearer key1" },
    });
    expect(dl.status).toBe(200);
    const download = (await dl.json()) as { data: { base64: string } };
    expect([...Buffer.from(download.data.base64, "base64")]).toEqual([...bytes]);
  });

  it("拒绝越界路径与非法载荷", async () => {
    const outside = await post("/api/v1/files/binary", { path: "../evil.png", base64: "AA==" });
    expect(outside.status).toBe(400);

    const bad = await post("/api/v1/files/binary", { path: "a.png", base64: "not base64!!" });
    expect(bad.status).toBe(400);

    const empty = await post("/api/v1/files/binary", { path: "a.png", base64: "" });
    expect(empty.status).toBe(400);
  });

  it("未认证时 401", async () => {
    const res = await fetch(`${base}/api/v1/files/binary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "a.png", base64: "AA==" }),
    });
    expect(res.status).toBe(401);
  });
});
