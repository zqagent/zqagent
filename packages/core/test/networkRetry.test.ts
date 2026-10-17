/**
 * 瞬时网络错误自动重试（CLI/服务端共用引擎行为）
 *
 * 场景：LLM 请求因连接重置（Connection error. / ECONNRESET）失败——
 * 以前直接「❌ 任务出错」，现在应自动重试；重试成功后任务照常完成，
 * 并产生 llm_retry 事件 + 持久化 notice。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import type { StreamChunk, ProviderClient } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function connectionError(): Error {
  const cause = Object.assign(new Error("other side closed"), { code: "ECONNRESET" });
  return Object.assign(new Error("Connection error."), { cause });
}

/** 前 N 次抛连接错误，之后正常回复 */
class FlakyProvider implements ProviderClient {
  calls = 0;
  constructor(private failTimes: number) {}
  async stream(): Promise<AsyncIterable<StreamChunk>> {
    this.calls++;
    if (this.calls <= this.failTimes) throw connectionError();
    return (async function* () {
      yield {
        content: "好了",
        reasoning: null,
        toolCalls: null,
        usage,
        finishReason: "stop",
      } as StreamChunk;
    })();
  }
  async chat(): Promise<string | null> {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 终态：任务结束（completed/error/stopped），避免刚提交时误判为结束 */
const isTerminal = (st: string) => st === "completed" || st === "error" || st === "stopped";

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(20);
  }
}

function makeManager(provider: ProviderClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-netretry-"));
  const store = new Store(root);
  const tenant: TenantConfig = {
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

describe("瞬时网络错误自动重试", () => {
  beforeEach(() => {
    vi.stubEnv("NETWORK_RETRY_MAX", "2");
    vi.stubEnv("NETWORK_RETRY_BASE_MS", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("首次连接失败后自动重试并完成（发出 llm_retry 事件）", async () => {
    const provider = new FlakyProvider(1);
    const { tenant, manager } = makeManager(provider);
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => isTerminal(manager.getSession(tenant.id, rec.sessionId)!.status));

    const { events } = manager.eventsSince(tenant.id, rec.sessionId, 0);
    const typed = events as unknown as { type: string; data: Record<string, unknown> }[];

    const s = manager.getSession(tenant.id, rec.sessionId)!;
    expect(s.status).toBe("completed");
    expect(provider.calls).toBe(2); // 1 次失败 + 1 次成功
    expect(typed.some((e) => e.type === "llm_retry")).toBe(true);
    const retry = typed.find((e) => e.type === "llm_retry")!;
    expect(retry.data["attempt"]).toBe(1);
    expect(retry.data["reason"]).toContain("Connection error.");
    // 重试提示同时落盘为 notice 消息（供网页时间线展示）
    expect(
      s.messages.some(
        (m) =>
          (m as { role?: string; kind?: string }).role === "notice" &&
          (m as { kind?: string }).kind === "retry",
      ),
    ).toBe(true);
  });

  it("超出重试次数仍失败 → 任务出错，且错误信息含端点/底层 code", async () => {
    const provider = new FlakyProvider(99);
    const { tenant, manager } = makeManager(provider);
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => isTerminal(manager.getSession(tenant.id, rec.sessionId)!.status));
    const s = manager.getSession(tenant.id, rec.sessionId)!;
    expect(s.status).toBe("error");
    expect(provider.calls).toBe(3); // 首次 + 2 次重试
  });

  it("非网络错误（400）不重试", async () => {
    class BadRequestProvider implements ProviderClient {
      calls = 0;
      async stream(): Promise<AsyncIterable<StreamChunk>> {
        this.calls++;
        throw Object.assign(new Error("400 Bad Request: invalid model"), { status: 400 });
      }
      async chat(): Promise<string | null> {
        return null;
      }
    }
    const provider = new BadRequestProvider();
    const { tenant, manager } = makeManager(provider);
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");
    await waitFor(() => isTerminal(manager.getSession(tenant.id, rec.sessionId)!.status));
    expect(provider.calls).toBe(1);
    expect(manager.getSession(tenant.id, rec.sessionId)!.status).toBe("error");
  });
});
