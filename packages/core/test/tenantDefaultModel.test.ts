/**
 * 新装节点的默认模型
 *
 * 历史 bug：演示租户把默认值硬编码成 `deepseek-v4-flash`，而志前 API 只认
 * `deepseek-flash`。新装节点第一次发请求就带上一个不存在的型号，直接报错。
 *
 * 这里锁住三件事：
 *   1. 默认值不再硬编码任何厂商的具体型号（兜底是空串 = 「未选择」）；
 *   2. 环境变量 → 节点默认 LLM → 兜底的优先级；
 *   3. 内置模型异步下发后，仍停在兜底型号的租户被对齐过去，但用户自己选过的型号不动。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import { BUILTIN_PROVIDER_ID, FALLBACK_MODEL, defaultTenantModel } from "../src/server/nodeLlm.js";
import { dropLegacyDefaultModels, ensureBuiltinProvider } from "../src/server/builtinLlm.js";
import type { LlmProviderEntry, TenantConfig } from "../src/server/types.js";

const BUILTIN: LlmProviderEntry = {
  id: BUILTIN_PROVIDER_ID,
  name: "志前大模型（内置）",
  type: "builtin",
  baseURL: "https://zqai-api.cd-zq.com/v1",
  model: "deepseek-flash",
  apiKey: "sk-zq",
};

function tenant(id: string, model: string): TenantConfig {
  return { id, apiKey: `key-${id}`, model, provider: {} };
}

describe("defaultTenantModel：默认型号的优先级", () => {
  let dir: string;
  let store: Store;
  const savedEnv = { MODEL: process.env.MODEL, OPENAI_MODEL: process.env.OPENAI_MODEL };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-default-model-"));
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
    delete process.env.MODEL;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // 还原宿主环境，避免影响同进程里的其它用例
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("什么都没配时是空串（未选择），不假装有模型", () => {
    expect(defaultTenantModel(store)).toBe(FALLBACK_MODEL);
    expect(defaultTenantModel(store)).toBe("");
    // 回归断言：这个值曾经是 deepseek-v4-flash，导致志前 API 报错
    expect(defaultTenantModel(store)).not.toBe("deepseek-v4-flash");
    // 之后又改成了 gpt-4o：控制台的模型下拉里会多出一个用户没配过的模型
    expect(defaultTenantModel(store)).not.toBe("gpt-4o");
  });

  it("节点默认 LLM 有型号时，跟随它（新装节点接入后开箱即用）", () => {
    store.saveNodeLlm({ providers: [BUILTIN], defaultProviderId: BUILTIN_PROVIDER_ID });
    expect(defaultTenantModel(store)).toBe("deepseek-flash");
  });

  it("显式 OPENAI_MODEL 优先于节点默认 LLM（自建用户不应被覆盖）", () => {
    store.saveNodeLlm({ providers: [BUILTIN], defaultProviderId: BUILTIN_PROVIDER_ID });
    process.env.OPENAI_MODEL = "my-own-model";
    expect(defaultTenantModel(store)).toBe("my-own-model");
  });

  it("只设了 MODEL 也能生效", () => {
    process.env.MODEL = "legacy-model";
    expect(defaultTenantModel(store)).toBe("legacy-model");
  });
});

describe("dropLegacyDefaultModels：清掉旧版写入的假默认模型", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-drop-legacy-"));
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("停在 gpt-4o / deepseek-v4-flash 的租户被清空为「未选择」", () => {
    store.saveTenant(tenant("a", "gpt-4o"));
    store.saveTenant(tenant("b", "deepseek-v4-flash"));

    dropLegacyDefaultModels(store);

    expect(store.loadTenant("a")!.model).toBe("");
    expect(store.loadTenant("b")!.model).toBe("");
  });

  it("用户自己选过的型号不动", () => {
    store.saveTenant(tenant("mine", "deepseek-reasoner"));

    dropLegacyDefaultModels(store);

    expect(store.loadTenant("mine")!.model).toBe("deepseek-reasoner");
  });

  it("租户自带 Key 时不动（那个型号可能是对方真实支持的）", () => {
    const own: TenantConfig = {
      id: "byok",
      apiKey: "key-byok",
      model: "gpt-4o",
      provider: { apiKey: "sk-mine", baseURL: "https://api.openai.com/v1" },
    };
    store.saveTenant(own);

    dropLegacyDefaultModels(store);

    expect(store.loadTenant("byok")!.model).toBe("gpt-4o");
  });
});

describe("内置模型下发后对齐租户型号", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-adopt-model-"));
    store = new Store(dir, { llmConfigFile: path.join(dir, "connections.json") });
    store.saveFleetCredential({
      hubUrl: "https://hub.example.com",
      fleetToken: "ft",
      fleetSecret: "fs",
      nodeId: "n1",
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** 控制面下发的内置模型：型号是志前 API 真实支持的 deepseek-flash */
  function mockGrant(): void {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            builtinLlm: {
              providerId: BUILTIN_PROVIDER_ID,
              name: "志前大模型（内置）",
              baseURL: "https://zqai-api.cd-zq.com/v1",
              apiKey: "sk-zq",
              model: "deepseek-flash",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it("仍停在兜底型号的租户被对齐到内置型号", async () => {
    store.saveTenant(tenant("demo", FALLBACK_MODEL));
    mockGrant();

    await ensureBuiltinProvider(store, { force: true });

    expect(store.loadTenant("demo")!.model).toBe("deepseek-flash");
  });

  it("用户自己选过型号的租户不被覆盖", async () => {
    store.saveTenant(tenant("mine", "gpt-4o-mini"));
    mockGrant();

    await ensureBuiltinProvider(store, { force: true });

    expect(store.loadTenant("mine")!.model).toBe("gpt-4o-mini");
  });

  it("多个租户时只改仍用兜底值的那个", async () => {
    store.saveTenant(tenant("fresh", FALLBACK_MODEL));
    store.saveTenant(tenant("tuned", "deepseek-reasoner"));
    mockGrant();

    await ensureBuiltinProvider(store, { force: true });

    expect(store.loadTenant("fresh")!.model).toBe("deepseek-flash");
    expect(store.loadTenant("tuned")!.model).toBe("deepseek-reasoner");
  });

  it("老节点：内置项已在本地时也迁移历史错误默认值（不重新拉取）", async () => {
    // 模拟升级上来的节点：内置项早就落盘，租户型号还是旧版的 deepseek-v4-flash
    store.saveNodeLlm({ providers: [BUILTIN], defaultProviderId: BUILTIN_PROVIDER_ID });
    store.saveTenant(tenant("demo", "deepseek-v4-flash"));
    const spy = vi.spyOn(globalThis, "fetch");

    const r = await ensureBuiltinProvider(store);

    expect(r.status).toBe("ready");
    expect(spy).not.toHaveBeenCalled(); // 本地已有，不该发网络请求
    expect(store.loadTenant("demo")!.model).toBe("deepseek-flash");
  });

  it("租户自带 Key 时不动它的型号（可能连的是第三方供应商）", async () => {
    store.saveNodeLlm({ providers: [BUILTIN], defaultProviderId: BUILTIN_PROVIDER_ID });
    const own: TenantConfig = {
      id: "byok",
      apiKey: "key-byok",
      model: "deepseek-v4-flash",
      // 用户自己配了 Key/端点：这个型号可能是对方真实支持的
      provider: { apiKey: "sk-third-party", baseURL: "https://api.example.com" },
    };
    store.saveTenant(own);

    await ensureBuiltinProvider(store);

    expect(store.loadTenant("byok")!.model).toBe("deepseek-v4-flash");
    expect(store.loadTenant("byok")!.provider.apiKey).toBe("sk-third-party");
  });
});
