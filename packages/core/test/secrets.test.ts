/**
 * 加密共享模块测试
 *
 * 覆盖 AES-256-GCM 加解密往返、密文篡改检测、主密钥来源。
 */
import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  encryptWithKey,
  decryptWithKey,
  masterKeyFromHex,
  SecretBox,
} from "../src/crypto/secrets.js";

const key = crypto.randomBytes(32);

describe("AES-256-GCM 加解密", () => {
  it("加密后可正确解密", () => {
    const plain = "sk-super-secret-123";
    const enc = encryptWithKey(key, plain);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptWithKey(key, enc)).toBe(plain);
  });

  it("每次加密产生不同密文（随机 IV）", () => {
    const a = encryptWithKey(key, "same");
    const b = encryptWithKey(key, "same");
    expect(a).not.toBe(b);
    expect(decryptWithKey(key, a)).toBe("same");
    expect(decryptWithKey(key, b)).toBe("same");
  });

  it("篡改密文/错误密钥 → 解密失败返回 null", () => {
    const enc = encryptWithKey(key, "secret");
    const wrongKey = crypto.randomBytes(32);
    expect(decryptWithKey(wrongKey, enc)).toBeNull();
    expect(decryptWithKey(key, "v1:not-a-valid-cipher")).toBeNull();
    expect(decryptWithKey(key, "garbage")).toBeNull();
    expect(decryptWithKey(key, "")).toBeNull();
  });
});

describe("主密钥来源", () => {
  it("masterKeyFromHex 接受 64 位 hex，拒绝非法值", () => {
    const hex = crypto.randomBytes(32).toString("hex");
    expect(masterKeyFromHex(hex)).toBeInstanceOf(Buffer);
    expect(masterKeyFromHex("short")).toBeNull();
    expect(masterKeyFromHex("zz".repeat(32))).toBeNull();
  });

  it("SecretBox.fromFile 生成并复用主密钥文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-sec-"));
    try {
      const file = path.join(dir, "secret.key");
      const box1 = SecretBox.fromFile(file);
      const box2 = SecretBox.fromFile(file);
      const enc = box1.encrypt("hello");
      expect(box2.decrypt(enc)).toBe("hello"); // 同一主密钥，跨实例可解
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
