/**
 * 消息编解码（Envelope / Ack / Status / Event）
 *
 * 字段定义见 proto/fleet.proto。手写编解码，规则与 prost 对齐（proto3 默认值省略、
 * 字段号升序、string 严格 UTF-8），未知字段按 wire type 跳过以支持前向兼容。
 *
 * 签名：`signableBytes()` 给出「不含 sig」的编码字节；`sig` 是 10 号字段（最后），
 * 因此 `encode(env, sig 置空) === signableBytes(env)` 恒成立，校验方可重编码比对。
 */
import { Reader, Writer, WIRE_LEN, WIRE_VARINT, WireError, EMPTY_BYTES } from "./varint.js";

/** 与现有 FleetCmdEnvelope（packages/shared/src/fleet.ts:159-178）语义一致 */
export interface Envelope {
  /** 毫秒时间戳 */
  t: number;
  nonce: string;
  reqId: string;
  type: string;
  clientId: string;
  nodeId: string;
  projectId?: string;
  sessionId?: string;
  /** 载荷字节（按 type 选择强类型消息或 JSON 字节） */
  payload?: Uint8Array;
  /**
   * 执行预算（毫秒，可选）：由发起方指定，网关据此决定等待回执的上限。
   * 0/缺省表示按 `type` 的默认分级（见 docs/wire-protocol.md §5.2）。
   */
  timeoutMs?: number;
  /** HMAC-SHA256 原始 32 字节（**必须是最后一个字段**：其前缀即签名字节） */
  sig?: Uint8Array;
}

export interface Ack {
  reqId: string;
  type: string;
  ok: boolean;
  error?: string;
  data?: Uint8Array;
}

export interface Status {
  nodeId: string;
  online: boolean;
  /** 毫秒时间戳（现有 JSON 协议为 ISO 字符串，映射在 M2） */
  ts: number;
  label?: string;
  platform?: string;
  mode?: string;
  version?: string;
  ip?: string;
}

export interface EventMsg {
  seq: number;
  ts: number;
  type: string;
  projectId?: string;
  sessionId?: string;
  data?: Uint8Array;
  /**
   * 事件来源节点。由**网关**按连接绑定的 nodeId 填充（节点上行时留空）。
   *
   * 终端面一条连接可订阅多个节点，缺了它就无法分辨事件来自哪台节点。
   */
  nodeId?: string;
}

/**
 * 命令终端数据（`FrameType.TERMINAL`）。
 *
 * 与 `EventMsg` 完全平行的另一条通道，**不是** Event 的一种：它不参与
 * seq 游标、不入事件环形缓冲、不跨副本广播（理由见 proto 注释）。
 */
export interface TerminalData {
  /** 目标节点；节点上行时留空，由网关按连接绑定填充 */
  nodeId?: string;
  /** 终端实例 ID（节点侧生成，`t_` 前缀；与会话 ID 不同空间） */
  terminalId: string;
  /**
   * 帧种类：
   *   opened | data | exited | error   —— 节点 → 网关 → 终端
   *   open | input | resize | close     —— 终端 → 网关 → 节点
   */
  kind: string;
  /** data 为原始字节；open/resize/error 为 JSON 字节 */
  data?: Uint8Array;
  /** 终端内局部序号（仅该终端内有效，不参与 resume） */
  seq?: number;
}

// ===================== Envelope =====================

export function encodeEnvelope(env: Envelope): Uint8Array {
  const w = new Writer(128);
  w.uint64Field(1, env.t);
  w.stringField(2, env.nonce);
  w.stringField(3, env.reqId);
  w.stringField(4, env.type);
  w.stringField(5, env.clientId);
  w.stringField(6, env.nodeId);
  w.stringField(7, env.projectId ?? "");
  w.stringField(8, env.sessionId ?? "");
  w.bytesField(9, env.payload ?? EMPTY_BYTES);
  w.uint64Field(10, env.timeoutMs ?? 0);
  w.bytesField(11, env.sig ?? EMPTY_BYTES);
  return w.finish();
}

