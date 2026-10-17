/**
 * TurnEngine 单元测试
 *
 * 使用脚本化 mock Provider 驱动完整事件流，覆盖：简单回复完成、
 * 工具调用全流程（授权→执行→结果回填→继续迭代）、工具被拒、
 * 未知工具、Provider 错误、最大迭代次数、steering 注入与流式中断。
 */
import { describe, it, expect } from "vitest";
import {
  TurnEngine,
  EventType,
  ToolRegistry,
  PermissionEngine,
  Mode,
} from "../src/index.js";
import type {
  TurnEngineOpts,
  WsEvent,
  StreamChunk,
  TokenUsage,
  ProviderClient,
  ToolMetadata,
  EngineHook,
  CompactionDoneInfo,
  CompactionStartInfo,
} from "../src/index.js";

const usage: TokenUsage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 脚本化 Provider：按调用次数依次返回预设的 chunk 序列 */
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

/** 文本型最终 chunk */
function textChunk(content: string, finishReason = "stop"): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason };
}

/** 工具调用型最终 chunk（usage 可覆盖，默认模块级 usage） */
function toolChunk(
  toolCalls: StreamChunk["toolCalls"],
  finishReason = "tool_calls",
  u: TokenUsage = usage,
): StreamChunk {
  return { content: null, reasoning: null, toolCalls, usage: u, finishReason };
}

/** 完整收集一轮 Turn 的事件 */
async function collect(engine: TurnEngine, input: string): Promise<WsEvent[]> {
  const events: WsEvent[] = [];
  for await (const e of engine.run(input)) events.push(e);
  return events;
}

const fakeToolMeta: ToolMetadata = {
  category: "test",
  riskLevel: "low",
  capabilities: ["fake_tool"],
  requiresApproval: false,
};

function buildEngine(opts: {
  script: StreamChunk[][];
  mode?: Mode;
  maxIterations?: number;
  contextWindow?: number;
  hook?: EngineHook;
  register?: (r: ToolRegistry) => void;
}): TurnEngine {
  const provider = new ScriptedProvider(opts.script);
  const registry = new ToolRegistry();
  // 默认注册一个 fake_tool，可被 register 回调覆盖/追加
  registry.register(
    (args) => ({ echoed: args }),
    fakeToolMeta,
    {
      type: "function",
      function: {
        name: "fake_tool",
        description: "fake",
        parameters: { type: "object", properties: {} },
      },
    },
  );
  opts.register?.(registry);

  const permissions = new PermissionEngine({
    workspaceRoot: "/work",
    mode: opts.mode ?? Mode.AUTO,
  });

  return new TurnEngine({
    provider,
    registry,
    permissions,
    model: "test-model",
    instructions: "test system",
    maxIterations: opts.maxIterations ?? 10,
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.hook ? { hook: opts.hook } : {}),
  });
}

describe("TurnEngine 基本流程", () => {
  it("无工具调用的回复直接 completed", async () => {
    const engine = buildEngine({ script: [[textChunk("你好"), { ...textChunk(""), usage, finishReason: "stop" }]] });
    const events = await collect(engine, "hello");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.TURN_START);
    expect(types).toContain(EventType.ASSISTANT_DELTA);
    expect(types).toContain(EventType.ASSISTANT_MESSAGE);
    expect(types[types.length - 1]).toBe(EventType.TURN_END);

    const end = events[types.length - 1];
    expect(end.data.status).toBe("completed");

    // 历史包含 system / user / assistant 消息
    const roles = engine.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant"]);
    expect(engine.messages[1].content).toBe("hello");
  });

  it("流式文本按 delta 逐段产出", async () => {
    const engine = buildEngine({
      script: [[{ content: "你", reasoning: null, toolCalls: null, usage: null, finishReason: null }, textChunk("好")]],
    });
    const events = await collect(engine, "hi");
    const deltas = events.filter((e) => e.type === EventType.ASSISTANT_DELTA).map((e) => e.data.text);
    expect(deltas).toEqual(["你", "好"]);
  });
});

