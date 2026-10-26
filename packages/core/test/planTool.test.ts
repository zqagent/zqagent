/**
 * 计划提案的三种回应：批准 / 拒绝 / 补充修订
 *
 * 需求背景：CLI 里原来只有 Y（批准）和 D（拒绝），其他输入被 while 循环
 * 直接丢弃再问一遍——用户写下的修改意见白写。现在非 Y/D 的自由文本视为
 * 「对计划的补充要求」，合并进原计划后重新提案。
 *
 * 覆盖两层：
 *   1. parsePlanAnswer：Web 端点回答文本 → 结构化结果（批准 / 拒绝 / 修订）；
 *   2. propose_plan 工具：把修订意图变成模型能照着做的返回值与 note。
 */
import { describe, it, expect, afterEach } from "vitest";
import { parsePlanAnswer } from "../src/server/session.js";
import {
  EventType,
  Mode,
  PermissionEngine,
  ToolRegistry,
  TurnEngine,
  interpretPlanReply,
  registerPlanTool,
  setPlanHandler,
} from "../src/index.js";
import type {
  ProviderClient,
  StreamChunk,
  TokenUsage,
  WsEvent,
} from "../src/index.js";

const usage: TokenUsage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 };

/** 脚本化 Provider：按调用次数返回预设 chunk 序列 */
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

function textChunk(content: string): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
}

function toolChunk(toolCalls: StreamChunk["toolCalls"]): StreamChunk {
  return { content: null, reasoning: null, toolCalls, usage, finishReason: "tool_calls" };
}

afterEach(() => {
  // handler 是模块级单例：每个用例都重新注册，这里清空避免串味
  setPlanHandler(() => Promise.resolve({ approved: false, feedback: "未设置" }));
});

describe("parsePlanAnswer", () => {
  it("肯定回答 → 批准", () => {
    expect(parsePlanAnswer("y").approved).toBe(true);
    expect(parsePlanAnswer("YES").approved).toBe(true);
    expect(parsePlanAnswer("同意").approved).toBe(true);
  });

  it("整句是拒绝词 → 拒绝（不是修订）", () => {
    for (const word of ["d", "n", "no", "reject", "拒绝", "取消"]) {
      const r = parsePlanAnswer(word);
      expect(r.approved).toBe(false);
      expect(r.revised).toBeUndefined();
    }
  });

  it("自由文本 → 修订，并原样带上用户的要求", () => {
    const text = "不要改 engine，改用 tools 层实现";
    const r = parsePlanAnswer(text);
    expect(r.approved).toBe(false);
    expect(r.revised).toBe(true);
    expect(r.feedback).toBe(text);
  });

  it("包含否定词的句子仍算修订，不会被当成拒绝", () => {
    // 「不要…」是修改意见，不是否决整个方案
    const r = parsePlanAnswer("不要动数据库，其他都可以");
    expect(r.revised).toBe(true);
  });

  it("空回答按修订处理，给出兜底说明", () => {
    const r = parsePlanAnswer("   ");
    expect(r.revised).toBe(true);
    expect(r.feedback).toBeTruthy();
  });
});

describe("interpretPlanReply（CLI 与 Web 共用的判定）", () => {
  it("Y / yes / 同意 / 好 → approve", () => {
    expect(interpretPlanReply("Y").kind).toBe("approve");
    expect(interpretPlanReply("yes").kind).toBe("approve");
    expect(interpretPlanReply("同意").kind).toBe("approve");
    // 中文单字口语：不能因为不在 Y/D 里就被当成补充要求
    expect(interpretPlanReply("好").kind).toBe("approve");
    expect(interpretPlanReply("行").kind).toBe("approve");
  });

  it("D / n / no / 拒绝 / 不 → reject", () => {
    expect(interpretPlanReply("D").kind).toBe("reject");
    expect(interpretPlanReply("n").kind).toBe("reject");
    expect(interpretPlanReply("no").kind).toBe("reject");
    expect(interpretPlanReply("拒绝").kind).toBe("reject");
    expect(interpretPlanReply("不").kind).toBe("reject");
  });

  it("其他文字 → revise，并带出原文", () => {
    const r = interpretPlanReply("把第二步改成先跑测试");
    expect(r).toEqual({ kind: "revise", feedback: "把第二步改成先跑测试" });
  });

  it("空输入 → empty（CLI 重新提示，不当作补充要求）", () => {
    expect(interpretPlanReply("   ").kind).toBe("empty");
  });
});

