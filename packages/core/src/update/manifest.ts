/**
 * 节点更新清单（manifest）的类型与校验。
 *
 * 清单由发布流程生成，托管在静态目录（默认
 * `https://agent.cd-zq.com/downloads/zqagent/stable.json`），
 * 与同名 `.sig`（Ed25519 签名）配对使用。
 */
import { parseVersion } from "./version.js";

/** 单个平台的产物描述 */
export interface UpdateBinary {
  /** 绝对 https 地址（或显式允许的 http） */
  url: string;
  /** 小写 hex 的 SHA-256 */
  sha256: string;
  /** 字节数（可选；用于下载上限与进度） */
  size?: number;
}

export interface UpdateManifest {
  /** 新版本号（bare semver，如 0.2.2） */
  version: string;
  /** 允许自动更新的最低版本：低于它的节点拒绝升级（防止跨破坏性变更） */
  minimumVersion?: string;
  notes?: string;
  publishedAt?: string;
  channel?: string;
  /** 平台键（见 platformKey）→ 产物 */
  binaries: Record<string, UpdateBinary>;
}

/** 产物名与 build_cli_binary.mjs 的 DISPLAY_PLATFORM 保持一致：macos / linux / windows */
const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

/**
 * 构建期注入的 libc 变体标记：普通产物为空，glibc 2.17 兼容产物为 `glibc217`。
 *
 * 由 build_cli_binary.mjs 在 `--libc glibc-217` 时传入环境变量，tsup 在打包时
 * 把 `process.env.ZQAGENT_LIBC_VARIANT` 替换成字面量，因此运行时不受环境影响。
 */
const LIBC_VARIANT = process.env.ZQAGENT_LIBC_VARIANT ?? "";

/** 当前进程对应的清单键，如 `macos-arm64`、`linux-x64`、`linux-x64-glibc217` */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const base = `${PLATFORM_NAMES[platform] ?? platform}-${arch}`;
  return LIBC_VARIANT ? `${base}-${LIBC_VARIANT}` : base;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 校验并规范化清单。允许 http 仅当调用方显式放行（内网自测）。
 */
export function parseManifest(
  raw: unknown,
  opts: { allowInsecureUrl?: boolean } = {},
): { manifest?: UpdateManifest; error?: string } {
  if (!isRecord(raw)) return { error: "清单不是 JSON 对象" };

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!parseVersion(version)) return { error: `清单 version 非法：${String(raw.version)}` };

  if (raw.minimumVersion !== undefined) {
    if (typeof raw.minimumVersion !== "string" || !parseVersion(raw.minimumVersion)) {
      return { error: `清单 minimumVersion 非法：${String(raw.minimumVersion)}` };
    }
  }

  if (!isRecord(raw.binaries)) return { error: "清单缺少 binaries" };
  const binaries: Record<string, UpdateBinary> = {};
  for (const [key, value] of Object.entries(raw.binaries)) {
    if (!isRecord(value)) return { error: `binaries.${key} 不是对象` };
    const url = typeof value.url === "string" ? value.url.trim() : "";
    const sha256 = typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "";
    if (!url) return { error: `binaries.${key} 缺少 url` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `binaries.${key}.url 非法：${url}` };
    }
    if (parsed.protocol !== "https:" && !opts.allowInsecureUrl) {
      return { error: `binaries.${key}.url 必须是 https：${url}` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { error: `binaries.${key}.url 协议不支持：${url}` };
    }
    if (!SHA256_HEX.test(sha256)) {
      return { error: `binaries.${key}.sha256 需为 64 位小写 hex` };
    }
    const size = typeof value.size === "number" && value.size > 0 ? value.size : undefined;
    binaries[key] = { url, sha256, ...(size ? { size } : {}) };
  }
  if (Object.keys(binaries).length === 0) return { error: "清单 binaries 为空" };

  return {
    manifest: {
      version,
      ...(typeof raw.minimumVersion === "string" ? { minimumVersion: raw.minimumVersion } : {}),
      ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
      ...(typeof raw.publishedAt === "string" ? { publishedAt: raw.publishedAt } : {}),
      ...(typeof raw.channel === "string" ? { channel: raw.channel } : {}),
      binaries,
    },
  };
}
