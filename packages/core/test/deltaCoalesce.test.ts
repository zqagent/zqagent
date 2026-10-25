/**
 * 流式 delta 合并（服务端）
 *
 * 模型逐 token 产出时，每个 delta 原本各占一条事件：一次几百 token 的回复会
 * 变成几百条 SSE 帧 + 几百次异步写盘，并让浏览器对每条都做一次全量重渲染，
 * 长会话下会卡住输入框。现在同一窗口内的同类 delta 合并成一条。
 *
 * 这里锁住三件事：
 *   1. 合并确实生效（事件数远小于 token 数）；
 *   2. 文本一个字都不丢（拼接结果与引擎汇总的完整消息一致）；
 *   3. 顺序语义不变——delta 一定排在 assistant_message / turn_end 之前。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import type { StreamChunk, ProviderClient } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 按给定节奏吐 chunk 的假 provider。
 *
 * gapMs=0 时全部 chunk 落在同一个宏任务里 → 应被合并成极少条事件；
 * gapMs 大于合并窗口时 → 按窗口分批。
 */
class StreamProvider implements ProviderClient {
  constructor(
    private readonly chunks: StreamChunk[],
    private readonly gapMs = 0,
  ) {}

  async stream(): Promise<AsyncIterable<StreamChunk>> {
    const { chunks, gapMs } = this;
    return (async function* () {
      for (const c of chunks) {
        if (gapMs > 0) await sleep(gapMs);
        yield c;
      }
    })();
  }

  async chat(): Promise<string | null> {
    return null;
  }
}

/** 造 n 条正文增量，最后补一条收尾 chunk */
function contentChunks(parts: string[]): StreamChunk[] {
  const out: StreamChunk[] = parts.map((p) => ({
    content: p,
    reasoning: null,
    toolCalls: null,
    usage: null,
    finishReason: null,
  }));
  out.push({
    content: null,
    reasoning: null,
    toolCalls: [],
    usage,
    finishReason: "stop",
  });
  return out;
}

function makeManager(provider: ProviderClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-delta-"));
  const store = new Store(root);
  const tenant = {
    id: "t1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
  } as TenantConfig;
  store.saveTenant(tenant);
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
  setupServerHandlers(manager);
  return { store, tenant, manager };
}

const isTerminal = (st: string) => st === "completed" || st === "error" || st === "stopped";

async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(15);
  }
}

interface TypedEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/** 提交一轮并等它结束，返回该会话的全部事件 */
async function runTurn(provider: ProviderClient, input = "开始") {
  const { tenant, manager } = makeManager(provider);
  const rec = manager.createSession(tenant, {});
  manager.submitTurn(tenant, rec.sessionId, input);
  await waitFor(() => isTerminal(manager.getSession(tenant.id, rec.sessionId)!.status));
  // 终态落盘是异步的；再等一个合并窗口，确保尾部 delta 也已发出
  await sleep(60);
  const { events } = manager.eventsSince(tenant.id, rec.sessionId, 0);
  return { events: events as unknown as TypedEvent[], manager, tenant, sessionId: rec.sessionId };
}

describe("流式 delta 合并", () => {
  it("同一窗口内的多个 delta 合并成一条事件，文本不丢", async () => {
    const parts = Array.from({ length: 100 }, (_, i) => `tok${i} `);
    const { events } = await runTurn(new StreamProvider(contentChunks(parts)));

    const deltas = events.filter((e) => e.type === "assistant_delta");
    // 原本 100 条；合并后应是个位数（同 tick 内通常就是 1 条）
    expect(deltas.length).toBeLessThan(10);
    const joined = deltas.map((d) => String(d.data["text"] ?? "")).join("");
    expect(joined).toBe(parts.join(""));

    // 引擎汇总的完整消息同样是全文，两者一致
    const msg = events.find((e) => e.type === "assistant_message");
    expect(String(msg?.data["text"] ?? "")).toBe(parts.join(""));
  }, 60_000);

  it("跨合并窗口的 delta 分批发出，但拼接后仍完整", async () => {
    const parts = Array.from({ length: 8 }, (_, i) => `w${i};`);
    // 间隔大于窗口 → 每条各自成批（或相邻两条成一批），不应合成 1 条
    const { events } = await runTurn(new StreamProvider(contentChunks(parts), 25));

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThanOrEqual(parts.length);
    expect(deltas.map((d) => String(d.data["text"] ?? "")).join("")).toBe(parts.join(""));
  }, 60_000);

  it("delta 一定排在 assistant_message 与 turn_end 之前", async () => {
    const parts = Array.from({ length: 40 }, (_, i) => `x${i}`);
    const { events } = await runTurn(new StreamProvider(contentChunks(parts)));

    const lastDelta = Math.max(
      ...events.filter((e) => e.type === "assistant_delta").map((e) => e.seq),
    );
    const msg = events.find((e) => e.type === "assistant_message")!;
    const end = events.find((e) => e.type === "turn_end")!;
    expect(lastDelta).toBeLessThan(msg.seq);
    expect(lastDelta).toBeLessThan(end.seq);
    // seq 本身严格单调递增（合并只是跳号，不会乱序或重复）
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it("思考与正文各自合并，互不串行", async () => {
    // 交替产出 reasoning / content：两类必须分别累积
    const chunks: StreamChunk[] = [];
    const reasoningParts: string[] = [];
    const contentParts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = `r${i}`;
      const c = `c${i}`;
      reasoningParts.push(r);
      contentParts.push(c);
      chunks.push({ content: null, reasoning: r, toolCalls: null, usage: null, finishReason: null });
      chunks.push({ content: c, reasoning: null, toolCalls: null, usage: null, finishReason: null });
    }
    chunks.push({
      content: null,
      reasoning: null,
      toolCalls: [],
      usage,
      finishReason: "stop",
    });

    const { events } = await runTurn(new StreamProvider(chunks));
    const joinedR = events
      .filter((e) => e.type === "reasoning_delta")
      .map((e) => String(e.data["text"] ?? ""))
      .join("");
    const joinedC = events
      .filter((e) => e.type === "assistant_delta")
      .map((e) => String(e.data["text"] ?? ""))
      .join("");

    expect(joinedR).toBe(reasoningParts.join(""));
    expect(joinedC).toBe(contentParts.join(""));
  }, 60_000);
});