describe("TurnEngine 工具调用流程", () => {
  it("工具执行后结果回填，继续迭代直到完成", async () => {
    const engine = buildEngine({
      script: [
        [toolChunk([{ id: "call_1", name: "fake_tool", arguments: { x: 1 } }])],
        [textChunk("全部完成"), { ...textChunk(""), usage, finishReason: "stop" }],
      ],
    });
    const events = await collect(engine, "do it");

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_PROPOSED);
    expect(types).toContain(EventType.TOOL_STARTED);
    expect(types).toContain(EventType.TOOL_FINISHED);
    expect(types).toContain(EventType.ITERATION_END);
    expect(types[types.length - 1]).toBe(EventType.TURN_END);
    expect(events[types.length - 1].data.status).toBe("completed");

    // 工具结果以 tool 消息回填历史，且带 tool_call_id
    const toolMsg = engine.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg!.content)).toEqual({ echoed: { x: 1 } });

    // provider 被调用两轮
    expect((engine.provider as ScriptedProvider).calls).toBe(2);
  });

  it("交互类工具(ask_user / request_directory)串行执行，不并发抢答", async () => {
    // 两个交互工具并发执行时，CLI 上会同时出现两个提示符，用户无法区分回答归属
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const makeTool = (name: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await sleep(10); // 模拟等待用户回答
      active -= 1;
      order.push(`${name}:end`);
      return { ok: name };
    };

    const engine = buildEngine({
      script: [
        [
          toolChunk([
            { id: "call_ask", name: "ask_user", arguments: { question: "?" } },
            { id: "call_dir", name: "request_directory", arguments: { path: "/x" } },
          ]),
        ],
        [textChunk("完成")],
      ],
      register: (r) => {
        for (const name of ["ask_user", "request_directory"]) {
          r.register(
            makeTool(name),
            {
              category: "interaction",
              riskLevel: "low",
              capabilities: [name],
              requiresApproval: false,
            },
            {
              type: "function",
              function: {
                name,
                description: name,
                parameters: { type: "object", properties: {} },
              },
            },
          );
        }
      },
    });

    await collect(engine, "go");

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "ask_user:start",
      "ask_user:end",
      "request_directory:start",
      "request_directory:end",
    ]);
  });

  it("权限引擎拒绝的工具不执行，直接产出 denied", async () => {
    // INTERACTIVE 模式 + 越界路径 → write_file 被权限引擎拒绝
    const engine = buildEngine({
      mode: Mode.INTERACTIVE,
      script: [
        [toolChunk([{ id: "call_1", name: "write_file", arguments: { path: "/etc/passwd", content: "x" } }])],
        [textChunk("收到")],
      ],
    });
    const events = await collect(engine, "write");

    const finished = events.find((e) => e.type === EventType.TOOL_FINISHED)!;
    expect(finished.data.status).toBe("denied");

    // 拒绝结果作为 tool 错误消息入历史，引擎继续迭代
    const toolMsg = engine.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("tool call not executed");
  });

  it("未知工具产出 error 状态", async () => {
    const engine = buildEngine({
      script: [
        [toolChunk([{ id: "call_1", name: "no_such_tool", arguments: {} }])],
        [textChunk("完成")],
      ],
    });
    const events = await collect(engine, "x");
    const finished = events.find((e) => e.type === EventType.TOOL_FINISHED)!;
    expect(finished.data.status).toBe("error");
    expect(finished.data.reason).toBe("unknown tool");
  });
});

