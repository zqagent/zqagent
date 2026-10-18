/**
 * 云端 Server 集成测试
 *
 * 用脚本化 mock Provider 驱动完整链路，覆盖核心场景：
 *   1. 审批挂起 → 用户回答 → run 原地恢复 → 完成
 *   2. 审批超时回收内存任务 → 模拟进程重启 → 回答 → resume 恢复
 *   3. ask_user 提问挂起 → 回答 → 继续执行
 *   4. HTTP 层：认证、路由、跨租户访问隔离
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
import { ApprovalOutcome, EventType } from "../src/index.js";
import type { StreamChunk, TokenUsage, ProviderClient, ToolRegistry } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";
import type { NotifyEvent } from "../src/server/types.js";

const usage: TokenUsage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 };

/** 脚本化 Provider：按调用次数依次返回预设 chunk 序列 */
class ScriptedProvider implements ProviderClient {
  calls = 0;
  constructor(private script: StreamChunk[][]) {}

  async stream(): Promise<AsyncIterable<StreamChunk>> {
    const chunks = this.script[this.calls++] ?? [];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

function textChunk(content: string, finishReason = "stop"): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason };
}

function toolChunk(toolCalls: StreamChunk["toolCalls"], finishReason = "tool_calls"): StreamChunk {
  return { content: null, reasoning: null, toolCalls, usage, finishReason };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(25);
  }
}

