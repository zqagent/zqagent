/**
 * 生成线协议交叉验证向量（proto/fixtures/wire-vectors.json）
 *
 * 向量是三方（Node / Rust / 浏览器·小程序）编解码一致性的**唯一字节基准**：改协议后
 * 必须重新生成并重跑两侧测试。见 docs/wire-protocol.md §7。
 *
 * 用法（cwd = packages/core）：npx tsx scripts/gen_wire_vectors.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeAck,
  encodeAuth,
  encodeEnvelope,
  encodeEvent,
  encodeFrame,
  encodeInfo,
  encodeNotify,
  encodeTerminalData,
  encodeSnapshot,
  encodeStatus,
  encodeSubscribe,
  signableAuthBytes,
  signableBytes,
  FrameType,
  PROTOCOL_VERSION,
  utf8Encode,
  toHex,
  type Envelope,
} from "@zqagent/shared/wire";
import { hmacSha256 } from "@zqagent/shared/wire/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, "../../../proto/fixtures/wire-vectors.json");

/** 固定测试密钥（仅用于一致性验证，非真实凭据） */
const SECRET = "zqagent-wire-test-secret";

interface EnvelopeCase {
  name: string;
  t: number;
  nonce: string;
  reqId: string;
  type: string;
  clientId: string;
  nodeId: string;
  projectId?: string;
  sessionId?: string;
  /** 载荷：二选一（payloadJson 按 UTF-8 编码为字节；payloadHex 为原始字节） */
  payloadJson?: string;
  payloadHex?: string;
  /** 执行预算（毫秒；缺省 0 表示按 type 默认分级） */
  timeoutMs?: number;
}

const envelopeCases: EnvelopeCase[] = [
  {
    name: "cmd-ping-最小",
    t: 1_700_000_000_000,
    nonce: "nonce-0001",
    reqId: "req-0001",
    type: "ping",
    clientId: "gw-replica-1",
    nodeId: "node-aaa",
  },
  {
    name: "cmd-带项目与会话",
    t: 1_700_000_001_234,
    nonce: "n-2",
    reqId: "req-2",
    type: "submit_turn",
    clientId: "gw-replica-1",
    nodeId: "node-bbb",
    projectId: "p1",
    sessionId: "s1",
    payloadJson: '{"input":"你好，世界"}',
  },
  {
    name: "cmd-空字符串可选字段被省略",
    t: 1_700_000_002_000,
    nonce: "",
    reqId: "",
    type: "",
    clientId: "",
    nodeId: "",
    projectId: "",
    sessionId: "",
    payloadJson: "",
  },
  {
    name: "cmd-二进制载荷（含 0x00 与高位字节）",
    t: 1_700_000_003_000,
    nonce: "n-4",
    reqId: "req-4",
    type: "read_file",
    clientId: "gw-replica-2",
    nodeId: "node-ccc",
    payloadHex: "00ff10fe7f0080abcd",
  },
  {
    name: "cmd-UTF8边界（emoji 与多字节）",
    t: 1_700_000_004_000,
    nonce: "n-5-🔒",
    reqId: "req-5",
    type: "run_command",
    clientId: "gw-replica-3",
    nodeId: "node-ddd",
    payloadJson: '{"command":"echo ✅ 中文 🚀"}',
  },
  {
    name: "cmd-带执行预算（timeout_ms）",
    t: 1_700_000_005_000,
    nonce: "n-6",
    reqId: "req-6",
    type: "run_command",
    clientId: "gw-replica-1",
    nodeId: "node-eee",
    payloadJson: '{"command":"sleep 5"}',
    timeoutMs: 120_000,
  },
];

function buildEnvelopeInput(c: EnvelopeCase): Envelope {
  const payload = c.payloadHex
    ? Uint8Array.from(c.payloadHex.match(/../g)!.map((h) => Number.parseInt(h, 16)))
    : utf8Encode(c.payloadJson ?? "");
  return {
    t: c.t,
    nonce: c.nonce,
    reqId: c.reqId,
    type: c.type,
    clientId: c.clientId,
    nodeId: c.nodeId,
    projectId: c.projectId,
    sessionId: c.sessionId,
    payload,
    timeoutMs: c.timeoutMs ?? 0,
  };
}

