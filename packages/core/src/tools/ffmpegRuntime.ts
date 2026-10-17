/**
 * ffmpeg / ffprobe 运行时定位与获取
 *
 * media 工具的「四级降级」把前两级放在这里实现：
 *
 *   1. 定位（resolveMedia）：环境变量 ZQAGENT_FFMPEG / ZQAGENT_FFPROBE
 *      → 工作区 .agent/bin/（本工具下载的静态构建）→ SEA 内嵌资源
 *      → PATH。优先级对齐 ripgrep.ts 的既有范式。
 *   2. 获取（downloadFfmpeg）：从各平台官方/社区编译的静态构建下载、
 *      校验、解包、安装到 .agent/bin/。
 *
 * 第 3/4 级（引导用户用 run_shell 安装 / 手工安装）由 media.ts 负责组织文案，
 * 本模块只提供 installHints() 的精确命令。
 *
 * 安全约定：
 * - 所有外部进程调用都走异步 execAsync + 参数数组，不拼 shell 字符串；
 * - 下载到临时目录 → 校验校验和 → 校验通过才原子重命名进 .agent/bin/，
 *   半成品不会污染安装目录。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { SocksProxyAgent } from "socks-proxy-agent";
import nodeFetch from "node-fetch";
import { execAsync } from "./execAsync.js";
import { decodeOutput } from "./shell.js";
import { findExecutable } from "./shellRuntime.js";

// =====================================================================
// 常量
// =====================================================================

/** 覆盖 ffmpeg / ffprobe 路径的环境变量 */
const ENV_FFMPEG = "ZQAGENT_FFMPEG";
const ENV_FFPROBE = "ZQAGENT_FFPROBE";

/**
 * SOCKS5 代理地址（环境变量 SOCKS5_PROXY）。
 * 与 web.ts / cli/connection.ts 保持同一约定：配置了就走代理，否则直连。
 * 下载体积大（数十 MB），国内环境经常需要代理，因此这里同样支持。
 */
const PROXY_ENV = process.env.SOCKS5_PROXY;

