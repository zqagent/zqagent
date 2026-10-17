/**
 * 审批视图：把审批请求（工具 / 原因 / 参数详情）规范化为统一的「字段行」，
 * 供 CLI、QQ、通用通知、邮件、MQTT、Web 等各端渲染成同一套表格。
 *
 * 唯一数据源是审批事件负载（toolName / reason / arguments），各通道只负责
 * 把这里产出的字段渲染成自己端上最好看的形态（终端框线表 / Markdown / HTML）。
 */

/** 审批表格中的一行 */
export interface ApprovalField {
  /** 字段名（工具 / 原因 / 参数名） */
  label: string;
  /** 字段值（已完成换行折叠与截断） */
  value: string;
}

/** 统一审批输入 */
export interface ApprovalViewInput {
  toolName: string;
  reason: string;
  arguments?: Record<string, unknown> | null;
}

/** 单个字段值的默认最大长度（超出以 … 截断） */
export const APPROVAL_VALUE_MAX = 120;

/** 表格列标题（各端保持一致） */
export const APPROVAL_COLUMNS = ["项目", "详情"] as const;

/** 工具 / 原因两行的固定文案 */
const TOOL_LABEL = "🔧 工具";
const REASON_LABEL = "💬 原因";

/** 把任意参数值折叠成单行文本并按需截断 */
function formatValue(v: unknown, maxLen: number): string {
  let text: string;
  if (v == null) {
    text = "";
  } else if (typeof v === "string") {
    text = v;
  } else {
    try {
      text = JSON.stringify(v);
    } catch {
      text = String(v);
    }
  }
  text = text.replace(/\r?\n/g, "↵");
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

/** 从 NotifyEvent.data（审批事件负载）提取统一输入 */
export function approvalInputFromData(
  data: Record<string, unknown>,
): ApprovalViewInput {
  const args = data["arguments"];
  return {
    toolName: String(data["toolName"] ?? ""),
    reason: String(data["reason"] ?? ""),
    arguments:
      args && typeof args === "object"
        ? (args as Record<string, unknown>)
        : undefined,
  };
}

/**
 * 规范化为统一字段行：工具 → 原因 → 每个参数各一行（行序在所有通道一致）。
 */
export function approvalFields(
  input: ApprovalViewInput,
  maxLen = APPROVAL_VALUE_MAX,
): ApprovalField[] {
  const fields: ApprovalField[] = [
    { label: TOOL_LABEL, value: formatValue(input.toolName, maxLen) },
    { label: REASON_LABEL, value: formatValue(input.reason, maxLen) },
  ];
  for (const [key, value] of Object.entries(input.arguments ?? {})) {
    fields.push({ label: formatValue(key, maxLen), value: formatValue(value, maxLen) });
  }
  return fields;
}

/** Markdown 表格单元格转义（竖线会破坏列结构） */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "↵");
}

/** 渲染为统一的两列 Markdown 表格 */
export function approvalToMarkdownTable(
  input: ApprovalViewInput,
  opts: { maxLen?: number; title?: string } = {},
): string {
  const lines: string[] = [];
  if (opts.title) lines.push(opts.title, "");
  lines.push(`| ${APPROVAL_COLUMNS[0]} | ${APPROVAL_COLUMNS[1]} |`, "| --- | --- |");
  for (const f of approvalFields(input, opts.maxLen)) {
    lines.push(`| ${escapeCell(f.label)} | ${escapeCell(f.value)} |`);
  }
  return lines.join("\n");
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 渲染为 HTML 表格（邮件 / Web 端直接展示为真正的表格） */
export function approvalToHtmlTable(
  input: ApprovalViewInput,
  maxLen = APPROVAL_VALUE_MAX,
): string {
  const rows = approvalFields(input, maxLen)
    .map(
      (f) =>
        `<tr>` +
        `<th style="text-align:left;padding:4px 12px 4px 0;color:#6b7280;font-weight:500;white-space:nowrap;vertical-align:top;">${escapeHtml(f.label)}</th>` +
        `<td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(f.value)}</td>` +
        `</tr>`,
    )
    .join("");
  return `<table style="border-collapse:collapse;font-size:13px;">${rows}</table>`;
}
