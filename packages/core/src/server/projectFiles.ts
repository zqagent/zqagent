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
import { MAX_ZIP_ENTRIES, buildZip, type ZipEntryInput } from "./zipArchive.js";

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
/**
 * 二进制写入上限（图片编辑保存）。
 *
 * base64 会膨胀 4/3，而网关 WebSocket 单帧上限 4MB（gateway/src/frame.rs）、
 * HTTP 请求体上限 10MB，取 2.5MB 让两条传输路径都有充足余量。
 */
export const MAX_BINARY_BYTES = 2.5 * 1024 * 1024;
/** 单目录条目上限 */
const MAX_ENTRIES = 2000;

/**
 * 压缩下载的原始字节上限（100MB）。
 *
 * 这是一种「防跑飞」的护栏而不是能力上限：误选一个 node_modules 或整个仓库时，
 * 打包会在节点侧把内存打满、再经 base64 传给浏览器，体验比直接拒绝差得多。
 * 调用方可传更小的上限（网关传输的单帧限制比这严格得多，见 console-core/gateway.ts）。
 */
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

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

/**
 * 按 base64 写入二进制文件（新建或覆盖；图片编辑保存用）。
 * 路径经 isWithinRoot 校验（含 symlink 防逃逸），大小不超过 MAX_BINARY_BYTES。
 */
