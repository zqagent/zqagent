/**
 * 纯 Node 实现的 grep 回退
 *
 * 当 ripgrep 不可用时（未捆绑 / 未安装），用 fs 递归遍历 + JS RegExp 匹配，
 * 保证 grep 工具在任意环境都能工作，且支持完整的 JS 正则语法
 * （\d / \s / + / | 等，findstr 的 POSIX 子集远不能及）。
 *
 * 取舍：比 ripgrep 慢，因此做了忽略目录（.git/node_modules）、文件大小上限、
 * 二进制探测与最大匹配数限制；作为最后兜底足够用。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface NodeGrepOptions {
  pattern: string;
  /** 搜索目标：文件或目录（可为绝对/相对路径） */
  target: string;
  /** 工作区根：用于把命中路径格式化为相对路径 */
  workspace: string;
  /** 单文件读取上限（字节），超过则跳过 */
  maxFileBytes?: number;
  /** 最大匹配数 */
  maxMatches?: number;
}

/** 遍历时跳过的目录名 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
]);

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 在目标文件 / 目录中搜索。命中返回 {file, line, text} 列表。
 * 目标不存在时抛错（区别于「无匹配」）。
 */
export function nodeGrep(opts: NodeGrepOptions): GrepMatch[] {
  const maxMatches = opts.maxMatches ?? 50;
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;

  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern);
  } catch (err) {
    throw new Error(`无效的正则表达式: ${opts.pattern}（${String(err)}）`);
  }

  const target = path.resolve(opts.workspace, opts.target);
  if (!fs.existsSync(target)) {
    throw new Error(`搜索路径不存在: ${opts.target}`);
  }

  const matches: GrepMatch[] = [];

  const scanFile = (file: string): boolean => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size > maxFileBytes) return false;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return false;
    }
    if (looksBinary(buf)) return false;

    const rel = path.relative(opts.workspace, file) || path.basename(file);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.replace(/\r$/, "");
      if (regex.test(raw)) {
        matches.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 200) });
        if (matches.length >= maxMatches) return true; // 达到上限，通知停止
      }
    }
    return false;
  };

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    scanFile(target);
    return matches;
  }

  // 迭代式深度优先遍历（避免深目录递归爆栈）
  const stack: string[] = [target];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        if (scanFile(full)) return matches;
      }
    }
  }

  return matches;
}