/** 高风险自定义工具：requiresApproval 必然触发审批挂起 */
function registerRiskyTool(registry: ToolRegistry): void {
  registry.register(
    async (args) => ({ executed: args.cmd }),
    { category: "test", riskLevel: "high", capabilities: ["risky_tool"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "risky_tool",
        description: "risky",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    },
  );
}

function makeEnv(script: StreamChunk[][], timeoutMs = 60000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-srv-"));
  const store = new Store(root);
  const tenant: TenantConfig = {
    id: "t1",
    apiKey: "k1",
    model: "test-model",
    provider: { apiKey: "sk-test" },
  };
  store.saveTenant(tenant);
  const provider = new ScriptedProvider(script);
  const manager = new SessionManager(store, timeoutMs, {
    providerFactory: () => provider,
    extraTools: registerRiskyTool,
  });
  setupServerHandlers(manager);
  return { root, store, tenant, provider, manager };
}

describe("云端 Server：审批挂起-恢复", () => {
  it("审批挂起时消息已落盘，回答后 run 原地恢复并完成", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])],
      [textChunk("全部完成")],
    ]);

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );

    // 挂起时：磁盘上有 pending 审批，且消息历史已含未回答的 assistant tool_calls
    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]!.toolName).toBe("risky_tool");
    expect(s.approvals[0]!.status).toBe("pending");
    const lastAssistant = (s.messages as Array<{ role: string; tool_calls?: Array<{ id: string }> }>)
      .filter((m) => m.role === "assistant")
      .at(-1)!;
    expect(lastAssistant.tool_calls?.[0]?.id).toBe("call_1");

    // 用户回答 → 原地恢复
    env.manager.answerApproval(env.tenant, rec.sessionId, "call_1", ApprovalOutcome.ONCE);
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.status).toBe("answered");
    expect(s.approvals[0]!.outcome).toBe(ApprovalOutcome.ONCE);
    // 工具真实执行：历史中出现 tool 消息（risky_tool 结果）
    const toolMsgs = (s.messages as Array<{ role: string; tool_call_id?: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(JSON.parse(toolMsgs[0]!.content as string)).toEqual({ executed: "doit" });
    // 恢复后继续了第二轮 LLM 调用
    expect(env.provider.calls).toBe(2);
  });

  it("审批通知携带工具名与参数", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit", path: "/tmp/x" } }])],
      [textChunk("全部完成")],
    ]);

    const notifies: NotifyEvent[] = [];
    env.manager.setNotifyHandler((_tenantId, ev) => {
      notifies.push(ev);
    });

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );

    const approvalEv = notifies.find((e) => e.kind === "approval_request");
    expect(approvalEv).toBeDefined();
    expect(approvalEv!.data["toolName"]).toBe("risky_tool");
    expect(approvalEv!.data["arguments"]).toEqual({ cmd: "doit", path: "/tmp/x" });
  });

  it("对非 run_shell 工具提交 always_command 被拒绝，且审批保持 pending", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])],
      [textChunk("全部完成")],
    ]);

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );

    // always_command 只对 run_shell 有意义：非 shell 工具应拒绝，且不改变挂起状态
    expect(() =>
      env.manager.answerApproval(
        env.tenant,
        rec.sessionId,
        "call_1",
        ApprovalOutcome.ALWAYS_COMMAND,
      ),
    ).toThrowError("always_command 仅适用于 run_shell 工具");
    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.status).toBe("pending");

    // 拒绝后仍可正常用其他决策回答并恢复运行
    env.manager.answerApproval(env.tenant, rec.sessionId, "call_1", ApprovalOutcome.ONCE);
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );
    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.outcome).toBe(ApprovalOutcome.ONCE);
  });

  it("审批挂起超时后内存任务被回收，重启后回答经 resume 恢复", async () => {
    const env = makeEnv(
      [
        [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])],
        [textChunk("恢复完成")],
      ],
      80, // 审批超时 80ms
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );

    // 等待超时回收
    await sleep(250);
    const info = env.manager.runtimeInfo(rec.sessionId)!;
    expect(info.inMemoryRun).toBe(false);
    expect(info.pendingApprovals).toBe(0);

    // 磁盘保持 pending，会话状态仍为 waiting_approval
    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.status).toBe("waiting_approval");
    expect(s.approvals[0]!.status).toBe("pending");

    // 模拟进程重启：丢弃原 manager，用同一 store 新建（不加载内存）
    const provider2 = new ScriptedProvider([[textChunk("恢复完成")]]);
    const manager2 = new SessionManager(env.store, 60000, {
      providerFactory: () => provider2,
      extraTools: registerRiskyTool,
    });
    setupServerHandlers(manager2);

    manager2.answerApproval(env.tenant, rec.sessionId, "call_1", ApprovalOutcome.ONCE);
    await waitFor(() => manager2.getSession(env.tenant.id, rec.sessionId)!.status === "completed");

    s = manager2.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.status).toBe("answered");
    // resume 重放了未执行的 tool call 并真实执行
    const toolMsgs = (s.messages as Array<{ role: string; tool_call_id?: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(JSON.parse(toolMsgs[0]!.content as string)).toEqual({ executed: "doit" });
    expect(provider2.calls).toBe(1);
  });

  it("回答已回收任务的审批前，无法提交新 turn（有未决交互）", async () => {
    const env = makeEnv(
      [[toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])]],
      60,
    );
    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );
    await sleep(200); // 等待回收

    expect(() => env.manager.submitTurn(env.tenant, rec.sessionId, "新输入")).toThrowError(
      /未决/,
    );
  });

  it("审批超时回收（同进程不重启）后，回答经 resume 原地恢复并完成", async () => {
    const env = makeEnv(
      [
        [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])],
        [textChunk("同进程恢复完成")],
      ],
      80,
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_approval",
    );

    // 超时回收（不重建 manager，复用同一运行时）
    await sleep(250);
    expect(env.manager.runtimeInfo(rec.sessionId)!.inMemoryRun).toBe(false);

    env.manager.answerApproval(env.tenant, rec.sessionId, "call_1", ApprovalOutcome.ONCE);
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    const s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.status).toBe("answered");
    const toolMsgs = (s.messages as Array<{ role: string; tool_call_id?: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(JSON.parse(toolMsgs[0]!.content as string)).toEqual({ executed: "doit" });
  });
});

