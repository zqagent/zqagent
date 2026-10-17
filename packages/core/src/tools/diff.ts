import { ToolRegistry } from "./ToolRegistry.js";

/**
 * apply_patch + apply_unified_diff
 * 对齐 Python 版 aisuite.toolkits.files.FileToolkit
 */

import * as fs from "fs";
import * as path from "path";
import { resolveEntryWithinRoot, resolveWithinRoot } from "./pathSafety.js";

/** apply_patch — Codex 风格补丁 (对齐 Python 版) */
function makeApplyPatch(workspace: string) {
  const root = path.resolve(workspace);

  return function apply_patch(args: Record<string, unknown>) {
    const patch = String(args.patch ?? "");
    if (!patch.trim()) return { error: "补丁内容不能为空" };

    // 归一化 CRLF，并去掉尾部空白：否则 `*** End Patch\n` 会因最后一项是空串
    // 而被误判为「补丁必须以 *** End Patch 结尾」。
    const lines = patch
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trimEnd()
      .split("\n");
    if (!lines[0]?.trim().startsWith("*** Begin Patch")) {
      return { error: "补丁必须以 '*** Begin Patch' 开头" };
    }
    if (!lines[lines.length - 1]?.trim().startsWith("*** End Patch")) {
      return { error: "补丁必须以 '*** End Patch' 结尾" };
    }

    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const deletedFiles: string[] = [];
    let fileCount = 0;

    let i = 1;
    while (i < lines.length - 1) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }

      if (line.startsWith("*** Add File: ")) {
        const filePath = line.slice("*** Add File: ".length).trim();
        const resolved = resolveWithinRoot(root, filePath);
        if (!resolved) {
          return { error: `路径在工作区之外: ${filePath}` };
        }
        const target = resolved.real;
        i++;
        const contentLines: string[] = [];
        while (i < lines.length - 1 && !lines[i].trimStart().startsWith("*** ")) {
          const current = lines[i];
          if (!current.startsWith("+")) {
            return { error: `无效的 add-file 补丁行: ${current}` };
          }
          contentLines.push(current.slice(1));
          i++;
        }
        if (fs.existsSync(target)) {
          return { error: `文件已存在: ${filePath}` };
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contentLines.join("\n") + "\n", "utf-8");
        const rel = path.relative(resolved.root, target);
        changedFiles.push(rel);
        addedFiles.push(rel);
        fileCount++;
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        const filePath = line.slice("*** Delete File: ".length).trim();
        // 删除作用于条目本身：父目录取 realpath，最后一段不解析
        const entry = resolveEntryWithinRoot(root, filePath);
        if (!entry) {
          return { error: `路径在工作区之外: ${filePath}` };
        }
        const target = entry.real;
        if (!fs.existsSync(target)) {
          return { error: `文件不存在: ${filePath}` };
        }
        fs.unlinkSync(target);
        deletedFiles.push(path.relative(entry.root, target));
        fileCount++;
        i++;
        continue;
      }

      if (line.startsWith("*** Update File: ")) {
        const filePath = line.slice("*** Update File: ".length).trim();
        const resolved = resolveWithinRoot(root, filePath);
        if (!resolved) {
          return { error: `路径在工作区之外: ${filePath}` };
        }
        const target = resolved.real;
        i++;
        let moveTo: string | null = null;
        if (i < lines.length - 1 && lines[i].trimStart().startsWith("*** Move to: ")) {
          moveTo = lines[i].trim().slice("*** Move to: ".length).trim();
          i++;
        }

        const chunkLines: string[][] = [];
        let currentChunk: string[] = [];
        while (i < lines.length - 1 && !lines[i].trimStart().startsWith("*** ")) {
          const ln = lines[i];
          if (ln.trimStart().startsWith("@@")) {
            if (currentChunk.length) {
              chunkLines.push(currentChunk);
              currentChunk = [];
            }
          } else if (ln && " +-".includes(ln[0]!)) {
            currentChunk.push(ln);
          }
          i++;
        }
        if (currentChunk.length) chunkLines.push(currentChunk);
        if (!chunkLines.length) {
          return { error: `补丁更新没有 hunks: ${filePath}` };
        }

        // Read original file
        if (!fs.existsSync(target)) {
          return { error: `文件不存在: ${filePath}` };
        }
        const oldLines = fs.readFileSync(target, "utf-8").split("\n");
        // Apply hunks
        const newLines = applyPatchHunks(oldLines, chunkLines, filePath);

        let finalResolved = resolved;
        if (moveTo) {
          const moved = resolveWithinRoot(root, moveTo);
          if (!moved) {
            return { error: `路径在工作区之外: ${moveTo}` };
          }
          finalResolved = moved;
        }
        const finalTarget = finalResolved.real;
        if (moveTo && fs.existsSync(finalTarget) && finalTarget !== target) {
          return { error: `文件已存在: ${moveTo}` };
        }
        fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
        fs.writeFileSync(finalTarget, newLines.join("\n"), "utf-8");
        if (moveTo && finalTarget !== target) {
          // 删除源条目本身：父目录取 realpath，最后一段不解析（符号链接删链接）
          const entry = resolveEntryWithinRoot(root, filePath);
          if (!entry) {
            return { error: `路径在工作区之外: ${filePath}` };
          }
          fs.unlinkSync(entry.real);
          deletedFiles.push(path.relative(resolved.root, target));
        }
        changedFiles.push(path.relative(finalResolved.root, finalTarget));
        fileCount++;
        continue;
      }

      return { error: `未知的补丁操作: ${line}` };
    }

    if (fileCount === 0) {
      return { error: "补丁不包含任何文件操作" };
    }

    return { changed_files: changedFiles, added_files: addedFiles, deleted_files: deletedFiles, file_count: fileCount };
  };
}