export function writeProjectFileBase64(
  workspaceRoot: string | null | undefined,
  relPath: string,
  base64: string,
): { path: string; size: number } {
  const base = projectRoot(workspaceRoot);
  const rel = (relPath ?? "").trim();
  if (!rel) throw new Error("文件路径不能为空");
  const file = resolveWithin(base, rel);
  const b64 = String(base64 ?? "").replace(/\s+/g, "");
  if (!b64) throw new Error("内容不能为空");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("内容不是合法的 base64");
  // 先按编码长度估算，避免为超大内容分配解码缓冲
  if (Math.floor((b64.length * 3) / 4) > MAX_BINARY_BYTES) {
    throw new Error(`内容超过 ${MAX_BINARY_BYTES / (1024 * 1024)}MB 上限，无法保存`);
  }
  const buf = Buffer.from(b64, "base64");
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
/** 删除结果：逐条返回，便于前端只对失败的项提示 */
export interface ProjectDeleteResult {
  /** 成功删除的相对路径（POSIX） */
  deleted: string[];
  /** 未能删除的项及原因 */
  failed: Array<{ path: string; error: string }>;
}

/**
 * 删除项目工作区内的文件 / 目录（目录递归删除）。
 *
 * 安全约束：
 * - 每个路径都经 resolveWithin 校验（含 symlink 防逃逸），越界直接算失败；
 * - 拒绝删除项目根（空路径）：那是整个工作区；
 * - 逐条处理而不是一次性全删——多选里混入一个不存在 / 无权限的项时，
 *   其余项仍应删掉，并把失败原因如实返回，而不是整批回滚。
 */
export function deleteProjectPaths(
  workspaceRoot: string | null | undefined,
  relPaths: string[],
): ProjectDeleteResult {
  const base = projectRoot(workspaceRoot);
  const out: ProjectDeleteResult = { deleted: [], failed: [] };
  const seen = new Set<string>();

  for (const raw of relPaths ?? []) {
    const rel = (raw ?? "").trim().replace(/^[/\\]+/, "");
    if (!rel) {
      out.failed.push({ path: String(raw ?? ""), error: "不能删除项目根目录" });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);

    let abs: string;
    try {
      abs = resolveWithin(base, rel);
    } catch (e) {
      out.failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // 再确认一次：解析后不能就是根目录本身
    if (path.resolve(abs) === path.resolve(base)) {
      out.failed.push({ path: rel, error: "不能删除项目根目录" });
      continue;
    }
    if (!fs.existsSync(abs)) {
      out.failed.push({ path: rel, error: "文件不存在" });
      continue;
    }
    try {
      // recursive: true 同时覆盖文件与目录；force 让并发删除不报错
      fs.rmSync(abs, { recursive: true, force: true });
      out.deleted.push(toPosix(path.relative(base, abs)));
    } catch (e) {
      out.failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** 人类可读的字节数（错误提示与 TODO 里都用它，避免各处自己算小数位） */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export interface ProjectRenameResult {
  /** 原相对路径（POSIX） */
  from: string;
  /** 重命名后的相对路径（POSIX） */
  path: string;
}

/**
 * 重命名项目工作区内的文件 / 目录（只改同一目录下的名字，不支持跨目录移动）。
 *
 * 约束与 deleteProjectPaths 一致：路径经 resolveWithin 校验（含 symlink 防逃逸），
 * 且新名字只能是**单段名字**——带 `/` 就变成了移动，语义与权限校验都另有一套。
 */
export function renameProjectPath(
  workspaceRoot: string | null | undefined,
  relPath: string,
  newName: string,
): ProjectRenameResult {
  const base = projectRoot(workspaceRoot);
  const rel = (relPath ?? "").trim().replace(/^[/\\]+/, "");
  if (!rel) throw new Error("不能重命名项目根目录");
  const abs = resolveWithin(base, rel);

  const name = (newName ?? "").trim();
  if (!name) throw new Error("名称不能为空");
  if (name === "." || name === "..") throw new Error("名称非法");
  if (/[/\\]/.test(name)) throw new Error("名称不能包含路径分隔符");
  if (!fs.existsSync(abs)) throw new Error("文件不存在");

  const parent = path.dirname(abs);
  const target = path.join(parent, name);
  if (!isWithinRoot(base, target)) throw new Error("路径越界（超出项目工作区）");

  if (fs.existsSync(target)) {
    // 仅改大小写（macOS / Windows 上很常见）时目标「已存在」其实是同一个 inode，
    // 用 inode 比对放行，否则用户会看到莫名其妙的「已存在同名文件」。
    // 不用 realpath：它在某些挂载点上不规范化末段的字符大小写，比对不可靠。
    let same = false;
    try {
      const a = fs.statSync(target);
      const b = fs.statSync(abs);
      same = a.ino === b.ino && a.dev === b.dev;
    } catch {
      same = false;
    }
    if (!same) throw new Error(`已存在同名文件或目录: ${name}`);
  }
  if (path.resolve(target) === path.resolve(abs)) {
    return { from: toPosix(path.relative(base, abs)), path: toPosix(path.relative(base, abs)) };
  }

  try {
    fs.renameSync(abs, target);
  } catch (e) {
    throw new Error(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { from: toPosix(path.relative(base, abs)), path: toPosix(path.relative(base, target)) };
}

export interface ProjectMoveResult {
  /** 移动成功的条目：原相对路径 → 新相对路径 */
  moved: Array<{ from: string; path: string }>;
  /** 逐条失败原因（个别失败不影响其余条目） */
  failed: Array<{ path: string; error: string }>;
}

/**
 * 把选中的文件 / 目录移动到目标目录（文件树里拖拽移动）。
 *
 * 与改名不同，目标可以是工作区内的任意目录。约束：
 * - 目标目录必须存在且在项目工作区内（resolveWithin 含 symlink 防逃逸）；
 * - 不覆盖同名条目：整条失败并说明原因，不做静默覆盖；
 * - 目录不能移动到自身或自身子目录里（否则会形成环）。
 */
export function moveProjectPaths(
  workspaceRoot: string | null | undefined,
  paths: string[],
  destDir: string,
): ProjectMoveResult {
  const base = projectRoot(workspaceRoot);
  const dest = resolveWithin(base, destDir ?? "");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dest);
  } catch {
    throw new Error(`目标目录不存在: ${toPosix(path.relative(base, dest)) || "/"}`);
  }
  if (!stat.isDirectory()) throw new Error("目标不是目录");

  const moved: ProjectMoveResult["moved"] = [];
  const failed: ProjectMoveResult["failed"] = [];

  for (const raw of paths) {
    const rel = (raw ?? "").trim().replace(/^[/\\]+/, "");
    if (!rel) {
      failed.push({ path: raw, error: "不能移动项目根目录" });
      continue;
    }
    try {
      const abs = resolveWithin(base, rel);
      if (!fs.existsSync(abs)) throw new Error("文件不存在");
      // 目录移进自己（或自己的子目录）会把整棵子树搬到自身之下，直接拒绝
      if (fs.statSync(abs).isDirectory() && (dest === abs || dest.startsWith(abs + path.sep))) {
        throw new Error("不能把目录移动到它自己内部");
      }

      const target = path.join(dest, path.basename(abs));
      const from = toPosix(path.relative(base, abs));
      if (path.resolve(target) === path.resolve(abs)) {
        // 已经在目标目录里：视为成功，不做无谓的 rename
        moved.push({ from, path: from });
        continue;
      }
      if (!isWithinRoot(base, target)) throw new Error("路径越界（超出项目工作区）");
      if (fs.existsSync(target)) {
        throw new Error(`目标目录已存在同名文件或目录: ${path.basename(abs)}`);
      }

      try {
        fs.renameSync(abs, target);
      } catch (e) {
        // 跨文件系统（工作区内有挂载点）时 rename 会 EXDEV，退化为复制后删除
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        fs.cpSync(abs, target, { recursive: true, errorOnExist: true, force: false });
        fs.rmSync(abs, { recursive: true, force: true });
      }
      moved.push({ from, path: toPosix(path.relative(base, target)) });
    } catch (e) {
      failed.push({ path: raw, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { moved, failed };
}

export interface ProjectZipResult {
  /** 归档文件名（含 .zip） */
  name: string;
  /** 归档字节数 */
  size: number;
  /** 归档前原始字节总数 */
  total: number;
  /** 归档内的条目数（含目录项） */
  entries: number;
  /** 归档内容（base64） */
  base64: string;
}

/** 待打包条目：文件带 size，目录（仅空目录）用来保留目录结构 */
interface ZipItem {
  abs: string;
  dir: boolean;
  size: number;
  mtime: Date;
}

/**
 * 把项目工作区内的文件 / 目录打成 zip（供控制台「压缩下载」）。
 *
 * - **打包前先算总量**：超过 `maxBytes` 立刻抛出带实际大小的错误，不做无谓的读盘与压缩；
 * - 单个目标打成「以它自身为根」的归档（选 `src/` 得到的是 `src/` 里的内容，
 *   而不是 `src/src/...`）；多选时保留各自相对工作区的路径；
 * - 软链一律跳过：它既可能指向工作区之外（打包即越权读取），也可能成环；
 * - 空目录写成一条尾随 `/` 的目录项，解压后目录结构不丢。
 */
export function zipProjectPaths(
  workspaceRoot: string | null | undefined,
  relPaths: string[],
  opts: { maxBytes?: number } = {},
): ProjectZipResult {
  const base = projectRoot(workspaceRoot);
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_ZIP_BYTES;
  const rels = (relPaths ?? []).map((x) => (x ?? "").trim().replace(/^[/\\]+/, ""));
  if (rels.length === 0) throw new Error("请选择要压缩的文件或目录");
  if (rels.some((r) => !r)) throw new Error("不能压缩项目根目录");

  const targets = rels.map((rel) => ({ rel, abs: resolveWithin(base, rel) }));
  const single = targets.length === 1 ? targets[0]!.abs : "";
  const items: ZipItem[] = [];
  let total = 0;

  const overLimit = (): Error =>
    new Error(
      `共 ${formatBytes(total)}，超过 ${formatBytes(maxBytes)} 上限，不支持压缩下载`,
    );

  /** 递归收集；返回该目录下的文件数（为 0 时写一条目录项保留空目录） */
  const walk = (absDir: string): number => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    let files = 0;
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const child = path.join(absDir, d.name);
      if (d.isDirectory()) {
        files += walk(child);
        continue;
      }
      if (!d.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(child);
      } catch {
        continue;
      }
      total += st.size;
      if (total > maxBytes) throw overLimit();
      if (items.length >= MAX_ZIP_ENTRIES) {
        throw new Error(`归档条目过多（超过 ${MAX_ZIP_ENTRIES} 项），请缩小范围后再试`);
      }
      items.push({ abs: child, dir: false, size: st.size, mtime: st.mtime });
      files++;
    }
    if (files === 0) {
      let mtime = new Date();
      try {
        mtime = fs.statSync(absDir).mtime;
      } catch {
        /* 忽略 */
      }
      items.push({ abs: absDir, dir: true, size: 0, mtime });
    }
    return files;
  };

  for (const t of targets) {
    let st: fs.Stats;
    try {
      st = fs.statSync(t.abs);
    } catch {
      throw new Error(`文件不存在: ${t.rel}`);
    }
    if (st.isDirectory()) {
      walk(t.abs);
      continue;
    }
    total += st.size;
    if (total > maxBytes) throw overLimit();
    items.push({ abs: t.abs, dir: false, size: st.size, mtime: st.mtime });
  }

  /** 归档内路径：单目标以其自身为根（相对路径为空时退回 basename，避免空名字） */
  const nameOf = (abs: string): string => {
    const rel = toPosix(path.relative(single || base, abs));
    return rel || path.posix.basename(toPosix(abs));
  };
  const zipEntries: ZipEntryInput[] = items.map((it) => {
    const name = nameOf(it.abs);
    if (it.dir) return { name: `${name}/`, mtime: it.mtime };
    return { name, data: fs.readFileSync(it.abs), mtime: it.mtime };
  });

  const buf = buildZip(zipEntries);
  const first = targets[0]!.rel;
  const name = single ? `${path.posix.basename(toPosix(first))}.zip` : "archive.zip";
  return {
    name,
    size: buf.length,
    total,
    entries: zipEntries.length,
    base64: buf.toString("base64"),
  };
}