describe("TurnEngine 异常与边界", () => {
  it("Provider 抛错时产出 ERROR 并终止", async () => {
    const provider = {
      async stream() {
        throw new Error("api down");
      },
    };
    const registry = new ToolRegistry();
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
    });

    const events = await collect(engine, "hi");
    const error = events.find((e) => e.type === EventType.ERROR)!;
    expect(error.data.error).toContain("api down");
    // notice 消息记录错误
    expect(engine.messages.some((m) => m.role === "notice" && m.kind === "error")).toBe(true);
  });

  it("可重试错误在 ERROR 事件携带 retriable/iteration 并补发 TURN_END", async () => {
    const provider = {
      async stream() {
        throw Object.assign(new Error("api down"), { status: 503 });
      },
    };
    const registry = new ToolRegistry();
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
    });

    const events = await collect(engine, "hi");
    const error = events.find((e) => e.type === EventType.ERROR)!;
    expect(error.data.retriable).toBe(true);
    expect(typeof error.data.iteration).toBe("number");

    // 错误终止也补齐 TURN_END，状态机闭合
    const end = events[events.length - 1];
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("error");
  });

  it("不可重试错误（4xx）在 ERROR 事件标记 retriable=false", async () => {
    const provider = {
      async stream() {
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    };
    const registry = new ToolRegistry();
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
    });

    const events = await collect(engine, "hi");
    const error = events.find((e) => e.type === EventType.ERROR)!;
    expect(error.data.retriable).toBe(false);
  });

  it("出错后可通过 retry() 恢复并正常完成", async () => {
    const provider = {
      calls: 0,
      async stream() {
        this.calls++;
        // 第一次瞬时故障（503），第二次成功
        if (this.calls === 1) throw Object.assign(new Error("temporary failure"), { status: 503 });
        return (async function* () {
          yield textChunk("重试成功");
        })();
      },
    };
    const registry = new ToolRegistry();
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
    });

    const first = await collect(engine, "hi");
    expect(first[first.length - 1].data.status).toBe("error");

    const retried: WsEvent[] = [];
    for await (const e of engine.retry()) retried.push(e);
    const end = retried[retried.length - 1];
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("completed");
  });

  it("hook 抛异常不影响引擎核心逻辑", async () => {
    const provider = new ScriptedProvider([[textChunk("你好"), { ...textChunk(""), usage, finishReason: "stop" }]]);
    const registry = new ToolRegistry();
    registry.register(
      (args) => ({ echoed: args }),
      fakeToolMeta,
      {
        type: "function",
        function: {
          name: "fake_tool",
          description: "fake",
          parameters: { type: "object", properties: {} },
        },
      },
    );
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
      hook: {
        onAssistantDelta: () => {
          throw new Error("hook boom");
        },
        onTurnEnd: () => {
          throw new Error("hook boom");
        },
      },
    });

    const events = await collect(engine, "hi");
    const end = events[events.length - 1];
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("completed");
  });

  it("达到最大迭代次数时以 max_iterations_exceeded 结束", async () => {
    // 每轮都请求工具调用 → 永远无法完成
    const engine = buildEngine({
      maxIterations: 2,
      script: [
        [toolChunk([{ id: "c1", name: "fake_tool", arguments: {} }])],
        [toolChunk([{ id: "c2", name: "fake_tool", arguments: {} }])],
        [toolChunk([{ id: "c3", name: "fake_tool", arguments: {} }])],
      ],
    });
    const events = await collect(engine, "loop");
    const end = events[events.length - 1];
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("max_iterations_exceeded");
  });
});

describe("TurnEngine steering 与中断", () => {
  it("排队 steering 消息在 Turn 完成后注入并继续迭代", async () => {
    const engine = buildEngine({
      script: [
        [textChunk("第一轮")],
        [textChunk("第二轮完成")],
      ],
    });
    engine.queueSteering("请补充细节");

    const events = await collect(engine, "hi");
    const end = events[events.length - 1];
    expect(end.data.status).toBe("completed");

    // steering 注入为一条 user 消息
    const userMessages = engine.messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual(["hi", "请补充细节"]);
    // provider 被调用了两轮
    expect((engine.provider as ScriptedProvider).calls).toBe(2);
  });

  it("流式过程中 requestInterrupt 产出 INTERRUPTED", async () => {
    let cancelled = false;
    const stream = (async function* () {
      yield { content: "part1", reasoning: null, toolCalls: null, usage: null, finishReason: null };
      // 等待外部中断信号
      while (!cancelled) await new Promise((r) => setTimeout(r, 10));
    })();
    const provider: ProviderClient = { async stream() { return stream; } };
    const registry = new ToolRegistry();
    const permissions = new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO });
    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: "test-model",
      instructions: "test system",
    });

    setTimeout(() => {
      cancelled = true;
      engine.requestInterrupt();
    }, 50);

    const events = await collect(engine, "hi");
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.ASSISTANT_DELTA);
    expect(types).toContain(EventType.INTERRUPTED);
    // 中断后仍补发 TURN_END，状态机闭合（status=interrupted）
    expect(types[types.length - 1]).toBe(EventType.TURN_END);
    expect(events[types.length - 1].data.status).toBe("interrupted");
    // 已流式文本被保留在历史中
    expect(engine.messages.some((m) => m.role === "assistant" && m.content === "part1")).toBe(true);
    expect(engine.messages.some((m) => m.role === "notice" && m.kind === "interrupted")).toBe(true);
  });
});