/** 应用补丁 hunks 到文件行 */
function applyPatchHunks(oldLines: string[], chunks: string[][], path: string): string[] {
  let newLines = [...oldLines];
  let cursor = 0;

  for (const chunk of chunks) {
    const oldBlock = chunk.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
    const newBlock = chunk.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1));

    if (!oldBlock.length) {
      throw new Error(`补丁 hunk 必须包含上下文或删除行: ${path}`);
    }

    // Find match for old block
    const matchStart = findBlockMatch(newLines, oldBlock, cursor);
    if (matchStart === -1) {
      throw new Error(`补丁上下文不匹配: ${path}`);
    }

    const matchEnd = matchStart + oldBlock.length;
    newLines.splice(matchStart, oldBlock.length, ...newBlock);
    cursor = matchStart + newBlock.length;
  }

  return newLines;
}

/** 在行数组中查找块匹配 */
function findBlockMatch(lines: string[], block: string[], start: number): number {
  for (let i = start; i <= lines.length - block.length; i++) {
    if (lines.slice(i, i + block.length).every((l, j) => l === block[j]!)) {
      return i;
    }
  }
  return -1;
}

// ==================== Unified Diff ====================

/** apply_unified_diff — 标准 unified diff (对齐 Python 版) */
function makeApplyUnifiedDiff(workspace: string) {
  const root = path.resolve(workspace);

  return function apply_unified_diff(args: Record<string, unknown>) {
    const diff = String(args.diff ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!diff.trim()) return { error: "diff 内容不能为空" };

    const patches = parseUnifiedDiff(diff);
    if (!patches.length) return { error: "未找到 unified diff 文件补丁" };

    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const deletedFiles: string[] = [];
    let hunkCount = 0;

    for (const patch of patches) {
      const oldIsDevNull = patch.oldPath === "/dev/null";
      const newIsDevNull = patch.newPath === "/dev/null";
      const targetPath = newIsDevNull ? patch.oldPath : patch.newPath;
      const resolved = resolveWithinRoot(root, targetPath);
      if (!resolved) {
        return { error: `路径在工作区之外: ${targetPath}` };
      }
      const target = resolved.real;

      const oldLines = oldIsDevNull ? [] : (fs.existsSync(target) ? fs.readFileSync(target, "utf-8").split("\n") : []);
      const newLines = applyDiffHunks(oldLines, patch.hunks, targetPath);
      hunkCount += patch.hunks.length;

      if (newIsDevNull) {
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isFile()) {
            return { error: `路径不是文件: ${targetPath}` };
          }
          // 删除源条目本身：父目录取 realpath，最后一段不解析
          const entry = resolveEntryWithinRoot(root, targetPath);
          if (!entry) {
            return { error: `路径在工作区之外: ${targetPath}` };
          }
          fs.unlinkSync(entry.real);
        }
        deletedFiles.push(path.relative(resolved.root, target));
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, newLines.join("\n"), "utf-8");
      const rel = path.relative(resolved.root, target);
      changedFiles.push(rel);
      if (oldIsDevNull) addedFiles.push(rel);
    }

    return {
      changed_files: changedFiles,
      added_files: addedFiles,
      deleted_files: deletedFiles,
      file_count: patches.length,
      hunk_count: hunkCount,
    };
  };
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split("\n");
  const patches: FilePatch[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.startsWith("--- ")) { i++; continue; }

    const oldPath = parseDiffFileLine(lines[i]!, "---");
    i++;
    if (i >= lines.length || !lines[i]!.startsWith("+++ ")) {
      throw new Error("Unified diff 缺少 +++ 文件头");
    }
    const newPath = parseDiffFileLine(lines[i]!, "+++");
    i++;

    const hunks: DiffHunk[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (current.startsWith("--- ")) break;
      if (!current.startsWith("@@ ")) { i++; continue; }

      const [oldStart, oldCount, newStart, newCount] = parseHunkHeader(current);
      i++;
      const hunkLines: string[] = [];
      while (i < lines.length) {
        const ln = lines[i]!;
        if (ln.startsWith("@@ ") || ln.startsWith("--- ")) break;
        if (ln.startsWith("\\ No newline")) { i++; continue; }
        if (ln && " +-".includes(ln[0]!)) {
          hunkLines.push(ln);
          i++;
        } else {
          break;
        }
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
    }
    if (hunks.length) {
      patches.push({ oldPath, newPath, hunks });
    }
  }

  return patches;
}

