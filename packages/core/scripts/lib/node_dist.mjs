/**
 * Node 官方发行包的下载 / 校验 / 解压（build_cli_binary.mjs 与 make_sea_probes.mjs 共用）
 *
 * 「取一份目标平台的 node 可执行文件」有两处需要：构建 CLI 单文件时作注入基座、
 * 生成对照探针时留一份零修改的原版基座。抽到一处避免两套解压逻辑各自跑偏。
 *
 * 这里只做下载、sha256 校验、解压三件事，失败一律抛 Error，由调用方决定怎么退出。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

/** nodejs.org 发行包命名用的平台名 */
export const DIST_PLATFORM = { darwin: "darwin", win32: "win", linux: "linux" };

export function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 发行包文件名主干，例如 node-v22.22.3-win-x64。
 * `libc` 用于 unofficial-builds 的兼容构建（Linux），例如 node-v22.23.2-linux-x64-glibc-217。
 */
export function distStem(version, platform, arch, libc) {
  return `node-v${String(version).replace(/^v/, "")}-${DIST_PLATFORM[platform]}-${arch}${libc ? `-${libc}` : ""}`;
}

/**
 * 从 zip 中解出单个条目。
 *
 * Node 没有内置的 zip 读取能力，而 GNU tar（Linux）也不认 zip，
 * 所以这里手工解析中央目录、用 zlib 解压。
 * 好处：不依赖外部 unzip，且只需解出 node.exe —— Windows 发行包里
 * 还有 npm/头文件/调试符号（解压后 100MB+），全解开纯属浪费。
 */
export function extractFromZipEntry(zipPath, entryName, destPath) {
  const buf = fs.readFileSync(zipPath);

  // End of Central Directory：从尾部往回找（zip 注释最长 65535 字节）
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`不是合法的 zip 文件：${zipPath}`);

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50)
      throw new Error(`zip 中央目录损坏（第 ${i} 项）`);
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    if (name === entryName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error(`zip 本地头损坏：${entryName}`);
      // 本地头的 name/extra 长度可能与中央目录不同，必须按本地头重新算数据起点
      const dataStart =
        localOffset +
        30 +
        buf.readUInt16LE(localOffset + 26) +
        buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`不支持的 zip 压缩算法 ${method}：${entryName}`);
      fs.writeFileSync(destPath, data);
      return destPath;
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 中找不到 ${entryName}：${zipPath}`);
}

/**
 * 下载源基址（按序尝试）。
 *
 * 官方 nodejs.org 在部分网络下连接超时或极慢；镜像同样提供完整发行包与
 * SHASUMS256.txt，可继续做同一套校验。`ZQAGENT_NODE_MIRROR` 可指定自定义
 * 基址（支持 `{version}` 占位符，否则自动拼 `/v<version>`），用于离线内网。
 */
export function nodeDistBases(version, libc) {
  const v = `v${String(version).replace(/^v/, "")}`;
  const bases = [];
  const custom = (process.env.ZQAGENT_NODE_MIRROR ?? "").trim();
  if (custom) {
    const base = custom.replace(/\/$/, "");
    bases.push(base.includes("{version}") ? base.replaceAll("{version}", v) : `${base}/${v}`);
  }
  if (libc) {
    // glibc 2.17 兼容构建只由 unofficial-builds 提供（官方发行包要求 glibc >= 2.28）
    bases.push(`https://unofficial-builds.nodejs.org/download/release/${v}`);
  } else {
    bases.push(
      `https://nodejs.org/dist/${v}`,
      `https://mirrors.aliyun.com/nodejs-release/${v}`,
      `https://mirrors.huaweicloud.com/nodejs/${v}`,
      `https://cdn.npmmirror.com/binaries/node/${v}`,
    );
  }
  return [...new Set(bases)];
}

/** 下载失败的底层原因（Node fetch 只报 “fetch failed”，cause 里才有 ECONNRESET 等） */
function describeFetchError(err) {
  const cause = err?.cause;
  const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code;
  return `${err?.message ?? err}${code ? `（${code}）` : ""}`;
}

