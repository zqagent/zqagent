/**
 * 平台内置模型（志前 API）：节点侧的装配与防删除语义
 *
 * 产品约束（已与需求方确认）：
 *   - 接入 Hub 后自动获得，用户不用关心 Key，也不能删除；
 *   - 未接入 Hub 不强求，用户自配其它模型同样可用；
 *   - 内置项允许换型号（model），但 baseURL/key 由平台托管。
 *
 * 这里锁住四件事：
 *   1. 合并语义：提交里删掉内置项 / 篡改 baseURL 与 key 均不生效，model 可改；
 *   2. 落盘兜底：任何一次保存都不会把内置项弄丢；
 *   3. 视图：内置项带 builtin 标记与 locked 字段，Key 只回 hasApiKey；
 *   4. 拉取：未接入 Hub 时静默跳过；接入后能落盘；401 触发的自愈有节流。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import {
  applyNodeLlmPatch,
  nodeLlmView,
  BUILTIN_PROVIDER_ID,
  type NodeLlmConfig,
} from "../src/server/nodeLlm.js";
import { ensureBuiltinProvider, healBuiltinOnAuthFailure } from "../src/server/builtinLlm.js";
import type { LlmProviderEntry } from "../src/server/types.js";

const BUILTIN: LlmProviderEntry = {
  id: BUILTIN_PROVIDER_ID,
  name: "志前大模型（内置）",
  type: "builtin",
  baseURL: "https://zqai-api.cd-zq.com/v1",
  model: "deepseek-flash",
  apiKey: "sk-zq-original",
};

const CUSTOM: LlmProviderEntry = {
  id: "p_mine",
  name: "我的 DeepSeek",
  type: "deepseek",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "sk-mine",
};

function cfg(providers: LlmProviderEntry[], defaultProviderId?: string): NodeLlmConfig {
  return { providers, defaultProviderId };
}

describe("applyNodeLlmPatch：内置项不可删除、不可改托管字段", () => {
  it("提交里完全没有内置项时，按旧值保留", () => {
    const next = applyNodeLlmPatch(cfg([BUILTIN, CUSTOM]), {
      providers: [{ id: "p_mine", name: "改名了", baseURL: CUSTOM.baseURL, model: "x" }],
    });
    const builtin = next.providers.find((p) => p.id === BUILTIN_PROVIDER_ID);
    expect(builtin).toBeTruthy();
    expect(builtin!.apiKey).toBe("sk-zq-original");
    expect(builtin!.baseURL).toBe(BUILTIN.baseURL);
  });

  it("内置项固定在列表首位（避免老前端按索引操作时错位）", () => {
    const next = applyNodeLlmPatch(cfg([CUSTOM, BUILTIN]), {
      providers: [{ id: "p_mine", name: CUSTOM.name, baseURL: CUSTOM.baseURL, model: "m" }],
    });
    expect(next.providers[0].id).toBe(BUILTIN_PROVIDER_ID);
  });

  it("篡改 baseURL / apiKey 不生效", () => {
    const next = applyNodeLlmPatch(cfg([BUILTIN]), {
      providers: [
        {
          id: BUILTIN_PROVIDER_ID,
          name: "志前大模型（内置）",
          baseURL: "https://evil.example.com/v1",
          model: "deepseek-flash",
          apiKey: "sk-attacker",
        },
      ],
    });
    const builtin = next.providers.find((p) => p.id === BUILTIN_PROVIDER_ID)!;
    expect(builtin.baseURL).toBe(BUILTIN.baseURL);
    expect(builtin.apiKey).toBe("sk-zq-original");
  });

  it("允许换型号与推理强度", () => {
    const next = applyNodeLlmPatch(cfg([BUILTIN]), {
      providers: [
        {
          id: BUILTIN_PROVIDER_ID,
          name: "志前大模型（内置）",
          baseURL: BUILTIN.baseURL,
          model: "deepseek-pro",
          reasoningEffort: "high",
        },
      ],
    });
    const builtin = next.providers.find((p) => p.id === BUILTIN_PROVIDER_ID)!;
    expect(builtin.model).toBe("deepseek-pro");
    expect(builtin.reasoningEffort).toBe("high");
    expect(builtin.baseURL).toBe(BUILTIN.baseURL);
  });

  it("普通供应商仍可正常删除", () => {
    const next = applyNodeLlmPatch(cfg([BUILTIN, CUSTOM]), { providers: [] });
    expect(next.providers.map((p) => p.id)).toEqual([BUILTIN_PROVIDER_ID]);
  });

  it("没有内置项时不会凭空造一个", () => {
    const next = applyNodeLlmPatch(cfg([CUSTOM]), { providers: [] });
    expect(next.providers).toEqual([]);
  });
});

describe("nodeLlmView：内置项标记与不可见 Key", () => {
  it("输出 builtin / locked，且不泄露 apiKey", () => {
    const view = nodeLlmView(cfg([BUILTIN, CUSTOM], BUILTIN_PROVIDER_ID));
    const builtin = view.providers.find((p) => p.id === BUILTIN_PROVIDER_ID) as Record<string, unknown>;
    expect(builtin["builtin"]).toBe(true);
    expect(builtin["locked"]).toEqual(["baseURL", "apiKey"]);
    expect(builtin["hasApiKey"]).toBe(true);
    expect(builtin["apiKey"]).toBeUndefined();
    // 普通供应商不带 builtin 标记
    const custom = view.providers.find((p) => p.id === "p_mine") as Record<string, unknown>;
    expect(custom["builtin"]).toBe(false);
    expect(custom["locked"]).toBeUndefined();
  });
});

describe("store.saveNodeLlm：缺失时自动补回", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-builtin-"));
    // LLM 配置默认落在 ~/.config/zqagent/connections.json（与 CLI 共用），
    // 测试必须注入隔离路径，否则会覆盖开发者本机配置
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("调用方漏传内置项时，按已落盘的旧值补回", () => {
    store.saveNodeLlm({ providers: [BUILTIN, CUSTOM] });
    // 模拟「CLI 删除 / 老前端整表提交」把内置项漏掉
    store.saveNodeLlm({ providers: [CUSTOM] });
    const after = store.loadNodeLlm();
    const builtin = after.providers.find((p) => p.id === BUILTIN_PROVIDER_ID);
    expect(builtin).toBeTruthy();
    expect(builtin!.apiKey).toBe("sk-zq-original");
    expect(builtin!.baseURL).toBe(BUILTIN.baseURL);
  });

  it("Key 加密落盘，读回是明文（供内部使用）", () => {
    store.saveNodeLlm({ providers: [BUILTIN] });
    const raw = fs.readFileSync(path.join(dir, "connections.json"), "utf-8");
    expect(raw).not.toContain("sk-zq-original");
    expect(store.loadNodeLlm().providers[0].apiKey).toBe("sk-zq-original");
  });
});

describe("ensureBuiltinProvider：未接入 Hub 时静默跳过", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-builtin2-"));
    // LLM 配置默认落在 ~/.config/zqagent/connections.json（与 CLI 共用），
    // 测试必须注入隔离路径，否则会覆盖开发者本机配置
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("无 fleet 凭据时返回 disabled，不报错", async () => {
    const r = await ensureBuiltinProvider(store);
    expect(r.status).toBe("disabled");
  });

  it("已有本地内置项时直接返回 ready 且不发起网络请求", async () => {
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    store.saveNodeLlm({ providers: [BUILTIN] });
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await ensureBuiltinProvider(store);
    expect(r.status).toBe("ready");
    expect(spy).not.toHaveBeenCalled();
  });

  it("force 时会重新拉取，并按控制面返回落盘", async () => {
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            builtinLlm: {
              providerId: BUILTIN_PROVIDER_ID,
              name: "志前大模型（内置）",
              baseURL: "https://zqai-api.cd-zq.com/v1",
              apiKey: "sk-zq-new",
              model: "deepseek-flash",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await ensureBuiltinProvider(store, { force: true });
    expect(r.status).toBe("ready");
    expect(store.loadNodeLlm().providers.find((p) => p.id === BUILTIN_PROVIDER_ID)!.apiKey).toBe(
      "sk-zq-new",
    );
  });

  it("控制面返回 null 时为 unavailable（未开户），不是 error", async () => {
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { builtinLlm: null, reason: "账号尚未开通大模型 API" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await ensureBuiltinProvider(store, { force: true });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toContain("尚未开通");
  });
});

describe("healBuiltinOnAuthFailure：只在凭据类错误时动作", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-builtin3-"));
    // LLM 配置默认落在 ~/.config/zqagent/connections.json（与 CLI 共用），
    // 测试必须注入隔离路径，否则会覆盖开发者本机配置
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("额度不足等非凭据错误不触发重拉", () => {
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    store.saveNodeLlm({ providers: [BUILTIN] });
    const spy = vi.spyOn(globalThis, "fetch");
    healBuiltinOnAuthFailure(store, "402 insufficient_balance");
    expect(spy).not.toHaveBeenCalled();
  });

  it("401 且存在内置项时触发一次拉取", async () => {
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    store.saveNodeLlm({ providers: [BUILTIN] });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: { builtinLlm: null } }), { status: 200 }));
    healBuiltinOnAuthFailure(store, "401 invalid_api_key: API key 无效");
    // 异步触发，等一个宏任务
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
  });
});

describe("HTTP 路由：/api/v1/node/llm 与 builtin-refresh", () => {
  it("内置项出现在视图里，刷新在未接入 Hub 时返回 ok:false 而不是 500", async () => {
    const { createApp } = await import("../src/server/routes.js");
    const { SessionManager } = await import("../src/server/session.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zq-builtin-http-"));
    const store = new Store(root, { llmConfigFile: path.join(root, "connections.json") });
    store.saveTenant({ id: "p1", apiKey: "key1", model: "m" } as never);
    store.saveNodeLlm({ providers: [BUILTIN, CUSTOM] });
    const manager = new SessionManager(store, 60_000);
    // /node/llm 是 adminOnly：用管理员密钥访问
    const server = createApp(store, manager, { adminKey: "adminkey" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: "Bearer adminkey" };

    try {
      const res = await fetch(`${base}/api/v1/node/llm`, { headers: auth });
      expect(res.status).toBe(200);
      const view = (await res.json()).data;
      const builtin = view.providers.find((p: { id: string }) => p.id === BUILTIN_PROVIDER_ID);
      expect(builtin).toMatchObject({ builtin: true, locked: ["baseURL", "apiKey"] });
      expect(builtin.apiKey).toBeUndefined();

      // 未接入 Hub：刷新应给出可读原因，而不是抛错
      const refresh = await fetch(`${base}/api/v1/node/llm/builtin-refresh`, {
        method: "POST",
        headers: auth,
      });
      expect(refresh.status).toBe(200);
      const body = (await refresh.json()).data;
      expect(body.ok).toBe(false);
      expect(body.reason).toContain("未接入 Hub");
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("authErrorHints：凭据类提示与模型类提示分开", () => {
  it("401 给出「刷新内置模型」指引，但不产生模型类建议", async () => {
    const { authErrorHints, paramErrorHints } = await import("../src/providers/diagnostics.js");
    const msg = "401 Incorrect API key provided";
    const auth = authErrorHints(msg, "authentication_error");
    expect(auth.some((h) => h.includes("刷新内置模型"))).toBe(true);
    // 既有契约：鉴权失败不应给「换模型」这类建议
    expect(paramErrorHints(msg, "authentication_error")).toEqual([]);
  });

  it("额度类错误给出充值入口与切换模型的出路", async () => {
    const { paramErrorHints } = await import("../src/providers/diagnostics.js");
    const hints = paramErrorHints("402 insufficient_balance", "insufficient_balance");
    expect(hints.some((h) => h.includes("hub.cd-zq.com"))).toBe(true);
    expect(hints.some((h) => h.includes("其它模型"))).toBe(true);
  });

  it("「余额不足」即使不含英文错误码也给出充值入口", async () => {
    const { paramErrorHints } = await import("../src/providers/diagnostics.js");
    const hints = paramErrorHints("402 余额不足：可用 0.09 元，本次需要约 0.11 元");
    expect(hints.some((h) => h.includes("hub.cd-zq.com"))).toBe(true);
  });

  it("无关错误不产生凭据提示", async () => {
    const { authErrorHints } = await import("../src/providers/diagnostics.js");
    expect(authErrorHints("ECONNRESET socket hang up")).toEqual([]);
  });
});

describe("余额查询：fetchLlmBalance", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-balance-"));
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("未接入 Hub 时返回 available=null + 原因，不抛错", async () => {
    const { fetchLlmBalance } = await import("../src/server/builtinLlm.js");
    const r = await fetchLlmBalance(store);
    expect(r.available).toBeNull();
    expect(r.reason).toContain("未接入 Hub");
  });

  it("正常返回余额与充值深链", async () => {
    const { fetchLlmBalance } = await import("../src/server/builtinLlm.js");
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            available: 0.098332,
            currency: "CNY",
            reserved: 0.01,
            topupUrl: "https://hub.example.com/topup",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await fetchLlmBalance(store);
    expect(r.available).toBeCloseTo(0.098332, 6);
    expect(r.currency).toBe("CNY");
    expect(r.reserved).toBeCloseTo(0.01, 6);
    expect(r.topupUrl).toBe("https://hub.example.com/topup");
  });

  it("Hub 未给 topupUrl 时按 hubUrl 兜底拼接", async () => {
    const { fetchLlmBalance } = await import("../src/server/builtinLlm.js");
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { available: 1, currency: "CNY" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await fetchLlmBalance(store);
    expect(r.topupUrl).toBe("https://hub.example.com/topup");
  });

  it("未开户时透传原因（available=null）", async () => {
    const { fetchLlmBalance } = await import("../src/server/builtinLlm.js");
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { available: null, reason: "账号尚未开通大模型 API" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await fetchLlmBalance(store);
    expect(r.available).toBeNull();
    expect(r.reason).toContain("尚未开通");
  });
});