/**
 * 去掉「空串 / undefined」的可选字段。
 *
 * proto3 不把默认值写上线，解码侧得到的是「字段缺席」而非空串；向量里的 `json`
 * 应当如实描述**语义**（缺席即缺席），否则两侧断言会被默认值噪声干扰。
 */
function pruneEmpty(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined));
}

const frames = envelopeCases.map((c) => {
  const input = buildEnvelopeInput(c);
  const signable = signableBytes(input);
  const sig = hmacSha256(SECRET, signable);
  const envelope = { ...input, sig };
  const envelopeBytes = encodeEnvelope(envelope);
  const frameBytes = encodeFrame({
    type: FrameType.CMD,
    seq: c.t % 100000,
    payload: envelopeBytes,
  });
  return {
    name: c.name,
    typeName: "CMD",
    seq: c.t % 100000,
    t: c.t,
    nonce: c.nonce,
    reqId: c.reqId,
    type: c.type,
    clientId: c.clientId,
    nodeId: c.nodeId,
    projectId: c.projectId ?? "",
    sessionId: c.sessionId ?? "",
    timeoutMs: input.timeoutMs ?? 0,
    payloadHex: toHex(input.payload ?? new Uint8Array(0)),
    signableHex: toHex(signable),
    sigHex: toHex(sig),
    envelopeHex: toHex(envelopeBytes),
    frameHex: toHex(frameBytes),
  };
});

/** 载荷消息向量（上行/回执） */
const statusVectors = [
  { name: "status-在线", msg: { nodeId: "node-aaa", online: true, ts: 1_700_000_000_000, platform: "linux", mode: "standalone", version: "0.1.59", ip: "10.0.0.7" } },
  { name: "status-离线-最小字段", msg: { nodeId: "node-bbb", online: false, ts: 1_700_000_005_000 } },
  { name: "status-带label", msg: { nodeId: "node-ccc", online: true, ts: 1_700_000_006_000, label: "研发机🏠" } },
].map(({ name, msg }) => ({ name, kind: "status", json: pruneEmpty(msg as Record<string, unknown>), hex: toHex(encodeStatus(msg)) }));

const ackVectors = [
  { name: "ack-成功带数据", msg: { reqId: "req-2", type: "list_projects", ok: true, data: utf8Encode('{"items":[]}') } },
  { name: "ack-失败带错误", msg: { reqId: "req-3", type: "read_file", ok: false, error: "文件不存在" } },
].map(({ name, msg }) => ({
  name,
  kind: "ack",
  json: pruneEmpty({
    reqId: msg.reqId,
    type: msg.type,
    ok: msg.ok,
    error: msg.error ?? "",
    dataHex: msg.data ? toHex(msg.data) : "",
  }),
  hex: toHex(encodeAck(msg)),
}));

const eventVectors = [
  { name: "event-基本", msg: { seq: 1, ts: 1_700_000_000_000, type: "assistant_message", projectId: "p1", sessionId: "s1", data: utf8Encode('{"text":"hi"}') } },
  { name: "event-大seq", msg: { seq: 9_007_199_254_740_990, ts: 1_700_000_009_000, type: "turn_end" } },
  {
    // 下行扇出帧由网关按连接绑定填入来源节点：终端一条连接订阅多个节点时据此归属
    name: "event-带来源节点",
    msg: { seq: 3, ts: 1_700_000_002_000, type: "tick", nodeId: "node-ccc", data: utf8Encode('{"n":1}') },
  },
].map(({ name, msg }) => ({
  name,
  kind: "event",
  json: pruneEmpty({
    seq: msg.seq,
    ts: msg.ts,
    type: msg.type,
    projectId: msg.projectId ?? "",
    sessionId: msg.sessionId ?? "",
    dataHex: msg.data ? toHex(msg.data) : "",
    nodeId: msg.nodeId ?? "",
  }),
  hex: toHex(encodeEvent(msg)),
}));

// ---- 握手认证（M2）：token 是 7 号字段（最后），故 signable 为其前缀 ----

