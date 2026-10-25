/**
 * 文件移动路由
 *
 * 控制台拖拽移动依赖 `POST /api/v1/files/move`：前端按 `{ data }` 解包，
 * 逐条返回成功 / 失败，别把某个条目失败变成整个请求失败。
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-move-"));
  workspace = path.join(root, "ws");
  fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
  fs.mkdirSync(path.join(workspace, "dest"));

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

describe("POST /api/v1/files/move", () => {
  it("移动文件到目标目录并返回新旧路径", async () => {
    const r = await post("/api/v1/files/move", { paths: ["src/a.ts"], dest: "dest" });
    expect(r.status).toBe(200);
    expect(r.payload.data).toEqual({
      moved: [{ from: "src/a.ts", path: "dest/a.ts" }],
      failed: [],
    });
    expect(fs.existsSync(path.join(workspace, "dest", "a.ts"))).toBe(true);
  });

  it("同名冲突逐条返回失败（200，不是整单 400）", async () => {
    fs.writeFileSync(path.join(workspace, "dest", "a.ts"), "keep");
    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "new");
    const r = await post("/api/v1/files/move", { paths: ["src/a.ts"], dest: "dest" });
    expect(r.status).toBe(200);
    const data = r.payload.data as { moved: unknown[]; failed: Array<{ error: string }> };
    expect(data.moved).toEqual([]);
    expect(data.failed[0]?.error).toMatch(/已存在/);
    expect(fs.readFileSync(path.join(workspace, "dest", "a.ts"), "utf-8")).toBe("keep");
  });

  it("目录不能移动到自身子目录", async () => {
    const r = await post("/api/v1/files/move", {
      paths: ["src"],
      dest: "src/components",
    });
    expect(r.status).toBe(200);
    const data = r.payload.data as { moved: unknown[]; failed: Array<{ error: string }> };
    expect(data.moved).toEqual([]);
    expect(data.failed[0]?.error).toMatch(/自己内部/);
  });

  it("空选择 / 目标目录不存在时 400", async () => {
    expect((await post("/api/v1/files/move", { paths: [], dest: "" })).status).toBe(400);
    expect((await post("/api/v1/files/move", { paths: ["src"], dest: "nope" })).status).toBe(400);
  });
});