/** 参与签名的字节（字段 1..10，不含 sig） */
export function signableBytes(env: Envelope): Uint8Array {
  return encodeEnvelope({ ...env, sig: undefined });
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const r = new Reader(bytes);
  const env: Envelope = { t: 0, nonce: "", reqId: "", type: "", clientId: "", nodeId: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else env.t = r.u64();
        break;
      case 2:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.nonce = r.string();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.reqId = r.string();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.type = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.clientId = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.nodeId = r.string();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.projectId = r.string();
        break;
      case 8:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.sessionId = r.string();
        break;
      case 9:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.payload = r.lenPrefixed();
        break;
      case 10:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else env.timeoutMs = r.u64();
        break;
      case 11:
        if (wire !== WIRE_LEN) r.skip(wire);
        else env.sig = r.lenPrefixed();
        break;
      default:
        r.skip(wire);
    }
  }
  return env;
}

// ===================== Ack =====================

export function encodeAck(ack: Ack): Uint8Array {
  const w = new Writer(64);
  w.stringField(1, ack.reqId);
  w.stringField(2, ack.type);
  w.boolField(3, ack.ok);
  w.stringField(4, ack.error ?? "");
  w.bytesField(5, ack.data ?? EMPTY_BYTES);
  return w.finish();
}

export function decodeAck(bytes: Uint8Array): Ack {
  const r = new Reader(bytes);
  const ack: Ack = { reqId: "", type: "", ok: false };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ack.reqId = r.string();
        break;
      case 2:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ack.type = r.string();
        break;
      case 3:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else ack.ok = r.varint() !== 0n;
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ack.error = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ack.data = r.lenPrefixed();
        break;
      default:
        r.skip(wire);
    }
  }
  return ack;
}

// ===================== Status =====================

export function encodeStatus(st: Status): Uint8Array {
  const w = new Writer(96);
  w.stringField(1, st.nodeId);
  w.boolField(2, st.online);
  w.uint64Field(3, st.ts);
  w.stringField(4, st.label ?? "");
  w.stringField(5, st.platform ?? "");
  w.stringField(6, st.mode ?? "");
  w.stringField(7, st.version ?? "");
  w.stringField(8, st.ip ?? "");
  return w.finish();
}

