/**
 * 基础类型定义
 *
 * 与 Python 版 zqagent 对齐的基础类型。这里定义了 Agent 引擎内部
 * 流转的核心数据模型：LLM 工具调用、助手回复、Token 用量、流式 chunk、
 * 对话消息以及 OpenAI 工具 Schema。
 */

/** LLM 请求的工具调用 */
export interface ToolCall {
  /** 工具调用 ID（OpenAI 格式，用于把 tool 结果消息关联回对应的调用） */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具参数（已解析为对象的形态） */
  arguments: Record<string, unknown>;
}

/** LLM 一次回复 */
export interface AssistantTurn {
  /** 回复正文文本；无文本时为 null */
  text: string | null;
  /** 本次回复请求的工具调用列表（可能为空） */
  toolCalls: ToolCall[];
  /** 结束原因（stop / tool_calls / length 等），由 Provider 提供 */
  finishReason: string | null;
  /** 推理过程内容（如 OpenAI o 系列模型的 reasoning_content） */
  reasoning: string | null;
  /** 本次调用的 Token 用量统计 */
  usage: TokenUsage | null;
}

/** 标准化的 Token 用量 */
export interface TokenUsage {
  /** 输入 token 数 */
  input: number;
  /** 输出 token 数 */
  output: number;
  /** 命中缓存（缓存读取）的 token 数 */
  cacheRead: number;
  /** 写入缓存的 token 数 */
  cacheWrite: number;
}

/** 计算上下文 token 总量（对齐 Python 版 TokenUsage.context_tokens） */
export function contextTokens(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** 流式输出的单个 chunk */
export interface StreamChunk {
  /** 文本增量；该 chunk 无文本时为 null */
  content: string | null;
  /** 推理内容增量 */
  reasoning: string | null;
  /**
   * 工具调用：流式过程中为 null；
   * 流结束的最终 chunk 中，有工具调用时为完整列表，否则为 null
   */
  toolCalls: ToolCall[] | null;
  /** 累计 Token 用量（OpenAI 在流结束前的最后一个 chunk 中返回） */
  usage: TokenUsage | null;
  /** 结束原因（仅在流结束 chunk 中出现） */
  finishReason: string | null;
}

/** 对话消息 */
export interface Message {
  /** 本轮任务ID */
  taskId?: string;
  /** 消息角色 */
  role: "system" | "user" | "assistant" | "tool" | "notice";
  /** 消息正文 */
  content: string;
  // display-only sidecar 字段：仅用于界面展示，发送给模型前会被剥离
  /** 附加来源信息（展示用） */
  source?: Record<string, unknown>;
  /** 展示用的替代文本（展示用） */
  _display?: string;
  /** 消息时间戳 */
  ts?: number;
  /** 推理过程文本（assistant 消息） */
  reasoning?: string;
  /** Token 用量（assistant 消息） */
  usage?: Record<string, unknown>;
  // tool 相关字段
  /** 关联的工具调用 ID（tool 消息回填用） */
  tool_call_id?: string;
  /** 工具调用名称（tool 消息回填用） */
  tool_call_name?: string;
  /** 工具调用列表（assistant 消息，OpenAI 格式） */
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  // notice 相关字段：notice 消息仅用于日志/展示，不会发送给模型
  /** 通知类型：错误 / 中断 / 上下文压缩 / 模型切换 */
  kind?: "error" | "interrupted" | "compacted" | "model_switch" | "retry";
  /** 通知附加文本 */
  text?: string;
}

/**
 * 推理强度（reasoning effort）
 *
 * 控制模型在生成答案前投入的推理计算量（OpenAI 的
 * reasoning_effort / Responses 的 reasoning.effort 参数）。
 * 仅对支持该参数的非 DeepSeek 模型生效（DeepSeek 用 thinking
 * 布尔开关，不支持级别控制，Provider 层会跳过）。
 */
export type ReasoningEffort = "low" | "medium" | "high";

/** OpenAI 工具 Schema */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
