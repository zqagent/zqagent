#!/usr/bin/env node
/**
 * 生成节点自动更新清单（latest.json / stable.json）与 Ed25519 签名。
 *
 * 用法：
 *   node make_update_manifest.mjs \
 *     --version 0.2.2 --dir release/cli --out dist/node/stable.json \
 *     --base-url https://agent.cd-zq.com/downloads/zqagent/v0.2.2 \
 *     --key /path/to/update-private.pem [--minimum-version 0.1.0] [--channel stable] [--notes "..."]
 *
 * 产物：
 *   <out>       清单 JSON
 *   <out>.sig   base64 编码的 Ed25519 签名（对清单原始字节签名）
 *
 * 平台键与 build_cli_binary.mjs 的产物名一一对应：
 *   zqagent-macos-arm64        → macos-arm64
 *   zqagent-linux-x64          → linux-x64
 *   zqagent-windows-x64.exe    → windows-x64
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, sign } from "node:crypto";

/** 产物文件名 → 清单平台键 */
const PLATFORM_PATTERNS = [
  [/^zqagent-macos-(arm64|x64)$/, (m) => `macos-${m[1]}`],
  [/^zqagent-linux-(arm64|x64)$/, (m) => `linux-${m[1]}`],
  [/^zqagent-windows-(arm64|x64)(?:\.exe)?$/, (m) => `windows-${m[1]}`],
];

function usage() {
  console.error(
    "usage: node make_update_manifest.mjs --version X --dir DIR --out FILE --base-url URL --key PRIVATE_KEY_PEM\n" +
      "       [--minimum-version X] [--channel stable] [--notes TEXT]",
  );
  process.exit(2);
}

function arg(name, args) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) usage();
  return v;
}

const args = process.argv.slice(2);
const version = arg("version", args);
const dir = arg("dir", args);
const out = arg("out", args);
const baseUrl = arg("base-url", args)?.replace(/\/+$/, "");
const keyPath = arg("key", args);
const minimumVersion = arg("minimum-version", args);
const channel = arg("channel", args) ?? "stable";
const notes = arg("notes", args) ?? "";

if (!version || !dir || !out || !baseUrl) usage();
if (version.startsWith("v")) {
  console.error("error: --version 传裸版本号（如 0.2.2），不要带 v 前缀");
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.error(`error: 目录不存在：${dir}`);
  process.exit(1);
}

const binaries = {};
for (const name of fs.readdirSync(dir)) {
  const full = path.join(dir, name);
  if (!fs.statSync(full).isFile()) continue;
  let key = null;
  for (const [pattern, toKey] of PLATFORM_PATTERNS) {
    const m = pattern.exec(name);
    if (m) {
      key = toKey(m);
      break;
    }
  }
  if (!key) continue;
  const buf = fs.readFileSync(full);
  binaries[key] = {
    url: `${baseUrl}/${name}`,
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
  };
}

const keys = Object.keys(binaries);
if (keys.length === 0) {
  console.error("error: 目录里没有可识别的节点产物（zqagent-<platform>-<arch>）");
  process.exit(1);
}

const manifest = {
  version,
  ...(minimumVersion ? { minimumVersion } : {}),
  channel,
  publishedAt: new Date().toISOString(),
  ...(notes ? { notes } : {}),
  binaries,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, json);

// 纯文本清单（<platform> <version> <url> <sha256> <size>）：
// 供 install-node.sh 这类零依赖安装脚本解析，避免在目标机上依赖 jq/python。
const txt = keys
  .sort()
  .map((k) => `${k} ${version} ${binaries[k].url} ${binaries[k].sha256} ${binaries[k].size ?? 0}`)
  .join("\n");
// stable.json → stable.txt（与清单同目录、同基名）
const txtPath = `${out.replace(/\.json$/, "")}.txt`;
fs.writeFileSync(txtPath, `${txt}\n`);

if (keyPath) {
  const privateKey = fs.readFileSync(keyPath, "utf-8");
  const sig = sign(null, Buffer.from(json), privateKey).toString("base64");
  fs.writeFileSync(`${out}.sig`, `${sig}\n`);
  console.log(`[update-manifest] 已写入 ${out}、${out}.sig、${txtPath}（${keys.length} 个平台）`);
} else {
  console.warn(
    `[update-manifest] 已写入 ${out} 与 ${txtPath}，但未提供 --key：节点无法验签，自动更新会拒绝该清单`,
  );
}
for (const k of keys) {
  const b = binaries[k];
  console.log(`  ${k.padEnd(14)} ${(b.size / 1024 / 1024).toFixed(1)}MB  ${b.sha256.slice(0, 12)}…`);
}
