/**
 * 节点/本地引擎的文件系统目录浏览（项目工作目录选择）
 *
 * 供 REST（GET /api/v1/fs/list、/api/v1/fs/search）与节点管理指令
 * （list_dirs、search_dirs）共用。只列目录/文件名与路径，不读取文件内容。
 *
 * 搜索（searchDirs）的性能取舍 —— 主要面向「根目录下文件非常多」的场景：
 * - **在节点侧过滤**：超大目录只回传命中项，绝不回传完整列表（否则前端拿到的
 *   仍是被 MAX_ENTRIES 截断的一份，搜索必然漏结果）；
 * - **一次 readdir 拿名字**，只对**命中项**（≤ limit）做 stat 判定软链类型，
 *   不对 N 万个条目逐个 stat（那是大目录下真正的耗时来源）；
 * - **同目录条目名短 TTL 缓存**：连续输入只在缓存上做字符串过滤，不重复 readdir；
 * - 用 `fs.promises` 异步 IO，避免阻塞节点事件循环（大目录同步 readdir 会卡住
 *   所有指令与心跳）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface DirEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  /** 目录内条目总数（未截断时等于 entries.length） */
  total?: number;
  /** 条目数超过上限被截断（entries 只是其中一部分） */
  truncated?: boolean;
}

/** 目录搜索命中（性能与截断信息一并回传，供前端提示「N 项，仅显示前 M 项」） */
export interface DirSearchResult extends DirListing {
  /** 实际使用的关键字（回显） */
  query: string;
  /** 命中总数（可能大于 entries.length） */
  total: number;
  /** 命中数超过返回上限 */
  truncated: boolean;
}

/** 单目录条目上限（避免超大目录刷爆前端） */
const MAX_ENTRIES = 2000;

/** 单次搜索返回条目上限：默认 200，硬上限 1000 */
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;

/**
 * 列出目录内容。input 为空时用用户主目录；返回绝对路径 + 父目录 + 条目（目录优先排序）。
 * 路径不存在/不是目录/无权限时抛出带说明的错误。
 */
export function listDirs(input?: string): DirListing {
  const base = (input ?? "").trim() || os.homedir();
  const target = path.resolve(base);

  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    throw new Error(`路径不存在: ${target}`);
  }
  if (!st.isDirectory()) throw new Error(`不是目录: ${target}`);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    throw new Error(`无法读取目录（权限不足？）: ${target}`);
  }

  const entries: DirEntry[] = dirents.map((d) => {
    const full = path.join(target, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        // 断开/无权限的软链按文件处理
      }
    }
    return { name: d.name, path: full, type: isDir ? "dir" : "file" };
  });

  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : 1,
  );

  const parentDir = path.dirname(target);
  return {
    path: target,
    parent: parentDir !== target ? parentDir : null,
    entries: entries.slice(0, MAX_ENTRIES),
    total: entries.length,
    truncated: entries.length > MAX_ENTRIES,
  };
}

/** 子串命中打分：前缀额外加权，位置越靠前、名字越接近关键字（越"专指"）越高 */
function substringScore(name: string, query: string, idx: number): number {
  return (idx === 0 ? 2000 : 1000) - idx * 4 - (name.length - query.length);
}

/** 顺序子序列命中打分（如 `npx` 命中 `node_exporter_proxy.txt`）：间隔越小、起点越靠前越高 */
function subsequenceScore(
  name: string,
  lower: string,
  query: string,
  qLower: string,
): number | null {
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < lower.length && qi < qLower.length; i++) {
    if (lower[i] !== qLower[qi]) continue;
    if (first < 0) first = i;
    last = i;
    qi++;
  }
  if (qi < qLower.length) return null;
  const gaps = last - first + 1 - qLower.length;
  return 500 - gaps * 6 - first * 2 - (name.length - query.length);
}

/**
 * 文件名模糊匹配打分（不区分大小写；不命中返回 null）。
 *
 * 三档优先级（分数越高越靠前）：
 *   1. 前缀命中（关键字在开头）；
 *   2. 子串命中（越靠前越好）；
 *   3. 顺序子序列命中。
 *
 * 纯字符比较、无正则无回溯，单条目 O(名字长度)，十万级条目一次性过滤也在毫秒量级。
 */
export function fuzzyScore(name: string, query: string): number | null {
  if (!query) return 0;
  const lower = name.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx >= 0) return substringScore(name, query, idx);
  return subsequenceScore(name, lower, query, qLower);
}

/**
 * 目录内的条目名。
 *
 * - `lower`：小写形式在 readdir 时算一次并缓存 —— 搜索框边输入边搜，避免每次
 *   过滤都为 N 万个名字重新 toLowerCase（那是大目录下过滤的主要分配开销）；
 * - 类型只按目录项判断，软链留到命中后再 stat（命中数 ≤ limit）。
 */
interface NameEntry {
  name: string;
  lower: string;
  isDir: boolean;
  isLink: boolean;
}

/** 条目名缓存：TTL / 目录数上限 / 单目录条目数上限（超限不缓存，防内存膨胀） */
const NAME_CACHE_TTL_MS = 2000;
const NAME_CACHE_MAX_DIRS = 4;
const NAME_CACHE_MAX_ENTRIES = 50_000;

/** key = 绝对目录路径；Map 迭代顺序即 LRU 顺序（命中时重插到尾部） */
const nameCache = new Map<string, { at: number; entries: NameEntry[] }>();

/** 丢弃某目录的缓存（目录内容变化后调用，避免 TTL 内读到旧结果） */
function invalidateDirNames(target: string): void {
  nameCache.delete(path.resolve(target));
}

