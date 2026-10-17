/**
 * 会话卡死在「推理中」且停止无效 —— 三条修复的回归测试：
 *
 *   1. Provider 流空闲看门狗：网关静默断供时抛错退出，而不是永久挂起；
 *   2. TurnEngine.requestInterrupt() 立刻掐断在飞的流式请求并按中断收尾；
 *   3. 孤儿 running 自愈：磁盘标记 running 但无内存运行时（进程重启遗留）
 *      时收敛为 interrupted，正在运行的会话不受影响。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { EventEmitter } from "events";
import type { AddressInfo } from "net";
import type { ServerResponse } from "http";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import {
  TurnEngine,
  EventType,
  ToolRegistry,
  PermissionEngine,
  Mode,
} from "../src/index.js";
import type {
  WsEvent,
  StreamChunk,
  ProviderClient,
  ToolMetadata,
} from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(10);
  }
}

function textChunk(content: string, finishReason = "stop"): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason };
}

// ===================== 1. Provider 流空闲看门狗 =====================

describe("Provider 流空闲看门狗", () => {
  it("流静默挂死时抛错退出，而不是永久挂起", async () => {
    const chunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "部分输出" }, finish_reason: null },
      ],
    };
    // 首个数据帧后静默：不回数据也不结束连接，模拟网关静默断供
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    process.env.OPENAI_FORCE_API_MODE = "chat";
    process.env.OPENAI_STREAM_IDLE_MS = "200";
    try {
      const provider = new OpenAIProvider({
        apiKey: "sk-test",
        baseURL: `http://127.0.0.1:${port}/v1`,
      });
      const chunks = await provider.stream("test-model", [], [], { reqId: "idle_test" });

      const received: string[] = [];
      let err: Error | null = null;
      const startedAt = Date.now();
      try {
        for await (const c of chunks) received.push(c.content ?? "");
      } catch (e) {
        err = e as Error;
      }
      const elapsed = Date.now() - startedAt;

      // 已收到的帧仍然交付，随后以超时错误结束
      expect(received).toEqual(["部分输出"]);
      expect(err?.message).toContain("空闲超时");
      expect(elapsed).toBeLessThan(3000);
    } finally {
      delete process.env.OPENAI_FORCE_API_MODE;
      delete process.env.OPENAI_STREAM_IDLE_MS;
      server.closeAllConnections?.();
      server.close();
    }
  });
});

// ===================== 2. 停止真正生效 =====================

/** 先吐一帧再挂死的 Provider：只有收到 abort 才会结束，用于验证中断能掐断在飞请求 */
class HangingProvider implements ProviderClient {
  started = false;
  aborted = false;

  async stream(
    _model: any,
    _messages: any,
    _tools: any,
    opts: any,
  ): Promise<AsyncIterable<StreamChunk>> {
    const signal: AbortSignal | undefined = opts?.signal;
    const self = this;
    return (async function* () {
      self.started = true;
      yield textChunk("部分输出", "");
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      self.aborted = true;
      throw new Error("AbortError: 本次请求已被中止");
    })();
  }
}

const fakeToolMeta: ToolMetadata = {
  category: "test",
  riskLevel: "low",
  capabilities: ["fake_tool"],
  requiresApproval: false,
};

function buildEngine(provider: ProviderClient): TurnEngine {
  const registry = new ToolRegistry();
  registry.register((args) => ({ echoed: args }), fakeToolMeta, {
    type: "function",
    function: {
      name: "fake_tool",
      description: "fake",
      parameters: { type: "object", properties: {} },
    },
  });
  return new TurnEngine({
    provider,
    registry,
    permissions: new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO }),
    model: "test-model",
    instructions: "test system",
    maxIterations: 10,
  });
}

