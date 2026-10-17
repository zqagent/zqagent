/**
 * WSS 链路客户端（去 EMQX：节点直连 Rust 网关的二进制 WSS）
 *
 * 职责边界刻意收得很窄——**只做连接与帧 I/O**，不碰业务：
 *
 *   - 握手：AUTH 帧（HMAC-SHA256）→ 等 AUTH_OK；
 *   - 保活：固定节拍 PING，收 PONG；超过 idle 判定链路死亡；
 *   - 断线重连：指数退避 + 抖动（见 §「重连退避为什么不能固定 3s」）；
 *   - 入站：解码帧 → CMD 交给 `onCommand`，PONG 更新存活时间，其余留给 `onFrame`。
 *
 * 刻意**不在这里**做的事（都由 `FleetNodeBridge` 负责）：
 * 指令签名校验、nonce 去重、只读并发池、回执构造 —— 那些已有成熟实现，
 * 且测试直接覆盖（`fleetReadonlyConcurrency.test.ts` 强转实例覆写 `_dispatch`），
 * 搬到本文件会破坏那个接缝。
 *
 * ## 与 MQTT 的语义差异（都不是「退化」，是换了实现方式）
 *
 * | MQTT | 本实现 |
 * | --- | --- |
 * | 遗嘱 LWT（broker 代发 offline） | socket 关闭 + 网关心跳超时 |
 * | retained status/info | 网关持有权威 states，连接建立时推 SNAPSHOT |
 * | SUBSCRIBE 一次拿全量 | 无需订阅：网关按 nodeId 路由到唯一连接 |
 * | QoS 1 重传（broker 保证） | 应用层回执 + reqId 幂等（网关侧 pending 表） |
 *
 * ## 重连退避为什么不能固定 3s
 *
 * MQTT 时代固定 3s 重连没问题：broker 由 EMQX 承担，连接数分散在多节点上。
 * 现在网关重启会让**所有节点同时重连**——固定间隔会把重连风暴原样重放给网关。
 * 因此改为指数退避 + 抖动：把上万个节点的重连时刻摊开在一个窗口里。
 *
 * 规范：docs/wire-protocol.md　契约：proto/fleet.proto
 */
import WebSocket from "ws";
import {
  FrameType,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeEnvelope,
  encodeAuth,
  encodeFrame,
  frameTypeName,
  type Auth,
  type Envelope,
} from "@zqagent/shared/wire";
import { signAuth, verifyEnvelope } from "@zqagent/shared/wire/node";

/** 保活节拍（毫秒）。与 MQTT 时代的 keepalive=15s 对齐 */
const DEFAULT_PING_MS = 15_000;
/** 多久收不到任何帧就判定链路死亡并重连（3× ping，与 MQTT keepalive×1.5~3 同量级） */
const DEFAULT_IDLE_MS = 45_000;
/** 握手超时 */
const AUTH_TIMEOUT_MS = 10_000;
/** 重连退避：起始 / 上限 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface WssLinkOptions {
  /** 网关地址，如 wss://gw.example.com/ws 或 ws://127.0.0.1:8790/ws */
  url: string;
  /** 节点 ID（同时也作为 AUTH 的身份） */
  nodeId: string;
  /** 舰队签名密钥（HMAC-SHA256） */
  fleetSecret: string;
  /** 客户端标识（仅上报，便于现场排查） */
  client?: string;
  /** 保活节拍（毫秒） */
  pingMs?: number;
  /** 静默判定阈值（毫秒） */
  idleMs?: number;
  /** 上层可传 TLS 相关选项（透传给 ws） */
  ca?: Buffer | string;
  cert?: Buffer | string;
  key?: Buffer | string;
  /** 连接建立（握手成功） */
  onReady?: () => void;
  /** 链路断开（任何原因：错误/关闭/静默超时） */
  onDown?: (reason: string) => void;
  /**
   * 收到指令帧。**已验证签名**——校验失败不会调用本回调。
   * 校验失败时调用 `onReject`（便于留痕，但默认静默，与 MQTT 行为一致）。
   */
  onCommand?: (env: Envelope) => void;
  /** 指令校验失败（签名/nonce/节点不匹配） */
  onReject?: (reason: string, env: Envelope) => void;
  /** 其他帧（SNAPSHOT/STATUS/…）的旁路观察点，便于测试与诊断 */
  onFrame?: (type: number, payload: Uint8Array) => void;
  /** 发送前的最终机会（测试注入用）；返回 null 表示按原样发送 */
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * 节点与网关之间的二进制 WSS 链路。
 *
 * 一个实例对应**一条**逻辑连接（内部自行重连），构造后调 `start()`。
 */
