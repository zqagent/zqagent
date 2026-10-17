/**
 * 项目工作区文件浏览 / 读取（面向控制台，只读）
 *
 * 与 fsBrowser.ts（全盘目录选择器，供 admin 选工作目录）不同：
 * 这里严格限定在项目 workspaceRoot 之内，路径经 isWithinRoot 校验（含 symlink 防逃逸），
 * 返回相对路径，供 REST（GET /api/v1/files）与节点管理指令（list_files / read_file）共用。
 */
import * as fs from "fs";
import * as path from "path";
import { isWithinRoot, resolveWithinRoot } from "../tools/pathSafety.js";

export interface ProjectFileEntry {
  name: string;
  /** 相对 workspaceRoot 的路径（POSIX 分隔符） */
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
}

export interface ProjectFileListing {
  /** workspaceRoot 绝对路径（供 UI 展示） */
  root: string;
  /** 当前目录相对路径（"" 表示根） */
  path: string;
  /** 父目录相对路径；已在根时为 null */
  parent: string | null;
  entries: ProjectFileEntry[];
}

export interface ProjectFileContent {
  path: string;
  size: number;
  /** 二进制文件（含 NUL 字节）：不返回 content */
  binary: boolean;
  /** 超过上限被截断 */
  truncated: boolean;
  content: string;
}

export interface ProjectFileDownload {
  path: string;
  /** 文件名（basename） */
  name: string;
  size: number;
  /** 原始字节（base64） */
  base64: string;
}

/** 单文件读取上限（2MB，超出截断） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单文件下载上限（16MB；base64 经 MQTT/Hub 传输，不宜过大） */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
/** 单目录条目上限 */
const MAX_ENTRIES = 2000;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 解析并校验项目根（workspaceRoot）；未配置时抛错 */
export function projectRoot(workspaceRoot: string | null | undefined): string {
  const r = (workspaceRoot ?? "").trim();
  if (!r) {
    throw new Error("项目未设置工作区目录（workspaceRoot），无法浏览文件");
  }
  const abs = path.resolve(r);
  if (!fs.existsSync(abs)) {
    throw new Error(`工作区目录不存在: ${abs}`);
  }
  // 统一用 realpath 作基准：根目录本身是符号链接时，校验与实际读写才能对齐
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** 相对路径 → 绝对路径（解析符号链接），并校验未越界 */
function resolveWithin(root: string, rel: string): string {
  const clean = (rel ?? "").replace(/^[/\\]+/, "");
  const resolved = resolveWithinRoot(root, clean);
  if (!resolved) {
    throw new Error("路径越界（超出项目工作区）");
  }
  return resolved.real;
}

export function listProjectFiles(
  workspaceRoot: string | null | undefined,
  relPath?: string,
): ProjectFileListing {
  const base = projectRoot(workspaceRoot);
  const dir = resolveWithin(base, relPath ?? "");

  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`目录不存在: ${toPosix(path.relative(base, dir)) || "/"}`);
  }
  if (!st.isDirectory()) throw new Error("目标不是目录");

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error("无法读取目录（权限不足？）");
  }

  const entries: ProjectFileEntry[] = dirents.map((d) => {
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        // 断开/无权限的软链按文件处理
      }
    }
    let size = 0;
    let mtime = "";
    try {
      const s = fs.statSync(full);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch {
      // 忽略不可 stat 的条目
    }
    return {
      name: d.name,
      path: toPosix(path.relative(base, full)),
      type: isDir ? "dir" : "file",
      size,
      mtime,
    };
  });

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );

  const relDir = toPosix(path.relative(base, dir));
  const parentAbs = path.dirname(dir);
  return {
    root: base,
    path: relDir,
    parent: isWithinRoot(base, parentAbs) ? toPosix(path.relative(base, parentAbs)) : null,
    entries: entries.slice(0, MAX_ENTRIES),
  };
}

