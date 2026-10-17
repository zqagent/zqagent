/**
 * 达到最大迭代次数的行为测试
 *
 * 覆盖：
 *   1. max_iterations_exceeded 后会话 status 变为 "stopped"（不再卡在 running）
 *   2. 触发 turn_stopped 通知（供手机端提醒"可继续"）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import type { StreamChunk, ProviderClient, ToolRegistry } from "../src/index.js";
import type { TenantConfig, NotifyEvent } from "../src/server/types.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

/** 永远请求调用低风险工具的 Provider，驱动引擎跑满迭代上限 */
class LoopProvider implements ProviderClient {
  async stream(): Promise<AsyncIterable<StreamChunk>> {
    return (async function* () {
      yield {
        content: null,
        reasoning: null,
        toolCalls: [
          {
            id: `call_${Math.random().toString(36).slice(2)}`,
            name: "loop_tool",
            arguments: {},
          },
        ],
        usage,
        finishReason: "tool_calls",
      };
    })();
  }

  async chat(): Promise<string | null> {
    return null;
  }
}

/** 低风险工具：不触发审批，让引擎持续迭代 */
function registerLoopTool(registry: ToolRegistry): void {
  registry.register(
    async () => ({ ok: true }),
    {
      category: "test",
      riskLevel: "low",
      capabilities: ["loop_tool"],
      requiresApproval: false,
    },
    {
      type: "function",
      function: {
        name: "loop_tool",
        description: "loop",
        parameters: { type: "object", properties: {} },
      },
    },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(25);
  }
}

describe("达到最大迭代次数", () => {
  beforeEach(() => vi.stubEnv("MAX_ITERATIONS", "2"));
  afterEach(() => vi.unstubAllEnvs());

  it("status 变为 stopped，且 emit turn_stopped 通知", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-maxit-"));
    const store = new Store(root);
    const tenant: TenantConfig = {
      id: "t1",
      apiKey: "k1",
      model: "m",
      provider: { apiKey: "a" },
    };
    store.saveTenant(tenant);

    const manager = new SessionManager(store, 60000, {
      providerFactory: () => new LoopProvider(),
      extraTools: registerLoopTool,
    });
    setupServerHandlers(manager);

    const notifies: NotifyEvent[] = [];
    manager.setNotifyHandler((_tenantId, ev) => {
      notifies.push(ev);
    });

    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "一直循环");
    await waitFor(
      () => manager.getSession(tenant.id, rec.sessionId)!.status === "stopped",
    );

    const s = manager.getSession(tenant.id, rec.sessionId)!;
    expect(s.status).toBe("stopped");
    expect(notifies.some((n) => n.kind === "turn_stopped")).toBe(true);
    expect(notifies.some((n) => n.kind === "turn_completed")).toBe(false);
    // 状态变化同时广播 session_status（跨节点总览的唯一增量通道）
    expect(
      notifies.some((n) => n.kind === "session_status" && n.data.status === "stopped"),
    ).toBe(true);
  });
});
