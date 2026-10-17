/**
 * 项目首页统计：会话数 / 运行 / 等待 / 完成 / 错误 + token 消耗 + 会话列表
 *
 * 供控制台「项目首页」使用（REST GET /api/v1/project/stats 与指令 project_stats）。
 * token 从各会话消息的 usage 汇总（assistant 消息带 usage）。
 */
import type { SessionManager } from "./session.js";
import type { SessionStatus } from "./types.js";

/** 列表预览用：最后一条用户指令的截断长度（避免整段粘贴内容进入统计响应） */
const LAST_INPUT_MAX_CHARS = 200;

/** 截断为列表预览长度 */
function previewInput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LAST_INPUT_MAX_CHARS
    ? `${trimmed.slice(0, LAST_INPUT_MAX_CHARS)}…`
    : trimmed;
}

/** 取最后一条用户指令（含运行中注入的补充信息）；无则 null */
function lastUserInput(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null | undefined;
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    const text = previewInput(m.content);
    if (text) return text;
  }
  return null;
}

/**
 * 会话的最近一次用户指令。
 *
 * 优先读 `lastInput`：它在提交时同步写入并落盘，引擎把消息推进 history 之前
 * 就能被首页看到；旧会话没有该字段时回退到扫描 messages。
 */
function sessionLastInput(s: { lastInput?: string; messages: unknown[] }): string | null {
  const direct = s.lastInput ? previewInput(s.lastInput) : "";
  return direct || lastUserInput(s.messages);
}

export interface ProjectSessionStat {
  sessionId: string;
  name: string | null;
  status: SessionStatus;
  model: string;
  messageCount: number;
  /** 最近一次用户指令（截断预览） */
  lastUserInput: string | null;
  savedAt: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ProjectStats {
  sessionCount: number;
  running: number;
  waiting: number;
  completed: number;
  error: number;
  idle: number;
  tokensIn: number;
  tokensOut: number;
  sessions: ProjectSessionStat[];
}

export function projectStats(manager: SessionManager, tenantId: string): ProjectStats {
  const sessions = manager.listSessions(tenantId);
  let tokensIn = 0;
  let tokensOut = 0;
  let running = 0;
  let waiting = 0;
  let completed = 0;
  let error = 0;
  let idle = 0;

  const list: ProjectSessionStat[] = sessions.map((s) => {
    let sIn = 0;
    let sOut = 0;
    if (s.usage) {
      // 账本口径：直接读会话累计（O(1)），不再遍历消息
      sIn = s.usage.input;
      sOut = s.usage.output;
    } else {
      for (const m of s.messages as Array<Record<string, unknown>>) {
        const u = m?.usage as { input?: unknown; output?: unknown } | undefined;
        if (u) {
          sIn += Number(u.input ?? 0) || 0;
          sOut += Number(u.output ?? 0) || 0;
        }
      }
    }
    tokensIn += sIn;
    tokensOut += sOut;
    if (s.status === "running") running += 1;
    else if (s.status === "waiting_approval" || s.status === "waiting_question") waiting += 1;
    else if (s.status === "completed") completed += 1;
    else if (s.status === "error") error += 1;
    else idle += 1;

    return {
      sessionId: s.sessionId,
      name: s.name ?? null,
      status: s.status,
      model: s.model,
      messageCount: (s.messages as unknown[]).length,
      lastUserInput: sessionLastInput(s),
      savedAt: s.savedAt,
      tokensIn: sIn,
      tokensOut: sOut,
    };
  });

  return {
    sessionCount: sessions.length,
    running,
    waiting,
    completed,
    error,
    idle,
    tokensIn,
    tokensOut,
    sessions: list,
  };
}