export function decodeStatus(bytes: Uint8Array): Status {
  const r = new Reader(bytes);
  const st: Status = { nodeId: "", online: false, ts: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.nodeId = r.string();
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else st.online = r.varint() !== 0n;
        break;
      case 3:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else st.ts = r.u64();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.label = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.platform = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.mode = r.string();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.version = r.string();
        break;
      case 8:
        if (wire !== WIRE_LEN) r.skip(wire);
        else st.ip = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  return st;
}

// ===================== Event =====================

export function encodeEvent(ev: EventMsg): Uint8Array {
  const w = new Writer(128);
  w.uint64Field(1, ev.seq);
  w.uint64Field(2, ev.ts);
  w.stringField(3, ev.type);
  w.stringField(4, ev.projectId ?? "");
  w.stringField(5, ev.sessionId ?? "");
  w.bytesField(6, ev.data ?? EMPTY_BYTES);
  w.stringField(7, ev.nodeId ?? "");
  return w.finish();
}

export function decodeEvent(bytes: Uint8Array): EventMsg {
  const r = new Reader(bytes);
  const ev: EventMsg = { seq: 0, ts: 0, type: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else ev.seq = r.u64();
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else ev.ts = r.u64();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ev.type = r.string();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ev.projectId = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ev.sessionId = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ev.data = r.lenPrefixed();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else ev.nodeId = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  return ev;
}

export { WireError };

// ===================== 节点能力/项目快照 =====================

export interface Info {
  nodeId: string;
  platform?: string;
  version?: string;
  ip?: string;
  /** 项目数 */
  projects: number;
  /** 会话数 */
  sessions: number;
  /** 运行中的会话数 */
  running: number;
  /** 等待审批/提问的会话数 */
  waiting: number;
  /** 毫秒时间戳 */
  ts: number;
  /**
   * 节点上报的**原始 info JSON**（含 label / 项目明细 / stats / usage）。
   *
   * 5..9 的计数供网关快速聚合；本字段原样承载完整快照，供控制面读取
   * （替代从前经 MQTT retained info 的那条路径），避免为视图反复改 schema。
   */
  detail?: Uint8Array;
}

export function encodeInfo(info: Info): Uint8Array {
  const w = new Writer(96);
  w.stringField(1, info.nodeId);
  w.stringField(2, info.platform ?? "");
  w.stringField(3, info.version ?? "");
  w.stringField(4, info.ip ?? "");
  w.uint64Field(5, info.projects);
  w.uint64Field(6, info.sessions);
  w.uint64Field(7, info.running);
  w.uint64Field(8, info.waiting);
  w.uint64Field(9, info.ts);
  w.bytesField(10, info.detail ?? EMPTY_BYTES);
  return w.finish();
}

export function decodeInfo(bytes: Uint8Array): Info {
  const r = new Reader(bytes);
  const info: Info = { nodeId: "", projects: 0, sessions: 0, running: 0, waiting: 0, ts: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else info.nodeId = r.string();
        break;
      case 2:
        if (wire !== WIRE_LEN) r.skip(wire);
        else info.platform = r.string();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else info.version = r.string();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else info.ip = r.string();
        break;
      case 5:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else info.projects = r.u64();
        break;
      case 6:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else info.sessions = r.u64();
        break;
      case 7:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else info.running = r.u64();
        break;
      case 8:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else info.waiting = r.u64();
        break;
      case 9:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else info.ts = r.u64();
        break;
      case 10:
        if (wire !== WIRE_LEN) r.skip(wire);
        else info.detail = r.lenPrefixed();
        break;
      default:
        r.skip(wire);
    }
  }
  return info;
}

// ===================== 通知（需可靠送达的上行） =====================

/**
 * 节点通知：审批请求 / 提问 / 回合完成 / 错误。
 *
 * 与 `EventMsg` 的分工：Event 是高频实时进度，Notify 是低频但重要（审批/提问挂起必须
 * 让终端看到）。两者共用网关分配的 `seq` 游标与缓冲，因此 `resume` 时都能回放。
 */
export interface NotifyMsg {
  /** 由网关分配的游标（节点上报时留 0） */
  seq: number;
  ts: number;
  kind: string;
  projectId?: string;
  sessionId?: string;
  data?: Uint8Array;
  /** 通知来源节点；由网关填充（多路复用终端据此归属到具体节点） */
  nodeId?: string;
}

export function encodeNotify(n: NotifyMsg): Uint8Array {
  const w = new Writer(160);
  w.uint64Field(1, n.seq);
  w.uint64Field(2, n.ts);
  w.stringField(3, n.kind);
  w.stringField(4, n.projectId ?? "");
  w.stringField(5, n.sessionId ?? "");
  w.bytesField(6, n.data ?? EMPTY_BYTES);
  w.stringField(7, n.nodeId ?? "");
  return w.finish();
}

export function decodeNotify(bytes: Uint8Array): NotifyMsg {
  const r = new Reader(bytes);
  const n: NotifyMsg = { seq: 0, ts: 0, kind: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else n.seq = r.u64();
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else n.ts = r.u64();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.kind = r.string();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.projectId = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.sessionId = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.data = r.lenPrefixed();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.nodeId = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  return n;
}

// ===================== 握手 / 认证 =====================

export interface Auth {
  /** 节点面：nodeId；终端面：userId */
  id: string;
  /** 毫秒时间戳（±60s 窗口） */
  ts: number;
  nonce: string;
  /** 协议能力版本 */
  proto: number;
  /** "node" | "terminal" */
  kind: string;
  /** 终端载体："web" | "miniapp" | "app"（节点面留空） */
  client?: string;
  /**
   * 终端面 = HMAC-SHA256(terminalSecret, signableAuthBytes)；节点面 = HMAC-SHA256(fleetSecret, …)
   *
   * 注意 `scope`/`expires` 在 `token` **之后**：proto3 按字段号升序编码，因此它们仍在
   * `signableAuthBytes` 内 —— 即**同样受签名完整性保护**（改 scope 会让 token 失效）。
   */
  token?: Uint8Array;
  /** 终端面被授权的 nodeId 列表（非空时网关严格校验；见 `verifyTerminalAuth`） */
  scope?: string[];
  /** 终端面过期时刻（毫秒）；>0 时网关跳过 ±60s 窗口 */
  expires?: number;
}

export interface AuthOk {
  ok: boolean;
  error?: string;
  serverTs: number;
}

export function encodeAuth(auth: Auth): Uint8Array {
  const w = new Writer(64);
  w.stringField(1, auth.id);
  w.uint64Field(2, auth.ts);
  w.stringField(3, auth.nonce);
  // 注意：proto3 默认值省略 → proto=0 与 proto=1 不同，proto=0 不出现在线格式中
  w.uint64Field(4, auth.proto);
  w.stringField(5, auth.kind);
  w.stringField(6, auth.client ?? "");
  w.bytesField(7, auth.token ?? EMPTY_BYTES);
  // repeated string 在 protobuf 中是重复 tag（非 packed），逐个写即可
  for (const id of auth.scope ?? []) w.stringField(8, id);
  w.uint64Field(9, auth.expires ?? 0);
  return w.finish();
}

/**
 * 参与签名的字节：清空 `token` 后编码。
 *
 * `scope`/`expires` 字段号大于 `token`，但 prost/本实现都按字段号升序编码，
 * 因此它们**仍在签名字节内**（受完整性保护），不是「token 之后的免费字段」。
 */
export function signableAuthBytes(auth: Auth): Uint8Array {
  return encodeAuth({ ...auth, token: undefined });
}

export function decodeAuth(bytes: Uint8Array): Auth {
  const r = new Reader(bytes);
  const auth: Auth = { id: "", ts: 0, nonce: "", proto: 0, kind: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else auth.id = r.string();
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else auth.ts = r.u64();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else auth.nonce = r.string();
        break;
      case 4:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else auth.proto = r.u64();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else auth.kind = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else auth.client = r.string();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else auth.token = r.lenPrefixed();
        break;
      case 8:
        if (wire !== WIRE_LEN) r.skip(wire);
        else (auth.scope ??= []).push(r.string());
        break;
      case 9:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else auth.expires = r.u64();
        break;
      default:
        r.skip(wire);
    }
  }
  return auth;
}

export function encodeAuthOk(ok: AuthOk): Uint8Array {
  const w = new Writer(48);
  w.boolField(1, ok.ok);
  w.stringField(2, ok.error ?? "");
  w.uint64Field(3, ok.serverTs);
  return w.finish();
}

export function decodeAuthOk(bytes: Uint8Array): AuthOk {
  const r = new Reader(bytes);
  const out: AuthOk = { ok: false, serverTs: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else out.ok = r.varint() !== 0n;
        break;
      case 2:
        if (wire !== WIRE_LEN) r.skip(wire);
        else out.error = r.string();
        break;
      case 3:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else out.serverTs = r.u64();
        break;
      default:
        r.skip(wire);
    }
  }
  return out;
}

