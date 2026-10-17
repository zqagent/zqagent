/**
 * QQ 官方机器人低层客户端（实现 QqClient 接口）
 *
 * 负责与 QQ 开放平台交互：
 *   - access_token 获取与临近过期刷新
 *   - WebSocket 网关连接、心跳、断线 Resume、事件解析
 *   - 按消息目标路由到单聊/群聊/频道发送接口
 *
 * 协议依据（QQ 机器人官方文档，实现时请以官方为准）：
 *   - Token: POST {base}/app/getAppAccessToken { appId, clientSecret } → { access_token, expires_in }
 *   - 鉴权头: Authorization: QQBot {token}
 *   - 网关: GET {base}/gateway → { url }；OpCode 10 Hello → 2 Identify → 0 Dispatch → 1 心跳 → 11 ACK
 *   - 事件: C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / AT_MESSAGE_CREATE / DIRECT_MESSAGE_CREATE
 *   - 发送: /v2/users/{openid}/messages、/v2/groups/{group_openid}/messages、
 *           /channels/{channel_id}/messages、/dms/{guild_id}/messages
 */
import WebSocket from "ws";
import type {
  QqClient,
  QqMessage,
  QqMessageHandler,
  QqStatusHandler,
  QqTarget,
} from "./types.js";

export interface OfficialBotOptions {
  appId: string;
  appSecret: string;
  /** 沙箱环境（API base 指向 sandbox） */
  sandbox?: boolean;
  /** 订阅 intents，默认 GROUP_AND_C2C_EVENT | PUBLIC_GUILD_MESSAGES | DIRECT_MESSAGE */
  intents?: number;
}

/** 默认 intents：单聊+群聊(1<<25) | 频道公域@(1<<30) | 频道私信(1<<12) */
const DEFAULT_INTENTS = (1 << 25) | (1 << 30) | (1 << 12);

/** 去重缓存上限（超出整体清空，事件按 seq 单调递进） */
const DEDUP_MAX = 2000;

/** 网关消息结构（payload） */
interface GatewayPayload {
  op: number;
  d?: Record<string, unknown>;
  s?: number | null;
  t?: string;
}

/** 从平台事件 d 提取归一化消息；不匹配返回 null */
export function parseMessageEvent(
  t: string,
  d: Record<string, unknown>,
): QqMessage | null {
  const id = typeof d["id"] === "string" ? d["id"] : "";
  const content = typeof d["content"] === "string" ? d["content"] : "";
  if (!id || !content) return null;

  const author =
    d["author"] && typeof d["author"] === "object"
      ? (d["author"] as Record<string, unknown>)
      : {};
  const senderId = String(
    author["user_openid"] ?? author["member_openid"] ?? author["id"] ?? "",
  );

  let target: QqTarget;
  switch (t) {
    case "C2C_MESSAGE_CREATE": {
      const openid = String(author["user_openid"] ?? author["id"] ?? "");
      if (!openid) return null;
      target = { kind: "c2c", openid };
      break;
    }
    case "GROUP_AT_MESSAGE_CREATE": {
      const groupOpenid = String(d["group_openid"] ?? "");
      if (!groupOpenid) return null;
      target = { kind: "group", groupOpenid };
      break;
    }
    case "AT_MESSAGE_CREATE": {
      const channelId = String(d["channel_id"] ?? "");
      if (!channelId) return null;
      target = { kind: "channel", channelId };
      break;
    }
    case "DIRECT_MESSAGE_CREATE": {
      const guildId = String(d["guild_id"] ?? "");
      if (!guildId) return null;
      target = { kind: "guild_direct", guildId };
      break;
    }
    default:
      return null;
  }

  return { eventId: id, content, target, msgId: id, senderId };
}

