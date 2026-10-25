/**
 * 聊天记录附件路由
 *
 * 用户消息里的图片 / 文件存在会话目录，控制台按引用路径经
 * `GET /api/v1/sessions/:id/attachments?path=` 回读：缩略图、看大图、聊天详情。
 * 这条接口只读，必须限定在 `attachments/` 下——否则会变成「读会话目录任意文件」。
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
let store: Store;
let server: Server;
let base: string;

const SESSION = "s-attach";
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-attach-route-"));
  store = new Store(root);
  const tenant: TenantConfig = {
    id: "t1",
    apiKey: "key1",
    model: "m",
    provider: { apiKey: "a" },
  };
  store.saveTenant(tenant);
  const dir = store.sessionDir("t1", SESSION);
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", "abc-0-cat.png"), BYTES);
  fs.writeFileSync(path.join(dir, "session.json"), "{}");
  store.saveSession({
    sessionId: SESSION,
    tenantId: "t1",
    model: "m",
    modelOverridden: false,
    messages: [],
    compaction: null,
    status: "idle",
    approvals: [],
    questions: [],
    sessionAllowTools: [],
    sessionAllowCommands: [],
    savedAt: new Date().toISOString(),
  });

  server = createApp(store, new SessionManager(store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

async function get(
  pathname: string,
): Promise<{ status: number; payload: { data?: unknown; error?: { message?: string } } }> {
  const res = await fetch(`${base}${pathname}`, {
    headers: { Authorization: "Bearer key1" },
  });
  return { status: res.status, payload: (await res.json()) as never };
}

describe("GET /api/v1/sessions/:id/attachments", () => {
  it("按引用路径回读附件字节", async () => {
    const r = await get(
      `/api/v1/sessions/${SESSION}/attachments?path=${encodeURIComponent("attachments/abc-0-cat.png")}`,
    );
    expect(r.status).toBe(200);
    const data = r.payload.data as { name: string; mimeType: string; size: number; base64: string };
    expect(data.base64).toBe(BYTES.toString("base64"));
    expect(data.mimeType).toBe("image/png");
    expect(data.size).toBe(BYTES.length);
    // 展示名去掉落盘前缀
    expect(data.name).toBe("cat.png");
  });

  it("拒绝越出 attachments/ 的路径", async () => {
    const bad = await get(
      `/api/v1/sessions/${SESSION}/attachments?path=${encodeURIComponent("../session.json")}`,
    );
    expect(bad.status).toBe(404);
    const direct = await get(
      `/api/v1/sessions/${SESSION}/attachments?path=${encodeURIComponent("session.json")}`,
    );
    expect(direct.status).toBe(404);
  });

  it("会话不存在时 404", async () => {
    const r = await get(
      `/api/v1/sessions/nope/attachments?path=${encodeURIComponent("attachments/abc-0-cat.png")}`,
    );
    expect(r.status).toBe(404);
  });
});