let socksAgent: SocksProxyAgent | null = null;
if (PROXY_ENV) {
  try {
    socksAgent = new SocksProxyAgent(PROXY_ENV);
  } catch {
    try {
      // 旧版实现只认 socks5://，把 socks5h:// 降级重试（与 web.ts 一致）
      socksAgent = new SocksProxyAgent(PROXY_ENV.replace(/^socks5h:\/\//, "socks5://"));
    } catch {
      socksAgent = null;
    }
  }
}

/** 单次下载超时（毫秒）——静态构建可达上百 MB，给足时间 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// =====================================================================
// 定位
// =====================================================================

/** 二进制的来源（用于错误信息与文档，也便于诊断「为什么用的是那个」） */
export type BinSource = "env" | "agent-bin" | "bundled" | "path";

export interface ResolvedBin {
  path: string;
  source: BinSource;
}

export interface ResolvedMedia {
  ffmpeg: ResolvedBin | null;
  ffprobe: ResolvedBin | null;
}

/** 本工具下载的静态构建的安装目录（随工作区，不进版本库：.agent/* 已 ignore） */
export function agentBinDir(workspace: string): string {
  return path.join(path.resolve(workspace), ".agent", "bin");
}

function exeName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

function defaultFileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 把 SEA 内嵌的二进制释放到临时目录，返回可执行文件路径 */
function extractBundled(name: string, platform: NodeJS.Platform): string | null {
  try {
    // CJS（SEA 单文件）下 require 可用；ESM 构建下用 createRequire 兜底。
    // 与 ripgrep.ts 相同的取法，避免依赖 import.meta。
    const req =
      typeof require === "function"
        ? require
        : createRequire(path.join(process.cwd(), "__zqagent__.js"));
    const sea = req("node:sea") as
      | { isSea?: () => boolean; getAsset?: (key: string) => ArrayBuffer | undefined }
      | undefined;
    if (!sea?.isSea?.() || typeof sea.getAsset !== "function") return null;
    const asset = sea.getAsset(name);
    if (!asset) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zqagent-${name}-`));
    const file = path.join(dir, exeName(name, platform));
    fs.writeFileSync(file, Buffer.from(asset));
    fs.chmodSync(file, 0o755);
    return file;
  } catch {
    // 未内嵌（npm 安装、普通 node 运行）或 API 不可用
    return null;
  }
}

export interface ResolveMediaOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 判断文件存在，便于测试注入 */
  fileExists?: (p: string) => boolean;
}

function resolveOne(
  name: string,
  workspace: string,
  o: Required<Pick<ResolveMediaOptions, "platform" | "env" | "fileExists">>,
): ResolvedBin | null {
  // 1. 环境变量显式指定
  const envKey = name === "ffmpeg" ? ENV_FFMPEG : ENV_FFPROBE;
  const explicit = (o.env[envKey] ?? "").trim();
  if (explicit && o.fileExists(explicit)) return { path: explicit, source: "env" };

  // 2. 工作区内 .agent/bin（本工具下载的静态构建）
  const local = path.join(agentBinDir(workspace), exeName(name, o.platform));
  if (o.fileExists(local)) return { path: local, source: "agent-bin" };

  // 3. SEA 内嵌资源
  const bundled = extractBundled(name, o.platform);
  if (bundled) return { path: bundled, source: "bundled" };

  // 4. PATH
  const onPath = findExecutable(name, {
    platform: o.platform,
    env: o.env,
    fileExists: o.fileExists,
  });
  return onPath ? { path: onPath, source: "path" } : null;
}

/** 解析结果缓存（按 平台 + 工作区），避免每次调用都探测文件系统 */
const cache = new Map<string, ResolvedMedia>();

/** 解析可用的 ffmpeg / ffprobe（结果带缓存） */
export function resolveMedia(
  workspace: string,
  opts: ResolveMediaOptions = {},
): ResolvedMedia {
  const platform = opts.platform ?? process.platform;
  const key = `${platform}:${path.resolve(workspace)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const ctx = {
    platform,
    env: opts.env ?? process.env,
    fileExists: opts.fileExists ?? defaultFileExists,
  };
  const resolved: ResolvedMedia = {
    ffmpeg: resolveOne("ffmpeg", workspace, ctx),
    ffprobe: resolveOne("ffprobe", workspace, ctx),
  };
  cache.set(key, resolved);
  return resolved;
}

/** 测试用 / 安装完成后：清除解析缓存 */
export function resetFfmpegCache(): void {
  cache.clear();
}

// =====================================================================
// 安装指引（第 3/4 级的素材）
// =====================================================================

/**
 * 返回目标平台的精确安装命令（按推荐顺序）。
 *
 * 这些命令同时用于第 3 级（模型转用 run_shell 安装）与第 4 级（用户手工安装），
 * 因此必须是可以直接复制执行的、非交互的形式。
 */
export function installHints(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "darwin":
      return [
        "brew install ffmpeg",
        "下载页: https://evermeet.cx/ffmpeg/ 与 https://evermeet.cx/ffprobe/（解压后把 ffmpeg / ffprobe 放进 PATH）",
      ];
    case "win32":
      return [
        'winget install "FFmpeg (Essentials Build)"',
        "choco install ffmpeg",
        "scoop install ffmpeg-essentials",
        "下载页: https://www.gyan.dev/ffmpeg/builds/（解压后把 bin 目录加入 PATH）",
      ];
    default:
      return [
        "apt-get install -y ffmpeg        # Debian / Ubuntu",
        "dnf install -y ffmpeg            # Fedora / RHEL（需启用 RPM Fusion）",
        "apk add ffmpeg                   # Alpine",
        "pacman -S ffmpeg                 # Arch",
        "下载页: https://johnvansickle.com/ffmpeg/（静态构建，解压后把 ffmpeg / ffprobe 放进 PATH 或 .agent/bin）",
      ];
  }
}

// =====================================================================
// 下载（第 2 级）
// =====================================================================

export type ArchiveKind = "tar.xz" | "zip";
export type ChecksumAlgo = "sha256" | "md5";

/** 下载源里的单个二进制 */
export interface DownloadComponent {
  /** 期望的二进制名（不含 .exe） */
  name: string;
  /** 直接下载地址（与 infoUrl 二选一） */
  url?: string;
  /** 通过 JSON 元数据接口动态取当前版本地址（evermeet 用） */
  infoUrl?: string;
  archive: ArchiveKind;
  /** 校验和边车文件地址（内容为 `<hash>  <文件名>`，或纯 hash） */
  checksumUrl?: string;
  checksumAlgo?: ChecksumAlgo;
}

export interface DistSpec {
  components: DownloadComponent[];
}

const JVS = "https://johnvansickle.com/ffmpeg/releases";
const EVERMEET_INFO = "https://evermeet.cx/ffmpeg/info";
const GYAN = "https://www.gyan.dev/ffmpeg/builds";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";

function distEntry(name: string, url: string, checksumUrl?: string, algo?: ChecksumAlgo): DownloadComponent {
  return { name, url, archive: url.endsWith(".zip") ? "zip" : "tar.xz", checksumUrl, checksumAlgo: algo };
}

/** 解析目标平台的下载源；不支持的平台返回 null（由调用方降级到第 3/4 级） */
export function distSpecFor(platform: NodeJS.Platform, arch: string): DistSpec | null {
  if (platform === "linux") {
    // johnvansickle 静态构建体积最小（x64 约 40MB），tar.xz 内含 ffmpeg + ffprobe
    const suffix =
      arch === "x64"
        ? "amd64"
        : arch === "arm64"
          ? "arm64"
          : arch === "arm"
            ? "armhf"
            : arch === "ia32"
              ? "i686"
              : null;
    if (!suffix) return null;
    return {
      components: [
        distEntry("ffmpeg", `${JVS}/ffmpeg-release-${suffix}-static.tar.xz`, `${JVS}/ffmpeg-release-${suffix}-static.tar.xz.md5`, "md5"),
        distEntry("ffprobe", `${JVS}/ffmpeg-release-${suffix}-static.tar.xz`),
      ],
    };
  }

  if (platform === "darwin") {
    // evermeet 分别发布 ffmpeg / ffprobe；用 JSON 元数据接口取当前版本的 zip 地址，
    // 避免把版本号写死在代码里（每次发版都要改代码）。
    return {
      components: [
        {
          name: "ffmpeg",
          infoUrl: `${EVERMEET_INFO}/ffmpeg/release`,
          archive: "zip",
        },
        {
          name: "ffprobe",
          infoUrl: `${EVERMEET_INFO}/ffprobe/release`,
          archive: "zip",
        },
      ],
    };
  }

  if (platform === "win32") {
    if (arch === "x64") {
      // gyan.dev essentials 包：含 ffmpeg + ffprobe + ffplay，站方提供 sha256
      const url = `${GYAN}/ffmpeg-release-essentials.zip`;
      return {
        components: [
          distEntry("ffmpeg", url, `${url}.sha256`, "sha256"),
          distEntry("ffprobe", url),
        ],
      };
    }
    if (arch === "arm64") {
      // BtbN 的 winarm64 构建；校验和在同仓库的 checksums.sha256 里按文件名查
      const url = `${BTBN}/ffmpeg-master-latest-winarm64-gpl.zip`;
      return {
        components: [
          distEntry("ffmpeg", url, `${BTBN}/checksums.sha256`, "sha256"),
          distEntry("ffprobe", url),
        ],
      };
    }
    return null;
  }

  return null;
}

/** 校验和文件解析：支持 `<hash>  <文件名>`、纯 hash、以及多行按文件名匹配 */
export function parseChecksumFile(text: string, filename: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const m = /^([0-9a-f]{32,128})\s+\*?(.*)$/i.exec(line.trim());
    if (!m) continue;
    const hash = m[1]!.toLowerCase();
    const name = m[2]?.trim() ?? "";
    // 多行文件（如 BtbN checksums.sha256）按文件名挑选；单行文件无文件名也接受
    if (!name || name === filename || path.basename(name) === filename) return hash;
  }
  // 纯 hash 无文件名的情况
  const single = lines[0]?.trim();
  if (lines.length === 1 && single && /^[0-9a-f]{32,128}$/i.test(single)) {
    return single.toLowerCase();
  }
  return null;
}

/** 计算文件校验和（流式，避免把上百 MB 一次性读进内存） */
export async function computeChecksum(file: string, algo: ChecksumAlgo): Promise<string> {
  const hash = createHash(algo);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

function fetchInit(): Record<string, unknown> {
  return socksAgent ? { agent: socksAgent } : {};
}

async function fetchText(url: string): Promise<string> {
  const resp = await nodeFetch(url, fetchInit() as never);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.text();
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const resp = await nodeFetch(url, fetchInit() as never);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error("响应没有内容");
  await pipeline(resp.body, fs.createWriteStream(dest));
}

/** 从 JSON 元数据接口取当前版本的 zip 地址（evermeet） */
async function resolveComponentUrl(c: DownloadComponent): Promise<string> {
  if (c.url) return c.url;
  if (!c.infoUrl) throw new Error(`下载源缺少 url / infoUrl: ${c.name}`);
  const text = await fetchText(c.infoUrl);
  const json = JSON.parse(text) as { download?: { zip?: { url?: string } } };
  const url = json.download?.zip?.url;
  if (!url) throw new Error(`元数据接口未给出 zip 地址: ${c.infoUrl}`);
  return url;
}

/** 递归查找解包目录下指定文件名的文件（各家归档的目录层级不一致，按名字找最稳） */
export function findBinaryInTree(dir: string, names: string[]): string | null {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (names.includes(e.name)) {
        return full;
      }
    }
  }
  return null;
}

/** 解包归档（tar.xz 用 tar；zip 用 unzip，Windows 用 PowerShell Expand-Archive） */
async function extractArchive(
  archive: string,
  dest: string,
  kind: ArchiveKind,
  platform: NodeJS.Platform,
): Promise<string | null> {
  fs.mkdirSync(dest, { recursive: true });
  let res;
  if (kind === "tar.xz") {
    // -J 走 xz 解压；多数发行版自带，缺失时会报错并降级到第 3/4 级
    res = await execAsync("tar", ["-xJf", archive, "-C", dest]);
  } else if (platform === "win32") {
    res = await execAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ],
    );
  } else {
    res = await execAsync("unzip", ["-o", "-q", archive, "-d", dest]);
  }
  if (res.error || res.status !== 0) {
    const detail = res.error?.message ?? decodeOutput(res.stderr).trim();
    return `解包失败 (${kind}): ${detail}`;
  }
  return null;
}

