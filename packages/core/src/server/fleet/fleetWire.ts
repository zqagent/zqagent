/**
 * 节点侧 wire 协议适配层：现有 fleet JSON 形状 ↔ protobuf 消息
 *
 * 为什么需要这一层：节点内部的指令/状态/事件仍是 JSON 形状（`FleetCmdEnvelope` /
 * `FleetStatus` / `FleetAckPayload`），`FleetCommands.ts` 直接消费它们；而 Rust 网关
 * 讲的是 protobuf 二进制。把「形状转换」集中在本模块，好处是：
 *
 *   - `FleetCommands.ts` **一行都不用改**（这是方案里对它明确的边界承诺）；
 *   - 转换是纯函数，可脱离连接单独测（`test/fleetWire.test.ts`）；
 *   - MQTT 链路完全不受影响——它继续走 JSON，不经过这里。
 *
 * 载荷保真策略：EVENT / NOTIFY 把**整段 JSON 原样放进 `data` 字节**，不拆字段。
 * 这样终端拿到的 `JSON.parse(data)` 与走 MQTT 时收到的 payload **逐字段一致**，
 * 消费端无需改动；同时帧类型/项目/会话这些需要路由的字段仍单独提出。
 *
 * 规范：docs/wire-protocol.md　契约：proto/fleet.proto
 */
import {
  FrameType,
  encodeFrame,
  encodeAck,
  encodeEnvelope,
  encodeEvent,
  encodeInfo,
  encodeNotify,
  encodeStatus,
  utf8Decode,
  utf8Encode,
  type Ack,
  type Envelope,
  type EventMsg,
  type Info,
  type NotifyMsg,
  type Status,
} from "@zqagent/shared/wire";
import type { FleetAckPayload, FleetCmdEnvelope, FleetStatus } from "@zqagent/shared/fleet";

/**
 * 节点上行消息（语义化）。
 *
 * 传输层负责把它编码成各自的形式：MQTT → topic + JSON；WSS → 帧类型 + protobuf。
 * QoS / retain 是 MQTT 概念，因此**留在 MQTT 传输里**，不进入本类型。
 */
export type FleetOutbound =
  | { kind: "status"; status: FleetStatus }
  /** 富信息快照（JSON 字符串）；WSS 下由 `toWireInfo` 取精简聚合 */
  | { kind: "info"; blob: string }
  /** 事件：单条或 `{zqBatch:[...]}` 批量 JSON（与 MQTT 时代同一形状） */
  | { kind: "event"; json: string }
  /** 通知（审批/提问/回合完成），JSON 字符串 */
  | { kind: "notify"; json: string }
  | { kind: "ack"; clientId: string; ack: FleetAckPayload };

/** ISO 时间字符串 → 毫秒；无法解析时返回 0（协议里 0 表示「无时间戳」） */
export function isoToMs(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 富信息快照的字段（`_publishInfo` 构造出来的 JSON 形状） */
export interface FleetInfoBlob {
  nodeId?: string;
  platform?: string;
  version?: string;
  ip?: string;
  totals?: { projects?: number; sessions?: number; running?: number; waiting?: number };
  /** 会话状态快照（仅标识与状态；供控制面建立初始视图） */
  sessions?: Array<{
    projectId?: string;
    sessionId?: string;
    name?: string | null;
    status?: string;
    lastUserMessage?: string | null;
    lastStartedAt?: string | null;
    lastCompletedAt?: string | null;
  }>;
  ts?: string;
}

/**
 * 富 info JSON → wire `Info`。
 *
 * 线上 `Info` 是**两段式**：
 *   - 计数字段（projects/sessions/running/waiting）：供网关快速聚合与查询；
 *   - `detail`：**原始 info JSON 原样字节**，承载 label / 项目明细 / stats / usage
 *     这些控制面要用的富字段。原样透传（不做二次建模）的理由与 EVENT/NOTIFY 的
 *     `data` 一致：消费端 `JSON.parse(detail)` 得到的对象与从前读 retained info
 *     完全一致，Hub 侧无需改解析逻辑。
 */
export function toWireInfo(blobJson: string, nodeId: string): Info {
  let blob: FleetInfoBlob = {};
  try {
    blob = JSON.parse(blobJson) as FleetInfoBlob;
  } catch {
    // 非法 JSON：只报计数为 0，detail 仍原样带上（由消费端决定怎么处理）
  }
  const totals = blob.totals ?? {};
  return {
    nodeId: blob.nodeId ?? nodeId,
    platform: blob.platform,
    version: blob.version,
    ip: blob.ip,
    projects: totals.projects ?? 0,
    sessions: totals.sessions ?? 0,
    running: totals.running ?? 0,
    waiting: totals.waiting ?? 0,
    ts: isoToMs(blob.ts),
    detail: utf8Encode(blobJson),
  };
}

/** `FleetStatus`（ISO 时间字符串）→ wire `Status`（毫秒） */
export function toWireStatus(s: FleetStatus): Status {
  return {
    nodeId: s.nodeId,
    online: s.online,
    ts: isoToMs(s.ts),
    label: s.label,
    platform: s.platform,
    mode: s.mode,
    version: s.version,
    ip: s.ip,
  };
}

/**
 * 事件 JSON → wire `EventMsg`。
 *
 * `seq` 留 0：游标由网关分配（见 docs/wire-protocol.md §3），节点不自己编号。
 * 解析失败返回 null（调用方跳过并留痕，不抛错打断事件流）。
 *
 * 批量合并串（`{zqBatch:[...]}`，见 `_flushEvents`）**没有顶层 type**，直接取
 * `o.type` 会判成非法而丢掉整批——这是 MQTT 时代的容器形状，故显式标为 `batch`。
 */
export function toWireEvent(json: string): EventMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as { type?: unknown; zqBatch?: unknown; projectId?: unknown; sessionId?: unknown };
  const isBatch = Array.isArray(o.zqBatch);
  const type = typeof o.type === "string" ? o.type : isBatch ? "batch" : null;
  if (!type) return null;
  return {
    seq: 0,
    ts: Date.now(),
    type,
    // 批量串跨多个项目/会话，不归属单个；单条才取
    projectId: !isBatch && typeof o.projectId === "string" ? o.projectId : undefined,
    sessionId: !isBatch && typeof o.sessionId === "string" ? o.sessionId : undefined,
    data: utf8Encode(json),
  };
}