interface AuthCase {
  name: string;
  id: string;
  ts: number;
  nonce: string;
  proto: number;
  kind: "node" | "terminal";
  client?: string;
  scope?: string[];
  expires?: number;
}

const authCases: AuthCase[] = [
  {
    name: "auth-节点面",
    id: "node-aaa",
    ts: 1_700_000_000_000,
    nonce: "auth-n-1",
    proto: PROTOCOL_VERSION,
    kind: "node",
  },
  {
    name: "auth-终端面-小程序",
    id: "user-1",
    ts: 1_700_000_001_000,
    nonce: "auth-t-1",
    proto: PROTOCOL_VERSION,
    kind: "terminal",
    client: "miniapp",
  },
  {
    name: "auth-终端面-web",
    id: "user-2",
    ts: 1_700_000_002_000,
    nonce: "auth-t-2",
    proto: PROTOCOL_VERSION,
    kind: "terminal",
    client: "web",
  },
  {
    // M5：终端令牌带授权范围与过期时刻。
    // 注意 scope/expires 在 token **之后**的字段号上，但仍参与签名——本向量正是为
    // 验证「改 scope 会让 token 失效」这条跨语言一致性而存在。
    name: "auth-终端面带授权范围与过期",
    id: "user-3",
    ts: 1_700_000_003_000,
    nonce: "auth-t-3",
    proto: PROTOCOL_VERSION,
    kind: "terminal",
    client: "web",
    scope: ["node-aaa", "node-bbb"],
    expires: 1_700_003_600_000,
  },
];

const handshakes = authCases.map((c) => {
  const input = {
    id: c.id,
    ts: c.ts,
    nonce: c.nonce,
    proto: c.proto,
    kind: c.kind,
    client: c.client,
    scope: c.scope,
    expires: c.expires,
  };
  const signable = signableAuthBytes(input);
  const token = hmacSha256(SECRET, signable);
  const withToken = { ...input, token };
  return {
    name: c.name,
    id: c.id,
    ts: c.ts,
    nonce: c.nonce,
    proto: c.proto,
    kind: c.kind,
    client: c.client ?? "",
    scope: c.scope,
    expires: c.expires,
    signableHex: toHex(signable),
    tokenHex: toHex(token),
    authHex: toHex(encodeAuth(withToken)),
  };
});

// ---- 订阅（M2 终端多路复用）----

const subscribeVectors = [
  { name: "subscribe-三节点", ids: ["node-aaa", "node-bbb", "node-ccc"] },
  { name: "subscribe-单节点", ids: ["node-aaa"] },
].map(({ name, ids }) => ({
  name,
  kind: "subscribe",
  json: { ids },
  hex: toHex(encodeSubscribe(ids)),
}));

const snapshotVectors = [
  {
    name: "snapshot-两节点",
    nodes: [
      {
        nodeId: "node-aaa",
        online: true,
        lastSeen: 1_700_000_000_000,
        platform: "linux",
        version: "0.1.59",
        ip: "10.0.0.7",
        // 快照携带原始 info JSON（替代 retained info），让终端订阅后一次拿到项目/统计
        detail: utf8Encode('{"label":"测试节点","stats":{"turns":3}}'),
      },
      { nodeId: "node-bbb", online: false, lastSeen: 1_700_000_003_000 },
    ],
    seq: 42,
  },
].map(({ name, nodes, seq }) => ({
  name,
  kind: "snapshot",
  json: {
    nodes: nodes.map(({ detail, ...rest }) => ({
      ...rest,
      ...(detail ? { detailHex: toHex(detail) } : {}),
    })),
    seq,
  },
  hex: toHex(encodeSnapshot({ nodes, seq })),
}));

// ---- 节点能力/项目快照（M2b）----

const infoVectors = [
  {
    name: "info-基本",
    info: {
      nodeId: "node-aaa",
      platform: "linux",
      version: "0.1.59",
      ip: "10.0.0.7",
      projects: 2,
      sessions: 5,
      running: 1,
      waiting: 1,
      ts: 1_700_000_000_000,
    },
  },
  {
    name: "info-仅节点（无项目）",
    info: { nodeId: "node-bbb", projects: 0, sessions: 0, running: 0, waiting: 0, ts: 1_700_000_004_000 },
  },
].map(({ name, info }) => ({
  name,
  kind: "info",
  json: pruneEmpty(info as unknown as Record<string, unknown>),
  hex: toHex(encodeInfo(info)),
}));

