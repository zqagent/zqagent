/**
 * 节点级事件流测试
 *
 * 订阅 GET /api/v1/events/stream（一条连接订阅该租户全部会话），
 * 断言：多会话事件复用同一条流、帧内带 sessionId、且不串到其它租户。
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
import type { StreamChunk, ProviderClient, ToolRegistry } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
function toolChunk(toolCalls: StreamChunk["toolCalls"]): StreamChunk {
  return { content: null, reasoning: null, toolCalls, usage, finishReason: "tool_calls" };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function registerRiskyTool(registry: ToolRegistry): void {
  registry.register(
    async (args) => ({ executed: args.cmd }),
    { category: "test", riskLevel: "high", capabilities: ["risky"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "risky_tool",
        description: "risky",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    },
  );
}

function makeProvider(): ProviderClient {
  return {
    async stream() {
      return (async function* () {
        yield toolChunk([{ id: "c1", name: "risky_tool", arguments: { cmd: "x" } }]);
      })();
    },
    async chat() {
      return null;
    },
  };
}

describe("节点级事件流", () => {
  it("一条连接收到多个会话的事件，且不串到其它租户", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-"));
    const store = new Store(root);
    const t1: TenantConfig = { id: "t1", apiKey: "k1", model: "m", provider: { apiKey: "a" } };
    const t2: TenantConfig = { id: "t2", apiKey: "k2", model: "m", provider: { apiKey: "a" } };
    store.saveTenant(t1);
    store.saveTenant(t2);
    const manager = new SessionManager(store, 60000, {
      providerFactory: () => makeProvider(),
      extraTools: registerRiskyTool,
    });
    setupServerHandlers(manager);
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const ac = new AbortController();
    let buf = "";
    let frames: { sessionId?: string }[] = [];
    const collect = () => {
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          frames.push(JSON.parse(line.slice(6)) as { sessionId?: string });
        } catch {
          // 忽略非 JSON 帧
        }
      }
    };
    const readerTask = (async () => {
      try {
        const res = await fetch(`${base}/api/v1/events/stream`, {
          headers: { Authorization: "Bearer k1", Accept: "text/event-stream" },
          signal: ac.signal,
        });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          collect();
        }
      } catch {
        // abort
      }
    })();
    const seen = (id: string) => frames.some((f) => f.sessionId === id);

    try {
      await sleep(150); // 等订阅建立
      const a = manager.createSession(t1, {});
      const b = manager.createSession(t1, {});
      const other = manager.createSession(t2, {});
      manager.submitTurn(t1, a.sessionId, "任务 A");
      manager.submitTurn(t1, b.sessionId, "任务 B");
      manager.submitTurn(t2, other.sessionId, "任务 C");

      for (let i = 0; i < 100 && !(seen(a.sessionId) && seen(b.sessionId)); i++) await sleep(30);
      // 同一连接上两个会话的事件都到达（复用而非每会话一条流）
      expect(seen(a.sessionId)).toBe(true);
      expect(seen(b.sessionId)).toBe(true);
      // 帧内带 seq（客户端按会话游标去重/补齐依赖它）
      expect(frames.every((f) => typeof (f as { seq?: number }).seq === "number")).toBe(true);
      // 租户隔离：t1 的连接不应收到 t2 的事件
      await sleep(200);
      expect(seen(other.sessionId)).toBe(false);
      expect(buf).not.toContain(other.sessionId);
    } finally {
      ac.abort();
      await readerTask.catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("缺少 Accept 时返回 400", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-"));
    const store = new Store(root);
    const t1: TenantConfig = { id: "t1", apiKey: "k1", model: "m", provider: { apiKey: "a" } };
    store.saveTenant(t1);
    const manager = new SessionManager(store, 60000, { providerFactory: () => makeProvider() });
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/v1/events/stream`, {
        headers: { Authorization: "Bearer k1" },
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