/**
 * 取目录内的条目名（带 TTL 缓存）。
 *
 * 根目录这类超大目录一次 readdir 就要几十到几百毫秒，而搜索框是「边输入边搜」，
 * 缓存让连续输入只在缓存数组上做字符串过滤，把重复成本降到几乎为零。
 */
async function loadDirNames(target: string): Promise<NameEntry[]> {
  const now = Date.now();
  const cached = nameCache.get(target);
  if (cached && now - cached.at < NAME_CACHE_TTL_MS) {
    nameCache.delete(target);
    nameCache.set(target, cached);
    return cached.entries;
  }

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(target, { withFileTypes: true });
  } catch {
    throw new Error(`无法读取目录（权限不足？）: ${target}`);
  }

  const entries: NameEntry[] = dirents.map((d) => ({
    name: d.name,
    lower: d.name.toLowerCase(),
    isDir: d.isDirectory(),
    isLink: d.isSymbolicLink(),
  }));

  if (entries.length <= NAME_CACHE_MAX_ENTRIES) {
    nameCache.set(target, { at: now, entries });
    while (nameCache.size > NAME_CACHE_MAX_DIRS) {
      const oldest = nameCache.keys().next().value;
      if (oldest === undefined) break;
      nameCache.delete(oldest);
    }
  } else {
    // 条目过多：缓存本身会占不少内存，直接不缓存
    nameCache.delete(target);
  }
  return entries;
}

/** 命中项 → 目录条目（软链才 stat；命中量 ≤ limit，成本可控） */
async function toDirEntry(dir: string, e: NameEntry): Promise<DirEntry> {
  const full = path.join(dir, e.name);
  let isDir = e.isDir;
  if (e.isLink) {
    try {
      isDir = (await fs.promises.stat(full)).isDirectory();
    } catch {
      // 断开/无权限的软链按文件处理
    }
  }
  return { name: e.name, path: full, type: isDir ? "dir" : "file" };
}

/**
 * 在当前目录内按关键字模糊搜索文件名（目录与文件都参与匹配）。
 *
 * - query 为空时等价于列出该目录（仍受 limit 约束）；
 * - 结果按匹配得分排序（同分时目录优先），最多返回 limit 条，total 为命中总数；
 * - 路径不存在/不是目录/无权限时抛出带说明的错误（与 listDirs 一致）。
 */
export async function searchDirs(
  input: string | undefined,
  query: string,
  limit?: number,
): Promise<DirSearchResult> {
  const base = (input ?? "").trim() || os.homedir();
  const target = path.resolve(base);

  let st: fs.Stats;
  try {
    st = await fs.promises.stat(target);
  } catch {
    throw new Error(`路径不存在: ${target}`);
  }
  if (!st.isDirectory()) throw new Error(`不是目录: ${target}`);

  const names = await loadDirNames(target);
  const q = (query ?? "").trim();
  const max = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.trunc(limit as number)), MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;

  interface Scored {
    entry: NameEntry;
    score: number;
  }
  const scored: Scored[] = [];
  const qLower = q.toLowerCase();
  // 一趟只做子串匹配（最常见的输入方式，且命中分数最高）：名字的小写形式已随条目缓存好
  for (const e of names) {
    if (!q) {
      scored.push({ entry: e, score: 0 });
      continue;
    }
    const idx = e.lower.indexOf(qLower);
    if (idx >= 0) scored.push({ entry: e, score: substringScore(e.name, q, idx) });
  }
  // 仅当子串命中不够时，才补一轮顺序子序列匹配（其分数恒低于子串命中，不会挤掉它们），
  // 避免「子串已经命中一大堆」时还做一遍全量子序列扫描
  if (q && scored.length < max) {
    for (const e of names) {
      if (e.lower.indexOf(qLower) >= 0) continue;
      const score = subsequenceScore(e.name, e.lower, q, qLower);
      if (score !== null) scored.push({ entry: e, score });
    }
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.entry.isDir !== b.entry.isDir
        ? a.entry.isDir
          ? -1
          : 1
        : a.entry.name.localeCompare(b.entry.name),
  );

  const hit = scored.slice(0, max);
  const entries = await Promise.all(hit.map(({ entry }) => toDirEntry(target, entry)));

  const parentDir = path.dirname(target);
  return {
    path: target,
    parent: parentDir !== target ? parentDir : null,
    entries,
    query: q,
    total: scored.length,
    truncated: scored.length > entries.length,
  };
}

/**
 * 在当前目录下新建目录（目录浏览时使用；支持 `a/b` 形式的相对多级路径）。
 *
 * @param parentInput 当前浏览目录（空 = 用户主目录）
 * @param name        新目录名（相对 parent；不允许越出 parent）
 * @returns 新建目录的条目（绝对路径）
 */
export function makeDirIn(parentInput: string | undefined, name: string): DirEntry {
  const parent = path.resolve((parentInput ?? "").trim() || os.homedir());
  const clean = (name ?? "").trim();
  if (!clean) throw new Error("目录名不能为空");
  if (clean === "." || clean === "..") throw new Error("目录名非法");

  const target = path.resolve(parent, clean);
  const rel = path.relative(parent, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("目录名不能越出当前目录");
  }

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(target);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) throw new Error(`已存在同名文件: ${target}`);

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    throw new Error(`创建目录失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 新建后立刻搜索该名字应能命中，不受条目缓存 TTL 影响
  invalidateDirNames(parent);
  return { name: path.basename(target), path: target, type: "dir" };
}