// ---- 通知（M2c：需可靠送达的上行）----

const notifyVectors = [
  {
    name: "notify-审批请求",
    msg: {
      seq: 0,
      ts: 1_700_000_000_000,
      kind: "approval_request",
      projectId: "p1",
      sessionId: "s1",
      data: utf8Encode('{"approvalId":"a1","toolName":"run_shell"}'),
      nodeId: "node-aaa", // 由网关按连接绑定填入
    },
  },
  {
    name: "notify-回合完成",
    msg: { seq: 7, ts: 1_700_000_010_000, kind: "turn_completed", sessionId: "s2" },
  },
].map(({ name, msg }) => ({
  name,
  kind: "notify",
  json: pruneEmpty({
    seq: msg.seq,
    ts: msg.ts,
    kind: msg.kind,
    projectId: msg.projectId ?? "",
    sessionId: msg.sessionId ?? "",
    dataHex: msg.data ? toHex(msg.data) : "",
    nodeId: msg.nodeId ?? "",
  }),
  hex: toHex(encodeNotify(msg)),
}));

// ---- 终端数据（控制台终端面板；独立帧类型，不进事件流）----
//
// 这组向量守两件事：一是 `TerminalData` 的字段号/编码与其他消息同样严格；
// 二是 `FrameType.TERMINAL = 15` 的帧头字节与 Rust 侧一致——终端帧走**独立队列**，
// 一旦两侧字节不同，网关会把终端数据当未知帧静默丢弃。
const terminalCases = [
  {
    name: "terminal-data-命令输出",
    td: {
      terminalId: "t_abc123",
      kind: "data",
      data: utf8Encode("$ pnpm test\n✓ 12 passed\n"),
      seq: 3,
    },
  },
  {
    name: "terminal-open-空载荷",
    td: { terminalId: "t_abc123", kind: "open", seq: 0 },
  },
  {
    name: "terminal-error-中文",
    td: {
      terminalId: "t_abc123",
      kind: "error",
      data: utf8Encode("节点繁忙，输入已丢弃"),
      seq: 9,
    },
  },
  {
    name: "terminal-input-带节点",
    td: { nodeId: "node-aaa", terminalId: "t_abc123", kind: "input", data: utf8Encode("ls -al\r"), seq: 1 },
  },
];

const terminalVectors = terminalCases.map(({ name, td }) => ({
  name,
  kind: "terminal",
  json: pruneEmpty({
    nodeId: td.nodeId ?? "",
    terminalId: td.terminalId,
    kind: td.kind,
    dataHex: td.data ? toHex(td.data) : "",
    seq: td.seq ?? 0,
  }),
  hex: toHex(encodeTerminalData(td)),
}));

/** 帧级向量：`frames` 是 CMD 专用结构，终端帧单列一组 */
const terminalFrames = terminalCases.map(({ name, td }) => {
  const payload = encodeTerminalData(td);
  const seq = td.seq ?? 0;
  return {
    name,
    seq,
    nodeId: td.nodeId ?? "",
    terminalId: td.terminalId,
    kind: td.kind,
    dataHex: td.data ? toHex(td.data) : "",
    payloadHex: toHex(payload),
    frameHex: toHex(encodeFrame({ type: FrameType.TERMINAL, seq, payload })),
  };
});

const payload = {
  note: "线协议 v1 交叉验证向量。由 packages/core/scripts/gen_wire_vectors.ts 生成，勿手改。",
  spec: "docs/wire-protocol.md",
  proto: "proto/fleet.proto",
  protocolVersion: PROTOCOL_VERSION,
  secret: SECRET,
  frames,
  handshakes,
  terminalFrames,
  messages: [...statusVectors, ...ackVectors, ...eventVectors, ...subscribeVectors, ...snapshotVectors, ...infoVectors, ...notifyVectors, ...terminalVectors],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
console.log(`已生成 ${outFile}`);
console.log(`  帧向量 ${frames.length} 个，消息向量 ${payload.messages.length} 个`);
