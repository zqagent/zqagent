/**
 * 搜索工具
 *
 * 提供 grep 工具。执行策略：
 *   1. ripgrep (rg) —— 优先使用内嵌/已安装的 rg，性能与正则支持最好；
 *   2. 纯 Node 扫描器（nodeGrep.ts）—— rg 不可用时的跨平台兜底，
 *      支持完整 JS 正则，不依赖系统 findstr/grep。
 *
 * 返回匹配的文件名、行号和内容，最多 50 条。
 */
import { ToolRegistry } from "./ToolRegistry.js";
import { execAsync } from "./execAsync.js";
import { decodeOutput } from "./shell.js";
import { nodeGrep, type GrepMatch } from "./nodeGrep.js";
import { resolveRipgrep } from "./ripgrep.js";

/** 解析 rg 的 `文件:行号:内容` 输出 */
function parseRgOutput(result: string): GrepMatch[] {
  return result
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)
    .slice(0, 50)
    .map((line) => {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) return { file: line.trim(), line: 0, text: "" };
      return { file: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) };
    });
}

/**
 * grep — 使用 ripgrep，缺失时回退到纯 Node 扫描
 *
 * 安全说明：使用异步 execAsync（参数数组）而非 shell 字符串拼接，
 * pattern/path 作为独立参数传递，不经 shell 解释，杜绝命令注入。
 */
function makeGrep(workspace: string) {
  return async function grep(args: Record<string, unknown>) {
    const pattern = String(args.pattern ?? "");
    const filePath = String(args.path ?? ".");

    if (!pattern.trim()) {
      return { error: "搜索模式不能为空" };
    }

    const rg = resolveRipgrep();
    if (rg) {
      const res = await execAsync(
        rg,
        [
          // --with-filename：单文件模式下 rg 默认不输出文件名前缀，会导致
          // "行号:内容" 被误当成 "文件:行号:内容" 解析而错位；显式要求带文件名。
          "--with-filename",
          "--line-number",
          "--no-heading",
          "--max-count",
          "50",
          pattern,
          filePath,
        ],
        {
          cwd: workspace,
          timeoutMs: 10000,
          maxBuffer: 1024 * 1024 * 2,
        },
      );
      // rg 退出码：0=有匹配，1=无匹配，其余=错误
      if (res.status === 0) {
        const matches = parseRgOutput(decodeOutput(res.stdout));
        return { query: pattern, engine: "ripgrep", matches, count: matches.length };
      }
      if (res.status === 1) {
        return { query: pattern, engine: "ripgrep", matches: [], count: 0 };
      }
      // 其它情况（含 rg 崩溃、路径不存在被 rg 报错）→ 交给纯 Node 扫描，
      // 后者能给出「路径不存在」这类明确错误。
    }

    try {
      const matches = nodeGrep({ pattern, target: filePath, workspace });
      return { query: pattern, engine: "node", matches, count: matches.length };
    } catch (exc) {
      return { error: `搜索失败: ${String(exc instanceof Error ? exc.message : exc)}` };
    }
  };
}

/** 注册 grep 工具（低风险，无需审批） */
export function registerSearchTool(registry: ToolRegistry, workspace: string): void {
  const grepFunc = makeGrep(workspace);

  registry.register(
    (args) => grepFunc(args),
    { category: "search", riskLevel: "low", capabilities: ["search"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "grep",
        description:
          "在文件中搜索文本模式（支持完整 JS 正则语法）。返回匹配的文件名、行号和内容，最多 50 条。" +
          "优先使用 ripgrep (rg) 以获得更好的性能；rg 不可用时自动回退到内置扫描器。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "搜索模式 (文本或正则表达式)" },
            path: { type: "string", description: "搜索路径 (文件或目录，默认 '.')" },
          },
          required: ["pattern"],
        },
      },
    },
  );
}