describe("propose_plan 工具", () => {
  async function runWith(handler: Parameters<typeof setPlanHandler>[0]) {
    setPlanHandler(handler);
    const registry = new ToolRegistry();
    registerPlanTool(registry);
    return (await registry.execute("propose_plan", {
      plan: "先改 A，再改 B",
    })) as Record<string, unknown>;
  }

  it("批准：返回 approved 与执行模式", async () => {
    const r = await runWith(() => Promise.resolve({ approved: true, mode: "interactive" }));
    expect(r.approved).toBe(true);
    expect(r.mode).toBe("interactive");
  });

  it("拒绝：返回反馈，不带 revised", async () => {
    const r = await runWith(() => Promise.resolve({ approved: false, feedback: "方案不可行" }));
    expect(r.approved).toBe(false);
    expect(r.revised).toBeUndefined();
    expect(r.feedback).toBe("方案不可行");
  });

  it("修订：标记 revised，并提示合并后重新提案", async () => {
    const r = await runWith(() =>
      Promise.resolve({ approved: false, revised: true, feedback: "改用 tools 层" }),
    );
    expect(r.approved).toBe(false);
    expect(r.revised).toBe(true);
    expect(r.feedback).toBe("改用 tools 层");
    // note 必须把下一步说清楚：合并 → 重新提案 → 不要开始实施
    const note = String(r.note);
    expect(note).toContain("补充要求");
    expect(note).toContain("propose_plan");
    expect(note).toContain("不要开始实施");
  });

  it("空计划直接报错，不进入审批", async () => {
    let called = false;
    setPlanHandler(() => {
      called = true;
      return Promise.resolve({ approved: true });
    });
    const registry = new ToolRegistry();
    registerPlanTool(registry);
    const r = (await registry.execute("propose_plan", { plan: "  " })) as Record<string, unknown>;
    expect(r.error).toBeTruthy();
    expect(called).toBe(false);
  });
});

describe("补充要求后在同一会话里重新提案", () => {
  /** 收集整轮事件 */
  async function collect(engine: TurnEngine, input: string): Promise<WsEvent[]> {
    const out: WsEvent[] = [];
    for await (const e of engine.run(input)) out.push(e);
    return out;
  }

  it("用户提补充要求 → 模型合并后再次提案 → 本次获批", async () => {
    // 第一次提案被「修订」，模型据反馈改了计划再提一次
    const replies = [
      { approved: false, revised: true, feedback: "改用 tools 层实现" },
      { approved: true, mode: "interactive" },
    ];
    setPlanHandler(() => Promise.resolve(replies.shift() ?? { approved: false }));

    const registry = new ToolRegistry();
    registerPlanTool(registry);
    const engine = new TurnEngine({
      provider: new ScriptedProvider([
        [toolChunk([{ id: "p1", name: "propose_plan", arguments: { plan: "改 engine" } }])],
        [toolChunk([{ id: "p2", name: "propose_plan", arguments: { plan: "改 tools（已合并反馈）" } }])],
        [textChunk("计划已获批，开始实施")],
      ]),
      registry,
      permissions: new PermissionEngine({ workspaceRoot: "/work", mode: Mode.PLAN }),
      model: "test-model",
      instructions: "test system",
      maxIterations: 10,
    });

    const events = await collect(engine, "请规划改造方案");

    const plans = events.filter((e) => e.type === EventType.PLAN_PROPOSED);
    expect(plans).toHaveLength(2);
    expect(String(plans[0]!.data.plan)).toBe("改 engine");
    // 第二次提案已经是合并反馈后的版本，说明修订被吸收而不是把方案丢掉
    expect(String(plans[1]!.data.plan)).toContain("已合并反馈");

    const end = events[events.length - 1]!;
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("completed");
  });
});