export interface DownloadResult {
  ok: boolean;
  /** 成功时：安装到 .agent/bin 的绝对路径 */
  installed?: Record<string, string>;
  error?: string;
  /** 完成但值得提示的信息（缺校验和、许可证义务等） */
  notes?: string[];
}

export interface DownloadOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** 覆盖下载源（测试注入） */
  spec?: DistSpec | null;
  log?: (msg: string) => void;
}

/**
 * 下载并安装静态构建到 `<workspace>/.agent/bin`。
 *
 * 供 media 工具的 `op="setup"` 调用——不静默触发：下载数十 MB 并写入工作区，
 * 必须是用户明确发起的动作（由权限引擎弹审批）。
 */
export async function downloadFfmpeg(
  workspace: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const log = opts.log ?? (() => {});
  const notes: string[] = [];

  const spec = opts.spec === undefined ? distSpecFor(platform, arch) : opts.spec;
  if (!spec || spec.components.length === 0) {
    return {
      ok: false,
      error: `暂不支持自动下载的平台: ${platform}/${arch}`,
    };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ffmpeg-"));
  const binDir = agentBinDir(workspace);
  const installed: Record<string, string> = {};

  try {
    // 同一归档承载多个二进制时只下一次（如 linux 的 tar.xz、gyan 的 zip）
    const fetched = new Map<string, { file: string; kind: ArchiveKind }>();

    for (const c of spec.components) {
      let url: string;
      try {
        url = await resolveComponentUrl(c);
      } catch (e) {
        return { ok: false, error: `获取下载地址失败: ${String(e instanceof Error ? e.message : e)}` };
      }

      let archive = fetched.get(url);
      if (!archive) {
        const archivePath = path.join(tmp, path.basename(new URL(url).pathname) || `${c.name}.${c.archive}`);
        log(`下载 ${url}`);
        try {
          await downloadToFile(url, archivePath);
        } catch (e) {
          return { ok: false, error: `下载失败 (${url}): ${String(e instanceof Error ? e.message : e)}` };
        }

        // 校验：拿不到边车文件时只告警不阻断（例如 macOS 的 evermeet 只有 GPG 签名）
        if (c.checksumUrl) {
          const algo = c.checksumAlgo ?? "sha256";
          try {
            const expected = parseChecksumFile(await fetchText(c.checksumUrl), path.basename(archivePath));
            if (!expected) {
              notes.push(`未能从 ${c.checksumUrl} 解析出校验和，已跳过校验`);
            } else {
              const actual = await computeChecksum(archivePath, algo);
              if (actual !== expected) {
                return {
                  ok: false,
                  error: `校验和不匹配 (${algo}): 期望 ${expected}，实际 ${actual}。已中止安装。`,
                };
              }
              log(`${algo} 校验通过`);
            }
          } catch (e) {
            notes.push(`校验和获取失败 (${c.checksumUrl}): ${String(e instanceof Error ? e.message : e)}`);
          }
        } else {
          notes.push(`${path.basename(archivePath)} 未提供校验和（仅 HTTPS 传输保护）`);
        }

        archive = { file: archivePath, kind: c.archive };
        fetched.set(url, archive);
      }

      const extractDir = fs.mkdtempSync(path.join(tmp, "x-"));
      const err = await extractArchive(archive.file, extractDir, archive.kind, platform);
      if (err) return { ok: false, error: err };

      const found = findBinaryInTree(extractDir, [exeName(c.name, platform), c.name]);
      if (!found) {
        return { ok: false, error: `归档内未找到 ${c.name}: ${path.basename(archive.file)}` };
      }

      // 装进 .agent/bin：先复制到临时名再 rename，避免半成品被后续调用当成可用二进制
      fs.mkdirSync(binDir, { recursive: true });
      const target = path.join(binDir, exeName(c.name, platform));
      const staging = `${target}.tmp-${process.pid}`;
      fs.copyFileSync(found, staging);
      fs.chmodSync(staging, 0o755);
      fs.renameSync(staging, target);
      installed[c.name] = target;
    }

    resetFfmpegCache();
    notes.push("ffmpeg 静态构建多为 GPL/LGPL 许可，随产品分发前请确认相应的源码提供义务");
    return { ok: true, installed, notes };
  } catch (e) {
    return { ok: false, error: `安装失败: ${String(e instanceof Error ? e.message : e)}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 供上层展示：本模块是否具备自动下载能力（不发起网络请求） */
export function canAutoDownload(platform: NodeJS.Platform, arch: string): boolean {
  return distSpecFor(platform, arch) !== null;
}