export class OfficialBotClient implements QqClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatInterval = 45_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  private connected = false;
  private readonly seen = new Set<string>();
  private readonly messageHandlers: QqMessageHandler[] = [];
  private readonly statusHandlers: QqStatusHandler[] = [];

  constructor(private readonly opts: OfficialBotOptions) {}

  private get apiBase(): string {
    return this.opts.sandbox
      ? "https://sandbox.api.bot.qq.com"
      : "https://api.bot.qq.com";
  }

  onMessage(handler: QqMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onStatus(handler: QqStatusHandler): void {
    this.statusHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connect();
  }

  stop(): void {
    this.started = false;
    this._clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    this._setConnected(false);
  }

  async send(target: QqTarget, content: string, msgId?: string): Promise<void> {
    const token = await this.fetchAccessToken();
    const headers = {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    };

    let url: string;
    let body: Record<string, unknown>;
    switch (target.kind) {
      case "c2c":
        url = `${this.apiBase}/v2/users/${encodeURIComponent(target.openid)}/messages`;
        body = { content, msg_type: 0, ...(msgId ? { msg_id: msgId } : {}) };
        break;
      case "group":
        url = `${this.apiBase}/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages`;
        body = { content, msg_type: 0, ...(msgId ? { msg_id: msgId } : {}) };
        break;
      case "channel":
        url = `${this.apiBase}/channels/${encodeURIComponent(target.channelId)}/messages`;
        body = { content, ...(msgId ? { msg_id: msgId } : {}) };
        break;
      case "guild_direct":
        url = `${this.apiBase}/dms/${encodeURIComponent(target.guildId)}/messages`;
        body = { content, ...(msgId ? { msg_id: msgId } : {}) };
        break;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`发送消息失败 HTTP ${res.status}: ${await res.text()}`);
    }
  }

  // ===================== Token =====================

  private async fetchAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) return this.token;

    const res = await fetch(`${this.apiBase}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.opts.appId,
        clientSecret: this.opts.appSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`获取 access_token 失败 HTTP ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in ?? 7200) * 1000;
    return this.token;
  }

  // ===================== 网关连接 =====================

  private async connect(): Promise<void> {
    try {
      const token = await this.fetchAccessToken();
      const gwRes = await fetch(`${this.apiBase}/gateway`, {
        headers: { Authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const gw = (await gwRes.json()) as { url?: string };
      const url = gw.url ?? "wss://api.bot.qq.com/websocket";

      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => this._setConnected(true));
      ws.on("message", (data) => this._handleGateway(ws, data.toString()));
      ws.on("close", () => this._handleClose());
      ws.on("error", (err) =>
        console.log(`[qq] 网关连接错误: ${err.message ?? String(err)}`),
      );
    } catch (e) {
      console.log(`[qq] 连接失败: ${e instanceof Error ? e.message : String(e)}`);
      this._scheduleReconnect();
    }
  }

  private _handleGateway(ws: WebSocket, raw: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }

    switch (payload.op) {
      case 10: {
        // Hello
        const d = payload.d ?? {};
        this.heartbeatInterval =
          typeof d["heartbeat_interval"] === "number"
            ? d["heartbeat_interval"]
            : 45_000;
        if (this.sessionId && this.lastSeq != null) {
          this._send(ws, {
            op: 6,
            d: {
              token: `QQBot ${this.token ?? ""}`,
              session_id: this.sessionId,
              seq: this.lastSeq,
            },
          });
        } else {
          this._send(ws, {
            op: 2,
            d: {
              token: `QQBot ${this.token ?? ""}`,
              intents: this.opts.intents ?? DEFAULT_INTENTS,
              shard: [0, 1],
              properties: { $os: "linux", $browser: "zqagent", $device: "zqagent" },
            },
          });
        }
        this._startHeartbeat(ws);
        break;
      }
      case 0: {
        // Dispatch
        if (typeof payload.s === "number") this.lastSeq = payload.s;
        if (payload.t === "READY") {
          const d = payload.d ?? {};
          if (typeof d["session_id"] === "string") this.sessionId = d["session_id"];
          console.log("[qq] 网关鉴权成功，已就绪");
          return;
        }
        if (payload.t === "RESUMED") {
          console.log("[qq] 会话恢复成功");
          return;
        }
        if (payload.t && payload.d) {
          const msg = parseMessageEvent(payload.t, payload.d);
          if (msg && !this.seen.has(msg.eventId)) {
            this.seen.add(msg.eventId);
            if (this.seen.size > DEDUP_MAX) this.seen.clear();
            for (const h of this.messageHandlers) void h(msg);
          }
        }
        break;
      }
      case 7: {
        // Reconnect：服务端要求重连
        this._scheduleReconnect();
        break;
      }
      case 9: {
        // Invalid Session：需重新鉴权
        this.sessionId = null;
        this.lastSeq = null;
        this._scheduleReconnect();
        break;
      }
    }
  }

  private _send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private _startHeartbeat(ws: WebSocket): void {
    this._clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send(ws, { op: 1, d: this.lastSeq });
    }, this.heartbeatInterval);
    // 避免阻止进程退出
    this.heartbeatTimer.unref?.();
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _handleClose(): void {
    this._clearHeartbeat();
    this._setConnected(false);
    if (this.started) this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) void this.connect();
    }, 3000);
    this.reconnectTimer.unref?.();
  }

  private _setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    for (const h of this.statusHandlers) h(v);
  }
}
