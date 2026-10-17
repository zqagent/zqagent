/**
 * 更新清单的签名校验（Ed25519）。
 *
 * 签名方案：对清单原始字节做 Ed25519 签名，签名以 base64 存于同名 `.sig` 文件。
 * 公钥通过 `ZQAGENT_UPDATE_PUBKEY` 提供（PEM 或 base64 的 SPKI DER）。
 * 未配置公钥时**禁用自动更新**——无法验签就不能替用户改可执行文件。
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** 从 PEM 或 base64(SPKI DER) 解析公钥；失败返回 null */
export function parsePublicKey(input: string): KeyObject | null {
  const text = input.trim();
  if (!text) return null;
  try {
    if (text.includes("BEGIN PUBLIC KEY")) {
      return createPublicKey({ key: text, format: "pem" });
    }
    return createPublicKey({
      key: Buffer.from(text, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/** 校验 `data` 的签名；任何异常都按失败处理 */
export function verifySignature(
  data: Buffer | Uint8Array,
  signatureBase64: string,
  publicKey: KeyObject,
): boolean {
  try {
    const sig = Buffer.from(signatureBase64.trim(), "base64");
    if (sig.length !== 64) return false;
    return verify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}
