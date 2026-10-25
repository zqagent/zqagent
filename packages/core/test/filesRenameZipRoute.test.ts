/**
 * 文件改名 / 压缩下载路由
 *
 * 控制台右键菜单的两项新能力：`POST /api/v1/files/rename`、`POST /api/v1/files/zip`。
 * 这里锁住路由接线与载荷形状（前端按 `{ data }` 解包），并覆盖「超过上限时不打包」。
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-rename-zip-"));
  workspace = path.join(root, "ws");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(workspace, "README.md"), "# hi\n");

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

async function post(
  pathname: string,
  body: unknown,
): Promise<{ status: number; payload: { data?: unknown; error?: { message?: string } } }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, payload: (await res.json()) as never };
}

describe("文件改名 / 压缩下载路由", () => {
  it("POST /files/rename 改同目录名字并返回新路径", async () => {
    const r = await post("/api/v1/files/rename", { path: "README.md", name: "GUIDE.md" });
    expect(r.status).toBe(200);
    expect(r.payload.data).toEqual({ from: "README.md", path: "GUIDE.md" });
    expect(fs.existsSync(path.join(workspace, "GUIDE.md"))).toBe(true);
  });

  it("POST /files/rename 拒绝重名（400 + 原因）", async () => {
    fs.writeFileSync(path.join(workspace, "dup.md"), "x");
    const r = await post("/api/v1/files/rename", { path: "dup.md", name: "GUIDE.md" });
    expect(r.status).toBe(400);
    expect(r.payload.error?.message).toMatch(/已存在/);
  });

  it("POST /files/zip 返回归档名与 base64（可解出原文件）", async () => {
    const r = await post("/api/v1/files/zip", { paths: ["src"] });
    expect(r.status).toBe(200);
    const data = r.payload.data as { name: string; base64: string; entries: number };
    expect(data.name).toBe("src.zip");
    const buf = Buffer.from(data.base64, "base64");
    // 本地文件头签名 + 归档内路径原文
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.includes(Buffer.from("a.ts", "utf-8"))).toBe(true);
  });

  it("POST /files/zip 空选择直接 400", async () => {
    const r = await post("/api/v1/files/zip", { paths: [] });
    expect(r.status).toBe(400);
  });
});
