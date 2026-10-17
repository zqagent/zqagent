/**
 * 文件系统工具
 *
 * 提供 read_file / write_file / list_files 三个文件工具的实现，
 * 并注册到 ToolRegistry。所有工具都做了路径范围检查（限制在
 * 工作区内，防止通过 ../ 逃逸）。实现为工厂函数（makeXxx），
 * 以便为每个引擎实例绑定各自的工作区根目录。
 */
import * as fs from "fs";
import * as path from "path";
import { ToolRegistry, RiskClass, type ToolMetadata } from "./ToolRegistry.js";
import { resolveWithinRoot } from "./pathSafety.js";

/** read_file 默认最大读取行数 */
const DEFAULT_MAX_LINES = 2000;
/** 单行最大字符数（超长行截断，防止输出爆炸） */
const MAX_LINE_CHARS = 500;

/**
 * read_file — 行号标注版 (对齐 Python 版)
 *
 * 返回带行号的内容，格式 '  12\ttext'，便于引用为 path:line；
 * 大文件通过 start_line / max_lines 窗口化阅读。
 */
function makeReadFile(workspace: string) {
  const root = path.resolve(workspace);

  return function read_file(args: Record<string, unknown>) {
    const filePath = String(args.path ?? "");
    const startLine = Math.max(1, Number(args.start_line ?? 1));
    const maxLines = Math.min(Number(args.max_lines ?? DEFAULT_MAX_LINES), DEFAULT_MAX_LINES);

    // 路径范围检查 + 存在性/文件类型检查。
    // 用解析后的真实路径做后续 fs 操作，避免校验后 symlink 组件被替换。
    const resolved = resolveWithinRoot(root, filePath);
    if (!resolved) {
      return { error: "路径在工作区之外" };
    }
    const target = resolved.real;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { error: `不是文件: ${filePath}` };
    }

    // 按窗口截取行，超长行截断并标注
    const selected: string[] = [];
    let total = 0;
    try {
      const content = fs.readFileSync(target, "utf-8");
      const lines = content.split("\n");
      total = lines.length;
      for (let i = startLine - 1; i < Math.min(startLine - 1 + maxLines, lines.length); i++) {
        let text = lines[i];
        if (text.length > MAX_LINE_CHARS) {
          text = text.slice(0, MAX_LINE_CHARS) + "… (line truncated)";
        }
        selected.push(`${String(i + 1).padStart(6)}\t${text}`);
      }
    } catch (exc) {
      return { error: `读取失败: ${String(exc)}` };
    }

    const end = startLine + selected.length - 1;
    const result: Record<string, unknown> = {
      path: path.relative(resolved.root, target),
      start_line: startLine,
      end_line: end,
      total_lines: total,
      content: selected.join("\n"),
    };
    // 文件未读完时提示继续阅读的入口
    if (end < total) {
      result.note = `显示第 ${startLine}-${end} 行，共 ${total} 行；调用 read_file(start_line=${end + 1}) 继续阅读`;
    }
    return result;
  };
}

/**
 * write_file — 路径范围检查 + UTF-8 写入
 *
 * 自动创建父目录；overwrite=false 时拒绝覆盖已存在文件。
 */
function makeWriteFile(workspace: string) {
  const root = path.resolve(workspace);

  return function write_file(args: Record<string, unknown>) {
    const filePath = String(args.path ?? "");
    const content = String(args.content ?? "");
    const overwrite = args.overwrite !== false;

    // 路径范围 + 类型检查（不能写目录、默认不覆盖已有文件）
    const resolved = resolveWithinRoot(root, filePath);
    if (!resolved) {
      return { error: "路径在工作区之外" };
    }
    const target = resolved.real;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return { error: "路径是目录，不是文件" };
    }
    if (fs.existsSync(target) && !overwrite) {
      return { error: "文件已存在 (overwrite=false)" };
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
    } catch (exc) {
      return { error: `写入失败: ${String(exc)}` };
    }

    return path.relative(resolved.root, target);
  };
}

/**
 * list_files — 列出目录内容
 *
 * 跳过隐藏文件（. 开头）及 node_modules / __pycache__ / dist 等
 * 无意义目录；目录项以 / 后缀标识；结果按名称排序。
 */