describe("云端 Server：提问挂起-恢复", () => {
  it("ask_user 提问挂起，回答后继续执行到完成", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_2", name: "ask_user", arguments: { question: "继续吗？" } }])],
      [textChunk("好的，继续执行")],
    ]);

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "开始");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_question",
    );

    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.kind).toBe("ask");
    expect(s.questions[0]!.status).toBe("pending");
    const qid = s.questions[0]!.id;

    env.manager.answerQuestion(env.tenant, rec.sessionId, qid, "继续");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions[0]!.status).toBe("answered");
    expect(s.questions[0]!.answer).toBe("继续");
    const assistantMsgs = (s.messages as Array<{ role: string; content?: string }>).filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMsgs.at(-1)!.content).toContain("好的，继续执行");
  });

  it("ask_user 提问挂起超时回收后，回答经 resume 恢复且不重复提问", async () => {
    const env = makeEnv(
      [
        [toolChunk([{ id: "call_2", name: "ask_user", arguments: { question: "继续吗？" } }])],
        [textChunk("好的，恢复执行")],
      ],
      80, // 提问超时 80ms
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "开始");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_question",
    );

    // 等待超时回收（内存 run 被释放，磁盘保持 pending）
    await sleep(250);
    let info = env.manager.runtimeInfo(rec.sessionId)!;
    expect(info.inMemoryRun).toBe(false);

    // 用户回答 → resume 恢复
    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    const qid = s.questions[0]!.id;
    env.manager.answerQuestion(env.tenant, rec.sessionId, qid, "继续");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    // 恢复过程不应重新挂起提问（questions 仍只有一条且已回答）
    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.status).toBe("answered");
    expect(s.questions[0]!.answer).toBe("继续");
    const assistantMsgs = (s.messages as Array<{ role: string; content?: string }>).filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMsgs.at(-1)!.content).toContain("好的，恢复执行");
  });

  it("propose_plan 计划提案超时回收后，回答经 resume 恢复且只确认一次", async () => {
    const env = makeEnv(
      [
        [toolChunk([{ id: "call_3", name: "propose_plan", arguments: { plan: "实施计划" } }])],
        [textChunk("计划通过，开始实施")],
      ],
      80,
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "请规划");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_question",
    );
    await sleep(250); // 超时回收

    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.kind).toBe("plan");
    env.manager.answerQuestion(env.tenant, rec.sessionId, s.questions[0]!.id, "yes");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.status).toBe("answered");
    expect(s.questions[0]!.parsed?.approved).toBe(true);
  });

  it("前一 turn 已回答的提问不会污染新 turn（新提问正常挂起）", async () => {
    const env = makeEnv(
      [
        [toolChunk([{ id: "c1", name: "ask_user", arguments: { question: "第一次确认？" } }])],
        [textChunk("第一轮完成")],
        [toolChunk([{ id: "c2", name: "ask_user", arguments: { question: "第二次确认？" } }])],
        [textChunk("第二轮完成")],
      ],
      60,
    );

    const rec = env.manager.createSession(env.tenant, {});
    // 第一轮：提问 → 超时回收 → 回答 → resume 完成
    env.manager.submitTurn(env.tenant, rec.sessionId, "第一轮");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_question",
    );
    await sleep(200); // 超时回收
    let s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    env.manager.answerQuestion(env.tenant, rec.sessionId, s.questions[0]!.id, "是");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    // 第二轮：新提问必须重新挂起，而不是复用第一轮的答案
    env.manager.submitTurn(env.tenant, rec.sessionId, "第二轮");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "waiting_question",
    );
    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(2);
    const latest = s.questions.at(-1)!;
    expect(latest.status).toBe("pending");
    expect(latest.question).toBe("第二次确认？");
    env.manager.answerQuestion(env.tenant, rec.sessionId, latest.id, "也确认");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );
    s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions.at(-1)!.answer).toBe("也确认");
  });
});