describe("TurnEngine contextWindow 选项", () => {
  // 大体积 user 消息（~5000 tokens），保证历史中存在可被摘要压缩的旧段
  const bigInput = "x".repeat(20_000);
  const bigUsage: TokenUsage = { input: 5000, output: 3, cacheRead: 0, cacheWrite: 0 };

  it("显式 contextWindow 缩小压缩阈值，超阈值时触发自动压缩", async () => {
    const engine = buildEngine({
      contextWindow: 2000, // 触发阈值 = 0.8 × 2000 = 1600 tokens（远低于默认 102400）
      script: [
        [toolChunk([{ id: "c1", name: "fake_tool", arguments: {} }], "tool_calls", bigUsage)],
        [textChunk("摘要完成")], // 压缩摘要器的 LLM 调用
        [textChunk("最终回答")], // 压缩后的下一轮 LLM 调用
      ],
    });

    const events = await collect(engine, bigInput);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.COMPACTING);
    expect(types).toContain(EventType.COMPACTED);
    // 压缩状态已建立（摘要 + 边界）
    expect(engine.compactionState).not.toBeNull();
    expect(engine.compactionState!.summaryText).toBe("摘要完成");
    // 3 次 provider 调用：工具轮 / 摘要器 / 压缩后继续
    expect((engine.provider as ScriptedProvider).calls).toBe(3);

    const end = events[events.length - 1];
    expect(end.type).toBe(EventType.TURN_END);
    expect(end.data.status).toBe("completed");
  });

  it("压缩事件与 hook 均携带用量与结果信息", async () => {
    const starts: CompactionStartInfo[] = [];
    const dones: CompactionDoneInfo[] = [];
    const engine = buildEngine({
      contextWindow: 2000,
      hook: {
        onCompacting: (info) => {
          if (info) starts.push(info);
        },
        onCompacted: (_text, info) => {
          if (info) dones.push(info);
        },
      },
      script: [
        [toolChunk([{ id: "c1", name: "fake_tool", arguments: {} }], "tool_calls", bigUsage)],
        [textChunk("摘要完成")],
        [textChunk("最终回答")],
      ],
    });

    const events = await collect(engine, bigInput);

    // 开始事件：阈值触发 + 窗口 + 压缩前消息条数
    const start = events.find((e) => e.type === EventType.COMPACTING)!;
    expect(start.data.trigger).toBe("threshold");
    expect(start.data.contextWindow).toBe(2000);
    expect(typeof start.data.tokens).toBe("number");
    expect(typeof start.data.outboundMessages).toBe("number");

    // 完成事件：摘要方式 + 压缩前后条数（边界前的消息折叠为 1 条摘要，
    // 小会话下折叠数可能与新增的摘要条数相抵，故不假设严格减少）
    const done = events.find((e) => e.type === EventType.COMPACTED)!;
    expect(done.data.method).toBe("summarized");
    expect(Number(done.data.messagesBefore)).toBeGreaterThan(0);
    expect(Number(done.data.messagesAfter)).toBeLessThanOrEqual(
      Number(done.data.messagesBefore),
    );

    // hook 收到同一份信息（CLI / 日志据此打印富文案）。
    // 注意：首轮触发时历史尚不足以折叠（buildState 返回 null），只发开始事件，
    // 因此这里断言「最后一次开始」与「唯一一次完成」的信息一致。
    const lastStart = starts[starts.length - 1];
    expect(lastStart.contextWindow).toBe(2000);
    expect(lastStart.tokens).toBeGreaterThan(1000); // 优先 API 精确用量（bigUsage.input=5000）
    expect(lastStart.outboundMessages).toBe(
      events.filter((e) => e.type === EventType.COMPACTING).pop()!.data.outboundMessages,
    );
    expect(dones).toHaveLength(1);
    expect(dones[0].method).toBe("summarized");
    expect(dones[0].messagesAfter).toBe(done.data.messagesAfter);
  });

  it("未配置 contextWindow 时走自动检测：未知模型默认 128K，同样用量不触发压缩", async () => {
    const engine = buildEngine({
      script: [
        [toolChunk([{ id: "c1", name: "fake_tool", arguments: {} }], "tool_calls", bigUsage)],
        [textChunk("最终回答")],
      ],
    });

    const events = await collect(engine, bigInput);
    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.COMPACTED);
    expect(engine.compactionState).toBeNull();
    // 2 次 provider 调用：工具轮 + 最终回答（无压缩）
    expect((engine.provider as ScriptedProvider).calls).toBe(2);
  });
});
