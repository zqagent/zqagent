/**
 * 线协议 v1：帧 + 消息编解码（node: 无依赖）
 *
 * 权威契约见 proto/fleet.proto，规范见 docs/wire-protocol.md。
 *
 * 本模块**平台中立**：只用 `Uint8Array`，不 import 任何 Node 内置模块，因此
 * Node（节点/core/hub）、浏览器（console-core/portal）、小程序三处共用同一份实现。
 * 平台相关的部分只有签名——Node 侧见 `./node.js`，浏览器/小程序侧用 Web Crypto。
 */
export {
  Writer,
  Reader,
  WireError,
  WIRE_VARINT,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_LEN,
  EMPTY_BYTES,
} from "./varint.js";
export {
  FRAME_MAGIC,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  FrameType,
  FrameError,
  encodeFrame,
  decodeFrame,
  frameTypeName,
  frameTypeFromName,
  type Frame,
  type FrameTypeName,
  type FrameTypeValue,
} from "./frame.js";
export {
  encodeEnvelope,
  decodeEnvelope,
  signableBytes,
  encodeAck,
  decodeAck,
  encodeStatus,
  decodeStatus,
  encodeEvent,
  decodeEvent,
  encodeInfo,
  decodeInfo,
  encodeNotify,
  decodeNotify,
  encodeTerminalData,
  decodeTerminalData,
  encodeAuth,
  decodeAuth,
  signableAuthBytes,
  encodeAuthOk,
  decodeAuthOk,
  encodeNodeState,
  decodeNodeState,
  encodeSnapshot,
  decodeSnapshot,
  encodeSubscribe,
  decodeSubscribe,
  encodeUnsubscribe,
  decodeUnsubscribe,
  encodeResume,
  decodeResume,
  type Envelope,
  type Ack,
  type Status,
  type EventMsg,
  type Info,
  type NotifyMsg,
  type TerminalData,
  type Auth,
  type AuthOk,
  type NodeState,
  type Snapshot,
} from "./messages.js";
export { utf8Encode, utf8Decode, Utf8Error } from "./utf8.js";
export { toHex, fromHex } from "./hex.js";
