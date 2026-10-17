/**
 * QQ 多租户绑定映射
 *
 * 记录「QQ 会话（单聊/群聊/频道）」↔「zqagent 租户 + 会话」的对应关系，
 * 落盘到 {DATA_DIR}/qq/bindings.json。每个 QQ 会话最多绑定一个租户，
 * 绑定后首次任务时创建 zqagent session 并记录 sessionId。
 */
import * as fs from "fs";
import * as path from "path";
import type { QqTarget } from "./types.js";

/** 单个 QQ 会话的绑定记录 */
export interface ConversationBinding {
  tenantId: string;
  /** 已建立的 zqagent 会话 ID；null 表示已绑定租户但尚未创建会话 */
  sessionId: string | null;
  updatedAt: string;
}

/** 绑定映射表 */
export interface QqBindings {
  conversations: Record<string, ConversationBinding>;
}

/** 由消息目标生成会话键（稳定、可逆） */
export function conversationKey(target: QqTarget): string {
  switch (target.kind) {
    case "c2c":
      return `u:${target.openid}`;
    case "group":
      return `g:${target.groupOpenid}`;
    case "channel":
      return `c:${target.channelId}`;
    case "guild_direct":
      return `d:${target.guildId}`;
  }
}

/** 由会话键反推消息目标（用于通知回发） */
export function targetFromKey(key: string): QqTarget | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  switch (kind) {
    case "u":
      return { kind: "c2c", openid: id };
    case "g":
      return { kind: "group", groupOpenid: id };
    case "c":
      return { kind: "channel", channelId: id };
    case "d":
      return { kind: "guild_direct", guildId: id };
    default:
      return null;
  }
}

/** 绑定映射持久化存储 */
export class QqBindingsStore {
  private cache: QqBindings | null = null;

  constructor(private readonly file: string) {}

  /** 基于 DATA_DIR 构造 */
  static in(dataDir: string): QqBindingsStore {
    return new QqBindingsStore(path.join(dataDir, "qq", "bindings.json"));
  }

  load(): QqBindings {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as QqBindings;
      this.cache = {
        conversations: raw.conversations ?? {},
      };
    } catch {
      this.cache = { conversations: {} };
    }
    return this.cache;
  }

  get(key: string): ConversationBinding | null {
    return this.load().conversations[key] ?? null;
  }

  set(key: string, binding: Omit<ConversationBinding, "updatedAt">): void {
    const b = this.load();
    b.conversations[key] = { ...binding, updatedAt: new Date().toISOString() };
    this.persist();
  }

  delete(key: string): void {
    const b = this.load();
    delete b.conversations[key];
    this.persist();
  }

  /** 反查：由租户+会话找到绑定键（用于通知回发） */
  findByTenantSession(tenantId: string, sessionId: string): string | null {
    for (const [key, binding] of Object.entries(this.load().conversations)) {
      if (binding.tenantId === tenantId && binding.sessionId === sessionId) {
        return key;
      }
    }
    return null;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf-8");
  }
}
