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
import * as path from "node:path";
import * as zlib from "node:zlib";

/** nodejs.org 发行包命名用的平台名 */
export const DIST_PLATFORM = { darwin: "darwin", win32: "win", linux: "linux" };

export function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 发行包文件名主干，例如 node-v22.22.3-win-x64 */
export function distStem(version, platform, arch) {
  return `node-v${String(version).replace(/^v/, "")}-${DIST_PLATFORM[platform]}-${arch}`;
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

/** 下载发行包并对照 SHASUMS256.txt 校验，返回存档路径与校验和 */
export async function downloadDistArchive(
  version,
  platform,
  arch,
  destDir,
  log = () => {},
) {
  const stem = distStem(version, platform, arch);
  const archive = `${stem}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const baseUrl = `https://nodejs.org/dist/v${String(version).replace(/^v/, "")}`;

  const url = `${baseUrl}/${archive}`;
  log(`下载基座 ${archive} : `, url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `下载失败（HTTP ${res.status}）：${baseUrl}/${archive}\n` +
        `若该版本没有 ${platform}-${arch} 发行包，请用 --node-version 指定另一版本。`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const sumsRes = await fetch(`${baseUrl}/SHASUMS256.txt`);
  if (!sumsRes.ok)
    throw new Error(`下载 SHASUMS256.txt 失败（HTTP ${sumsRes.status}）`);
  const expected = (await sumsRes.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${archive}`);
  const actual = sha256Of(buf);
  if (actual !== expected) {
    throw new Error(
      `${archive} 校验和不匹配（期望 ${expected}，实际 ${actual}）`,
    );
  }

  const archivePath = path.join(destDir, archive);
  fs.writeFileSync(archivePath, buf);
  return { archive, archivePath, sha256: actual };
}

/** 下载 Node 官方发行包，解压后返回其中的 node 可执行文件路径 */
export async function fetchNodeBase(
  version,
  platform,
  arch,
  tmpDir,
  log = () => {},
) {
  const stem = distStem(version, platform, arch);
  const { archive, archivePath } = await downloadDistArchive(
    version,
    platform,
    arch,
    tmpDir,
    log,
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
