/**
 * 未配置 LLM 时提交失败的收尾
 *
 * 两个必须守住的点：
 *   1. 提交要**同步抛错**——前端据此把刚清空的输入放回去（否则用户白打一段话）；
 *   2. 抛错后会话**不能卡在 running**——否则控制台一直显示「运行中 / 终止」，
 *      这条根本没发出去的输入还会被广播成 lastUserMessage 排到工作台最前。
 *
 * 真实成因：`OpenAIProvider` 构造时缺 apiKey 会抛错，而 `_startTurn` 原先
 * 先 `_setStatus(running)` 再 `_buildEngine()`。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../../core/src/server/store.js";
import { SessionManager } from "../../core/src/server/session.js";
import type { TenantConfig } from "../../core/src/server/types.js";

function tenant(id: string): TenantConfig {
  // provider 与 apiKey 都为空 → 解析不到任何可用 LLM
  return { id, name: id, model: "gpt-4o", provider: {}, allowedCommands: [] } as TenantConfig;
}

describe("未配置 LLM 时提交 turn", () => {
  it("同步抛错（前端可据此保留输入），而不是静默接受后异步失败", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-nollm-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000, {
      providerFactory: () => {
        throw new Error("❌ 未设置 OPENAI_API_KEY 环境变量");
      },
    });
    const t1 = tenant("t1");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});

    expect(() => manager.submitTurn(t1, a.sessionId, "帮我看看这个 bug")).toThrow(
      /未设置|API_KEY/,
    );
  });

  it("失败后会话仍是 idle，不残留 running", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-nollm2-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000, {
      providerFactory: () => {
        throw new Error("❌ 未设置 OPENAI_API_KEY 环境变量");
      },
    });
    const t1 = tenant("t1");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});

    expect(() => manager.submitTurn(t1, a.sessionId, "任务")).toThrow();

    // 关键断言：**内存**状态不能是 running。
    // 修复前 _setStatus(running) 先于 _buildEngine()，虽然 _persist 没跑到，
    // 但内存里已是 running，控制台会一直显示「运行中 / 终止」。
    expect(manager.busySessionCount()).toBe(0);
    expect(manager.isIdle()).toBe(true);
    // 磁盘记录同样保持 idle
    const rec = store.loadSession("t1", a.sessionId)!;
    expect(rec.status).toBe("idle");
    // 这条输入没有发出去，不应写成「最近指令」
    expect(rec.lastInput ?? "").not.toBe("任务");
  });

  it("失败后仍可正常提交：状态没被污染，配置好后立刻能跑", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-nollm3-"));
    const store = new Store(root);
    let broken = true;
    const manager = new SessionManager(store, 60_000, {
      providerFactory: () => {
        if (broken) throw new Error("❌ 未设置 OPENAI_API_KEY 环境变量");
        // 修复配置后用一个永不返回的假 provider，只要不抛错即证明提交被受理
        return {
          stream: async function* () {
            yield { content: null, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
          },
        } as never;
      },
    });
    const t1 = tenant("t1");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});

    expect(() => manager.submitTurn(t1, a.sessionId, "第一次")).toThrow();
    expect(store.loadSession("t1", a.sessionId)!.status).toBe("idle");

    broken = false;
    expect(() => manager.submitTurn(t1, a.sessionId, "第二次")).not.toThrow();
  });
});
