/**
 * 收尾事件与状态的一致性
 *
 * 现象：任务结束后页面仍显示「AI 生成回复中」，要等 30s 兜底轮询才恢复。
 *
 * 根因：客户端收到 turn_end / interrupted / error 会立刻拉一次 /state，
 * 而服务端原来是「先发事件、后改状态」——那一刻 rt.status 还是 running，
 * 读到的自然也是 running（磁盘快照更早，还在上一轮）。
 *
 * 这里锁住：**收尾事件对外可见的那一刻，状态已经是终态**；
 * 同时保证事件顺序不变（收尾事件仍是本批最后一条）。
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function chunk(content: string | null, reasoning: string | null = null): StreamChunk {
  return { content, reasoning, toolCalls: null, usage: null, finishReason: null };
}

const finish: StreamChunk = {
  content: null,
  reasoning: null,
  toolCalls: [],
  usage,
  finishReason: "stop",
};

/** 逐段回包的 provider：模拟真实节奏，让 running 有机会先落盘 */
class SlowProvider implements ProviderClient {
  constructor(private readonly gapMs = 60) {}
  async stream() {
    const gap = this.gapMs;
    return (async function* () {
      for (let i = 0; i < 3; i++) {
        await sleep(gap);
        yield chunk(`t${i}`);
      }
      yield finish;
    })();
  }
  async chat() {
    return null;
  }
}

/** 回包时抛错的 provider */
class FailingProvider implements ProviderClient {
  async stream() {
    return (async function* () {
      yield chunk("开始");
      throw Object.assign(new Error("上游 500"), { status: 500 });
    })();
  }
  async chat() {
    return null;
  }
}

/** 挂住不动、只响应 abort 的 provider（用于中断） */
class HangingProvider implements ProviderClient {
  started = false;
  async stream(_m: string, _msgs: unknown, _t: unknown, opts: { signal?: AbortSignal }) {
    const self = this;
    return (async function* () {
      self.started = true;
      yield chunk(null, "思考中…");
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 10_000);
      });
      throw new Error("Request was aborted.");
    })();
  }
  async chat() {
    return null;
  }
}

function makeManager(provider: ProviderClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-settle-"));
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
  return { root, store, tenant, manager };
}

interface Observed {
  /** 收尾事件到达时读到的状态 */
  statusAt: Map<string, string>;
  /** 事件类型顺序 */
  order: string[];
  /** 收尾事件到达时读到的磁盘状态 */
  diskAt: Map<string, string | undefined>;
}

/**
 * 用 eventHandler 精确卡在「事件对外可见」那一刻（与 SSE 下发同一时刻），
 * 此时去读状态，就是客户端 refreshState 会拿到的值。
 */
function observe(manager: SessionManager): Observed {
  const seen: Observed = { statusAt: new Map(), order: [], diskAt: new Map() };
  const terminal = new Set(["turn_end", "interrupted", "error"]);
  manager.eventHandler = (tid, sid, entry) => {
    seen.order.push(entry.type);
    if (!terminal.has(entry.type)) return;
    if (seen.statusAt.has(entry.type)) return;
    seen.statusAt.set(entry.type, manager.getSession(tid, sid)?.status ?? "null");
    seen.diskAt.set(entry.type, manager.store.loadSession(tid, sid)?.status);
  };
  return seen;
}

async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(15);
  }
}

describe("收尾事件与状态一致性", () => {
  it("turn_end 到达时状态已是 completed（界面不再卡在生成中）", async () => {
    const { tenant, manager } = makeManager(new SlowProvider());
    const seen = observe(manager);

    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => seen.statusAt.has("turn_end"));

    expect(seen.statusAt.get("turn_end")).toBe("completed");
    // 事件顺序不变：turn_end 仍是最后一条
    expect(seen.order[seen.order.length - 1]).toBe("turn_end");
  }, 60_000);

  it("interrupted 到达时状态已是 interrupted", async () => {
    const provider = new HangingProvider();
    const { tenant, manager } = makeManager(provider);
    const seen = observe(manager);

    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => provider.started);

    manager.interrupt(tenant, rec.sessionId);
    await waitFor(() => seen.statusAt.has("interrupted") || seen.statusAt.has("turn_end"));

    const at = seen.statusAt.get("interrupted") ?? seen.statusAt.get("turn_end");
    expect(at).toBe("interrupted");
  }, 60_000);

  it("error 到达时状态已是 error", async () => {
    const { tenant, manager } = makeManager(new FailingProvider());
    const seen = observe(manager);

    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => seen.statusAt.has("error"));

    expect(seen.statusAt.get("error")).toBe("error");
  }, 60_000);

  it("磁盘落盘后也是终态（异步写最终一致）", async () => {
    const { tenant, manager } = makeManager(new SlowProvider());
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");

    await waitFor(() => manager.getSession(tenant.id, rec.sessionId)?.status === "completed");
    // 落盘是异步的：给写链一点时间，之后磁盘也应为 completed
    await sleep(200);
    expect(manager.store.loadSession(tenant.id, rec.sessionId)?.status).toBe("completed");
  }, 60_000);
});
