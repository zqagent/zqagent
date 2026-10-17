/**
 * 控制台全局通知流测试（P4.1）
 *
 * 订阅 GET /api/v1/notifications/stream，触发一次需要审批的 turn，
 * 断言收到 approval_request 通知帧。
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

describe("全局通知流", () => {
  it("审批挂起时经 SSE 推送 approval_request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-notify-"));
    const store = new Store(root);
    const tenant: TenantConfig = { id: "t1", apiKey: "k1", model: "m", provider: { apiKey: "a" } };
    store.saveTenant(tenant);
    const provider: ProviderClient = {
      async stream() {
        return (async function* () {
          yield toolChunk([{ id: "c1", name: "risky_tool", arguments: { cmd: "x" } }]);
        })();
      },
      async chat() {
        return null;
      },
    };
    const manager = new SessionManager(store, 60000, {
      providerFactory: () => provider,
      extraTools: registerRiskyTool,
    });
    setupServerHandlers(manager);
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const ac = new AbortController();
    let buf = "";
    let got = false;
    const readerTask = (async () => {
      try {
        const res = await fetch(`${base}/api/v1/notifications/stream`, {
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
          if (buf.includes("approval_request")) {
            got = true;
            return;
          }
        }
      } catch {
        // abort
      }
    })();

    try {
      // 等订阅建立
      await sleep(150);
      const rec = manager.createSession(tenant, {});
      manager.submitTurn(tenant, rec.sessionId, "执行任务");
      for (let i = 0; i < 100 && !got; i++) await sleep(30);
      expect(got).toBe(true);
      // 帧内含 sessionId 与租户
      expect(buf).toContain(rec.sessionId);
      expect(buf).toContain("approval_request");
    } finally {
      ac.abort();
      await readerTask.catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
