/**
 * 会话级 LLM（控制台输入区「先选配置、再选模型」）
 *
 * 覆盖：
 *   1. resolveSessionProvider 优先级：会话级 > 项目配置 > 节点默认
 *   2. updateSessionLlm：切到节点配置 / 切回项目 / 校验未知 id / 同步模型
 *   3. 舰队指令 set_session_llm（含白名单）
 *   4. 会话状态视图回传 providerId（控制台据此回显）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { resolveSessionProvider, GLOBAL_PROVIDER_ID } from "../src/server/nodeLlm.js";
import { dispatchFleetCommand } from "../src/server/fleet/FleetCommands.js";
import { FLEET_CMD_TYPES } from "@zqagent/shared";
import type { FleetCmdEnvelope } from "@zqagent/shared/fleet";
import type { TenantConfig } from "../src/server/types.js";

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-sllm-"));
  const store = new Store(root);
  return { root, store };
}

function tenant(over: Partial<TenantConfig> = {}): TenantConfig {
  return { id: "t1", apiKey: "k", model: "proj-model", ...over } as TenantConfig;
}

describe("会话级 LLM 解析", () => {
  it("优先级：会话级 > 项目配置 > 节点默认", () => {
    const { store } = tmpStore();
    store.saveNodeLlm({
      providers: [
        { id: "p1", name: "供应商1", baseURL: "https://a/v1", model: "m1", apiKey: "k1" },
        { id: "p2", name: "供应商2", baseURL: "https://b/v1", model: "m2", apiKey: "k2" },
      ],
      defaultProviderId: "p2",
    });
    const t = tenant({ provider: { apiKey: "pk", baseURL: "https://proj/v1" } });

    // 会话级指定 p1 → 覆盖项目配置
    expect(resolveSessionProvider(store, t, "p1")).toMatchObject({
      apiKey: "k1",
      baseURL: "https://a/v1",
      model: "m1",
      providerId: "p1",
    });
    // 未指定 → 项目配置
    expect(resolveSessionProvider(store, t)).toMatchObject({ apiKey: "pk", model: "proj-model" });
    // 项目无 Key → 节点默认 p2
    const noKey = tenant({ provider: { baseURL: "https://proj/v1" } });
    expect(resolveSessionProvider(store, noKey)).toMatchObject({
      apiKey: "k2",
      baseURL: "https://proj/v1",
      model: "m2",
    });
    // 未知/失效的会话级 id → 回退
    expect(resolveSessionProvider(store, t, "gone").apiKey).toBe("pk");
  });

  it("环境变量全局项（__env__）可被会话选中", () => {
    const { store } = tmpStore();
    const prevKey = process.env.OPENAI_API_KEY;
    const prevUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_BASE_URL = "https://env/v1";
    try {
      const r = resolveSessionProvider(store, tenant({ provider: {} }), GLOBAL_PROVIDER_ID);
      expect(r.apiKey).toBe("env-key");
      expect(r.baseURL).toBe("https://env/v1");
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevUrl;
    }
  });
});

describe("updateSessionLlm", () => {
  it("切换配置并沿用其模型；可切回项目配置", () => {
    const { store } = tmpStore();
    store.saveNodeLlm({
      providers: [{ id: "p1", name: "供应商1", baseURL: "https://a/v1", model: "m1", apiKey: "k1" }],
      defaultProviderId: "p1",
    });
    const t = tenant();
    store.saveTenant(t);
    const manager = new SessionManager(store, 60000, {});
    const rec = manager.createSession(t, {});

    const switched = manager.updateSessionLlm(t, rec.sessionId, { providerId: "p1" });
    expect(switched.providerId).toBe("p1");
    expect(switched.model).toBe("m1");
    expect(switched.modelOverridden).toBe(true);

    const withModel = manager.updateSessionLlm(t, rec.sessionId, {
      providerId: "p1",
      model: "m1-turbo",
    });
    expect(withModel.model).toBe("m1-turbo");

    const back = manager.updateSessionLlm(t, rec.sessionId, { providerId: "project" });
    expect(back.providerId).toBeUndefined();

    // 重建管理器（模拟重启）：providerId 从磁盘恢复
    const manager2 = new SessionManager(store, 60000, {});
    manager2.updateSessionLlm(t, rec.sessionId, { providerId: "p1", model: "m1" });
    expect(manager2.getSession(t.id, rec.sessionId)!.providerId).toBe("p1");
  });

  it("未知配置 id 报 400", () => {
    const { store } = tmpStore();
    const t = tenant();
    store.saveTenant(t);
    const manager = new SessionManager(store, 60000, {});
    const rec = manager.createSession(t, {});
    expect(() => manager.updateSessionLlm(t, rec.sessionId, { providerId: "nope" })).toThrowError(
      /未知的 LLM 配置/,
    );
  });

  it("舰队指令 set_session_llm 生效并回传 providerId", async () => {
    const { store } = tmpStore();
    store.saveNodeLlm({
      providers: [{ id: "p1", name: "供应商1", baseURL: "https://a/v1", model: "m1", apiKey: "k1" }],
    });
    const t = tenant();
    store.saveTenant(t);
    const manager = new SessionManager(store, 60000, {});
    const rec = manager.createSession(t, {});

    const env = {
      t: Date.now(),
      nonce: "n1",
      reqId: "r1",
      type: "set_session_llm",
      clientId: "c1",
      nodeId: "node-1",
      projectId: t.id,
      sessionId: rec.sessionId,
      payload: { providerId: "p1" },
      sig: "x",
    } as unknown as FleetCmdEnvelope;

    const ack = await dispatchFleetCommand({ store, manager }, env);
    expect(ack.ok).toBe(true);
    expect(manager.getSession(t.id, rec.sessionId)!.providerId).toBe("p1");
    expect(FLEET_CMD_TYPES).toContain("set_session_llm");
  });
});
