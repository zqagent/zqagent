/**
 * SubagentHook — 把子代理（explore）的执行情况缩进打印到控制台
 *
 * 子代理在独立上下文中运行，它的事件流默认被 explore 工具吞掉（只留最终报告），
 * 于是「它读了哪些文件、搜了哪些关键字」在 CLI 上完全不可见。把本 Hook 注入
 * 子引擎后，子代理的每一步会以缩进树的形式，穿插在主代理的「⚙ explore ...」
 * 进度行与随后的结果卡片之间。
 *
 * 渲染工具活动、终态，以及最终报告：子代理的流式正文/思考不回显——它们不会进入
 * 主上下文，回显只会制造噪音；但最终报告是子代理唯一的产出，必须完整给出（见
 * _emitReport：它回给主代理时只是一段被截断的结果预览）。
 */
import type { EngineHook, EventType } from "./events.js";
import { cliLog, UNICODE_SUPPORTED } from "../terminal.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import {
  displayWidth,
  formatToolArgs,
  oneLine,
  truncateToWidth,
} from "./ConsoleHook.js";

/** 子代理结束状态 → 中文描述 */
function statusText(status: string): string {
  if (status === "completed") return "✅ 完成";
  if (status === "error") return "❌ 出错";
  if (status === "interrupted") return "⏹ 已中断";
  if (status === "max_iterations_exceeded") return "⚠️ 达到迭代上限";
  return `⚠️ 停止 (${status})`;
}

export class SubagentHook implements EngineHook {
  /** 全局递增序号：同一条回复里并发的多个 explore 子代理靠它区分输出行 */
  private static _seq = 0;
  private _tag: string;
  /** 本轮已执行的工具数 */
  private _steps = 0;
  /**
   * 待执行工具的参数：onToolProposed 依次入队（同名 FIFO），onToolStarted 时
   * 取出，用于在进度行里显示子代理到底在看什么。每轮 LLM 回复开始时清空，
   * 避免被拒/中断的工具残留参数错配到下一轮。
   */
  private _args = new Map<string, Record<string, unknown>[]>();
  /** onTurnEnd 只收尾一次 */
  private _open = false;
  /**
   * 子代理最后一条带正文的回复 —— 即它交给主代理的最终报告。口径与 explore 工具
   * 取报告一致（见 explore.ts：报告 = 最后一条带正文的 assistant 消息）。
   */
  private _report = "";

  constructor(label = "explore") {
    this._tag = `${label}#${++SubagentHook._seq}`;
  }

  /** 输出一行缩进的子代理日志，整行按终端列数截断，避免折行打乱主输出排版 */
  private _line(mark: string, text: string): void {
    const prefix = `   ${mark} ${this._tag} `;
    const width = Math.max(
      40,
      (process.stdout.columns ?? 80) - displayWidth(prefix),
    );
    cliLog(prefix + truncateToWidth(oneLine(text), width));
  }

  /** 取出某个工具最早入队的参数（无则 undefined） */
  private _takeArgs(name: string): Record<string, unknown> | undefined {
    const queue = this._args.get(name);
    if (!queue || queue.length === 0) return undefined;
    const args = queue.shift();
    if (queue.length === 0) this._args.delete(name);
    return args;
  }

  onTurnStart(input: string): void {
    this._open = true;
    this._steps = 0;
    this._report = "";
    this._line("┌─", `🧭 ${input}`);
  }

  onAssistantMessage(text: string | null, _toolCalls: string[]): void {
    // 最后一轮带正文的回复就是子代理的最终报告（中途带正文的回复会被后面的覆盖）
    if (text) this._report = text;
    // 新一轮工具调用的起点：丢弃上一轮可能残留的参数（被拒/中断的工具不会回调）
    this._args.clear();
  }

  onToolProposed(name: string, args: Record<string, unknown>): void {
    const queue = this._args.get(name) ?? [];
    queue.push(args);
    this._args.set(name, queue);
  }

  onToolStarted(name: string): void {
    this._steps++;
    const argsText = formatToolArgs(this._takeArgs(name));
    this._line("│", `⚙ ${name}${argsText ? ` (${argsText})` : ""} ...`);
  }

  onToolFinished(name: string, status: string, resultPreview: string): void {
    const mark = status === "ok" ? "✓" : "✗";
    const brief = resultPreview ? oneLine(resultPreview) : "";
    this._line("│", brief ? `${mark} ${name} — ${brief}` : `${mark} ${name}`);
  }

  onError(error: string): void {
    this._line("│", `❌ ${error}`);
  }

  onTurnEnd(status: string, iterations: number, _producedFiles: string[]): void {
    if (!this._open) return;
    this._open = false;
    /*
     * 同时给「轮次」与「工具次数」：两者不是一回事（一轮可并发多个工具），
     * 只写「48 步」会让人误以为是迭代上限配错了。
     */
    this._line(
      "└─",
      `${statusText(status)} · ${iterations} 轮 / ${this._steps} 步（工具调用）`,
    );
    this._emitReport();
    this._report = "";
  }

  /**
   * 打印子代理的最终报告。
   *
   * 报告是子代理唯一的产出，但它回给主代理时只以「某次工具调用的结果」出现，
   * 而结果预览被截断到 200 字符——正文在 CLI 上根本看不全。这里按 Markdown
   * 完整渲染，缩进到子代理块之下，与上面的进度行连成一体。
   */
  private _emitReport(): void {
    const report = this._report.trim();
    if (!report) return;
    const renderer = new MarkdownRenderer({ unicode: UNICODE_SUPPORTED });
    const rendered = (renderer.push(report + "\n") + renderer.flush()).trim();
    if (!rendered) return;
    cliLog(`   📄 ${this._tag} 报告`);
    cliLog(
      rendered
        .split("\n")
        .map((line) => (line ? `   ${line}` : ""))
        .join("\n"),
    );
  }

  onEvent(_type: EventType, _data: Record<string, unknown>): void {
    // 通用兜底：不需要额外渲染
  }
}
