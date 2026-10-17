/**
 * MarkdownRenderer — 流式 Markdown 终端渲染器
 *
 * 将 LLM 流式输出的 Markdown 渲染为 ANSI 终端格式，基于成熟解析器
 * markdown-it（覆盖加粗/斜体/链接/列表/表格/代码块/引用等全部常见元素），
 * 自写终端渲染层（Token → ANSI）。
 *
 * 流式策略：逐「块」输出。普通段落/标题/列表/引用按行实时渲染；
 * 代码块（```）与表格（| 行）为块级结构，缓冲到块结束才渲染。
 * 末尾未完整块由 flush() 兜底输出。
 *
 * 回退模式：当环境不支持颜色（非 TTY / chalk.level===0）或 Unicode 时，
 * 降级为「基础格式化」——去掉 ANSI 颜色与 Unicode 边框，但保留结构：
 * 加粗/斜体保留 ** / * 符号、链接附 url、表格用 ASCII 边框、emoji 保留短代码。
 *
 * 灰阶模式（`gray`）：保留列表/表格/段落等排版结构，但全部前景色统一为
 * 灰色（不做语法高亮、不用青色项目符号/蓝色链接），用于「思考」内容。
 */
import chalk from "chalk";
import { highlight } from "cli-highlight";
import Table from "cli-table3";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { emojify, unemojify } from "node-emoji";