// ===================== 终端数据 =====================

export function encodeTerminalData(td: TerminalData): Uint8Array {
  const w = new Writer(64 + (td.data?.length ?? 0));
  w.stringField(1, td.nodeId ?? "");
  w.stringField(2, td.terminalId);
  w.stringField(3, td.kind);
  w.bytesField(4, td.data ?? EMPTY_BYTES);
  w.uint64Field(5, td.seq ?? 0);
  return w.finish();
}

export function decodeTerminalData(bytes: Uint8Array): TerminalData {
  const r = new Reader(bytes);
  const td: TerminalData = { terminalId: "", kind: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else td.nodeId = r.string();
        break;
      case 2:
        if (wire !== WIRE_LEN) r.skip(wire);
        else td.terminalId = r.string();
        break;
      case 3:
        if (wire !== WIRE_LEN) r.skip(wire);
        else td.kind = r.string();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else td.data = r.lenPrefixed();
        break;
      case 5:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else td.seq = r.u64();
        break;
      default:
        r.skip(wire);
    }
  }
  return td;
}

// ===================== 快照 / 订阅 =====================

export interface NodeState {
  nodeId: string;
  online: boolean;
  lastSeen: number;
  platform?: string;
  version?: string;
  ip?: string;
  /**
   * 节点上报的原始 info JSON（`Info.detail` 的转发），供终端快照读取项目/统计。
   *
   * 快照借此**替代 MQTT retained info**：订阅后一次拿到，不必逐节点发指令。
   * 节点从未上报过 INFO 时为空。
   */
  detail?: Uint8Array;
}

