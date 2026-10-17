/**
 * 对称加密共享模块
 *
 * 从 CLI 的 connection.ts 抽出的 AES-256-GCM 加解密实现，供 CLI 与
 * 云端 Server 复用。密文格式 `v1:iv:tag:ciphertext`（均 base64）。
 *
 * 安全说明：这是「本机混淆式加密」（纯 Node 无外部依赖），主密钥与密文
 * 可存于同一台机器，能防止明文泄露 / 被 grep / 误提交，但无法抵御能读取
 * 本机主密钥文件的攻击者（如需 OS 级密钥链，可替换为 keytar / libsecret 等）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** 用给定主密钥做 AES-256-GCM 加密，输出 `v1:iv:tag:ciphertext`（base64） */
export function encryptWithKey(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

/** 用给定主密钥解密；格式非法 / 认证失败返回 null */
export function decryptWithKey(key: Buffer, payload: string): string | null {
  try {
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const data = Buffer.from(parts[3]!, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** 读取或生成主密钥（32 字节随机，权限 600）。文件损坏则重建。 */
export function loadOrCreateMasterKey(masterKeyFile: string): Buffer {
  if (fs.existsSync(masterKeyFile)) {
    const hex = fs.readFileSync(masterKeyFile, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      return Buffer.from(hex, "hex");
    }
    console.warn(`⚠️  主密钥文件损坏，已重新生成（旧密文将无法解密）`);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(masterKeyFile, key.toString("hex"), {
    mode: 0o600,
    encoding: "utf8",
  });
  return key;
}

/** 从 64 位 hex 字符串解析主密钥；非法返回 null */
export function masterKeyFromHex(hex: string): Buffer | null {
  const h = hex.trim();
  return /^[0-9a-f]{64}$/i.test(h) ? Buffer.from(h, "hex") : null;
}

/**
 * 密文工具：持有固定主密钥，对字符串做加解密。
 * CLI 与 Server 各自构造实例（CLI 用 ~/.config/zqagent/secret.key，
 * Server 用 DATA_DIR/secret.key 或 SECRET_KEY 环境变量）。
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {}

  /** 主密钥来源一：本机密钥文件（不存在则创建） */
  static fromFile(masterKeyFile: string): SecretBox {
    return new SecretBox(loadOrCreateMasterKey(masterKeyFile));
  }

  /** 主密钥来源二：hex 字符串（如环境变量 SECRET_KEY）；非法返回 null */
  static fromHex(hex: string): SecretBox | null {
    const key = masterKeyFromHex(hex);
    return key ? new SecretBox(key) : null;
  }

  encrypt(plain: string): string {
    return encryptWithKey(this.key, plain);
  }

  decrypt(payload: string): string | null {
    return decryptWithKey(this.key, payload);
  }
}