/** ANSI 样式码（颜色由 _color 开关控制，不依赖 chalk.level） */
const ANSI = {
  bold: "\x1b[1m",
  boldOff: "\x1b[22m",
  dim: "\x1b[2m",
  dimOff: "\x1b[22m",
  italic: "\x1b[3m",
  italicOff: "\x1b[23m",
  underline: "\x1b[4m",
  underlineOff: "\x1b[24m",
  strike: "\x1b[9m",
  strikeOff: "\x1b[29m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  fgReset: "\x1b[39m",
} as const;

/** 表格 ASCII 边框（回退模式用） */
const ASCII_CHARS = {
  top: "-",
  "top-mid": "+",
  "top-left": "+",
  "top-right": "+",
  bottom: "-",
  "bottom-mid": "+",
  "bottom-left": "+",
  "bottom-right": "+",
  left: "|",
  "left-mid": "+",
  mid: "-",
  "mid-mid": "+",
  right: "|",
  "right-mid": "+",
  middle: "|",
} as const;

/** markdown-it 实例（复用） */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** 渲染能力配置 */
export interface MarkdownRendererOptions {
  /** 是否输出 ANSI 颜色（默认自动检测 TTY + chalk 环境） */
  color?: boolean;
  /** 是否支持 Unicode（表格边框 / emoji，默认 true） */
  unicode?: boolean;
  /**
   * 灰阶模式：保留 Markdown 排版（列表/表格/段落/标题），
   * 但所有前景色统一为灰色（等价于整段包裹灰色，内部不再产生彩色）。
   */
  gray?: boolean;
}

export class MarkdownRenderer {
  /** 未完整块的内容缓冲 */
  private _buffer = "";
  /** 是否输出颜色 */
  private _color: boolean;
  /** 是否支持 Unicode */
  private _unicode: boolean;
  /** 灰阶模式：仅灰色前景，无其他颜色 */
  private _gray: boolean;

  // ---- 块级遍历状态 ----
  /** 列表栈：每层 { ordered, counter } */
  private _listStack: { ordered: boolean; counter: number }[] = [];
  /** 表格收集：行（每行是单元格纯文本数组） */
  private _tableRows: string[][] = [];
  /** 表格收集：当前行 */
  private _tableRow: string[] = [];
  /** 是否正在收集表格单元格内容 */
  private _inTable = false;
  /** 当前链接 href（link_open 记录，link_close 消费） */
  private _pendingLinkHref = "";

  constructor(opts: MarkdownRendererOptions = {}) {
    this._color = opts.color ?? chalk.level > 0;
    this._unicode = opts.unicode ?? true;
    this._gray = opts.gray ?? false;
  }

  /**
   * 输入一段流式文本，返回本次可输出的渲染结果（块未完整时可能为空）。
   */
  push(text: string): string {
    this._buffer += text;
    return this._drain();
  }

  /** 回复结束：输出剩余缓冲并复位 */
  flush(): string {
    let out = "";
    if (this._buffer.trim() !== "") {
      out += this._renderMarkdown(this._buffer.trimEnd() + "\n");
    }
    this._buffer = "";
    this._listStack = [];
    return out;
  }

  /** 复位状态（一轮回复结束） */
  reset(): void {
    this._buffer = "";
    this._listStack = [];
  }

  // ===================== 块提取 =====================

  /** 提取并渲染所有「完整块」，返回输出；未完整块留在 buffer */
  private _drain(): string {
    let out = "";
    let block: string | null;
    while ((block = this._extractBlock()) !== null) {
      out += this._renderMarkdown(block);
    }
    return out;
  }

  /**
   * 从 buffer 提取第一个完整块；无完整块返回 null（继续缓冲）。
   * 块边界：代码块围栏闭合、表格结束（非 | 行）、空行。
   */
  private _extractBlock(): string | null {
    const text = this._buffer;
    if (text === "") return null;

    const lines = text.split("\n");
    const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
    if (lineCount === 0) return null; // 没有完整行

    const first = lines[0]!;

    // 1. 代码块（``` 围栏）
    if (/^\s*```/.test(first)) {
      for (let i = 1; i < lineCount; i++) {
        if (/^\s*```\s*$/.test(lines[i]!)) {
          return this._takeBlock(text, lines, i + 1);
        }
      }
      return null; // 未闭合，缓冲
    }

    // 2. 表格（| 开头的连续行），必须「结束」才完整
    if (/^\s*\|/.test(first)) {
      let i = 0;
      while (i < lineCount && /^\s*\|/.test(lines[i]!)) i++;
      if (i >= lineCount) return null; // 表格未结束，缓冲
      return this._takeBlock(text, lines, i);
    }

    // 3. 普通块（段落/标题/列表/引用）：到空行为止
    let i = 0;
    while (i < lineCount && lines[i]!.trim() !== "") i++;
    if (i >= lineCount) return null; // 无空行，块可能未完整
    return this._takeBlock(text, lines, i + 1); // 含空行
  }

  /** 从 buffer 截取前 n 行作为块，更新 buffer */
  private _takeBlock(text: string, lines: string[], n: number): string {
    const block = lines.slice(0, n).join("\n") + "\n";
    this._buffer = text.slice(block.length);
    return block;
  }

  // ===================== 块渲染 =====================

  /** 用 markdown-it 解析并渲染一段完整 Markdown */
  private _renderMarkdown(block: string): string {
    const tokens = md.parse(block, {});
    this._tableRows = [];
    this._tableRow = [];
    this._inTable = false;
    const rendered = this._renderTokens(tokens);
    // 灰阶模式：整段包裹灰色；内部前景色已被 _fg/_fgReset 抑制
    if (!this._gray || !this._color || rendered === "") return rendered;
    return ANSI.gray + rendered + ANSI.fgReset;
  }

  private _renderTokens(tokens: Token[]): string {
    let out = "";
    for (const t of tokens) out += this._renderToken(t);
    return out;
  }

  private _renderToken(t: Token): string {
    switch (t.type) {
      case "heading_open":
        return this._headingOpen(t.tag);
      case "heading_close":
        return this._c(ANSI.boldOff + ANSI.underlineOff) + "\n";

      case "paragraph_open":
        return "";
      case "paragraph_close":
        // 段落结束追加空行，与下一段区分；列表项内的段落保持紧凑
        return this._listStack.length > 0 ? "\n" : "\n\n";

      case "bullet_list_open":
        this._listStack.push({ ordered: false, counter: 0 });
        return "";
      case "ordered_list_open":
        this._listStack.push({ ordered: true, counter: 0 });
        return "";
      case "bullet_list_close":
      case "ordered_list_close":
        this._listStack.pop();
        // 顶级列表结束后补一个空行，与后续内容区分
        return this._listStack.length === 0 ? "\n" : "";
      case "list_item_open":
        return this._listItemPrefix();
      case "list_item_close":
        return "";

      case "blockquote_open":
        return this._fg(ANSI.gray) + "> " + this._fgReset();
      case "blockquote_close":
        return "";

      case "fence":
        return this._renderCode(t.content, t.info) + "\n";

      case "hr":
        return this._color
          ? this._fg(ANSI.gray) + "─".repeat(48) + this._fgReset() + "\n"
          : "---\n";

      case "table_open":
        this._tableRows = [];
        return "";
      case "thead_open":
      case "tbody_open":
        return "";
      case "tr_open":
        this._tableRow = [];
        return "";
      case "tr_close":
        this._tableRows.push(this._tableRow);
        return "";
      case "th_open":
      case "td_open":
        this._inTable = true;
        return "";
      case "th_close":
      case "td_close":
        this._inTable = false;
        return "";
      case "table_close":
        return this._renderTable(this._tableRows) + "\n";

      case "inline": {
        if (this._inTable) {
          // 表格单元格：收集纯文本（无颜色、无 Markdown 符号）
          this._tableRow.push(this._renderInlinePlain(t.children ?? []));
          return "";
        }
        return this._renderInlineChildren(t.children ?? []);
      }

      default:
        return "";
    }
  }

  // ===================== 块级辅助 =====================

  private _headingOpen(tag: string): string {
    const level = parseInt(tag.slice(1), 10) || 1;
    if (this._color) {
      const style =
        level <= 2 ? ANSI.bold + ANSI.underline : level <= 4 ? ANSI.bold : ANSI.bold + ANSI.dim;
      return "\n" + style;
    }
    return "\n" + "#".repeat(level) + " ";
  }

  private _listItemPrefix(): string {
    const depth = this._listStack.length;
    const top = this._listStack[depth - 1];
    const indent = "  ".repeat(depth - 1);
    if (top && top.ordered) {
      top.counter += 1;
      const num = `${top.counter}.`;
      return indent + this._fg(ANSI.cyan) + num + this._fgReset() + " ";
    }
    return indent + this._fg(ANSI.cyan) + "-" + this._fgReset() + " ";
  }

  private _renderCode(code: string, lang: string): string {
    const fence = "```" + (lang || "");
    if (this._color) {
      let hl: string;
      try {
        // 灰阶模式跳过语法高亮，避免引入彩色 ANSI
        hl = this._gray
          ? code
          : highlight(code, { language: lang || undefined, ignoreIllegals: true });
      } catch {
        hl = code;
      }
      return (
        this._fg(ANSI.gray) + fence + this._fgReset() + "\n" + hl + "\n" +
        this._fg(ANSI.gray) + "```" + this._fgReset()
      );
    }
    return `${fence}\n${code}\n\`\`\``;
  }

  private _renderTable(rows: string[][]): string {
    if (rows.length === 0) return "";
    try {
      const head = rows[0]!;
      const body = rows.slice(1);
      const options = this._unicode
        ? { head }
        : { head, chars: { ...ASCII_CHARS } };
      const table = new Table(options);
      for (const row of body) table.push(row);
      let result = table.toString();
      if (!this._color || this._gray) {
        // cli-table3 硬编码表头颜色，回退/灰阶时剥离 ANSI
        result = result.replace(/\u001b\[[0-9;]*m/g, "");
      }
      return result;
    } catch {
      return rows.map((r) => r.join(" | ")).join("\n");
    }
  }

  // ===================== 行内渲染 =====================

  private _renderInlineChildren(children: Token[]): string {
    let out = "";
    for (const t of children) out += this._renderInlineToken(t);
    return out;
  }

  private _renderInlineToken(t: Token): string {
    switch (t.type) {
      case "text":
        return this._emoji(t.content);

      case "strong_open":
        return this._color ? ANSI.bold : "**";
      case "strong_close":
        return this._color ? ANSI.boldOff : "**";
      case "em_open":
        return this._color ? ANSI.italic : "*";
      case "em_close":
        return this._color ? ANSI.italicOff : "*";
      case "s_open":
        return this._color ? ANSI.strike : "~~";
      case "s_close":
        return this._color ? ANSI.strikeOff : "~~";

      case "code_inline":
        return this._color
          ? this._fg(ANSI.cyan) + t.content + this._fgReset()
          : "`" + t.content + "`";

      case "link_open": {
        const href = t.attrGet("href");
        this._pendingLinkHref = href === null ? "" : String(href);
        return this._color ? ANSI.underline + this._fg(ANSI.blue) : "";
      }
      case "link_close": {
        const href = this._pendingLinkHref;
        this._pendingLinkHref = "";
        const reset = this._color ? ANSI.underlineOff + this._fgReset() : "";
        const url = href
          ? (this._color
              ? this._fg(ANSI.gray) + ` (${href})` + this._fgReset()
              : ` (${href})`)
          : "";
        return reset + url;
      }

      case "image":
        // [alt](src) → alt
        return this._color
          ? this._fg(ANSI.gray) + t.content + this._fgReset()
          : t.content;

      case "softbreak":
        return " ";
      case "hardbreak":
        return "\n";

      default:
        return t.content ?? "";
    }
  }

  /** 纯文本渲染（无颜色、无 Markdown 符号），用于表格单元格 */
  private _renderInlinePlain(children: Token[]): string {
    let out = "";
    for (const t of children) {
      if (t.type === "text" || t.type === "code_inline") {
        out += t.content;
      } else if (t.type === "softbreak") {
        out += " ";
      } else if (t.type === "hardbreak") {
        out += " ";
      } else if (t.type === "image") {
        out += t.content;
      }
      // strong/em/s/link 的 open/close 不输出，仅保留内容
    }
    return out;
  }

  /** emoji：Unicode 支持时 :smile: → 😄；否则 😄 → :smile: */
  private _emoji(text: string): string {
    if (text === "") return "";
    if (this._unicode) return emojify(text);
    return unemojify(text);
  }

  /** 颜色开关：启用时返回 ANSI 码，否则返回空串 */
  private _c(code: string): string {
    return this._color ? code : "";
  }

  /** 前景色码：灰阶模式下省略（由 _renderMarkdown 统一包裹灰色） */
  private _fg(code: string): string {
    return this._color && !this._gray ? code : "";
  }

  /** 前景色重置：灰阶模式下省略，避免打断外层灰色 */
  private _fgReset(): string {
    return this._color && !this._gray ? ANSI.fgReset : "";
  }
}