export interface Snapshot {
  nodes: NodeState[];
  /** 当前事件游标（客户端据此发起 resume） */
  seq: number;
}

export function encodeNodeState(n: NodeState): Uint8Array {
  const w = new Writer(96);
  w.stringField(1, n.nodeId);
  w.boolField(2, n.online);
  w.uint64Field(3, n.lastSeen);
  w.stringField(4, n.platform ?? "");
  w.stringField(5, n.version ?? "");
  w.stringField(6, n.ip ?? "");
  w.bytesField(7, n.detail ?? EMPTY_BYTES);
  return w.finish();
}

export function decodeNodeState(bytes: Uint8Array): NodeState {
  const r = new Reader(bytes);
  const n: NodeState = { nodeId: "", online: false, lastSeen: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.nodeId = r.string();
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else n.online = r.varint() !== 0n;
        break;
      case 3:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else n.lastSeen = r.u64();
        break;
      case 4:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.platform = r.string();
        break;
      case 5:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.version = r.string();
        break;
      case 6:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.ip = r.string();
        break;
      case 7:
        if (wire !== WIRE_LEN) r.skip(wire);
        else n.detail = r.lenPrefixed();
        break;
      default:
        r.skip(wire);
    }
  }
  return n;
}

export function encodeSnapshot(snap: Snapshot): Uint8Array {
  const w = new Writer(128);
  for (const node of snap.nodes) {
    w.tag(1, WIRE_LEN);
    w.lenPrefixed(encodeNodeState(node));
  }
  w.uint64Field(2, snap.seq);
  return w.finish();
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new Reader(bytes);
  const snap: Snapshot = { nodes: [], seq: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (wire !== WIRE_LEN) r.skip(wire);
        else snap.nodes.push(decodeNodeState(r.lenPrefixed()));
        break;
      case 2:
        if (wire !== WIRE_VARINT) r.skip(wire);
        else snap.seq = r.u64();
        break;
      default:
        r.skip(wire);
    }
  }
  return snap;
}

function encodeNodeIds(ids: string[]): Uint8Array {
  const w = new Writer(64);
  for (const id of ids) w.stringField(1, id);
  return w.finish();
}

function decodeNodeIds(bytes: Uint8Array): string[] {
  const r = new Reader(bytes);
  const ids: string[] = [];
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) ids.push(r.string());
    else r.skip(wire);
  }
  return ids;
}

export const encodeSubscribe = encodeNodeIds;
export const decodeSubscribe = decodeNodeIds;
export const encodeUnsubscribe = encodeNodeIds;
export const decodeUnsubscribe = decodeNodeIds;

export function encodeResume(since: number): Uint8Array {
  const w = new Writer(16);
  w.uint64Field(1, since);
  return w.finish();
}

export function decodeResume(bytes: Uint8Array): { since: number } {
  const r = new Reader(bytes);
  let since = 0;
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_VARINT) since = r.u64();
    else r.skip(wire);
  }
  return { since };
}