describe("云端 Server：HTTP 层", () => {
  it("认证、创建会话、跨租户访问隔离、turn 驱动", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-srv-http-"));
    const store = new Store(root);
    const t1: TenantConfig = { id: "t1", apiKey: "key1", model: "m", provider: { apiKey: "a" } };
    const t2: TenantConfig = { id: "t2", apiKey: "key2", model: "m", provider: { apiKey: "b" } };
    store.saveTenant(t1);
    store.saveTenant(t2);

    const manager = new SessionManager(store, 60000, {
      providerFactory: () => new ScriptedProvider([[textChunk("你好，世界")]]),
      extraTools: registerRiskyTool,
    });
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 健康检查公开
      expect((await fetch(`${base}/healthz`)).status).toBe(200);

      // 无 Key → 401
      expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(401);
      expect(
        (await fetch(`${base}/api/v1/sessions`, { headers: { Authorization: "Bearer bad-key" } }))
          .status,
      ).toBe(401);

      // t1 创建会话
      const created = await fetch(`${base}/api/v1/sessions`, {
        method: "POST",
        headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(200);
      const { data: rec } = (await created.json()) as { data: { sessionId: string } };

      // t2 的 Key 访问 t1 的会话 → 404（租户隔离）
      const cross = await fetch(`${base}/api/v1/sessions/${rec.sessionId}`, {
        headers: { Authorization: "Bearer key2" },
      });
      expect(cross.status).toBe(404);

      // t1 提交 turn → 完成
      const turn = await fetch(`${base}/api/v1/sessions/${rec.sessionId}/turns`, {
        method: "POST",
        headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
        body: JSON.stringify({ input: "你好" }),
      });
      expect(turn.status).toBe(200);
      await waitFor(() => manager.getSession(t1.id, rec.sessionId)!.status === "completed");

      // 事件轮询可读到 TURN_END
      const events = await fetch(`${base}/api/v1/sessions/${rec.sessionId}/events?since=0`, {
        headers: { Authorization: "Bearer key1" },
      });
      const { data } = (await events.json()) as {
        data: { events: Array<{ type: string }> };
      };
      expect(data.events.some((e) => e.type === EventType.TURN_END)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("云端 Server：运行中补充信息(steer)", () => {
  it("运行中提交 turn 自动转为补充信息并注入消息历史", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-steer-"));
    const store = new Store(root);
    const tenant: TenantConfig = {
      id: "t1",
      apiKey: "k1",
      model: "test-model",
      provider: { apiKey: "sk-test" },
    };
    store.saveTenant(tenant);

    // 第一次 stream 阻塞以保持 running；第二次 stream(steering 注入后)直接完成
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const provider: ProviderClient = {
      async stream() {
        calls++;
        return (async function* () {
          if (calls === 1) {
            yield textChunk("第一段输出");
            await gate; // 阻塞，保持 running
            yield textChunk("继续输出");
          } else {
            yield textChunk("已按补充信息完成");
          }
        })();
      },
      async chat() {
        return null;
      },
    };

    const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
    setupServerHandlers(manager);
    /** 总览列表靠 session_status 增量更新：记录通知，核对最近一条用户消息 */
    const notices: Array<{ kind: string; data: Record<string, unknown> }> = [];
    manager.setNotifyHandler((_tenantId, ev) => notices.push({ kind: ev.kind, data: ev.data }));

    const rec = manager.createSession(tenant, {});
    expect(manager.submitOrSteer(tenant, rec.sessionId, "开始任务")).toBe("started");
    // run 已同步启动(内存 runTask 非空)
    expect(manager.runtimeInfo(rec.sessionId)?.inMemoryRun).toBe(true);
    const lastStatus = () => notices.filter((n) => n.kind === "session_status").at(-1);
    expect(lastStatus()?.data.status).toBe("running");
    expect(lastStatus()?.data.lastUserMessage).toBe("开始任务");

    // 运行中再次提交 → 自动转为补充信息
    expect(
      manager.submitOrSteer(tenant, rec.sessionId, "补充：请额外检查边界情况"),
    ).toBe("steered");
    // 尚未注入：状态快照需带回待注入队列，刷新页面后才能恢复排队提示
    expect(manager.pendingSteers(rec.sessionId)).toEqual(["补充：请额外检查边界情况"]);
    // 补充信息不改变 status，但仍要推送最新指令给总览列表
    expect(lastStatus()?.data.lastUserMessage).toBe("补充：请额外检查边界情况");

    // 释放 run，让 steering 在迭代间隙注入并最终完成
    release();
    await waitFor(() => manager.getSession(tenant.id, rec.sessionId)!.status === "completed");
    expect(manager.pendingSteers(rec.sessionId)).toEqual([]);

    const s = manager.getSession(tenant.id, rec.sessionId)!;
    const userMsgs = (s.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "user",
    );
    expect(userMsgs.map((m) => m.content)).toContain("补充：请额外检查边界情况");

    // 事件流含 queue_steering
    const events = store.loadEvents(tenant.id, rec.sessionId);
    expect(events.some((e) => e.type === "queue_steering")).toBe(true);

    // 补充信息注入后触发了第二轮 LLM 调用
    expect(calls).toBe(2);
  });
});

describe("云端 Server：挂起态中断", () => {
  /** 等待会话彻底停下（状态收敛 + 内存 run 任务释放） */
  async function waitStopped(manager: SessionManager, tenantId: string, sessionId: string) {
    await waitFor(() => manager.getSession(tenantId, sessionId)!.status === "interrupted");
    await waitFor(() => manager.runtimeInfo(sessionId)!.inMemoryRun === false);
  }

  it("审批挂起时 interrupt 立即终止任务，不再卡在 waiting_approval", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])],
      [textChunk("第二个任务完成")],
    ]);

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(() => env.manager.runtimeInfo(rec.sessionId)!.status === "waiting_approval");
    // 挂起期间引擎仍在内存中（阻塞在等待回答的 await 上，安全点不可达）
    expect(env.manager.runtimeInfo(rec.sessionId)!.inMemoryRun).toBe(true);

    env.manager.interrupt(env.tenant, rec.sessionId);
    await waitStopped(env.manager, env.tenant.id, rec.sessionId);

    expect(env.manager.runtimeInfo(rec.sessionId)!.pendingApprovals).toBe(0);
    const s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]!.status).toBe("cancelled");

    // 中断后不再判定为「有未决交互」：会话可继续使用
    expect(env.manager.submitOrSteer(env.tenant, rec.sessionId, "新任务")).toBe("started");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );
  });

  it("ask_user 提问挂起时 interrupt 立即终止任务", async () => {
    const env = makeEnv([
      [toolChunk([{ id: "call_2", name: "ask_user", arguments: { question: "继续吗？" } }])],
      [textChunk("不应到达")],
    ]);

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "开始");
    await waitFor(() => env.manager.runtimeInfo(rec.sessionId)!.status === "waiting_question");

    env.manager.interrupt(env.tenant, rec.sessionId);
    await waitStopped(env.manager, env.tenant.id, rec.sessionId);

    expect(env.manager.runtimeInfo(rec.sessionId)!.pendingQuestions).toBe(0);
    const s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.status).toBe("cancelled");
  });

  it("挂起任务已被超时回收（无引擎）后，interrupt 仍能收敛为 interrupted", async () => {
    const env = makeEnv(
      [[toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])]],
      60,
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(() => env.manager.runtimeInfo(rec.sessionId)!.status === "waiting_approval");
    await sleep(250); // 等审批超时 → 内存 run 任务被回收，磁盘仍是 waiting_approval + pending
    expect(env.manager.runtimeInfo(rec.sessionId)!.inMemoryRun).toBe(false);

    // 旧实现在这里是 rt.engine?.requestInterrupt() 静默 no-op：会话永久停在 waiting_approval
    env.manager.interrupt(env.tenant, rec.sessionId);
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "interrupted",
    );

    const s = env.manager.getSession(env.tenant.id, rec.sessionId)!;
    expect(s.approvals[0]!.status).toBe("cancelled");
  });

  it("进程重启遗留的挂起态（新管理器、无内存运行时）也能被终止", async () => {
    const env = makeEnv(
      [[toolChunk([{ id: "call_1", name: "risky_tool", arguments: { cmd: "doit" } }])]],
      100,
    );

    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "执行任务");
    await waitFor(() => env.manager.runtimeInfo(rec.sessionId)!.status === "waiting_approval");
    await sleep(250); // 旧运行时回收，避免遗留挂起协程

    // 模拟重启：新管理器从同一 store 物化（engine 为空），磁盘仍是 waiting_approval
    const manager2 = new SessionManager(env.store, 60000, {
      providerFactory: () => new ScriptedProvider([[textChunk("恢复完成")]]),
      extraTools: registerRiskyTool,
    });
    setupServerHandlers(manager2);
    expect(manager2.getSession(env.tenant.id, rec.sessionId)!.status).toBe("waiting_approval");

    manager2.interrupt(env.tenant, rec.sessionId);
    await waitFor(
      () => manager2.getSession(env.tenant.id, rec.sessionId)!.status === "interrupted",
    );
    expect(manager2.getSession(env.tenant.id, rec.sessionId)!.approvals[0]!.status).toBe("cancelled");
  });

  it("无任务可终止时（completed）interrupt 不改写状态", async () => {
    const env = makeEnv([[textChunk("完成")]]);
    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "跑一下");
    await waitFor(
      () => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed",
    );

    env.manager.interrupt(env.tenant, rec.sessionId);
    await sleep(50);
    expect(env.manager.getSession(env.tenant.id, rec.sessionId)!.status).toBe("completed");
  });
});
