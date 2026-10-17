/**
 * MQTT 节点管理协议 v2 + 指令分发单测
 *
 * 覆盖：按节点 topic 构建、签名/验签/防篡改、信封解析；
 * 以及 dispatchFleetCommand 的项目/会话/运行指令（不依赖 broker）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import {
  fleetCmdTopic,
  fleetNotifyTopic,
  fleetEventsTopic,
  fleetAckTopic,
  fleetStatusTopic,
  fleetInfoTopic,
  signFleetCmd,
  verifyFleetSig,
  parseFleetEnvelope,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";
import { dispatchFleetCommand } from "../src/server/fleet/FleetCommands.js";
import type { StreamChunk, ProviderClient } from "../src/index.js";
import type { TenantConfig } from "../src/server/types.js";

const SECRET = "fleet-secret-abc";

function textChunk(content: string): StreamChunk {
  return { content, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
}
const provider: ProviderClient = {
  async stream() {
    return (async function* () {
      yield textChunk("done");
    })();
  },
  async chat() {
    return "标题";
  },
};

function makeEnv(
  type: FleetCmdType,
  opts: {
    projectId?: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
  } = {},
): FleetCmdEnvelope {
  const base = {
    t: Date.now(),
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    reqId: `r-${Math.random().toString(36).slice(2)}`,
    type,
    clientId: "console-1",
    nodeId: "node-1",
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    payload: opts.payload ?? {},
  };
  return { ...base, sig: signFleetCmd(SECRET, base) };
}

function makeDeps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-fleet-"));
  const store = new Store(root);
  const tenant: TenantConfig = {
    id: "p1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
  };
  store.saveTenant(tenant);
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
  setupServerHandlers(manager);
  return { store, manager, tenant };
}

describe("节点管理协议 v2：topic", () => {
  it("按节点命名空间构建", () => {
    expect(fleetCmdTopic("ft", "n1")).toBe("zqagent/fleet/ft/node/n1/cmd");
    expect(fleetNotifyTopic("ft", "n1")).toBe("zqagent/fleet/ft/node/n1/notify");
    expect(fleetEventsTopic("ft", "n1")).toBe("zqagent/fleet/ft/node/n1/events");
    expect(fleetStatusTopic("ft", "n1")).toBe("zqagent/fleet/ft/node/n1/status");
    expect(fleetInfoTopic("ft", "n1")).toBe("zqagent/fleet/ft/node/n1/info");
    expect(fleetAckTopic("ft", "n1", "c1")).toBe("zqagent/fleet/ft/node/n1/ack/c1");
  });
});

describe("节点管理协议 v2：签名与解析", () => {
  it("合法信封验签通过；篡改失败", () => {
    const env = makeEnv("ping");
    expect(verifyFleetSig(SECRET, env)).toBe(true);
    expect(verifyFleetSig(SECRET, { ...env, payload: { x: 1 } })).toBe(false);
    expect(verifyFleetSig(SECRET, { ...env, nodeId: "node-2" })).toBe(false);
    expect(verifyFleetSig("wrong", env)).toBe(false);
  });

  it("parseFleetEnvelope 结构与类型校验", () => {
    const env = makeEnv("list_projects");
    expect(parseFleetEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
    expect(parseFleetEnvelope(null)).toBeNull();
    expect(parseFleetEnvelope({ ...env, type: "nope" })).toBeNull();
    expect(parseFleetEnvelope({ ...env, reqId: undefined })).toBeNull();
  });
});

describe("节点管理指令分发", () => {
  it("ping / get_node_info / list_projects", async () => {
    const deps = makeDeps();
    const ping = await dispatchFleetCommand(deps, makeEnv("ping"));
    expect(ping.ok).toBe(true);

    const info = await dispatchFleetCommand(deps, makeEnv("get_node_info"));
    expect(info.ok).toBe(true);
    expect((info.data as { nodeId: string }).nodeId).toBeTruthy();

    const list = await dispatchFleetCommand(deps, makeEnv("list_projects"));
    expect((list.data as Array<{ id: string }>).map((p) => p.id)).toContain("p1");
  });

  it("create_project 回传一次性 apiKey", async () => {
    const deps = makeDeps();
    const ack = await dispatchFleetCommand(
      deps,
      makeEnv("create_project", { payload: { name: "新项目" } }),
    );
    expect(ack.ok).toBe(true);
    const data = ack.data as { id: string; apiKey: string };
    expect(data.apiKey).toMatch(/^zk_/);
    expect(deps.store.loadTenant(data.id)).not.toBeNull();
  });

  it("create_session / list_sessions / submit_turn / get_state", async () => {
    const deps = makeDeps();
    const created = await dispatchFleetCommand(
      deps,
      makeEnv("create_session", { projectId: "p1" }),
    );
    expect(created.ok).toBe(true);
    const sid = (created.data as { sessionId: string }).sessionId;

    const listed = await dispatchFleetCommand(
      deps,
      makeEnv("list_sessions", { projectId: "p1" }),
    );
    expect((listed.data as unknown[]).length).toBe(1);

    const submitted = await dispatchFleetCommand(
      deps,
      makeEnv("submit_turn", { projectId: "p1", sessionId: sid, payload: { input: "你好" } }),
    );
    expect(submitted.ok).toBe(true);

    const state = await dispatchFleetCommand(
      deps,
      makeEnv("get_state", { projectId: "p1", sessionId: sid }),
    );
    expect(state.ok).toBe(true);
    expect((state.data as { sessionId: string }).sessionId).toBe(sid);
    expect((state.data as { draft: string }).draft).toBe("");
  });

  it("set_session_draft 后 get_state 回传草稿（控制台刷新回填）", async () => {
    const deps = makeDeps();
    const created = await dispatchFleetCommand(
      deps,
      makeEnv("create_session", { projectId: "p1" }),
    );
    const sid = (created.data as { sessionId: string }).sessionId;

    const saved = await dispatchFleetCommand(
      deps,
      makeEnv("set_session_draft", {
        projectId: "p1",
        sessionId: sid,
        payload: { draft: "未发送的内容" },
      }),
    );
    expect(saved.ok).toBe(true);

    const state = await dispatchFleetCommand(
      deps,
      makeEnv("get_state", { projectId: "p1", sessionId: sid }),
    );
    expect((state.data as { draft: string }).draft).toBe("未发送的内容");
  });

  it("错误路径：缺 projectId / 未知项目 / 非法 decision", async () => {
    const deps = makeDeps();
    const noProject = await dispatchFleetCommand(deps, makeEnv("list_sessions"));
    expect(noProject.ok).toBe(false);

    const badProject = await dispatchFleetCommand(
      deps,
      makeEnv("list_sessions", { projectId: "nope" }),
    );
    expect(badProject.ok).toBe(false);

    const badDecision = await dispatchFleetCommand(
      deps,
      makeEnv("approval_answer", {
        projectId: "p1",
        sessionId: "s1",
        payload: { approvalId: "a1", decision: "bad" },
      }),
    );
    expect(badDecision.ok).toBe(false);
    expect(badDecision.reqId).toBeTruthy();
  });

  it("回执回带相同 reqId", async () => {
    const deps = makeDeps();
    const env = makeEnv("ping");
    const ack = await dispatchFleetCommand(deps, env);
    expect(ack.reqId).toBe(env.reqId);
    expect(ack.type).toBe("ping");
  });
});
