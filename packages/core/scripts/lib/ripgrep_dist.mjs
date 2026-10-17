/**
 * ripgrep 发行包下载 / 校验 / 解压（供 SEA 单文件构建内嵌 rg 用）
 *
 * 与 node_dist.mjs 同源思路：把目标平台的 rg 可执行文件取出来，作为 SEA asset
 * 打包进单文件，运行时由 src/tools/ripgrep.ts 释放后执行。这样即便目标机没有
 * 安装 ripgrep，grep 工具也能享受其性能与完整正则支持；取不到时构建降级
 * （不阻断），运行时回退纯 Node 扫描器。
 *
 * 下载源（按序尝试）：
 *   1. ZQAGENT_RG_BUNDLE 指定的本地可执行文件（离线/自定义）；
 *   2. GitHub Release（官方）；
 *   3. npmmirror 的 ripgrep-prebuilt 二进制镜像（内网/国内网络更稳）。
 * 不同源的压缩包内目录布局不同，这里对「根目录 rg」与「<stem>/rg」都做了兼容。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractFromZipEntry } from "./node_dist.mjs";

/** GitHub Release 版本标签 */
export const RIPGREP_VERSION = "14.1.1";
/** npmmirror ripgrep-prebuilt 的版本目录名 */
const MIRROR_VERSION = "v14.1.1-1";

/** 平台 × 架构 → rust target triple */
const TRIPLES = {
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-gnu" },
};

function tripleFor(platform, arch) {
  const triple = TRIPLES[platform]?.[arch];
  if (!triple) throw new Error(`ripgrep 不支持 ${platform}-${arch}`);
  return triple;
}

/** 返回下载源列表：{ name, url, sha256Url?, stem } */
export function rgSources(platform, arch) {
  const triple = tripleFor(platform, arch);
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const ghStem = `ripgrep-${RIPGREP_VERSION}-${triple}`;
  const mirrorStem = `ripgrep-${MIRROR_VERSION}-${triple}`;
  const ghUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${ghStem}.${ext}`;
  return [
    { name: "github", url: ghUrl, sha256Url: `${ghUrl}.sha256`, stem: ghStem },
    {
      name: "npmmirror",
      url: `https://registry.npmmirror.com/-/binary/ripgrep-prebuilt/${MIRROR_VERSION}/${mirrorStem}.${ext}`,
      stem: mirrorStem,
    },
  ];
}

/** 从压缩包解出 rg 到 binPath；兼容「根目录」与「<stem>/」两种布局 */
function extractRg(archivePath, platform, stem, binPath) {
  const binName = platform === "win32" ? "rg.exe" : "rg";
  const dir = path.dirname(binPath);
  fs.mkdirSync(dir, { recursive: true });

  if (platform === "win32") {
    for (const member of [`${stem}/${binName}`, binName]) {
      try {
        extractFromZipEntry(archivePath, member, binPath);
        return;
      } catch {
        /* 尝试下一个布局 */
      }
    }
    throw new Error(`zip 中未找到 ${binName}`);
  }

  for (const member of [binName, `${stem}/${binName}`]) {
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", dir, member], {
      stdio: "ignore",
      shell: false,
    });
    const extracted = path.join(dir, member);
    if (result.status === 0 && fs.existsSync(extracted)) {
      if (extracted !== binPath) fs.renameSync(extracted, binPath);
      return;
    }
  }
  throw new Error(`tar 中未找到 ${binName}`);
}

/** 下载单个源并解出 rg；失败抛错 */
async function fetchFromSource(source, platform, arch, destDir, log) {
  log(`下载 ripgrep ${source.stem}（${source.name}）…`);
  const res = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // 有校验和地址的就对照（GitHub 提供；npmmirror 没有）
  if (source.sha256Url) {
    try {
      const sr = await fetch(source.sha256Url, { signal: AbortSignal.timeout(30000) });
      if (sr.ok) {
        // 兼容两种格式：纯 `<hash>  <file>`，以及 `SHA256 (file) = <hash>`
        const text = await sr.text();
        const expected = (text.match(/\b[a-fA-F0-9]{64}\b/) ?? [])[0];
        const actual = createHash("sha256").update(buf).digest("hex");
        if (expected && expected.toLowerCase() !== actual) {
          throw new Error(`校验和不匹配（期望 ${expected}，实际 ${actual}）`);
        }
      }
    } catch (err) {
      if (String(err?.message ?? err).includes("校验和不匹配")) throw err;
      // 校验和下载失败不阻断
    }
  }

  const ext = platform === "win32" ? "zip" : "tar.gz";
  const archivePath = path.join(destDir, `${source.stem}.${ext}`);
  fs.writeFileSync(archivePath, buf);

  const binName = platform === "win32" ? "rg.exe" : "rg";
  const binPath = path.join(destDir, binName);
  extractRg(archivePath, platform, source.stem, binPath);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * 下载并解出目标平台的 rg，返回可执行文件路径。
 * 依次尝试 ZQAGENT_RG_BUNDLE 本地文件、GitHub、npmmirror；全部失败才抛错。
 */
export async function fetchRipgrep(platform, arch, destDir, log = () => {}) {
  // 显式提供的本地 rg（跳过下载）
  const local = (process.env.ZQAGENT_RG_BUNDLE ?? "").trim();
  if (local) {
    if (!fs.existsSync(local)) {
      throw new Error(`ZQAGENT_RG_BUNDLE 指向的文件不存在：${local}`);
    }
    const binPath = path.join(destDir, platform === "win32" ? "rg.exe" : "rg");
    fs.copyFileSync(local, binPath);
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }

  const errors = [];
  for (const source of rgSources(platform, arch)) {
    try {
      return await fetchFromSource(source, platform, arch, destDir, log);
    } catch (err) {
      errors.push(`${source.name}: ${err?.message ?? err}`);
      log(`⚠️  ripgrep 源 ${source.name} 失败：${err?.message ?? err}`);
    }
  }
  throw new Error(`所有 ripgrep 下载源均失败（${errors.join("; ")}）`);
}