export function readProjectFile(
  workspaceRoot: string | null | undefined,
  relPath: string,
): ProjectFileContent {
  const base = projectRoot(workspaceRoot);
  const file = resolveWithin(base, relPath ?? "");

  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error("文件不存在");
  }
  if (!st.isFile()) throw new Error("目标不是文件");

  const buf = fs.readFileSync(file);
  const binary = isBinary(buf);
  const truncated = buf.length > MAX_FILE_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  return {
    path: toPosix(path.relative(base, file)),
    size: st.size,
    binary,
    truncated,
    content: binary ? "" : slice.toString("utf-8"),
  };
}

/**
 * 读取文件原始字节（下载用，含二进制）。
 * 路径经 isWithinRoot 校验（含 symlink 防逃逸），大小不超过 MAX_DOWNLOAD_BYTES。
 */
export function downloadProjectFile(
  workspaceRoot: string | null | undefined,
  relPath: string,
): ProjectFileDownload {
  const base = projectRoot(workspaceRoot);
  const file = resolveWithin(base, relPath ?? "");

  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error("文件不存在");
  }
  if (!st.isFile()) throw new Error("目标不是文件");
  if (st.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`文件超过下载上限（${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB）`);
  }

  const buf = fs.readFileSync(file);
  return {
    path: toPosix(path.relative(base, file)),
    name: path.basename(file),
    size: buf.length,
    base64: buf.toString("base64"),
  };
}

/** 粗略二进制判定：前 8KB 出现 NUL 即视为二进制 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 写入项目工作区文件（UTF-8 文本；新建或覆盖）。
 * 路径经 isWithinRoot 校验（含 symlink 防逃逸），大小不超过 2MB。
 */
export function writeProjectFile(
  workspaceRoot: string | null | undefined,
  relPath: string,
  content: string,
): { path: string; size: number } {
  const base = projectRoot(workspaceRoot);
  const rel = (relPath ?? "").trim();
  if (!rel) throw new Error("文件路径不能为空");
  const file = resolveWithin(base, rel);
  const buf = Buffer.from(String(content ?? ""), "utf-8");
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error("内容超过 2MB 上限，无法保存");
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  } catch (e) {
    throw new Error(`写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { path: toPosix(path.relative(base, file)), size: buf.length };
}

/** 新建目录（递归创建父目录） */
export function createProjectDir(
  workspaceRoot: string | null | undefined,
  relPath: string,
): { path: string } {
  const base = projectRoot(workspaceRoot);
  const rel = (relPath ?? "").trim();
  if (!rel) throw new Error("目录路径不能为空");
  const dir = resolveWithin(base, rel);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`创建目录失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { path: toPosix(path.relative(base, dir)) };
}

/** 新建文件（不覆盖已存在文件；自动创建父目录） */
export function createProjectFile(
  workspaceRoot: string | null | undefined,
  relPath: string,
  content = "",
): { path: string; size: number } {
  const base = projectRoot(workspaceRoot);
  const rel = (relPath ?? "").trim();
  if (!rel) throw new Error("文件路径不能为空");
  const file = resolveWithin(base, rel);
  if (fs.existsSync(file)) throw new Error("文件已存在");
  const buf = Buffer.from(String(content ?? ""), "utf-8");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  } catch (e) {
    throw new Error(`创建文件失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { path: toPosix(path.relative(base, file)), size: buf.length };
}

/** 递归搜索文件名（按关键字，忽略大小写；跳过常见重目录；上限 200 条） */
export function searchProjectFiles(
  workspaceRoot: string | null | undefined,
  query: string,
): Array<{ path: string; type: "file" | "dir" }> {
  const base = projectRoot(workspaceRoot);
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [];
  const LIMIT = 200;
  const SKIP = new Set([
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "target",
    ".cache",
  ]);
  const out: Array<{ path: string; type: "file" | "dir" }> = [];
  const walk = (dir: string, relBase: string): void => {
    if (out.length >= LIMIT) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length >= LIMIT) return;
      if (SKIP.has(d.name)) continue;
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(dir, d.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (d.name.toLowerCase().includes(q)) {
        out.push({ path: rel, type: isDir ? "dir" : "file" });
      }
      if (isDir) walk(path.join(dir, d.name), rel);
    }
  };
  walk(base, "");
  return out;
}