describe("TurnEngine 中断", () => {
  it("requestInterrupt 立刻掐断在飞的流式请求并按中断收尾", async () => {
    const provider = new HangingProvider();
    const engine = buildEngine(provider);

    const events: WsEvent[] = [];
    const pumping = (async () => {
      for await (const e of engine.run("开始")) events.push(e);
    })();

    // 等引擎真正进入流式读取（已消费第一帧，挂在等待下一帧上）
    await waitFor(() => provider.started);
    await sleep(20);

    const t0 = Date.now();
    engine.requestInterrupt();
    // 若中断不能掐断在飞请求，这里会一直挂到 vitest 超时
    await pumping;
    const elapsed = Date.now() - t0;

    expect(provider.aborted).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.INTERRUPTED);
    expect(types).not.toContain(EventType.ERROR);
    const end = events.find((e) => e.type === EventType.TURN_END);
    expect((end?.data as { status?: string }).status).toBe("interrupted");
    expect(elapsed).toBeLessThan(2000);
  });

  it("工具执行期间中断 → 中断信号立即传给工具（不再等命令自然结束）", async () => {
    let toolStarted = false;
    let toolAborted = false;
    let toolSignal: AbortSignal | undefined;

    const registry = new ToolRegistry();
    registry.register(
      async (_args, ctx) => {
        toolStarted = true;
        toolSignal = ctx?.signal;
        await new Promise<void>((resolve) => {
          if (ctx?.signal?.aborted) return resolve();
          ctx?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        toolAborted = true;
        return { stopped: true };
      },
      {
        category: "test",
        riskLevel: "high",
        capabilities: ["slow_tool"],
        requiresApproval: false,
      },
      {
        type: "function",
        function: {
          name: "slow_tool",
          description: "slow",
          parameters: { type: "object", properties: {} },
        },
      },
    );
    const engine = new TurnEngine({
      provider: new ToolCallProvider(),
      registry,
      permissions: new PermissionEngine({ workspaceRoot: "/work", mode: Mode.AUTO }),
      model: "test-model",
      instructions: "test system",
      maxIterations: 10,
    });

    const events: WsEvent[] = [];
    const pumping = (async () => {
      for await (const e of engine.run("开始")) events.push(e);
    })();

    await waitFor(() => toolStarted);
    const t0 = Date.now();
    engine.requestInterrupt();
    // 若中断传导不到工具，工具会一直挂着，这里会等到 vitest 超时
    await pumping;
    const elapsed = Date.now() - t0;

    expect(toolAborted).toBe(true);
    expect(toolSignal?.aborted).toBe(true);
    expect(events.map((e) => e.type)).toContain(EventType.INTERRUPTED);
    expect(elapsed).toBeLessThan(2000);
  });
});

/** 先要求调用一次工具、再收尾的 Provider：用于让引擎进入工具执行阶段 */
class ToolCallProvider implements ProviderClient {
  async stream(_model: any, messages: any[]): Promise<AsyncIterable<StreamChunk>> {
    const hasToolResult = messages.some((m) => m.role === "tool");
    if (hasToolResult) {
      return (async function* () {
        yield textChunk("完成");
      })();
    }
    return (async function* () {
      yield {
        content: "",
        reasoning: null,
        toolCalls: [{ id: "call_1", name: "slow_tool", arguments: {} }],
        usage: null,
        finishReason: "tool_calls",
      } satisfies StreamChunk;
    })();
  }
}

// ===================== 3. 孤儿 running 自愈 =====================

/** 卡在 gate 上的 Provider：用于让会话保持 running */
class GateProvider implements ProviderClient {
  private release!: () => void;
  readonly gate = new Promise<void>((r) => {
    this.release = r;
  });

  async stream(): Promise<AsyncIterable<StreamChunk>> {
    const gate = this.gate;
    return (async function* () {
      await gate;
      yield textChunk("完成");
      yield { ...textChunk(""), finishReason: "stop" };
    })();
  }
}

/** 假 ServerResponse：subscribe 只用到 write/on/writableEnded/socket */
class FakeRes extends EventEmitter {
  writableEnded = false;
  socket = { setNoDelay: () => undefined, setTimeout: () => undefined };
  write = () => true;
  end = () => {
    this.writableEnded = true;
  };
}

function makeEnv(provider: ProviderClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-orphan-"));
  const store = new Store(root);
  const tenant: TenantConfig = {
    id: "t1",
    apiKey: "k1",
    model: "test-model",
    provider: { apiKey: "sk-test" },
  };
  store.saveTenant(tenant);
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
  return { root, store, tenant, manager };
}

/** 把磁盘记录改成 running，模拟上一进程崩溃/重启后遗留的孤儿状态 */
async function writeOrphanRunning(
  store: Store,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  const rec = store.loadSession(tenantId, sessionId)!;
  await store.saveSession({ ...rec, status: "running" });
}

describe("孤儿 running 自愈", () => {
  it("读路径（getSession / listSessions）把孤儿 running 收敛为 interrupted 并回写", async () => {
    const { store, tenant, manager } = makeEnv(new GateProvider());
    const rec = manager.createSession(tenant, {});
    await writeOrphanRunning(store, tenant.id, rec.sessionId);

    expect(manager.getSession(tenant.id, rec.sessionId)!.status).toBe("interrupted");
    expect(manager.listSessions(tenant.id)[0]!.status).toBe("interrupted");
    await waitFor(() => store.loadSession(tenant.id, rec.sessionId)!.status === "interrupted");
  });

  it("物化内存运行时（订阅事件流）时同样不残留 running", async () => {
    const { store, tenant, manager } = makeEnv(new GateProvider());
    const rec = manager.createSession(tenant, {});
    await writeOrphanRunning(store, tenant.id, rec.sessionId);

    const res = new FakeRes();
    manager.subscribe(tenant.id, rec.sessionId, res as unknown as ServerResponse);
    try {
      expect(manager.runtimeInfo(rec.sessionId)!.status).toBe("interrupted");
    } finally {
      res.emit("close");
    }
  });

  it("正在运行的会话不被误判为孤儿", async () => {
    const provider = new GateProvider();
    const { store, tenant, manager } = makeEnv(provider);
    const rec = manager.createSession(tenant, {});

    manager.submitTurn(tenant, rec.sessionId, "跑起来");
    await waitFor(() => manager.runtimeInfo(rec.sessionId)?.inMemoryRun === true);

    // 磁盘上恰好是 running，但内存里有对应运行时 → 权威状态，读路径不得改写
    await writeOrphanRunning(store, tenant.id, rec.sessionId);
    expect(manager.getSession(tenant.id, rec.sessionId)!.status).toBe("running");

    provider.release();
    await waitFor(() => manager.getSession(tenant.id, rec.sessionId)!.status === "completed");
  });
});
