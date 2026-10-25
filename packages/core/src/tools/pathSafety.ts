/**
 * 路径安全辅助函数
 *
 * 判断目标路径是否真正位于工作区根目录之内。
 *
 * 仅做字符串比较（path.relative）无法防御符号链接逃逸：
 * 工作区内若存在指向外部的 symlink，`workspace/link/secret.txt`
 * 的字符串前缀合法，但实际读写发生在链接目标（工作区外）。
 *
 * 因此这里用 fs.realpathSync 解析符号链接后再与根目录的 realpath
 * 比较。目标尚不存在（如 write_file 新建文件）时，向上回溯到最近
 * 已存在的祖先目录解析，再拼回剩余路径段。
 *
 * 校验通过时把解析后的真实路径一并返回：调用方必须用它（而非原始
 * 相对路径）做实际 fs 操作，否则「校验后、操作前」路径组件被替换为
 * 指向外部的 symlink 仍会逃逸（TOCTOU）。
 */
import * as fs from "fs";
import * as path from "path";

/**
 * 判断 `path.relative(root, target)` 的结果是否落在 root 之内。
 *
 * 逃逸必然恰好是 `..` 或以 `..` + 分隔符开头，不能用 `startsWith("..")`：
 * 工作区里名为 `..foo` 的合法条目会被误判为逃逸而拒绝。
 * 跨盘符时（Windows）path.relative 返回绝对路径，一并拒绝。
 *
 * 导出供自行做 `path.relative` 校验的调用方复用（如目录浏览新建目录、
 * git 面板的 repo / path 参数），避免各处重复写 `startsWith("..")`。
 */
export function isInsideRelative(rel: string): boolean {
  return (
    !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
  );
}

/** 是否为文件系统根（"/"、"C:\\"） */
function isFilesystemRoot(p: string): boolean {
  return path.parse(p).root === p;
}

/** 校验通过的路径：root 为工作区根的真实路径，real 为目标的真实路径 */
export interface ResolvedPath {
  root: string;
  real: string;
}

/**
 * 校验 target（相对 workspace 的路径）是否位于 workspace 内，并返回
 * 解析符号链接后的真实路径；不在工作区内时返回 null。
 *
 * - 解析符号链接：路径中任何 symlink 组件都会先 realpath 再校验；
 *   broken symlink（存在但无法解析）一律拒绝。
 * - 目标不存在时（写新文件）：回溯到最近存在的祖先做 realpath，
 *   再拼接剩余段，仍能捕获祖先链中的 symlink 逃逸。
 * - 工作区根若就是文件系统根（`WORKSPACE=/`）：此时任何绝对路径都在
 *   其内，等同没有沙箱，直接判为越界。
 */
export function resolveWithinRoot(
  workspace: string,
  target: string,
): ResolvedPath | null {
  const abs = path.resolve(workspace, target);

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(workspace);
  } catch {
    // 根目录不存在（如权限引擎尚未初始化工作区）：
    // 没有实际目录结构即无 symlink 逃逸面，退化为纯字符串路径比较。
    const rootAbs = path.resolve(workspace);
    if (!isInsideRelative(path.relative(rootAbs, abs))) return null;
    return { root: rootAbs, real: abs };
  }
  if (isFilesystemRoot(rootReal)) return null;

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // abs 不存在：向上回溯找最近存在的祖先
    let probe = abs;
    const tail: string[] = [];
    for (;;) {
      // 组件存在（含 broken symlink）但 realpath 失败 → 无法解析，拒绝
      const exists = fs.existsSync(probe) || fs.lstatSync(probe, { throwIfNoEntry: false }) !== undefined;
      if (exists) {
        try {
          real = path.join(fs.realpathSync(probe), ...tail);
          break;
        } catch {
          return null;
        }
      }
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) return null; // 已到文件系统根
      probe = parent;
    }
  }

  if (!isInsideRelative(path.relative(rootReal, real))) return null;
  return { root: rootReal, real };
}

/**
 * 判断 target 是否安全地位于 workspace 内（不需要真实路径时用这个）。
 *
 * 注意：删除类操作不应据此改用 realpath 去 unlink —— 那会删掉符号链接
 * 指向的目标而非链接本身；这类操作请用 resolveEntryWithinRoot。
 */
export function isWithinRoot(workspace: string, target: string): boolean {
  return resolveWithinRoot(workspace, target) !== null;
}

/**
 * 解析「目录项本身」的路径：父目录取 realpath，最后一段保持原样。
 *
 * 供 unlink / rename 等作用于条目自身的操作用：父目录不可被 symlink
 * 替换，而最后一段若是符号链接，被操作的是链接本身，不会被跟随。
 */
export function resolveEntryWithinRoot(
  workspace: string,
  target: string,
): ResolvedPath | null {
  const abs = path.resolve(workspace, target);
  const parent = resolveWithinRoot(workspace, path.dirname(abs));
  if (!parent) return null;
  return { root: parent.root, real: path.join(parent.real, path.basename(abs)) };
}
