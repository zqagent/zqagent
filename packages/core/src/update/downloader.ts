/**
 * 清单拉取与产物下载。
 *
 * 下载全程流式写入 `.part` 文件并同步计算 SHA-256，校验通过后才 rename 为正式文件。
 * 任何一步失败都会清理临时文件，不会留下半截可执行文件。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import * as path from "node:path";
import { parseManifest, type UpdateBinary, type UpdateManifest } from "./manifest.js";
import { verifySignature } from "./signature.js";

/** 单个产物的下载上限（SEA 带内嵌 ripgrep，当前约 100MB；留足余量） */
const MAX_BINARY_BYTES = 400 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface FetchManifestResult {
  manifest?: UpdateManifest;
  /** 校验失败的说明 */
  error?: string;
  raw?: Buffer;
}

/**
 * 拉取并校验清单：
 * 1. GET `<url>` 与 `<url>.sig`
 * 2. Ed25519 验签（对原始字节）
 * 3. JSON 解析 + 字段/URL/哈希校验
 */
export async function fetchManifest(
  url: string,
  publicKey: KeyObject,
  opts: { allowInsecureUrl?: boolean } = {},
): Promise<FetchManifestResult> {
  let raw: Buffer;
  let sig: string;
  try {
    const [mRes, sRes] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) }),
      fetch(`${url}.sig`, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) }),
    ]);
    if (!mRes.ok) return { error: `清单请求失败 HTTP ${mRes.status}` };
    if (!sRes.ok) return { error: `签名请求失败 HTTP ${sRes.status}` };
    raw = Buffer.from(await mRes.arrayBuffer());
    sig = (await sRes.text()).trim();
  } catch (err) {
    return { error: `拉取清单失败：${(err as Error).message}` };
  }

  if (!sig) return { error: "签名文件为空" };
  if (!verifySignature(raw, sig, publicKey)) {
    return { error: "清单签名校验失败（公钥不匹配或内容被篡改）" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch (err) {
    return { error: `清单不是合法 JSON：${(err as Error).message}` };
  }
  const { manifest, error } = parseManifest(parsed, opts);
  if (!manifest) return { error };
  return { manifest, raw };
}

/**
 * 下载产物到 `destPath`，边下边校验 sha256 与大小。返回实际字节数。
 */
export async function downloadBinary(
  bin: UpdateBinary,
  destPath: string,
  log: (msg: string) => void = () => {},
): Promise<{ bytes?: number; error?: string }> {
  const partPath = `${destPath}.part`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.rmSync(partPath, { force: true });

  let res: Response;
  try {
    res = await fetch(bin.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return { error: `下载失败：${(err as Error).message}` };
  }
  if (!res.ok) return { error: `下载失败 HTTP ${res.status}` };
  if (!res.body) return { error: "下载响应没有 body" };

  const expected = bin.size && bin.size > 0 ? bin.size : undefined;
  const limit = expected ? Math.max(expected * 2, 1024 * 1024) : MAX_BINARY_BYTES;
  const hash = createHash("sha256");
  let bytes = 0;

  try {
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > limit) throw new Error(`产物超过大小上限（>${limit} 字节）`);
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(partPath, { mode: 0o755 }),
    );
  } catch (err) {
    fs.rmSync(partPath, { force: true });
    return { error: `下载中断：${(err as Error).message}` };
  }

  const actual = hash.digest("hex");
  if (actual !== bin.sha256) {
    fs.rmSync(partPath, { force: true });
    return { error: `SHA-256 不匹配（期望 ${bin.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` };
  }
  if (expected && bytes !== expected) {
    fs.rmSync(partPath, { force: true });
    return { error: `产物大小不匹配（期望 ${expected}，实际 ${bytes}）` };
  }

  fs.rmSync(destPath, { force: true });
  fs.renameSync(partPath, destPath);
  fs.chmodSync(destPath, 0o755);
  log(`已下载 ${path.basename(destPath)}（${Math.round(bytes / 1024 / 1024)}MB，校验通过）`);
  return { bytes };
}

/**
 * 安装前自检：跑一次 `--version`，输出必须包含清单版本。
 * 防住「架构不匹配 / 包损坏 / 误标版本」三类事故。
 */
export function selfCheck(binPath: string, expectedVersion: string): { ok: boolean; error?: string } {
  try {
    const r = spawnSync(binPath, ["--version"], {
      timeout: 20_000,
      encoding: "utf-8",
      env: { ...process.env, ZQAGENT_AUTO_UPDATE: "0" },
    });
    if (r.error) return { ok: false, error: `执行自检失败：${r.error.message}` };
    if (r.status !== 0) return { ok: false, error: `自检退出码 ${r.status}：${(r.stderr || "").trim()}` };
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (!out.includes(expectedVersion)) {
      return { ok: false, error: `自检版本不符（期望 ${expectedVersion}，输出：${out.trim().slice(0, 120)}）` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `自检异常：${(err as Error).message}` };
  }
}
