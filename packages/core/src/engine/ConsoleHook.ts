/**
 * ConsoleHook — 将引擎事件打印到控制台
 *
 * 这是 EngineHook 的参考实现。调用者可替换为 FileLogHook、
 * WsBroadcastHook、SqliteHook 等任意实现。
 */
import type {
  EngineHook,
  EventType,
  CompactionStartInfo,
  CompactionDoneInfo,
} from "../engine/events.js";
import type { TokenUsage } from "../engine/types.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { formatTokens } from "./compaction.js";
import { authErrorHints, networkErrorHints, paramErrorHints } from "../providers/diagnostics.js";
import { cliLog, cliWrite, UNICODE_SUPPORTED } from "../terminal.js";

/** Markdown 行内转义：工具名按字面渲染，避免 _ * ` 等被当作行内语法 */
function mdInline(text: string): string {
  return String(text).replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** 折叠为单行：参数值里的换行会打断卡片「一项一行」的排版 */
export function oneLine(text: string): string {
  return String(text)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** 单个字符的显示宽度：CJK/全角字符占 2 列 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6);
  return wide ? 2 : 1;
}

/** 字符串的终端显示宽度（列数） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 参数值的一行宽度上限：扣掉「参数: 」标签，保证整行不超出终端宽度 */
function argsMaxWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, cols - displayWidth("参数: "));
}

/** 按显示宽度截断（CJK 占 2 列），末尾用省略号提示后文已省略 */
export function truncateToWidth(text: string, maxWidth = 80): string {
  if (displayWidth(text) <= maxWidth) return text;
  let head = "";
  for (const ch of text) {
    if (displayWidth(head) + charWidth(ch) > maxWidth - 3) break;
    head += ch;
  }
  return head + "...";
}

/** 工具参数 → 单行可读文本（`key: value`），超宽按显示宽度截断 */
export function formatToolArgs(
  args: Record<string, unknown> | undefined,
  maxWidth = 80,
): string {
  if (!args) return "";
  const text = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return truncateToWidth(text, maxWidth);
}

/** 工具执行状态 → 中文描述 */
function toolStatusText(status: string): string {
  if (status === "ok") return "✅ 完成";
  if (status === "error") return "❌ 失败";
  if (status === "denied") return "🚫 拒绝";
  if (status === "interrupted") return "⏹ 已中断";
  return status;
}

/**
 * 静默工具：不列入「工具执行」清单、不打印进度行，也不输出结果卡片
 * （这类工具的效果已直接体现在对话正文里，展示执行细节只是噪音）
 */
const SILENT_TOOLS = new Set(["todo_write"]);

/** ConsoleHook 构造选项 */
export interface ConsoleHookOptions {
  /**
   * 结果卡片只显示一行摘要的工具名（可选）。
   *
   * 用于「完整结果已由别的渲染器输出」的工具：例如 explore 的子代理报告由
   * SubagentHook 完整渲染在上方，卡片里再贴一份被截断到 200 字符的 JSON 预览
   * 纯属重复噪音。默认空 —— 结果原样多行展示（原有行为）。
   */
  compactResultTools?: string[];
}

export class ConsoleHook implements EngineHook {
  /** 流式 Markdown 渲染器 */
  private _md = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
  /** 思考内容渲染器：同样是 Markdown，但统一灰色（不做彩色/语法高亮） */
  private _reasoningMd = new MarkdownRenderer({
    unicode: UNICODE_SUPPORTED,
    gray: true,
  });
  /** 本轮是否已输出过思考（reasoning）内容 */
  private _reasoningSeen = false;
  /** 思考内容是否已闭合（已追加分隔换行） */
  private _reasoningClosed = false;
  /**
   * 本轮待执行工具的参数：onToolProposed 依次入队（同名 FIFO），
   * onToolFinished 时取出，用于在结果卡片中展示「参数」一项。
   * 每轮 LLM 回复开始时清空，避免被拒/中断的工具残留参数错配到下一轮。
   */
  private _proposedArgs = new Map<string, Record<string, unknown>[]>();
  /**
   * 上一次输出是否已经留下一个空行（卡片/正文块尾部自带空行）：
   * 段首统一用 _lead() 补空行，靠这个标志避免叠出两行空行。
   */
  private _blankEmitted = false;
  /** 结果卡片只显示一行摘要的工具 */
  private _compactResult: Set<string>;

  constructor(opts: ConsoleHookOptions = {}) {
    this._compactResult = new Set(opts.compactResultTools ?? []);
  }

  /** 段首空行：上一块已留空行则不再补，保证相邻两块之间恰好一行空行 */
  private _lead(): string {
    if (this._blankEmitted) {
      this._blankEmitted = false;
      return "";
    }
    return "\n";
  }

  /** 输出一段已成块的渲染文本，并记下它尾部是否已自带空行 */
  private _writeBlock(text: string): void {
    if (!text) return;
    cliWrite(this._lead() + text);
    this._blankEmitted = text.endsWith("\n\n");
  }

