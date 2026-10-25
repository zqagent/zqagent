/**
 * 会话自动命名（参考 CLI：第 1/3/5 次任务完成后自动生成标题）
 *
 * 覆盖：
 *   - 第 1 次完成后后台生成标题并持久化（nameSource=auto）；
 *   - 用户手动改名后（nameSource=user）不再自动命名；
 *   - HTTP PATCH /sessions/:id 改名，列表回传 name。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { createApp } from "../src/server/routes.js";
import type { StreamChunk, ProviderClient } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

function textChunk(content: string): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
}

/** 可统计 chat 调用的 Provider：stream 一次即完成一轮，chat 返回带包裹符的标题 */
class NamingProvider implements ProviderClient {
  chatCalls = 0;
  constructor(private title = "登录超时修复") {}
  async stream() {
    return (async function* () {
      yield textChunk("ok");
    })();
  }
  async chat() {
    this.chatCalls += 1;
    return `「${this.title}」`; // 测试清洗：应剥离书名号
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(20);
  }
}

function makeManager(title?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-name-"));
  const store = new Store(root);
  const tenant: TenantConfig = { id: "t1", apiKey: "k1", model: "m", provider: { apiKey: "a" } };
  store.saveTenant(tenant);
  const provider = new NamingProvider(title);
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
  setupServerHandlers(manager);
  return { root, store, tenant, provider, manager };
}

describe("会话自动命名（server）", () => {
  it("第 1 次任务完成后自动生成标题并持久化（清洗书名号）", async () => {
    const { store, tenant, provider, manager } = makeManager();
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "帮我修复登录超时");

    await waitFor(() => manager.getSession(tenant.id, rec.sessionId)!.name === "登录超时修复");

    const s = manager.getSession(tenant.id, rec.sessionId)!;
    expect(s.name).toBe("登录超时修复");
    expect(s.nameSource).toBe("auto");
    expect(s.taskCount).toBe(1);
    expect(provider.chatCalls).toBe(1);
    // 落盘
    expect(store.loadSession(tenant.id, rec.sessionId)!.name).toBe("登录超时修复");
  });

  it("用户手动改名后不再自动命名（第 3 次也不触发）", async () => {
    const { tenant, provider, manager } = makeManager();
    const rec = manager.createSession(tenant, {});
    await manager.renameSession(tenant, rec.sessionId, "我的标题");

    for (let i = 0; i < 3; i++) {
      manager.submitTurn(tenant, rec.sessionId, `任务 ${i + 1}`);
      await waitFor(() => {
        const s = manager.getSession(tenant.id, rec.sessionId)!;
        // 必须把 taskCount 也纳入条件：getSession 读的是磁盘（_persist 异步写），
        // runtimeInfo 读的是内存。两者不同步时，磁盘可能还停在上一次的 completed，
        // 只看 status 会在本轮结束前就误判为「已完成」，断言随即读到旧的计数。
        return (
          s.status === "completed" &&
          s.taskCount === i + 1 &&
          manager.runtimeInfo(rec.sessionId)?.inMemoryRun === false
        );
      });
    }
    // 计数到 3，但用户已手动命名 → 不再自动生成
    // _persist 是异步落盘，这里等磁盘追平再断言，否则会读到上一轮的计数
    await waitFor(() => manager.getSession(tenant.id, rec.sessionId)!.taskCount === 3);
    const s = manager.getSession(tenant.id, rec.sessionId)!;
    expect(s.taskCount).toBe(3);
    expect(s.name).toBe("我的标题");
    expect(s.nameSource).toBe("user");
    expect(provider.chatCalls).toBe(0);
  });

  it("HTTP PATCH /sessions/:id 改名并回传名称", async () => {
    const { store, tenant, manager } = makeManager();
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${tenant.apiKey}` };
    try {
      const created = await fetch(`${base}/api/v1/sessions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{}",
      });
      const { data: rec } = (await created.json()) as { data: { sessionId: string } };

      const patch = await fetch(`${base}/api/v1/sessions/${rec.sessionId}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "手动标题" }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as { data: { name: string; nameSource: string } };
      expect(body.data.name).toBe("手动标题");
      expect(body.data.nameSource).toBe("user");

      const list = await fetch(`${base}/api/v1/sessions`, { headers: auth });
      const { data: sessions } = (await list.json()) as {
        data: Array<{ sessionId: string; name?: string }>;
      };
      expect(sessions.find((x) => x.sessionId === rec.sessionId)?.name).toBe("手动标题");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