export class WssLink {
  private ws: WebSocket | null = null;
  /** 握手是否已完成（收到 AUTH_OK） */
  private ready = false;
  /** 是否已成功握手过（区分「一直连不上」与「连上后断开」） */
  private everReady = false;
  /** 停止标记：stop() 之后不再重连 */
  private stopped = false;
  /** 当前重连退避（成功后重置） */
  private backoffMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次收到任何帧的时刻（判静默） */
  private lastInboundAt = Date.now();
  /** 已观测到的 nonce（防重放；与 MQTT 链路同一策略） */
  private readonly seenNonces = new Set<string>();
  private readonly nonceOrder: string[] = [];
  private downSince: number | null = null;

  constructor(private readonly opts: WssLinkOptions) {}

  isReady(): boolean {
    return this.ready;
  }

  /** 最近一次断开时长（毫秒）；当前在线则为 0 —— 供日志与诊断 */
  downMs(): number {
    return this.downSince ? Date.now() - this.downSince : 0;
  }

  start(): void {
    this.stopped = false;
    this._connect();
  }

  stop(): void {
    this.stopped = true;
    this._clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      // 先摘 listener 再关闭：避免 close 事件把 _noteDown 再跑一遍（重复日志）
      ws.removeAllListeners();
      try {
        ws.close(1000, "node shutting down");
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 发送一个已编码的帧；socket 未打开时返回 false。
   *
   * 注意**不能**用 `ready` 做门槛：AUTH 帧必须在握手完成**之前**发出，否则永远
   * 等不到 AUTH_OK。业务帧的「是否已就绪」由上层（`FleetNodeBridge.connected`）把关。
   */
  send(frame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private _log(msg: string): void {
    (this.opts.logger ?? console).info(msg);
  }

  private _warn(msg: string): void {
    (this.opts.logger ?? console).warn(msg);
  }

  private _connect(): void {
    if (this.stopped) return;
    const { url } = this.opts;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        ...(this.opts.ca || this.opts.cert || this.opts.key
          ? { ca: this.opts.ca, cert: this.opts.cert, key: this.opts.key }
          : {}),
      });
    } catch (e) {
      // URL 非法等：重试没有意义，直接报错退出
      this._warn(`[fleet] 节点 ${this.opts.nodeId} 无法创建 WSS 连接（${url}）: ${errText(e)}`);
      return;
    }
    this.ws = ws;
    this.lastInboundAt = Date.now();

    ws.on("open", () => this._sendAuth());
    ws.on("message", (data) => this._onMessage(data));
    ws.on("error", (e) => this._warn(`[fleet] WSS 错误: ${errText(e)}`));
    ws.on("close", (code, reason) => {
      this._noteDown(`close(code=${code}${reason?.length ? `, ${reason.toString()}` : ""})`);
    });
  }