/** 通知 JSON → wire `NotifyMsg`（`seq` 同样留 0，由网关分配） */
export function toWireNotify(json: string): NotifyMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { kind?: unknown; projectId?: unknown; sessionId?: unknown };
  if (typeof o.kind !== "string") return null;
  return {
    seq: 0,
    ts: Date.now(),
    kind: o.kind,
    projectId: typeof o.projectId === "string" ? o.projectId : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    data: utf8Encode(json),
  };
}

/** 回执 → wire `Ack`（`data` 走 JSON 字节） */
export function toWireAck(ack: FleetAckPayload): Ack {
  return {
    reqId: ack.reqId,
    type: ack.type,
    ok: ack.ok,
    error: ack.error,
    data: ack.data === undefined ? undefined : utf8Encode(JSON.stringify(ack.data)),
  };
}

/**
 * 回执 JSON 的单帧安全上限。
 *
 * 帧上限（16MB）是为聊天附件预留的；回执不需要那么大，这里仍按 4MB 控制，
 * 避免一次 `get_events` / `read_file` 的大结果把终端内存顶上去。
 * 留 64KB 余量：payload 外面还有帧头与 protobuf 的 tag/length 开销，
 * 真正的意义是让「刚好卡在边界」的结果不至于因为包装而越界。
 */
export const ACK_JSON_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * 把回执收进单帧：过大时降级为一条**明确的错误回执**。
 *
 * 为什么需要：`encodeFrame` 对超限载荷是**抛错**，而这条路径上的异常会被写链的
 * `.catch()` 吞掉 —— 控制台侧表现为「指令没有回执」，只能干等到 15s 超时，
 * 用户看到的是「操作超时」，无从知道真实原因是结果太大。降级成错误回执后，
 * 失败原因能直接显示在界面上。
 *
 * 只检查 `ok && 有 data` 的回执：失败回执本身很小，没必要每条都量一遍字节数。
 *
 * `json` 由调用方传入（它已经为日志序列化过一次），避免大对象重复 stringify。
 */
export function guardAckSize(ack: FleetAckPayload, json: string): FleetAckPayload {
  if (!ack.ok || ack.data === undefined) return ack;
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= ACK_JSON_MAX_BYTES) return ack;
  return {
    reqId: ack.reqId,
    type: ack.type,
    ok: false,
    // 带上实际大小：用户据此能判断「差一点」还是「差很多」，而不是只看到「失败」
    error: `结果过大（${mb(bytes)} MB），超过单帧传输上限（${mb(ACK_JSON_MAX_BYTES)} MB），请缩小范围后重试`,
  };
}

/**
 * wire 指令 → 内部 `FleetCmdEnvelope`。
 *
 * `sig` 置空：wire 的签名是对 protobuf 字节的 HMAC，与 JSON 规范形的 base64url
 * 签名不是同一个值，**已在传输层用 `verifyEnvelope` 校验**。这里保留空串是为了
 * 满足内部类型的形状；下游（`FleetCommands`）不读取该字段。
 */
export function fromWireCommand(env: Envelope): FleetCmdEnvelope {
  let payload: Record<string, unknown> = {};
  if (env.payload && env.payload.length > 0) {
    try {
      const parsed: unknown = JSON.parse(utf8Decode(env.payload));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // 载荷非 JSON：保持空对象，交由 FleetCommands 报「参数缺失」
    }
  }
  return {
    t: env.t,
    nonce: env.nonce,
    reqId: env.reqId,
    type: env.type as FleetCmdEnvelope["type"],
    clientId: env.clientId,
    nodeId: env.nodeId,
    projectId: env.projectId || undefined,
    sessionId: env.sessionId || undefined,
    payload,
    sig: "",
  };
}

// ===================== 帧打包（WSS 用） =====================

/** 把上行消息编码为「帧类型 + 帧字节」；无法编码时返回 null（调用方留痕并跳过） */
export function encodeOutbound(msg: FleetOutbound, nodeId: string): Uint8Array | null {
  let type: number;
  let payload: Uint8Array;
  switch (msg.kind) {
    case "status":
      type = FrameType.STATUS;
      payload = encodeStatus(toWireStatus(msg.status));
      break;
    case "info": {
      type = FrameType.INFO;
      payload = encodeInfo(toWireInfo(msg.blob, nodeId));
      break;
    }
    case "event": {
      const ev = toWireEvent(msg.json);
      if (!ev) return null;
      type = FrameType.EVENT;
      payload = encodeEvent(ev);
      break;
    }
    case "notify": {
      const n = toWireNotify(msg.json);
      if (!n) return null;
      type = FrameType.NOTIFY;
      payload = encodeNotify(n);
      break;
    }
    case "ack":
      type = FrameType.ACK;
      payload = encodeAck(toWireAck(msg.ack));
      break;
  }
  return encodeFrame({ type, seq: 0, payload });
}

/** 把 `Envelope` 打成 CMD 帧（供测试与将来的网关内联场景使用） */
export function encodeCmdFrame(env: Envelope): Uint8Array {
  return encodeFrame({ type: FrameType.CMD, seq: 0, payload: encodeEnvelope(env) });
}
