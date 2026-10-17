/**
 * 共享通用工具（节点管理协议与 MQTT 相关）
 *
 * 从 v1 协议层抽出，供节点管理协议（node 与 hub 共用）使用，避免 shared 依赖 core。
 */
import * as crypto from "crypto";

/** 时间戳允许的最大时钟偏差（毫秒） */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** 生成高熵随机 token（base64url，默认 32 字节） */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** 时间戳是否在允许窗口内（防重放） */
export function isFreshTimestamp(
  t: number,
  now = Date.now(),
  skewMs = DEFAULT_CLOCK_SKEW_MS,
): boolean {
  return typeof t === "number" && Number.isFinite(t) && Math.abs(now - t) <= skewMs;
}

/**
 * 一次性 nonce 去重器：记录已见 nonce（带过期清理），拒绝重放。
 * 每个 MQTT 连接（租户/节点）持有一个实例。
 */
export class NonceTracker {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_CLOCK_SKEW_MS * 5) {}

  /** 返回 true 表示首次见到（可用）；false 表示重放 */
  checkAndRecord(nonce: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }

  private prune(now: number): void {
    for (const [k, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(k);
    }
  }
}