  private _sendAuth(): void {
    const auth: Auth = {
      id: this.opts.nodeId,
      ts: Date.now(),
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      proto: PROTOCOL_VERSION,
      kind: "node",
      client: this.opts.client ?? "zqagent-node",
      token: new Uint8Array(0),
    };
    const signed = signAuth(this.opts.fleetSecret, auth);
    const frame = encodeFrame({
      type: FrameType.AUTH,
      seq: 0,
      payload: encodeAuth(signed),
    });
    // 握手超时兜底：网关侧也会超时断开，这里主动收敛以便走统一的重连路径
    this.authTimer = setTimeout(() => {
      if (!this.ready) this._noteDown("auth timeout");
    }, AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();
    this.send(frame);
  }

  private _onMessage(data: WebSocket.RawData): void {
    this.lastInboundAt = Date.now();
    let bytes: Uint8Array;
    try {
      bytes = toBytes(data);
    } catch {
      return;
    }
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (e) {
      this._warn(`[fleet] 收到非法帧，已丢弃: ${errText(e)}`);
      return;
    }

    switch (frame.type) {
      case FrameType.AUTH_OK:
        this._onReady();
        return;
      case FrameType.PING:
        // 网关侧心跳：回 PONG 即可
        this.send(encodeFrame({ type: FrameType.PONG, seq: 0, payload: new Uint8Array(0) }));
        return;
      case FrameType.PONG:
        return;
      case FrameType.CMD: {
        const env = this._verifyCommand(frame.payload);
        if (env) this.opts.onCommand?.(env);
        return;
      }
      default:
        this.opts.onFrame?.(frame.type, frame.payload);
    }
  }

  /**
   * 校验指令：签名（对 protobuf 字节的 HMAC）+ 目标节点 + nonce 去重。
   *
   * 时间戳窗口**交给网关**：网关在握手与路由时已校验，节点侧再算一次只会引入
   * 时钟偏差导致的双向不一致。签名本身已保证不可伪造。
   */
  private _verifyCommand(payload: Uint8Array): Envelope | null {
    let env: Envelope;
    try {
      env = decodeEnvelope(payload);
    } catch (e) {
      this._reject(`载荷非法: ${errText(e)}`, null);
      return null;
    }
    if (env.nodeId !== this.opts.nodeId) {
      this._reject(`目标节点不匹配（${env.nodeId}）`, env);
      return null;
    }
    if (!verifyEnvelope(this.opts.fleetSecret, env)) {
      this._reject("签名校验失败", env);
      return null;
    }
    if (!this._recordNonce(env.nonce)) {
      this._reject(`nonce 重放（${env.nonce}）`, env);
      return null;
    }
    return env;
  }

  private _reject(reason: string, env: Envelope | null): void {
    if (this.opts.onReject && env) {
      this.opts.onReject(reason, env);
      return;
    }
    // 与 MQTT 链路一致：静默丢弃，避免伪造流量刷爆日志
  }

  /** nonce 去重（上限 4096，FIFO 淘汰；重放窗口远小于此） */
  private _recordNonce(nonce: string): boolean {
    if (!nonce) return false;
    if (this.seenNonces.has(nonce)) return false;
    this.seenNonces.add(nonce);
    this.nonceOrder.push(nonce);
    if (this.nonceOrder.length > 4096) {
      const old = this.nonceOrder.shift();
      if (old) this.seenNonces.delete(old);
    }
    return true;
  }

  private _onReady(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.ready = true;
    this.everReady = true;
    this.backoffMs = RECONNECT_MIN_MS;
    if (this.downSince !== null) {
      const down = Math.round(this.downMs() / 1000);
      this._log(`[fleet] 节点 ${this.opts.nodeId} WSS 已恢复连接（断连约 ${down}s）`);
    } else {
      this._log(`[fleet] 节点 ${this.opts.nodeId} WSS 已连接（网关: ${this.opts.url}）`);
    }
    this.downSince = null;
    this._startPing();
    this.opts.onReady?.();
  }

  private _startPing(): void {
    if (this.pingTimer) return;
    const pingMs = this.opts.pingMs ?? DEFAULT_PING_MS;
    const idleMs = this.opts.idleMs ?? DEFAULT_IDLE_MS;
    this.pingTimer = setInterval(() => {
      if (!this.ready) return;
      // 静默判定：连网关的 PING 都不回，说明链路已死（NAT 掉线/对端崩溃且未发 FIN）
      if (Date.now() - this.lastInboundAt > idleMs) {
        this._noteDown(`idle > ${idleMs}ms`);
        return;
      }
      this.send(encodeFrame({ type: FrameType.PING, seq: 0, payload: new Uint8Array(0) }));
    }, pingMs);
    this.pingTimer.unref?.();
  }

  /** 链路断开：置状态、通知上层、安排重连 */
  private _noteDown(reason: string): void {
    const wasReady = this.ready;
    this.ready = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        /* 忽略 */
      }
    }
    if (this.downSince === null) this.downSince = Date.now();
    if (wasReady) {
      this.opts.onDown?.(reason);
    }
    this._scheduleReconnect();
  }

  /**
   * 指数退避 + 抖动。
   *
   * 抖动是必须的：网关重启后所有节点会在同一瞬间开始重连，固定退避会让它们
   * 每一轮都**同时**重试（周期性冲击）。随机化把重试时刻摊开。
   */
  private _scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(this.backoffMs, RECONNECT_MAX_MS);
    // 全抖动（0.5~1.5 倍）：既保持退避趋势，又打散同时刻重连
    const jittered = Math.round(base * (0.5 + Math.random()));
    this.backoffMs = Math.min(base * 2, RECONNECT_MAX_MS);
    if (!this.everReady) {
      // 首连失败也留痕（否则「一直连不上」在现场毫无线索）
      this._warn(
        `[fleet] 节点 ${this.opts.nodeId} WSS 未连接（${this.opts.url}），${jittered}ms 后重试`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  private _clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }
}

// ===================== 小工具 =====================

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** ws 的 RawData（Buffer | ArrayBuffer | Buffer[]）→ Uint8Array（零拷贝优先） */
function toBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const total = data.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of data) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }
  // Buffer 是 Uint8Array 子类；注意 ws 可能给出「大 Buffer 的视图」，
  // 必须按 byteOffset/byteLength 取视图，否则会带上池化分配的多余字节。
  const buf = data as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 延迟 import 避免循环依赖：`decodeEnvelope` 只在真正收到 CMD 时才需要 */
function decodeEnvelopeSafe(payload: Uint8Array): Envelope {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decodeEnvelope } = require("@zqagent/shared/wire") as typeof import("@zqagent/shared/wire");
  return decodeEnvelope(payload);
}

/** 帧类型名（诊断日志用） */
export function frameName(type: number): string {
  return frameTypeName(type as Parameters<typeof frameTypeName>[0]);
}
