#!/usr/bin/env node
/**
 * 拉取 BusyBox-w32（单个 exe 内含 ash/ls/grep/sed/awk/find/cat/rm/cp/mv/tar 等
 * Unix 工具），供 Windows 下的 run_shell 使用。
 *
 * 为什么需要它：Windows 的 cmd.exe 没有 ls/grep/rm/cat，模型产出的 POSIX 命令
 * 会大面积失败。把 busybox.exe 放到 CLI 可执行文件同目录（或同目录的 bin/）后，
 * shellRuntime 会自动探测到并以 `busybox.exe sh -c "<cmd>"` 执行，行为与
 * macOS/Linux 基本一致。
 *
 * 用法：
 *   node scripts/fetch_busybox_windows.mjs                          # x64，写入 bin/busybox.exe
 *   node scripts/fetch_busybox_windows.mjs --arch arm64             # Windows on ARM
 *   node scripts/fetch_busybox_windows.mjs --variant compat         # 老系统（Win7/2008 R2 时代）用的非 Unicode 构建
 *   node scripts/fetch_busybox_windows.mjs --version FRP-6075        # 锁定版本，便于复现
 *   node scripts/fetch_busybox_windows.mjs --name sh.exe            # 存成 sh.exe（argv[0] 即 applet，无需再前置 sh）
 *   node scripts/fetch_busybox_windows.mjs --out release/cli
 *
 * 来源：https://frippery.org/busybox/（busybox-w32 官方分发），下载后按
 * 同目录 SHA256SUM 校验；上游用 GPG 对该校验文件签名，如需更高保证请自行验证签名。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://frippery.org/files/busybox/";

/** 上游的「最新版」固定别名（同时也在 SHA256SUM 里，可直接校验） */
const LATEST = {
  x86: { compat: "busybox.exe" },
  x64: { compat: "busybox64.exe", unicode: "busybox64u.exe" },
  arm64: { compat: "busybox64a.exe", unicode: "busybox64a.exe" },
};

/** 锁定版本时的文件名前缀（上游只保留约三年的历史构建） */
const PINNED_PREFIX = { x86: "busybox-w32-FRP-", x64: "busybox-w64-FRP-", arm64: "busybox-w64a-FRP-" };

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[busybox] ${message}`);
}

function parseArgs(argv) {
  const opts = {
    arch: process.arch === "arm64" ? "arm64" : "x64",
    variant: "unicode",
    version: null,
    name: "busybox.exe",
    out: path.join(ROOT, "bin"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} 缺少取值`);
      return v;
    };
    switch (arg) {
      case "--arch": opts.arch = value(); break;
      case "--variant": opts.variant = value(); break;
      case "--version": opts.version = value().replace(/-g[0-9a-f]+$/i, ""); break;
      case "--name": opts.name = value(); break;
      case "--out": opts.out = path.resolve(value()); break;
      case "-h":
      case "--help":
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}`);
    }
  }
  return opts;
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`下载失败（HTTP ${res.status}）：${url}`);
  return res.text();
}

/** 解析 SHA256SUM（每行 `hash  filename`），返回 [hash, name] 列表 */
function parseSums(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2)
    .map(([hash, name]) => [hash, name]);
}

/** 目标文件名：默认取上游「最新版」别名，--version 时按前缀在 SHA256SUM 里找 */
function pickFileName(opts, sums) {
  if (!opts.version) {
    const variants = LATEST[opts.arch];
    if (!variants) fail(`不支持的架构：${opts.arch}（支持 x86 / x64 / arm64）`);
    const name = variants[opts.variant];
    if (!name) fail(`${opts.arch} 没有 ${opts.variant} 变体（可选：${Object.keys(variants).join(" / ")}）`);
    return name;
  }
  const prefix = PINNED_PREFIX[opts.arch];
  const tag = opts.version.startsWith("FRP-") ? opts.version : `FRP-${opts.version}`;
  const matched = sums
    .map(([, name]) => name)
    .filter((name) => name.startsWith(prefix) && name.includes(`-${tag}-`));
  if (matched.length === 0) {
    fail(`SHA256SUM 中找不到 ${prefix}${tag} 对应的构建；上游只保留近三年的历史版本。`);
  }
  return matched[0];
}

/** 从同 hash 的历史文件名里反推构建号（如 FRP-6075），方便写进文档 */
function inferBuildTag(hash, sums) {
  for (const [sum, name] of sums) {
    if (sum === hash) {
      const m = /-FRP-(\d+)-/.exec(name);
      if (m) return `FRP-${m[1]}`;
    }
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  log("获取 SHA256SUM …");
  const sums = parseSums(await getText(`${BASE_URL}SHA256SUM`));
  const fileName = pickFileName(opts, sums);
  const expected = sums.find(([, name]) => name === fileName)?.[0];
  if (!expected) fail(`SHA256SUM 中找不到 ${fileName}`);

  log(`下载 ${fileName} …`);
  const res = await fetch(`${BASE_URL}${fileName}`);
  if (!res.ok) fail(`下载失败（HTTP ${res.status}）：${BASE_URL}${fileName}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== expected) fail(`${fileName} 校验和不匹配（期望 ${expected}，实际 ${actual}）`);

  fs.mkdirSync(opts.out, { recursive: true });
  const outPath = path.join(opts.out, opts.name);
  fs.writeFileSync(outPath, buf);

  const sizeKb = (buf.length / 1024).toFixed(0);
  const tag = inferBuildTag(expected, sums);
  log(`✓ ${path.relative(ROOT, outPath)}（${sizeKb} KB，sha256 ${actual.slice(0, 16)}…）`);
  if (tag) log(`  对应构建：${tag}（复现可用 --version ${tag}）`);
  log("  放置位置：CLI 可执行文件同目录，或同目录下的 bin/ —— 运行时会自动探测");
}

await main();
