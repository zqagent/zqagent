/**
 * 工具结果预算
 *
 * 单次工具调用的结果可能远大于上下文预算（read_file 2000 行、git_diff 全量、
 * explore 报告……）。整条塞进对话历史会让上下文水位迅速触顶，而压缩只能在
 * user / assistant 边界切分，切不动挂在尾部的一条巨大 tool 消息——于是出现
 * “压完仍超阈值、下一轮继续压”的空转。
 *
 * 这里在工具结果进入历史之前统一裁剪：完整内容落盘，上下文中只保留头尾片段
 * 与文件路径，模型需要细节时可自行按路径重读。
 */
import * as fs from "fs";
import * as path from "path";
import { stateDir } from "../paths.js";

/** 单条工具结果进入上下文的最大字符数（约 6K token） */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 24_000;

/** 头尾片段中头部占比 */
const HEAD_RATIO = 0.6;

/** 解析 TOOL_RESULT_MAX_CHARS；非法 / 非正数回退默认值 */
function budgetChars(): number {
  const n = Number(process.env.TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/** 落盘目录：TOOL_RESULT_DIR > 状态目录下的 tool-results */
export function toolResultDir(): string {
  const env = process.env.TOOL_RESULT_DIR?.trim();
  return env || path.join(stateDir(), "tool-results");
}

/** 把字符串截成「头 + 省略提示 + 尾」，结果长度不超过 budget */
function clipText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // 先按最大位数估算标记长度，再调整头尾，保证总长不超预算
  const room = Math.max(
    0,
    budget - `\n\n… [${text.length} characters omitted] …\n\n`.length,
  );
  const headLen = Math.floor(room * HEAD_RATIO);
  const tailLen = room - headLen;
  const omitted = text.length - headLen - tailLen;
  return (
    text.slice(0, headLen) +
    `\n\n… [${omitted} characters omitted] …\n\n` +
    text.slice(-tailLen)
  );
}

/**
 * 字段级裁剪：保持 JSON 结构合法。
 *
 * run_shell / git_diff 等返回的是对象，直接截断字符串会破坏 JSON。
 * 逐字段裁剪后 exit_code、路径等元信息仍完整可读。
 */
function clipDeep(value: unknown, perField: number): unknown {
  if (typeof value === "string") {
    return value.length <= perField ? value : clipText(value, perField);
  }
  if (Array.isArray(value)) {
    return value.map((v) => clipDeep(v, perField));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, perField);
    return out;
  }
  return value;
}

/** 完整内容落盘，返回路径；失败时返回 undefined（不影响主流程） */
function saveRaw(tool: string, raw: string, dir: string): string | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
    const name = `${Date.now()}-${process.pid}-${Math.random()
      .toString(36)
      .slice(2, 8)}-${safe}.txt`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, raw, "utf-8");
    return file;
  } catch {
    return undefined;
  }
}

/** 工具结果的预算处理结果 */
export interface BudgetedToolResult {
  /** 进入对话历史的内容（字符串） */
  content: string;
  /** 是否发生了裁剪 */
  truncated: boolean;
  /** 完整内容的落盘路径（未落盘时为空） */
  savedPath?: string;
}

/**
 * 对工具结果应用预算。
 *
 * @param tool 工具名（用于落盘文件名）
 * @param result 工具原始返回值
 * @param opts.maxChars 覆盖默认预算（测试用）
 * @param opts.dir 覆盖落盘目录（测试用）
 */
export function applyToolResultBudget(
  tool: string,
  result: unknown,
  opts: { maxChars?: number; dir?: string } = {},
): BudgetedToolResult {
  const budget = opts.maxChars ?? budgetChars();
  const raw =
    typeof result === "string"
      ? result
      : (JSON.stringify(result, null, 2) ?? String(result));

  if (raw.length <= budget) {
    return { content: raw, truncated: false };
  }

  // 1) 对象优先按字段裁剪，保住 JSON 结构；
  //    多字段同时超长时逐步收紧单字段上限，直到整体落回预算
  let content = raw;
  if (typeof result === "object" && result !== null) {
    let perField = Math.floor(budget * 0.7);
    let clipped = JSON.stringify(clipDeep(result, perField), null, 2);
    for (let i = 0; i < 6 && clipped && clipped.length > budget && perField > 128; i++) {
      perField = Math.floor(perField / 2);
      clipped = JSON.stringify(clipDeep(result, perField), null, 2);
    }
    if (clipped && clipped.length <= budget) content = clipped;
  }
  // 2) 兜底：整体保留头尾
  if (content.length > budget) content = clipText(content, budget);

  // 3) 完整内容落盘，上下文里留下取回路径
  const savedPath = saveRaw(tool, raw, opts.dir ?? toolResultDir());
  if (savedPath) {
    content =
      `[tool output truncated: ${raw.length} chars, full output saved to ${savedPath}]\n\n` +
      content;
  }

  return { content, truncated: true, savedPath };
}
