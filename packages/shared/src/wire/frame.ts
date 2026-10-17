/**
 * 帧编解码（magic + ver/type + seq + len + payload）
 *
 * 规范见 docs/wire-protocol.md §1/§6。节点面与终端面共用同一套帧。
 */
import { Reader, Writer, WireError } from "./varint.js";

/** ASCII "ZQ"：用于在公网暴露面上廉价丢弃非法流量 */
export const FRAME_MAGIC = [0x5a, 0x51] as const;
export const PROTOCOL_VERSION = 1;
/** 载荷上限：现状节点侧上报上限约 3.5 MB（FleetNodeBridge.ts:53,992-996） */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 帧类型（低 4 位）。M1 已实现载荷的消息见 docs/wire-protocol.md §3 */
export const FrameType = {
  HELLO: 0,
  AUTH: 1,
  SNAPSHOT: 2,
  STATUS: 3,
  INFO: 4,
  EVENT: 5,
  NOTIFY: 6,
  CMD: 7,
  ACK: 8,
  SUBSCRIBE: 9,
  UNSUBSCRIBE: 10,
  RESUME: 11,
  PING: 12,
  PONG: 13,
  /** 握手结果（服务端 → 客户端）。与 AUTH 分开，避免「同类型双向」的解析歧义 */
  AUTH_OK: 14,
} as const;
export type FrameTypeName = keyof typeof FrameType;
export type FrameTypeValue = (typeof FrameType)[FrameTypeName];

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export interface Frame {
  type: FrameTypeValue;
  /** 单调递增序号（用于去重与断线续传定位） */
  seq: number;
  payload: Uint8Array;
}

/** 帧头长度下界：magic(2) + ver/type(1) + seq(≥1) + len(≥1) */
const MIN_HEADER_BYTES = 5;

export function encodeFrame(frame: {
  type: number;
  seq: number;
  payload: Uint8Array;
}): Uint8Array {
  if (!Number.isInteger(frame.type) || frame.type < 0 || frame.type > 15) {
    throw new FrameError(`非法帧类型: ${frame.type}`);
  }
  if (frame.payload.length > MAX_FRAME_BYTES) {
    throw new FrameError(`载荷超限: ${frame.payload.length} > ${MAX_FRAME_BYTES}`);
  }
  const w = new Writer(frame.payload.length + MIN_HEADER_BYTES);
  w.u8(FRAME_MAGIC[0]);
  w.u8(FRAME_MAGIC[1]);
  w.u8((PROTOCOL_VERSION << 4) | frame.type);
  w.varint(frame.seq);
  w.varint(frame.payload.length);
  w.raw(frame.payload);
  return w.finish();
}

/**
 * 解码入口：**先校验头部再分配**——`len` 在分配/切分前就与实际上限和剩余字节比对，
 * 避免畸形头部引发的大内存分配。
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < MIN_HEADER_BYTES) {
    throw new FrameError(`帧过短: ${bytes.length} 字节`);
  }
  if (bytes[0] !== FRAME_MAGIC[0] || bytes[1] !== FRAME_MAGIC[1]) {
    throw new FrameError("magic 不符（非本协议流量）");
  }
  const verType = bytes[2]!;
  const version = verType >> 4;
  const type = verType & 0x0f;
  if (version !== PROTOCOL_VERSION) {
    throw new FrameError(`不支持的协议版本: ${version}`);
  }
  if (!KNOWN_TYPES.has(type)) {
    throw new FrameError(`未定义的帧类型: ${type}`);
  }

  let r: Reader;
  let seq: number;
  let len: number;
  try {
    r = new Reader(bytes.subarray(3));
    seq = r.u64();
    len = r.u64();
  } catch (e) {
    throw new FrameError(`帧头解析失败: ${e instanceof WireError ? e.message : String(e)}`);
  }
  if (len > MAX_FRAME_BYTES) {
    throw new FrameError(`载荷超限: ${len} > ${MAX_FRAME_BYTES}`);
  }
  if (r.remaining !== len) {
    throw new FrameError(`len(${len}) 与剩余字节(${r.remaining})不符`);
  }
  const payload = r.take(len);
  return { type: type as FrameTypeValue, seq, payload };
}

/** 帧类型名（日志/向量文件用） */
export function frameTypeName(type: number): FrameTypeName {
  for (const [name, value] of Object.entries(FrameType)) {
    if (value === type) return name as FrameTypeName;
  }
  throw new FrameError(`未定义的帧类型: ${type}`);
}

/** 帧类型名 → 值（向量文件用） */
export function frameTypeFromName(name: string): FrameTypeValue {
  if (!(name in FrameType)) throw new FrameError(`未知帧类型名: ${name}`);
  return FrameType[name as FrameTypeName];
}