function makeListFiles(workspace: string) {
  const root = path.resolve(workspace);

  return function list_files(args: Record<string, unknown>) {
    const dirPath = String(args.path ?? ".");
    const maxResults = Math.min(Number(args.max_results ?? 100), 100);
    const resolved = resolveWithinRoot(root, dirPath);
    if (!resolved) return { error: "路径在工作区之外" };
    const target = resolved.real;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { error: `不是目录: ${dirPath}` };
    }

    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const results: string[] = [];
      for (const e of entries) {
        if (results.length >= maxResults) break;
        if (e.name.startsWith(".")) continue;
        if (e.name === "node_modules" || e.name === "__pycache__" || e.name === "dist") continue;
        results.push(e.isDirectory() ? `${e.name}/` : e.name);
      }
      results.sort();
      return { path: path.relative(resolved.root, target), entries: results.slice(0, maxResults) };
    } catch (exc) {
      return { error: `列出文件失败: ${String(exc)}` };
    }
  };
}

/** replace_in_file — 精确文本替换 (对齐 Python 版 aisuite) */
function makeReplaceInFile(workspace: string) {
  const root = path.resolve(workspace);

  return function replace_in_file(args: Record<string, unknown>) {
    const filePath = String(args.path ?? "");
    const oldStr = String(args.old ?? "");
    const newStr = String(args.new ?? "");
    const expectedReplacements = Math.max(1, Number(args.expected_replacements ?? 1));

    if (!oldStr) return { error: "old 不能为空" };

    const resolved = resolveWithinRoot(root, filePath);
    if (!resolved) return { error: "路径在工作区之外" };
    const target = resolved.real;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { error: `不是文件: ${filePath}` };
    }

    try {
      const content = fs.readFileSync(target, "utf-8");
      const count = content.split(oldStr).length - 1;

      if (count !== expectedReplacements) {
        return { error: `期望 ${expectedReplacements} 处替换，实际找到 ${count} 处: ${filePath}` };
      }

      const updated = content.replaceAll(oldStr, newStr);
      fs.writeFileSync(target, updated, "utf-8");
      return {
        path: path.relative(resolved.root, target),
        replacements: count,
        chars_before: content.length,
        chars_after: updated.length,
      };
    } catch (exc) {
      return { error: `替换失败: ${String(exc)}` };
    }
  };
}

/**
 * 注册只读文件工具（read_file / list_files）。
 *
 * 供 explore 子代理等「只读」场景使用，使声明的 schema 与实际能力一致。
 */
export function registerReadOnlyFileTools(registry: ToolRegistry, workspace: string): void {
  const readFile = makeReadFile(workspace);
  registry.register(
    (args) => readFile(args),
    { category: "filesystem", riskLevel: "low", capabilities: ["read_file"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文本文件，返回带行号的内容 (格式: '  12\\\\ttext')，以便引用为 path:line。大文件窗口化：传递 start_line 从上一次读取的位置继续。只读。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径 (相对于工作区)" },
            start_line: { type: "integer", description: "起始行号 (从1开始，默认1)" },
            max_lines: { type: "integer", description: `最大行数 (默认 ${DEFAULT_MAX_LINES})` },
          },
          required: ["path"],
        },
      },
    },
  );

  const listFiles = makeListFiles(workspace);
  registry.register(
    (args) => listFiles(args),
    { category: "filesystem", riskLevel: "low", capabilities: ["list_files"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "列出目录下的文件和子目录。跳过隐藏文件和 node_modules 等目录。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径 (相对于工作区，默认 '.')" },
            max_results: { type: "integer", description: "最大结果数 (默认 100)" },
          },
        },
      },
    },
  );
}

/**
 * 注册文件工具到 ToolRegistry
 *
 * read_file / list_files 为低风险（无需审批）；write_file / replace_in_file
 * 为中风险且 requiresApproval=true（由权限引擎决定是否需要审批）。
 */
export function registerFileTools(registry: ToolRegistry, workspace: string): void {
  registerReadOnlyFileTools(registry, workspace);

  const writeFile = makeWriteFile(workspace);
  registry.register(
    (args) => writeFile(args),
    { category: "filesystem", riskLevel: "medium", capabilities: ["write_file"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "写入一个 UTF-8 文本文件。用于创建新文件或完全重写现有文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径 (相对于工作区)" },
            content: { type: "string", description: "文件内容 (UTF-8)" },
            overwrite: { type: "boolean", description: "是否覆盖已存在的文件 (默认 true)" },
          },
          required: ["path", "content"],
        },
      },
    },
  );

  const replaceFile = makeReplaceInFile(workspace);
  registry.register(
    (args) => replaceFile(args),
    { category: "filesystem", riskLevel: "medium", capabilities: ["edit_file"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "在文件中精确替换一段文本。先按预期次数精确匹配 old 字符串，然后替换为 new。用于小范围精确编辑。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径 (相对于工作区)" },
            old: { type: "string", description: "要被替换的精确文本" },
            new: { type: "string", description: "替换后的新文本" },
            expected_replacements: { type: "integer", description: "期望的替换次数 (默认 1)" },
          },
          required: ["path", "old", "new"],
        },
      },
    },
  );
}
