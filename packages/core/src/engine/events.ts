/**
 * 事件模型
 *
 * 对齐 Python 版 Event 模型。TurnEngine 以异步生成器（AsyncGenerator）
 * 的形式对外产出事件流，CLI/WebSocket 等消费方通过监听这些事件来渲染
 * 实时进度、展示工具执行状态、处理审批请求等。
 */

/** 事件类型 */
export enum EventType {
  /** 一轮 Turn 开始 */
  TURN_START = "turn_start",
  /** 助手回复的文本增量（流式） */
  ASSISTANT_DELTA = "assistant_delta",
  /** 助手推理过程的文本增量（流式） */
  REASONING_DELTA = "reasoning_delta",
  /** 一轮完整的助手消息（流结束后汇总） */
  ASSISTANT_MESSAGE = "assistant_message",
  /** 提议执行某工具（执行前的预通知） */
  TOOL_PROPOSED = "tool_proposed",
  /** 需要用户审批 */
  PERMISSION_REQUIRED = "permission_required",
  /** 请求用户提供目录/路径（预留） */
  DIRECTORY_REQUESTED = "directory_requested",
  /** 提出计划（预留） */
  PLAN_PROPOSED = "plan_proposed",
  /** 工具开始执行 */
  TOOL_STARTED = "tool_started",
  /** 工具执行结束（含结果摘要或错误） */
  TOOL_FINISHED = "tool_finished",
  /** 一轮迭代（LLM 调用 + 工具执行）结束 */
  ITERATION_END = "iteration_end",
  /** 一轮 Turn 结束（completed / max_iterations_exceeded / 其他状态） */
  TURN_END = "turn_end",
  /** 引擎内部错误 */
  ERROR = "error",
  /** 被用户中断 */
  INTERRUPTED = "interrupted",
  /** 上下文压缩开始 */
  COMPACTING = "compacting",
  /** 上下文压缩完成 */
  COMPACTED = "compacted",
  /** 队列中排队等待执行 */
  QUEUE_STEERING = "queue_steering",
  /** LLM 请求发出 — 携带 reqId 用于关联审计日志与后续 delta/error 事件 */
  LLM_REQUEST = "llm_request",
  /** 模型通过 ask_user 工具向用户提问 */
  ASK_USER_QUESTION = "ask_user_question",
  /** 会话名已（自动/手动）更新 — data: { name, source } */
  SESSION_NAMED = "session_named",
  /** 瞬时网络错误自动重试 — data: { attempt, max, reason } */
  LLM_RETRY = "llm_retry",
}

/** WebSocket 事件 (CLI 模式下通过 async generator 模拟) */
export interface WsEvent {
  /** 事件类型 */
  type: EventType;
  /** 事件负载（结构随事件类型变化） */
  data: Record<string, unknown>;
}

/** 审批请求 */
export interface PermissionRequest {
  /** 需要审批的工具名 */
  toolName: string;
  /** 该工具调用的参数 */
  arguments: Record<string, unknown>;
  /** 工具元数据（风险等级、分类等） */
  metadata: unknown;
  /** 需要审批的原因说明 */
  reason: string;
  /** 关联的工具调用 ID（云端挂起式审批用于匹配恢复时的请求） */
  toolCallId?: string;
}

/** 审批结果 */
export enum ApprovalOutcome {
  /** 仅本次允许 */
  ONCE = "once",
  /** 本会话内总是允许该工具 */
  ALWAYS_TOOL = "always_tool",
  /** 本会话内总是允许该命令 */
  ALWAYS_COMMAND = "always_command",
  /** 拒绝 */
  DENY = "deny",
}

/** 审批回调：接收审批请求，返回审批结果 */
export type Approver = (request: PermissionRequest) => Promise<ApprovalOutcome>;

// ==================== 引擎钩子 ====================

import type { TokenUsage } from "./types.js";

