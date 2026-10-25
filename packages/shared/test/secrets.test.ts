/** AES-256-GCM 共享加密：往返、篡改检测、主密钥来源。 */
import { describe, it, expect, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SecretBox,
  decryptWithKey,
  encryptWithKey,
  loadOrCreateMasterKey,
  masterKeyFromHex,
} from "../src/secrets.js";

const key = crypto.randomBytes(32);
const tmpDirs: string[] = [];

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-secrets-"));
  tmpDirs.push(dir);
  return path.join(dir, "secret.key");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("encryptWithKey / decryptWithKey", () => {
  it("往返保持原文（含中文与多行）", () => {
    const plain = "sk-测试密钥\n第二行";
    const enc = encryptWithKey(key, plain);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptWithKey(key, enc)).toBe(plain);
  });

  it("同一原文两次加密得到不同密文（随机 IV）", () => {
    expect(encryptWithKey(key, "same")).not.toBe(encryptWithKey(key, "same"));
  });

  it("错误密钥、篡改密文/认证标签均返回 null", () => {
    const enc = encryptWithKey(key, "secret");
    expect(decryptWithKey(crypto.randomBytes(32), enc)).toBeNull();
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(decryptWithKey(key, parts.join(":"))).toBeNull();
    const badTag = enc.split(":");
    badTag[2] = crypto.randomBytes(16).toString("base64");
    expect(decryptWithKey(key, badTag.join(":"))).toBeNull();
  });

  it("格式非法返回 null", () => {
    expect(decryptWithKey(key, "")).toBeNull();
    expect(decryptWithKey(key, "v2:a:b:c")).toBeNull();
    expect(decryptWithKey(key, "v1:a:b")).toBeNull();
    expect(decryptWithKey(key, "not-a-ciphertext")).toBeNull();
  });
});

describe("masterKeyFromHex", () => {
  it("接受 64 位 hex（大小写/空白）", () => {
    const hex = key.toString("hex");
    expect(masterKeyFromHex(hex)?.equals(key)).toBe(true);
    expect(masterKeyFromHex(`  ${hex.toUpperCase()}  `)?.equals(key)).toBe(true);
  });

  it("拒绝非 64 位或非法字符", () => {
    expect(masterKeyFromHex("")).toBeNull();
    expect(masterKeyFromHex("a".repeat(63))).toBeNull();
    expect(masterKeyFromHex("g".repeat(64))).toBeNull();
  });
});

describe("loadOrCreateMasterKey", () => {
  it("首次生成 64 位 hex 文件且权限为 600", () => {
    const file = tmpFile();
    const k = loadOrCreateMasterKey(file);
    expect(k).toHaveLength(32);
    expect(fs.readFileSync(file, "utf8")).toBe(k.toString("hex"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("已存在时读取同一密钥", () => {
    const file = tmpFile();
    const first = loadOrCreateMasterKey(file);
    expect(loadOrCreateMasterKey(file).equals(first)).toBe(true);
  });

  it("文件损坏时重建并覆盖", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "broken");
    const k = loadOrCreateMasterKey(file);
    expect(k).toHaveLength(32);
    expect(fs.readFileSync(file, "utf8")).toBe(k.toString("hex"));
  });
});

describe("SecretBox", () => {
  it("fromHex 合法可用，非法返回 null", () => {
    const box = SecretBox.fromHex(key.toString("hex"));
    expect(box).not.toBeNull();
    const enc = box!.encrypt("hello");
    expect(box!.decrypt(enc)).toBe("hello");
    expect(SecretBox.fromHex("bad")).toBeNull();
  });

  it("fromFile 与 loadOrCreateMasterKey 互通", () => {
    const file = tmpFile();
    const a = SecretBox.fromFile(file);
    const b = SecretBox.fromFile(file);
    expect(b.decrypt(a.encrypt("across instances"))).toBe("across instances");
  });
});
