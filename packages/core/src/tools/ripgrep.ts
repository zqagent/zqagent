/**
 * ripgrep (rg) 定位
 *
 * 优先级：
 *   1. 环境变量 ZQAGENT_RG 显式指定的路径；
 *   2. SEA 单文件内嵌的 rg 资源（构建时由 build_cli_binary.mjs 作为 asset 打包，
 *      运行时用 node:sea 的 getAsset 释放到临时目录）；
 *   3. PATH 上的 rg。
 * 都拿不到时返回 null，由调用方回退到纯 Node 扫描器（nodeGrep.ts）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { findExecutable } from "./shellRuntime.js";

/** 已解析结果缓存（null 表示确认没有，勿重复探测） */
let cached: string | null | undefined;

/** 把 SEA 内嵌的 rg 资源释放到临时目录，返回可执行文件路径 */
function extractBundledRipgrep(): string | null {
  try {
    // CJS（SEA 单文件）下 require 可用；ESM 构建下用 createRequire 兜底。
    // 以 cwd 为基准构造 createRequire，避免依赖 import.meta（CJS 产物里不稳定）。
    const req =
      typeof require === "function"
        ? require
        : createRequire(path.join(process.cwd(), "__zqagent__.js"));
    const sea = req("node:sea") as
      | { isSea?: () => boolean; getAsset?: (key: string) => ArrayBuffer | undefined }
      | undefined;
    if (!sea?.isSea?.() || typeof sea.getAsset !== "function") return null;
    const asset = sea.getAsset("rg");
    if (!asset) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-rg-"));
    const file = path.join(dir, process.platform === "win32" ? "rg.exe" : "rg");
    fs.writeFileSync(file, Buffer.from(asset));
    fs.chmodSync(file, 0o755);
    return file;
  } catch {
    // 未内嵌 rg（如 npm 安装、普通 node 运行）或 API 不可用
    return null;
  }
}

/** 解析可用的 rg 路径；无则返回 null（结果带缓存） */
export function resolveRipgrep(): string | null {
  if (cached !== undefined) return cached;

  const explicit = (process.env.ZQAGENT_RG ?? "").trim();
  if (explicit && fs.existsSync(explicit)) {
    cached = explicit;
    return cached;
  }

  const bundled = extractBundledRipgrep();
  if (bundled) {
    cached = bundled;
    return cached;
  }

  cached = findExecutable("rg", {
    platform: process.platform,
    env: process.env,
    fileExists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  });
  return cached;
}

/** 测试用：清除解析缓存 */
export function resetRipgrepCache(): void {
  cached = undefined;
}
