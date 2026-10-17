/**
 * 线协议签名（Node 侧，node:crypto）
 *
 * 规范见 docs/wire-protocol.md §2：sig = HMAC-SHA256(fleetSecret, 不含 sig 的编码字节)。
 * 浏览器/小程序侧不可引入 node:crypto，用 Web Crypto 对 `signableBytes()` 做同样的运算。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Auth, Envelope } from "./messages.js";
import { signableAuthBytes, signableBytes } from "./messages.js";

/** HMAC-SHA256 原始 32 字节 */
export function hmacSha256(secret: string | Uint8Array, data: Uint8Array): Uint8Array {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  const mac = createHmac("sha256", key).update(data).digest();
  return new Uint8Array(mac);
}

/** 计算并写入签名（返回新对象） */
export function signEnvelope(secret: string | Uint8Array, env: Envelope): Envelope {
  return { ...env, sig: hmacSha256(secret, signableBytes(env)) };
}

/** 常量时间校验签名 */
export function verifyEnvelope(secret: string | Uint8Array, env: Envelope): boolean {
  const sig = env.sig;
  if (!sig || sig.length !== 32) return false;
  const expected = hmacSha256(secret, signableBytes(env));
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// ===================== 握手认证（M2） =====================

/** 计算并写入握手认证 token（节点面：以 fleetSecret 为密钥） */
export function signAuth(secret: string | Uint8Array, auth: Auth): Auth {
  return { ...auth, token: hmacSha256(secret, signableAuthBytes(auth)) };
}

/** 常量时间校验握手 token */
export function verifyAuth(secret: string | Uint8Array, auth: Auth): boolean {
  const token = auth.token;
  if (!token || token.length !== 32) return false;
  const expected = hmacSha256(secret, signableAuthBytes(auth));
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