/** 错误附加信息（供调用方决定是否重试） */
export interface EngineErrorInfo {
  /** 是否可重试：HTTP 429/5xx、网络/超时类错误、上下文溢出等 */
  retriable: boolean;
  /** 出错时的迭代号（从 1 开始） */
  iteration: number;
  /** 错误堆栈（异常对象存在时提供，可能缺失） */
  stack?: string;
}

/**
 * 上下文压缩触发原因
 *
 * - `threshold`：达到触发阈值的预防性压缩
 * - `overflow`：API 报上下文溢出后的强制压缩
 */
export type CompactionTrigger = "threshold" | "overflow";

/** 压缩开始时的上下文用量（供 hook / 事件携带，便于展示更多信息） */
export interface CompactionStartInfo {
  /** 触发原因 */
  trigger: CompactionTrigger;
  /** 触发时的上下文 token 用量（优先 API 精确值，否则为估算） */
  tokens: number;
  /** tokens 是否为 chars/4 估算值 */
  estimated: boolean;
  /** 当前模型的上下文窗口（token 数） */
  contextWindow: number;
  /** 触发阈值占窗口的比例（0-1） */
  thresholdPct: number;
  /** 触发阈值（token 数，已计入 capTokens 截断） */
  thresholdTokens: number;
  /** 压缩前发送给模型的消息条数 */
  outboundMessages: number;
}

/** 压缩结果信息 */
export interface CompactionDoneInfo {
  /** summarized=LLM 摘要，trimmed=裁剪降级 */
  method: "summarized" | "trimmed";
  /** 压缩前发送给模型的消息条数 */
  messagesBefore: number;
  /** 压缩后发送给模型的消息条数 */
  messagesAfter: number;
  /** 摘要所用模型（method=summarized 时提供） */
  model?: string;
  /** 摘要保留的早期用户消息数 */
  keptUserMessages?: number;
  /** 摘要丢弃的早期用户消息数 */
  droppedUserMessages?: number;
}

/**
 * 引擎生命周期钩子
 *
 * 所有方法均为可选。调用者在构建 TurnEngine 时注入自己的实现——
 * 控制台打印、日志落盘、WebSocket 广播、数据库写入等，由调用者决定。
 * 引擎保证在对应生命周期点调用（不抛异常，不影响核心逻辑）。
 */
export interface EngineHook {
  /** Turn 开始 */
  onTurnStart?(input: string): void;
  /** Turn 结束 */
  onTurnEnd?(status: string, iterations: number, producedFiles: string[]): void;

  /** LLM 流式文本增量 */
  onAssistantDelta?(text: string): void;
  /** LLM 推理文本增量 */
  onReasoningDelta?(text: string): void;
  /** LLM 完整回复 */
  onAssistantMessage?(
    text: string | null,
    toolCalls: string[],
    usage?: TokenUsage,
  ): void;

  /** 工具执行生命周期 */
  onToolProposed?(name: string, args: Record<string, unknown>): void;
  onToolStarted?(name: string): void;
  onToolFinished?(name: string, status: string, resultPreview: string): void;

  /** 审批 */
  onPermissionRequired?(name: string, reason: string): void;

  /** 迭代结束 */
  onIterationEnd?(iteration: number): void;

  /** 上下文压缩：开始（info 含触发原因与用量）/ 完成（info 含压缩方式与前后条数） */
  onCompacting?(info?: CompactionStartInfo): void;
  onCompacted?(text: string, info?: CompactionDoneInfo): void;

  /** 异常 */
  onError?(error: string, errorType: string, info?: EngineErrorInfo): void;

  /** 瞬时网络错误自动重试（attempt 从 1 开始） */
  onRetry?(attempt: number, max: number, reason: string): void;
  onInterrupted?(iterations: number): void;

  /** 通用兜底：所有未匹配到具体回调的事件都会走这里 */
  onEvent?(type: EventType, data: Record<string, unknown>): void;
}
