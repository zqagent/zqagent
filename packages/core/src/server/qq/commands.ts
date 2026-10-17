/**
 * QQ 指令解析（纯函数，可单测）
 *
 * 解析用户文本为结构化指令。普通文本默认作为任务提交；
 * 以 `/` 开头视为命令。审批/提问用到的决策值兼容中英文。
 */
import { ApprovalOutcome } from "../../engine/events.js";

/** 解析后的指令 */
export type ParsedCommand =
  | { kind: "task"; text: string }
  | { kind: "bind"; code: string }
  | { kind: "unbind" }
  | { kind: "new" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "list" }
  | { kind: "approve"; decision: ApprovalOutcome }
  | { kind: "answer"; text: string }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

/** 审批决策文本 → ApprovalOutcome；无法识别返回 null */
export function parseDecision(raw: string): ApprovalOutcome | null {
  const v = raw.trim().toLowerCase();
  switch (v) {
    case "once":
    case "同意":
    case "允许":
    case "本次允许":
    case "yes":
    case "y":
    case "ok":
      return ApprovalOutcome.ONCE;
    case "always_tool":
    case "总是允许":
    case "总是允许该工具":
    case "全部同意":
    case "全部允许":
    case "总是同意":
      return ApprovalOutcome.ALWAYS_TOOL;
    case "always_command":
    case "总是允许命令":
      return ApprovalOutcome.ALWAYS_COMMAND;
    case "deny":
    case "拒绝":
    case "no":
    case "n":
      return ApprovalOutcome.DENY;
    default:
      return null;
  }
}

/** 解析命令（去掉前后空白、命令不区分大小写） */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) {
    return { kind: "task", text };
  }

  const space = text.indexOf(" ");
  const head = (space >= 0 ? text.slice(1, space) : text.slice(1)).toLowerCase();
  const rest = space >= 0 ? text.slice(space + 1).trim() : "";

  switch (head) {
    case "bind":
    case "绑定":
      return { kind: "bind", code: rest };
    case "unbind":
    case "解绑":
      return { kind: "unbind" };
    case "new":
    case "新建":
    case "新会话":
      return { kind: "new" };
    case "status":
    case "状态":
      return { kind: "status" };
    case "stop":
    case "停止":
    case "中断":
      return { kind: "stop" };
    case "list":
    case "列表":
      return { kind: "list" };
    case "approve":
    case "审批": {
      const decision = parseDecision(rest);
      return decision ? { kind: "approve", decision } : { kind: "unknown", raw: text };
    }
    case "answer":
    case "回答":
      return { kind: "answer", text: rest };
    case "help":
    case "帮助":
    case "h":
      return { kind: "help" };
    default:
      return { kind: "unknown", raw: text };
  }
}

/** 帮助文本 */
export const HELP_TEXT = [
  "支持的命令：",
  "/bind [配对码] — 绑定本会话到租户（多租户用；单租户直接发消息即可，无需绑定）",
  "/unbind — 解除绑定",
  "/new — 新建会话",
  "/status — 查看当前会话状态",
  "/list — 列出会话",
  "/stop — 中断当前任务",
  "/approve <once|always_tool|always_command|deny> — 审批（也可发 同意/全部同意/拒绝）",
  "/answer <内容> — 回答提问",
  "/help — 本帮助",
  "直接发消息 = 提交任务（等待提问时则作为答案）",
].join("\n");