/**
 * 代理地址（CI 里境外源常需要走代理）。
 *
 * Node 内置的 fetch 不遵循 HTTP_PROXY/HTTPS_PROXY —— 有代理时会绕过它直连然后超时，
 * 所以在设了代理时改用 curl 下载（curl 原生读这两个变量）。curl 不可用则回退 fetch。
 */
function proxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  );
}

/** 带代理地取一个 URL 的完整内容（curl 与 fetch 的错误语义保持一致） */
async function httpGet(url, timeoutMs) {
  if (proxyUrl()) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-dl-"));
    const out = path.join(tmpDir, "body");
    try {
      const res = spawnSync(
        "curl",
        [
          "-fsSL",
          // 走代理时 HTTP/2 多路复用常被掐断（curl 报 18），强制单路 HTTP/1.1
          "--http1.1",
          // 多个构建作业并发时带宽被分摊，180s 下不完 45MB+ 的基座；放宽时限并重试
          "--retry",
          "3",
          "--retry-delay",
          "3",
          "--retry-all-errors",
          "--max-time",
          String(Math.ceil(timeoutMs / 1000)),
          "-o",
          out,
          url,
        ],
        { encoding: "utf8" },
      );
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`HTTP 请求失败（curl 退出码 ${res.status}）`);
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 日志里显示源主机；自定义镜像可能不是合法 URL，退化为原字符串 */
function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 下载单个源：发行包 + 校验和，校验通过才落盘；失败抛错 */
async function downloadFromBase(baseUrl, archive, destDir) {
  const buf = await httpGet(`${baseUrl}/${archive}`, 600000);
  const expected = (await httpGet(`${baseUrl}/SHASUMS256.txt`, 30000))
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${archive}`);
  const actual = sha256Of(buf);
  if (actual !== expected) {
    throw new Error(`校验和不匹配（期望 ${expected}，实际 ${actual}）`);
  }

  const archivePath = path.join(destDir, archive);
  fs.writeFileSync(archivePath, buf);
  return { archivePath, sha256: actual };
}

/** 下载发行包并对照 SHASUMS256.txt 校验，返回存档路径与校验和 */
export async function downloadDistArchive(
  version,
  platform,
  arch,
  destDir,
  log = () => {},
  libc,
) {
  const stem = distStem(version, platform, arch, libc);
  const archive = `${stem}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const bases = nodeDistBases(version, libc);
  const errors = [];

  for (const baseUrl of bases) {
    log(`下载基座 ${archive} : `, `${baseUrl}/${archive}`);
    try {
      const { archivePath, sha256 } = await downloadFromBase(
        baseUrl,
        archive,
        destDir,
      );
      return { archive, archivePath, sha256 };
    } catch (err) {
      errors.push(`${hostOf(baseUrl)}: ${describeFetchError(err)}`);
      log(`⚠️  基座源 ${hostOf(baseUrl)} 失败：${describeFetchError(err)}`);
    }
  }

  throw new Error(
    `所有 Node 基座下载源均失败（${errors.join("; ")}）\n` +
      `若该版本没有 ${platform}-${arch} 发行包，请用 --node-version 指定另一版本；` +
      `也可用 ZQAGENT_NODE_MIRROR 指定可用镜像（支持 {version} 占位符）。`,
  );
}

/** 下载 Node 官方发行包，解压后返回其中的 node 可执行文件路径 */
export async function fetchNodeBase(
  version,
  platform,
  arch,
  tmpDir,
  log = () => {},
  libc,
) {
  const stem = distStem(version, platform, arch, libc);
  const { archive, archivePath } = await downloadDistArchive(
    version,
    platform,
    arch,
    tmpDir,
    log,
    libc,
  );

  if (platform === "win32") {
    // Windows 发行包是 zip：只解出 node.exe（见 extractFromZipEntry）
    const bin = path.join(tmpDir, "node.exe");
    extractFromZipEntry(archivePath, `${stem}/node.exe`, bin);
    return bin;
  }

  // macOS/Linux 是 tar.gz，交给系统 tar（不用 shell：路径可能含空格）
  const result = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error(`无法执行 tar：${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`解压 ${archive} 失败（exit=${result.status}）`);

  const bin = path.join(tmpDir, stem, "bin", "node");
  if (!fs.existsSync(bin))
    throw new Error(`发行包中未找到 node 可执行文件：${bin}`);
  return bin;
}