  /** 取出某个工具最早入队的参数（无则 undefined） */
  private _takeArgs(name: string): Record<string, unknown> | undefined {
    const queue = this._proposedArgs.get(name);
    if (!queue || queue.length === 0) return undefined;
    const args = queue.shift();
    if (queue.length === 0) this._proposedArgs.delete(name);
    return args;
  }

  /** 用统一的 MarkdownRenderer 渲染一段 Markdown（与审批表同样的彩色终端输出） */
  private _renderMarkdown(md: string): string {
    const renderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
    return (renderer.push(md + "\n") + renderer.flush()).trim();
  }

  /**
   * 渲染「标签: 值」一项：首行紧跟标签，换行后的续行按标签宽度缩进对齐，
   * 制表符展开为空格，避免工具结果里的缩进破坏对齐。
   */
  private _field(label: string, value: string): string {
    const prefix = `${label}: `;
    const pad = " ".repeat(displayWidth(prefix));
    const lines = String(value)
      .replace(/\t/g, "    ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return "";
    return (
      prefix +
      (lines[0] ?? "") +
      lines
        .slice(1)
        .map((line) => "\n" + (line ? pad + line : ""))
        .join("")
    );
  }

  /**
   * 结果字段的文本：紧凑工具（compactResultTools）压成一行，其余保留原始换行
   * 交给 _field 缩进呈现。压行后按终端列数截断，保证单行不折行。
   */
  private _resultText(name: string, resultPreview: string): string {
    if (!this._compactResult.has(name)) return resultPreview;
    const cols = process.stdout.columns ?? 80;
    return truncateToWidth(
      oneLine(resultPreview),
      Math.max(40, cols - displayWidth("结果: ")),
    );
  }

  /**
   * 工具执行结果卡片：标题（工具 + 状态）后，逐项列出「标签: 值」，项与项之间空行。
   *
   * 不用表格：参数/结果常是长文本（含中英文混排），表格列宽会被最长内容撑开、
   * 触发终端折行后边框错乱；一项一行更稳定、也更好扫读。结果保留原有换行并按值列
   * 缩进（多行报错、diff、文件片段都能看出结构）；参数压成一行并截断（细节价值低、
   * 长了必然折行）。字段名与审批表（approvalToMarkdownTable）的用词保持一致。
   */
  private _toolCard(
    name: string,
    status: string,
    resultPreview: string,
    args: Record<string, unknown> | undefined,
  ): string {
    const head = this._renderMarkdown(
      `### ⚙ ${mdInline(name)} — ${toolStatusText(status)}`,
    );

    const fields: string[] = [];
    const argsText = formatToolArgs(args, argsMaxWidth());
    if (argsText) fields.push(this._field("参数", oneLine(argsText)));
    if (resultPreview)
      fields.push(this._field("结果", this._resultText(name, resultPreview)));
    const body = fields.filter(Boolean);
    if (body.length === 0) return head;

    // 字段为纯文本（不经 Markdown 解析，避免结果里的链接/强调符号被改写），
    // 直接以空行分隔拼接，保证每项独占一块、互不挤在一起
    return head + "\n\n" + body.join("\n\n");
  }

  onTurnStart(input: string): void {
    // CLI 静默，只显示输入
  }

  onTurnEnd(status: string, iterations: number, producedFiles: string[]): void {
    if (status === "completed") {
      cliLog(`${this._lead()}✅ 本次任务完成`);
    } else if (status === "max_iterations_exceeded") {
      cliLog(
        `${this._lead()}⚠️  已达到最大迭代次数（已执行 ${iterations} 次迭代），任务可能未完成`,
      );
      cliLog(`   💡 输入「继续」可继续完成剩下的任务`);
    } else if (status === "error") {
      cliLog(`${this._lead()}❌ 任务出错`);
    } else {
      cliLog(`${this._lead()}⚠️  任务终止: ${status}`);
    }

    // 产出文件列表
    if (producedFiles.length > 0) {
      cliLog(`${this._lead()}📦 本轮产出文件 (${producedFiles.length}):`);
      for (const f of producedFiles) {
        cliLog(`   📄 ${f}`);
      }
    }
    cliLog("");
    this._blankEmitted = true;
  }

  onAssistantDelta(text: string): void {
    if (this._reasoningSeen && !this._reasoningClosed) {
      this._reasoningClosed = true;
      // 思考内容输出完毕后，正文开始前：先冲刷思考缓冲（未闭合块兜底），
      // 再空一行与正文区分开
      this._writeBlock(this._reasoningMd.flush());
      cliWrite(this._lead());
      this._blankEmitted = true;
    }
    this._writeBlock(this._md.push(text));
  }

  onReasoningDelta(text: string): void {
    this._reasoningSeen = true;
    // 思考内容按 Markdown 渲染（列表/表格/段落排版），但整体保持灰色
    this._writeBlock(this._reasoningMd.push(text));
  }

  onAssistantMessage(
    text: string | null,
    toolCalls: string[],
    usage?: TokenUsage,
  ): void {
    // 本轮回复结束：输出 Markdown 渲染器中的剩余缓冲（未闭合的块）
    this._writeBlock(this._reasoningMd.flush());
    this._writeBlock(this._md.flush());

    // 复位思考状态，供下一轮迭代使用
    this._reasoningSeen = false;
    this._reasoningClosed = false;

    // 新一轮工具调用的起点：丢弃上一轮可能残留的参数（被拒/中断的工具不会回调）
    this._proposedArgs.clear();

    // 静默工具（todo_write 等）只执行不展示，清单里也不列，避免「有头无尾」
    const visibleCalls = toolCalls.filter((name) => !SILENT_TOOLS.has(name));
    if (visibleCalls.length > 0) {
      // 与「Agent 提问」一致的排版：标题 + 空行 + 内容（下面是逐条执行的进度行）
      cliLog(`${this._lead()}🔧 工具执行 (${visibleCalls.length}): ${visibleCalls.join(", ")}`);
      if (usage) cliLog(`   [Token: ${usage.input}+${usage.output}]`);
      cliLog();
      this._blankEmitted = true;
    } else if (usage) {
      cliLog(`   [Token: ${usage.input}+${usage.output}]`);
      this._blankEmitted = false;
    }
  }

  onToolProposed(name: string, args: Record<string, unknown>): void {
    // 静默：审批由 CLI 的 approver 打印，参数在结果卡片中展示
    const queue = this._proposedArgs.get(name) ?? [];
    queue.push(args);
    this._proposedArgs.set(name, queue);
  }

  onToolStarted(name: string): void {
    if (SILENT_TOOLS.has(name)) return;
    cliLog(`  ⚙ ${name} ...`);
    this._blankEmitted = false;
  }

  onToolFinished(name: string, status: string, resultPreview: string): void {
    // 先出队参数：静默工具也要出队，避免残留参数错配到下一轮
    const args = this._takeArgs(name);
    if (SILENT_TOOLS.has(name)) return;

    // 卡片前留一个空行（与进度行、与上一张卡片隔开）；尾部只留一个换行，
    // 空行交给下一块的段首处理，避免叠出两行空行。
    cliWrite(this._lead() + this._toolCard(name, status, resultPreview, args) + "\n");
    this._blankEmitted = false;
  }

  onPermissionRequired(name: string, reason: string): void {
    // 审批由 CLI 的 approver 处理器负责
  }

  onIterationEnd(_iteration: number): void {
    // 静默
  }

  onCompacting(info?: CompactionStartInfo): void {
    const usage = info
      ? `（已用 ${info.estimated ? "~" : ""}${formatTokens(info.tokens)} / ${formatTokens(
          info.contextWindow,
        )} · ${info.outboundMessages} 条消息）`
      : "";
    const reason = info?.trigger === "overflow" ? "上下文溢出，强制压缩" : "正在压缩上下文";
    cliLog(`  🔄 ${reason}...${usage}`);
    this._blankEmitted = false;
  }

  onCompacted(text: string, info?: CompactionDoneInfo): void {
    const detail = info
      ? `（${info.method === "trimmed" ? "裁剪降级" : "摘要压缩"} · ${info.messagesBefore} → ${info.messagesAfter} 条消息）`
      : "";
    cliLog(`  📦 ${text}${detail}`);
    this._blankEmitted = false;
  }

  onError(error: string, errorType: string): void {
    cliLog(`${this._lead()}❌ 错误: ${error}`);
    // 连接类错误：补可执行的排查建议（DNS/TLS/代理/超时）
    for (const hint of networkErrorHints(error, errorType)) {
      cliLog(`   💡 ${hint}`);
    }
    // 凭据类错误（401/403）：指出 Key 为什么失效、去哪儿换
    for (const hint of authErrorHints(error, errorType)) {
      cliLog(`   💡 ${hint}`);
    }
    // 模型/参数类错误（如阿里兼容模式的 InvalidParameter）：指出换模型
    for (const hint of paramErrorHints(error)) {
      cliLog(`   💡 ${hint}`);
    }
    this._blankEmitted = false;
  }

  onRetry(attempt: number, max: number, reason: string): void {
    const why = reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
    cliLog(`${this._lead()}🔁 网络中断（${why}），第 ${attempt}/${max} 次重试…`);
    this._blankEmitted = false;
  }

  onInterrupted(_iterations: number): void {
    cliLog(`${this._lead()}⏹  已中断\n`);
    this._blankEmitted = false;
  }

  onEvent(type: EventType, data: Record<string, unknown>): void {
    // 通用兜底：未匹配到具体回调时使用
  }
}
