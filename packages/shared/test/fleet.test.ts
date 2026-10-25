/** 节点管理协议：topic 构造、命令信封签名/验签与结构校验。 */
import { describe, it, expect } from "vitest";
import {
  FLEET_CMD_TYPES,
  FLEET_TOPIC_PREFIX,
  fleetAckTopic,
  fleetCmdTopic,
  fleetEventsTopic,
  fleetInfoTopic,
  fleetNotifyTopic,
  fleetStatusTopic,
  parseFleetEnvelope,
  signFleetCmd,
  verifyFleetSig,
  type FleetCmdEnvelope,
} from "../src/fleet.js";

const base = {
  t: 1_700_000_000_000,
  nonce: "n-1",
  reqId: "req-1",
  type: "create_session" as const,
  clientId: "cli-1",
  nodeId: "node-1",
  payload: { text: "hi" },
};

function signed(secret = "s3cret", over: Partial<FleetCmdEnvelope> = {}): FleetCmdEnvelope {
  const env = { ...base, ...over };
  return { ...env, sig: signFleetCmd(secret, env) };
}

describe("fleet topics", () => {
  it("按 fleetToken/nodeId 拼接各主题", () => {
    expect(fleetCmdTopic("ft", "n1")).toBe(`${FLEET_TOPIC_PREFIX}/ft/node/n1/cmd`);
    expect(fleetNotifyTopic("ft", "n1")).toBe(`${FLEET_TOPIC_PREFIX}/ft/node/n1/notify`);
    expect(fleetEventsTopic("ft", "n1")).toBe(`${FLEET_TOPIC_PREFIX}/ft/node/n1/events`);
    expect(fleetStatusTopic("ft", "n1")).toBe(`${FLEET_TOPIC_PREFIX}/ft/node/n1/status`);
    expect(fleetInfoTopic("ft", "n1")).toBe(`${FLEET_TOPIC_PREFIX}/ft/node/n1/info`);
    expect(fleetAckTopic("ft", "n1", "c1")).toBe(
      `${FLEET_TOPIC_PREFIX}/ft/node/n1/ack/c1`,
    );
  });
});

describe("signFleetCmd / verifyFleetSig", () => {
  it("同一输入签名稳定且可验证", () => {
    const env = signed();
    expect(env.sig).toBe(signFleetCmd("s3cret", base));
    expect(verifyFleetSig("s3cret", env)).toBe(true);
  });

  it("projectId/sessionId 参与签名（缺省与空串等价）", () => {
    const withIds = signed("s3cret", { projectId: "p1", sessionId: "s1" });
    const emptyIds = signed("s3cret", { projectId: "", sessionId: "" });
    expect(withIds.sig).not.toBe(emptyIds.sig);
    expect(emptyIds.sig).toBe(signed().sig);
    expect(verifyFleetSig("s3cret", withIds)).toBe(true);
  });

  it("篡改任一字段或换密钥均验证失败", () => {
    const env = signed();
    expect(verifyFleetSig("other", env)).toBe(false);
    expect(verifyFleetSig("s3cret", { ...env, payload: { text: "changed" } })).toBe(false);
    expect(verifyFleetSig("s3cret", { ...env, nodeId: "node-2" })).toBe(false);
    expect(verifyFleetSig("s3cret", { ...env, type: "ping" })).toBe(false);
  });

  it("空/缺失签名直接拒绝", () => {
    expect(verifyFleetSig("s3cret", { ...base, sig: "" })).toBe(false);
    expect(verifyFleetSig("s3cret", { ...base, sig: "short" })).toBe(false);
  });
});

describe("parseFleetEnvelope", () => {
  it("接受合法信封并保留可选字段", () => {
    const env = signed("s3cret", { projectId: "p1", sessionId: "s1" });
    expect(parseFleetEnvelope(env)).toEqual(env);
  });

  it("缺省可选字段为 undefined", () => {
    const parsed = parseFleetEnvelope(signed());
    expect(parsed?.projectId).toBeUndefined();
    expect(parsed?.sessionId).toBeUndefined();
  });

  it("拒绝非对象、缺字段、未知类型与非对象 payload", () => {
    expect(parseFleetEnvelope(null)).toBeNull();
    expect(parseFleetEnvelope("x")).toBeNull();
    for (const k of ["t", "nonce", "reqId", "type", "clientId", "nodeId", "sig"]) {
      expect(parseFleetEnvelope({ ...signed(), [k]: undefined })).toBeNull();
    }
    expect(parseFleetEnvelope({ ...signed(), type: "unknown.cmd" })).toBeNull();
    expect(parseFleetEnvelope({ ...signed(), payload: null })).toBeNull();
    expect(parseFleetEnvelope({ ...signed(), payload: "str" })).toBeNull();
  });

  it("接受全部已声明命令类型", () => {
    for (const type of FLEET_CMD_TYPES) {
      expect(parseFleetEnvelope({ ...signed(), type })?.type).toBe(type);
    }
  });
});
