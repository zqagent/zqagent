/**
 * 租户认证
 *
 * 多租户隔离的第一道边界：`Authorization: Bearer <apiKey>` 解析出
 * 租户 ID。所有 API 请求（除健康检查外）都必须携带有效 Key。
 */
import type { IncomingMessage } from "http";
import * as crypto from "crypto";
import type { Store } from "./store.js";
import type { TenantConfig } from "./types.js";

/** 从请求头解析 API Key，找不到返回 null */
export function extractApiKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

/** 按 API Key 查找租户 */
export function authenticate(store: Store, apiKey: string): TenantConfig | null {
  for (const id of store.listTenants()) {
    const tenant = store.loadTenant(id);
    if (tenant && tenant.apiKey === apiKey) return tenant;
  }
  return null;
}

/** 常量时间比较：判断是否为管理员密钥（空密钥一律 false） */
export function isAdminKey(adminKey: string | null | undefined, apiKey: string): boolean {
  if (!adminKey || !apiKey) return false;
  const a = Buffer.from(adminKey, "utf8");
  const b = Buffer.from(apiKey, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从请求头读取控制台选中的项目（管理员凭此在任意项目上操作） */
export function extractProjectId(req: IncomingMessage): string | null {
  const raw = req.headers["x-project-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v.trim() ? v.trim() : null;
}
