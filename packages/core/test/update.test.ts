/**
 * 更新模块单元测试
 *
 * 覆盖：版本比较、清单校验、Ed25519 验签、安装/回滚的原子替换。
 * 不触网：下载路径通过临时目录与本地文件模拟。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { compareVersions, isNewer, parseVersion } from "../src/update/version.js";
import { parseManifest, platformKey } from "../src/update/manifest.js";
import { parsePublicKey, verifySignature } from "../src/update/signature.js";
import { installStaged, rollback, replaceExecutable } from "../src/update/installer.js";
import { loadState, patchState } from "../src/update/state.js";

describe("version", () => {
  it("解析带 v 前缀与预发布标识", () => {
    expect(parseVersion("v0.2.1")).toMatchObject({ major: 0, minor: 2, patch: 1, pre: [] });
    expect(parseVersion("0.2.1-beta.2")).toMatchObject({ pre: ["beta", 2] });
    expect(parseVersion("0.2")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
  });

  it("按数值而非字典序比较", () => {
    expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("正式版高于同号预发布版", () => {
    expect(compareVersions("0.2.1", "0.2.1-beta.1")).toBe(1);
    expect(compareVersions("0.2.1-beta.2", "0.2.1-beta.10")).toBe(-1);
    expect(isNewer("0.2.2", "0.2.1")).toBe(true);
  });
});

describe("manifest", () => {
  const ok = {
    version: "0.2.2",
    minimumVersion: "0.1.0",
    binaries: {
      "macos-arm64": { url: "https://example.com/zqagent", sha256: "a".repeat(64), size: 10 },
    },
  };

  it("接受合法清单", () => {
    const r = parseManifest(ok);
    expect(r.error).toBeUndefined();
    expect(r.manifest?.version).toBe("0.2.2");
    expect(r.manifest?.binaries["macos-arm64"]?.sha256).toBe("a".repeat(64));
  });

  it("拒绝非法版本、缺字段与非法哈希", () => {
    expect(parseManifest({ ...ok, version: "latest" }).error).toMatch(/version/);
    expect(parseManifest({ ...ok, binaries: {} }).error).toMatch(/binaries/);
    expect(
      parseManifest({ ...ok, binaries: { x: { url: "https://e.com/a", sha256: "zz" } } }).error,
    ).toMatch(/sha256/);
  });

  it("默认拒绝 http，显式放行后可用", () => {
    const item = { version: "1.0.0", binaries: { "linux-x64": { url: "http://e.com/a", sha256: "b".repeat(64) } } };
    expect(parseManifest(item).error).toMatch(/https/);
    expect(parseManifest(item, { allowInsecureUrl: true }).manifest?.version).toBe("1.0.0");
  });

  it("平台键与产物命名一致", () => {
    expect(platformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(platformKey("win32", "x64")).toBe("windows-x64");
  });
});

describe("signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");

  it("接受正确签名（PEM 与 base64 DER 两种公钥）", () => {
    const data = Buffer.from('{"version":"1.0.0"}');
    const sig = sign(null, data, privateKey).toString("base64");
    expect(verifySignature(data, sig, parsePublicKey(pem)!)).toBe(true);
    expect(verifySignature(data, sig, parsePublicKey(der)!)).toBe(true);
  });

  it("篡改内容或签名长度不符时拒绝", () => {
    const data = Buffer.from('{"version":"1.0.0"}');
    const sig = sign(null, data, privateKey).toString("base64");
    expect(verifySignature(Buffer.from('{"version":"9.9.9"}'), sig, parsePublicKey(pem)!)).toBe(false);
    expect(verifySignature(data, "AAAA", parsePublicKey(pem)!)).toBe(false);
  });

  it("无效公钥返回 null", () => {
    expect(parsePublicKey("not-a-key")).toBeNull();
    expect(parsePublicKey("")).toBeNull();
  });
});

describe("installer", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-update-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("替换前备份当前文件，并把暂存文件搬到目标位置", () => {
    const execPath = path.join(dir, "zqagent");
    const staged = path.join(dir, "staged", "zqagent-0.2.2");
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(execPath, "old-binary");
    fs.writeFileSync(staged, "new-binary");

    const state = installStaged({ dataDir: dir, execPath, stagedPath: staged, version: "0.2.2" });

    expect(fs.readFileSync(execPath, "utf-8")).toBe("new-binary");
    expect(fs.existsSync(staged)).toBe(false);
    expect(state.backupPath && fs.readFileSync(state.backupPath, "utf-8")).toBe("old-binary");
    expect(state.pendingVersion).toBe("0.2.2");
  });

  it("回滚用备份覆盖当前文件", () => {
    const execPath = path.join(dir, "zqagent");
    const staged = path.join(dir, "staged", "zqagent-0.2.2");
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(execPath, "old-binary");
    fs.writeFileSync(staged, "new-binary");
    installStaged({ dataDir: dir, execPath, stagedPath: staged, version: "0.2.2" });

    const restored = rollback(dir, execPath);
    expect(restored).toBeTruthy();
    expect(fs.readFileSync(execPath, "utf-8")).toBe("old-binary");
  });

  it("没有备份时回滚返回 null", () => {
    const execPath = path.join(dir, "zqagent");
    fs.writeFileSync(execPath, "x");
    expect(rollback(dir, execPath)).toBeNull();
  });

  it("直接替换保留可执行权限", () => {
    const execPath = path.join(dir, "zqagent");
    const staged = path.join(dir, "next");
    fs.writeFileSync(execPath, "old");
    fs.writeFileSync(staged, "new");
    replaceExecutable(execPath, staged);
    expect(fs.statSync(execPath).mode & 0o111).toBeTruthy();
  });

  it("替换在目标目录新建文件，不搬移暂存文件的 inode", () => {
    // 跨目录 rename 会把 inode 连同源目录的 SELinux 上下文一起搬进 /usr/local/bin，
    // systemd 执行时被拒（203/EXEC）。这里断言替换后是目标目录里的新文件。
    const execPath = path.join(dir, "bin", "zqagent");
    const staged = path.join(dir, "updates", "staged", "zqagent-0.2.4");
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(execPath, "old-binary");
    fs.writeFileSync(staged, "new-binary");
    const stagedIno = fs.statSync(staged).ino;

    replaceExecutable(execPath, staged);

    expect(fs.readFileSync(execPath, "utf-8")).toBe("new-binary");
    expect(fs.statSync(execPath).ino).not.toBe(stagedIno);
    expect(fs.existsSync(`${execPath}.new`)).toBe(false);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it("状态文件损坏时按空状态处理", () => {
    fs.mkdirSync(path.join(dir, "updates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "updates", "state.json"), "{not json");
    expect(loadState(dir)).toEqual({});

    patchState(dir, { stagedVersion: "1.0.0" });
    expect(loadState(dir).stagedVersion).toBe("1.0.0");
  });
});

describe("downloader hash contract", () => {
  it("sha256 计算与清单字段格式一致", () => {
    const buf = Buffer.from("zqagent-binary");
    const hex = createHash("sha256").update(buf).digest("hex");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