function parseDiffFileLine(line: string, marker: string): string {
  let value = line.slice(marker.length).trim();
  if (value.includes("\t")) value = value.split("\t")[0]!;
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value;
}

function parseHunkHeader(line: string): [number, number, number, number] {
  const parts = line.split(" ");
  if (parts.length < 3 || !parts[1]!.startsWith("-") || !parts[2]!.startsWith("+")) {
    throw new Error(`无效的 hunk header: ${line}`);
  }
  const [oldStart, oldCount] = parseRange(parts[1]!.slice(1));
  const [newStart, newCount] = parseRange(parts[2]!.slice(1));
  return [oldStart, oldCount, newStart, newCount];
}

function parseRange(value: string): [number, number] {
  if (!value.includes(",")) return [parseInt(value), 1];
  const [start, count] = value.split(",");
  return [parseInt(start!), parseInt(count!)];
}

function applyDiffHunks(oldLines: string[], hunks: DiffHunk[], filePath: string): string[] {
  const newLines: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = Math.max(hunk.oldStart - 1, 0);
    if (start < cursor) {
      throw new Error(`Overlapping hunks: ${filePath}`);
    }
    newLines.push(...oldLines.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      const prefix = line[0]!;
      const content = line.slice(1);
      if (prefix === " ") {
        if (cursor >= oldLines.length || oldLines[cursor] !== content) {
          throw new Error(`Diff context 不匹配: ${filePath}`);
        }
        newLines.push(oldLines[cursor]!);
        cursor++;
      } else if (prefix === "-") {
        if (cursor >= oldLines.length || oldLines[cursor] !== content) {
          throw new Error(`Diff removal 不匹配: ${filePath}`);
        }
        cursor++;
      } else if (prefix === "+") {
        newLines.push(content);
      }
    }
  }
  newLines.push(...oldLines.slice(cursor));
  return newLines;
}

/** 注册 diff 工具 */
export function registerDiffTools(registry: ToolRegistry, workspace: string): void {
  const applyPatchFunc = makeApplyPatch(workspace);
  registry.register(
    (args) => applyPatchFunc(args),
    { category: "filesystem", riskLevel: "medium", capabilities: ["edit_file"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "应用 Codex 风格的补丁信封（使用 *** Begin Patch / *** End Patch 段落）。支持 Add File、Delete File、Update File 操作。",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "补丁内容 (必须包含 *** Begin Patch 和 *** End Patch)" },
          },
          required: ["patch"],
        },
      },
    },
  );

  const applyUnifiedDiffFunc = makeApplyUnifiedDiff(workspace);
  registry.register(
    (args) => applyUnifiedDiffFunc(args),
    { category: "filesystem", riskLevel: "medium", capabilities: ["edit_file"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "apply_unified_diff",
        description: "应用标准 unified diff 补丁。支持 --- / +++ 文件头和 @@ hunk headers。",
        parameters: {
          type: "object",
          properties: {
            diff: { type: "string", description: "unified diff 格式的补丁内容" },
          },
          required: ["diff"],
        },
      },
    },
  );
}
