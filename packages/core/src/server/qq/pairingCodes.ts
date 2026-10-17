/**
 * QQ 配对码存储（内存态，单次消费、短时有效）
 *
 * 管理员通过 REST API 为某个租户生成配对码，用户在 QQ 内发 `/bind <code>`
 * 完成「QQ 会话 → 租户」绑定。配对码单次使用、5 分钟过期，避免 apiKey 明文
 * 出现在聊天记录中。
 */
import * as crypto from "crypto";

/** 默认有效期：5 分钟 */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

interface Entry {
  tenantId: string;
  expiresAt: number;
}

/** 生成易读、无易混淆字符的短码（base32，大写） */
function randomCode(len = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I/O/0/1
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i]! % alphabet.length]!;
  }
  return out;
}

export class PairingCodeStore {
  private readonly codes = new Map<string, Entry>();

  constructor(private readonly ttlMs = PAIRING_CODE_TTL_MS) {}

  /** 为租户生成配对码，返回码与有效期（秒） */
  issue(tenantId: string): { code: string; expiresIn: number } {
    this.prune();
    const code = randomCode();
    this.codes.set(code, { tenantId, expiresAt: Date.now() + this.ttlMs });
    return { code, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  /** 消费配对码，返回租户 ID；无效/过期返回 null（单次使用） */
  consume(code: string): string | null {
    this.prune();
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.tenantId;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }
}
