/**
 * TurnEngine — 核心 Agent 循环
 *
 * 对齐 Python 版 TurnEngine。以异步生成器（AsyncGenerator<WsEvent>）
 * 的形式驱动一轮完整的 Agent 交互（Turn）：
 *   LLM 流式调用 → 事件输出 → 工具授权（审批）→ 工具执行 → 迭代
 * 直到模型不再请求工具调用（或达到迭代上限 / 被中断 / 出错）。
 *
 * 外部通过消费生成器产出的事件流来渲染实时进度、执行审批等。
 */
import {
  EventType,
  type WsEvent,
  ApprovalOutcome,
  type Approver,
  type EngineHook,
  type CompactionTrigger,
  type CompactionStartInfo,
  type CompactionDoneInfo,
} from "./events.js";
import {
  type AssistantTurn,
  type Message,
  type ToolCall,
  type ReasoningEffort,
  contextTokens,
} from "./types.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { errorCode, isNetworkErrorText } from "../providers/diagnostics.js";
import { PermissionEngine } from "../permissions/PermissionEngine.js";
import type { ProviderClient } from "../providers/OpenAIProvider.js";
import * as compaction from "./compaction.js";
import type { CompactionState } from "./compaction.js";
import { applyToolResultBudget } from "./toolResultBudget.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as _path from "path";
import { GEN_SESSION_NAME_INSTRUCTIONS } from "../prompts/index.js";
import type { MessageAttachment, StoredAttachment } from "./attachments.js";
import { DEFAULT_MAX_ITERATIONS } from "./limits.js";

/** 待注入的 steering 项（文本 + 可选的附件） */
interface SteeringItem {
  text: string;
  attachments?: MessageAttachment[];
  /** 附件落盘引用（与 attachments 一一对应；随事件带给控制台） */
  attachmentRefs?: StoredAttachment[];
}

/** 生成短请求 ID（8 位 hex，用于关联 LLM 请求与审计日志/事件） */
function genReqId(): string {
  return crypto.randomBytes(6).toString("base64url");
}

/**
 * 需要用户实时作答的工具（与 _handleToolCalls 中产出专用事件的工具一致）。
 * 它们必须串行执行：并发时用户无法区分回答归属，CLI 上还会同时出现
 * 多个提示符（见 cli/input.ts 的 ask 排队）。
 */
const INTERACTIVE_TOOLS = new Set([
  "ask_user",
  "propose_plan",
  "request_directory",
]);

/** _compactNow 的结构化返回值 */
interface CompactResult {
  notice: string | null;
  method: "summarized" | "trimmed" | null;
  boundaryIndex?: number;
  modelUsed?: string;
  summaryPreview?: string;
  keptUserMessages?: number;
  droppedUserMessages?: number;
  /** 压缩前发送给模型的消息条数 */
  messagesBefore?: number;
  /** 压缩后发送给模型的消息条数 */
  messagesAfter?: number;
}

/** 单次压缩最多连续执行的轮数（防止尾部消息过大时反复进出压缩） */
const MAX_COMPACT_ROUNDS = 4;
/** 强制压缩（溢出）后的目标水位：占触发阈值的比例 */
const OVERFLOW_TARGET_RATIO = 0.5;
/** 强制裁剪时丢弃的比例（溢出路径要一次让出足够空间） */
const OVERFLOW_TRIM_FRACTION = 0.5;
/** 压缩无进展后，至少新增这么多条消息才再次尝试预防性压缩 */
const COMPACT_STALL_RETRY_DELTA = 20;

/**
 * 达到迭代上限时的收尾指令（仅 `finalizeOnMaxIterations` 生效）。
 *
 * 撞上限那一刻模型通常正处在「继续调用工具」的姿态，最后一条正文可能根本不存在：
 * 子代理几十步的探索成果会因此全部作废。这里追加一段指令并**不提供任何工具**，
 * 逼它把已收集到的信息写成结论。
 */
const FINALIZE_ON_LIMIT_PROMPT =
  "已达到本轮迭代上限，你不能再调用任何工具。请立即基于上面已经收集到的信息输出最终报告：" +
  "直接回答任务、给出结论与 path:line 引用，并明确说明哪些部分尚未查证。不要询问、不要继续探索。";

/** TurnEngine 构造参数 */
export interface TurnEngineOpts {
  /** LLM Provider（流式调用） */
  provider: ProviderClient;
  /** 工具注册表 */
  registry: ToolRegistry;
  /** 权限引擎（工具调用的风险评估与门控） */
  permissions: PermissionEngine;
  /** 模型标识 */
  model: string;
  /** 系统提示词（注入为第一条 system 消息） */
  instructions: string;
  /** 生成会话名称的提示词 */
  genSessionNamePrompt?: string;
  /** 单轮最大迭代次数（缺省用 DEFAULT_MAX_ITERATIONS） */
  maxIterations?: number;
  /**
   * 达到迭代上限后，是否再用一轮「不带工具」的调用让模型收尾总结。
   *
   * 只给子代理（explore）用：它的产出就是一份报告，半途而废等于白跑。
   * 主代理撞上限通常意味着任务确实没做完，强行总结会给出似是而非的结论，
   * 因此缺省关闭。
   */
  finalizeOnMaxIterations?: boolean;
  /**
   * 推理强度（可选）。透传给 Provider 的 LLM 请求参数
   * （OpenAI reasoning_effort；DeepSeek 自动跳过）。
   */
  reasoningEffort?: ReasoningEffort;
  /** 初始对话历史（可选） */
  messages?: Message[];
  /** 引擎生命周期钩子（可选） */
  hook?: EngineHook;
  /** 模型上下文窗口大小（token 数）。设置后将覆盖自动检测与默认值 (128K)。 */
  contextWindow?: number;
  /** 压缩触发阈值比例（占窗口比例，默认 0.8） */
  thresholdPct?: number;
  /**
   * 软阈值比例（占窗口比例）：达到它只淘汰旧工具结果，不调用 LLM。
   * 缺省为硬阈值的 75%（即默认 60% 窗口）。
   */
  softThresholdPct?: number;
  /** 压缩触发阈值绝对上限（token 数；缺省不限制，即按比例用满窗口） */
  capTokens?: number | null;
  /**
   * 超预算工具结果的落盘目录（可选）。
   *
   * 多租户 Server 应指向租户/会话自己的目录，避免不同租户的内容混在一个目录里。
   */
  toolResultDir?: string;
}

/** 工具执行结果辅助函数：把工具返回值转成 tool 角色消息（带结果预算） */
function toolResultMessage(
  tc: ToolCall,
  result: unknown,
  taskId?: string,
  toolResultDir?: string,
): Message {
  const budgeted = applyToolResultBudget(tc.name, result, { dir: toolResultDir });
  return {
    role: "tool",
    tool_call_id: tc.id,
    tool_call_name: tc.name,
    content: budgeted.content,
    taskId,
  };
}

/** 工具未执行（被拒/中断/未知）时的错误消息 */
function toolErrorMessage(
  tc: ToolCall,
  reason: string,
  taskId?: string,
): Message {
  return {
    role: "tool",
    tool_call_id: tc.id,
    tool_call_name: tc.name,
    content: JSON.stringify({ error: "tool call not executed", reason }),
    taskId,
  };
}

/** 把一次完整的 assistant 回复转换为对话历史消息（含 tool_calls/usage/reasoning） */
function assistantMessage(
  turn: AssistantTurn,
  model: string,
  taskId?: string,
): Message {
  const msg: Message = {
    role: "assistant",
    content: turn.text ?? "",
    ts: Date.now(),
    taskId,
  };
  if (turn.toolCalls.length > 0) {
    msg.tool_calls = turn.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  if (turn.usage) {
    msg.usage = { model, ...turn.usage };
  }
  if (turn.reasoning) {
    msg.reasoning = turn.reasoning;
  }
  return msg;
}

/** 工具结果的单行预览（换行转义 + 截断），用于事件负载 */
function preview(value: unknown, maxLen = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\n/g, "\\n");
  return flat.length <= maxLen ? flat : flat.slice(0, maxLen - 3) + "...";
}

/**
 * 判断错误是否可重试
 *
 * 可重试：HTTP 429/5xx（Provider 侧瞬时故障）、网络/超时类错误。
 * 不可重试：4xx 校验错误、认证失败、本地环境问题等。
 * （上下文溢出不在此列，由调用方在 catch 块单独判定。）
 */
/** 瞬时网络错误（连接重置/超时/DNS 抖动）→ 自动重试；HTTP 状态类错误不在此列 */
function isTransientNetworkError(exc: unknown): boolean {
  const status = (exc as { status?: number } | null)?.status;
  if (typeof status === "number") {
    // 429/5xx 由 SDK 自身重试；其余（400/401/403/404…）不该重试
    return false;
  }
  const msg = `${exc instanceof Error ? exc.message : String(exc)} ${errorCode(exc) ?? ""}`;
  return isNetworkErrorText(msg);
}

/** 网络重试次数（NETWORK_RETRY_MAX，默认 2）与退避基数（NETWORK_RETRY_BASE_MS，默认 800） */
function networkRetryMax(): number {
  const n = Number(process.env.NETWORK_RETRY_MAX);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}
function networkRetryBaseMs(): number {
  const n = Number(process.env.NETWORK_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 800;
}
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetriableError(exc: unknown): boolean {
  const status = (exc as { status?: number } | null)?.status;
  if (typeof status === "number") {
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    return false;
  }
  const text = String(
    (exc instanceof Error ? exc.message : exc) ?? "",
  ).toLowerCase();
  const markers = [
    "connection error",
    "fetch failed",
    "econnreset",
    "etimedout",
    "econnrefused",
    "socket hang up",
    "network",
    "timeout",
    "rate limit",
    "unavailable",
    "overloaded",
    "temporarily",
  ];
  return markers.some((m) => text.includes(m));
}

/** 核心 Agent 循环 (对齐 Python 版 TurnEngine) */
export class TurnEngine {
  provider: ProviderClient;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  model: string;
  instructions: string; // 系统提示词
  genSessionNamePrompt: string; // 生成会话名称的提示
  maxIterations: number;
  /** 对话历史（含 notice 消息，发送前过滤） */
  messages: Message[];
  /** 审批回调（由外部注入，如 CLI 的 Y/N 交互） */
  approver: Approver | null = null;

  /** 引擎生命周期钩子（由外部注入，可选） */
  private _hook: EngineHook | undefined;

  // 中断标记：requestInterrupt() 置位后，引擎在下一个安全点停止
  private _cancel = false;
  // 在飞的 LLM 流式中止句柄：requestInterrupt() 直接 abort，
  // 否则流静默挂死时引擎永远等不到检查标志位的安全点
  private _llmAbort: AbortController | null = null;
  // 在一轮工具执行期间生效的中止句柄：requestInterrupt() 一并 abort，
  // 使正在执行的可中断工具（run_shell）立即终止子进程，而不是等它自然结束
  private _toolAbort: AbortController | null = null;
  // Steering 消息队列：外部排队注入的用户级指令，迭代间隙注入
  private _steering: SteeringItem[] = [];

  // 上下文压缩
  compactionState: CompactionState | null = null;
  private _lastContextTokens: number | null = null;
  /** 压缩无进展时的消息条数快照；-1 表示无冷却 */
  private _compactStalledAt = -1;
  /** 显式配置的上下文窗口大小（token 数），未设置时为 undefined（走自动检测） */
  private _contextWindow: number | undefined;
  /** 压缩触发阈值比例（默认 0.8） */
  private _thresholdPct: number;
  /** 软阈值比例（undefined = 取硬阈值的 75%） */
  private _softThresholdPct: number | undefined;
  /** 是否启用软阈值淘汰（COMPACTION_ELIDE=0 可关闭） */
  private _elisionEnabled: boolean;
  /** 是否启用重复读取去重（COMPACTION_DEDUP=0 可关闭） */
  private _dedupEnabled: boolean;
  /** 压缩触发阈值绝对上限（null = 不限制） */
  private _capTokens: number | null;
  /** 超预算工具结果的落盘目录（undefined = 使用默认状态目录） */
  private _toolResultDir: string | undefined;

  // 产出文件追踪（本轮 Turn 中成功写入的文件）
  private _producedFiles: string[] = [];
  private _turnStartTime = 0;
  private static readonly FILE_WRITE_TOOLS = new Set([
    "write_file",
    "replace_in_file",
    "apply_patch",
    "apply_unified_diff",
  ]);

  /** 兜底扫描：文件后缀白名单（对齐 Python 版 _artifact_kind） */
  private static readonly SCAN_SUFFIXES = new Set([
    ".md",
    ".markdown",
    ".html",
    ".htm",
    ".txt",
    ".json",
    ".csv",
    ".tsv",
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".pdf",
    ".xlsx",
    ".xls",
    ".pptx",
    ".docx",
    ".doc",
  ]);

  private taskId?: string;

  /** 推理强度（透传给 Provider；undefined = 使用模型默认） */
  private _reasoningEffort: ReasoningEffort | undefined;

  /** 撞上限后是否再跑一轮收尾（见 TurnEngineOpts.finalizeOnMaxIterations） */
  private _finalizeOnMaxIterations: boolean;
  /** 收尾轮只跑一次（防止 yield* 被重入时反复总结） */
  private _finalized = false;

  constructor(opts: TurnEngineOpts) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.permissions = opts.permissions;
    this.model = opts.model;
    this.instructions = opts.instructions; // 注入为首条 system 消息
    this.genSessionNamePrompt =
      opts.genSessionNamePrompt || GEN_SESSION_NAME_INSTRUCTIONS;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this._finalizeOnMaxIterations = opts.finalizeOnMaxIterations ?? false;
    this.messages = opts.messages ? [...opts.messages] : [];
    this._hook = opts.hook;
    this._contextWindow = opts.contextWindow;
    this._thresholdPct = opts.thresholdPct ?? compaction.DEFAULT_THRESHOLD_PCT;
    this._softThresholdPct = opts.softThresholdPct;
    this._elisionEnabled = !/^(0|false|off|no)$/i.test(
      (process.env.COMPACTION_ELIDE ?? "").trim(),
    );
    this._dedupEnabled = !/^(0|false|off|no)$/i.test(
      (process.env.COMPACTION_DEDUP ?? "").trim(),
    );
    this._capTokens = opts.capTokens ?? null;
    this._toolResultDir = opts.toolResultDir;
    this._reasoningEffort = opts.reasoningEffort;
    // 注入 system prompt（仅在历史为空或首条不是 system 时）
    if (this.messages.length === 0 || this.messages[0].role !== "system") {
      this.messages.unshift({ role: "system", content: this.instructions });
    }
  }

  /**
   * 外部中断：置位取消标记 + 掐断在飞的 LLM 请求 + 中止正在执行的工具，
   * 引擎随后按中断收尾
   */
  requestInterrupt(): void {
    this._cancel = true;
    this._llmAbort?.abort();
    this._toolAbort?.abort();
  }

  /** 设置审批回调 */
  setApprover(approver: Approver): void {
    this.approver = approver;
  }

  /**
   * 运行时替换系统提示词（切换 agent / 修改 prompt 后调用）。
   *
   * 同步更新 this.instructions 与首条 system 消息的内容；
   * 若历史首条不是 system（如恢复的会话），则在最前插入新的 system 消息。
   */
  setSystemPrompt(prompt: string): void {
    this.instructions = prompt;
    const first = this.messages[0];
    if (first && first.role === "system") {
      first.content = prompt;
    } else {
      this.messages.unshift({ role: "system", content: prompt });
    }
  }

  /** 排队 steering 消息（下一迭代间隙注入为 user 消息） */
  queueSteering(
    text: string,
    attachments?: MessageAttachment[],
    attachmentRefs?: StoredAttachment[],
  ) {
    this._steering.push({
      text,
      ...(attachments?.length ? { attachments } : {}),
      ...(attachmentRefs?.length ? { attachmentRefs } : {}),
    });
  }

  /**
   * 撤销一条尚未注入的 steering。
   *
   * 按文本删第一条匹配项：调用方（SessionManager）已按索引删掉了自己那份队列，
   * 这里只需保证引擎不再注入同样的内容。用文本而非索引，是因为引擎会在迭代
   * 间隙批量清空 `_steering`，索引可能已经漂移；文本相同则删哪条都等价。
   *
   * @returns 是否真的删掉了（已注入的项返回 false，调用方据此提示用户）
   */
  removeSteering(text: string): boolean {
    const i = this._steering.findIndex((s) => s.text === text);
    if (i < 0) return false;
    this._steering.splice(i, 1);
    return true;
  }

  // ===================== 主入口 =====================

  /**
   * 运行一轮 Turn
   *
   * 追加用户输入到历史，产出 TURN_START 事件，然后转发 _loop()
   * 的全部事件。收到中断后仍会消费完剩余事件（保证 TURN_END 产出）。
   */
  async *run(
    userInput: string,
    taskId?: string,
    attachments?: MessageAttachment[],
    /** 附件落盘引用（由会话层先存盘再传入）：消息与事件只带它，不带 base64 */
    attachmentRefs?: StoredAttachment[],
  ): AsyncGenerator<WsEvent> {
    /*
     * 模型为空时不要发请求。
     *
     * 系统不再给「未配置模型」兜底一个假型号（早期是 gpt-4o，用户既没这个型号
     * 的 Key、也没选过它，第一轮必然失败且报错难懂）。这里提前给出可执行的提示。
     */
    if (!this.model.trim()) {
      throw new Error(
        "未指定模型：请先选择模型（CLI 运行 /connect；控制台在「设置 → AI 模型」中添加供应商并选择模型）",
      );
    }
    this.taskId = taskId;
    // 本轮起点先定：outbound 用它判定哪些附件属于本轮（见 _finalizeOutbound）
    this._turnStartTime = Date.now();
    this.messages.push({
      role: "user",
      content: userInput,
      ...(attachments?.length ? { attachments } : {}),
      ...(attachmentRefs?.length ? { attachmentRefs } : {}),
      ts: this._turnStartTime,
      taskId,
    });

    this._cancel = false;
    this._producedFiles = [];
    // 新 turn 重新给压缩一次机会（上一 turn 可能因无进展而处于冷却）
    this._compactStalledAt = -1;

    this._emitHook((h) => h.onTurnStart?.(userInput));

    yield {
      type: EventType.TURN_START,
      data: {
        taskId: this.taskId,
        input: userInput,
        // 只报个数：附件字节不进事件流（事件会落盘，base64 会把日志撑爆）
        ...(attachments?.length ? { attachmentCount: attachments.length } : {}),
        // 落盘引用足够小，随事件带给控制台渲染缩略图 / 详情回看
        ...(attachmentRefs?.length ? { attachments: attachmentRefs } : {}),
      },
    };

    for await (const event of this._loop()) {
      yield event;
    }
  }

  /** 重试 (仅在 Provider 错误后可用) */
  async *retry(): AsyncGenerator<WsEvent> {
    if (!this._tailIsRetriableError()) return;
    this._cancel = false;
    yield {
      type: EventType.TURN_START,
      data: { taskId: this.taskId, input: "(retry)" },
    };
    for await (const event of this._loop()) {
      yield event;
    }
  }

  /** 从持久化的挂起点恢复 Turn (对齐 Python 版 resume) */
  async *resume(): AsyncGenerator<WsEvent> {
    const pending = this._unansweredTrailingToolCalls();
    if (pending.length === 0) return;

    this._cancel = false;
    this._producedFiles = [];
    this._turnStartTime = Date.now();
    yield {
      type: EventType.TURN_START,
      data: { taskId: this.taskId, input: "(resumed)" },
    };

    // 重新处理挂起的 tool_calls（approver 会因已 resolved 而立即返回）
    for await (const event of this._handleToolCalls(pending)) {
      yield event;
    }

    yield {
      type: EventType.ITERATION_END,
      data: { taskId: this.taskId, iteration: 0 },
    };

    // 继续正常循环
    if (!this._cancel) {
      for await (const event of this._loop()) {
        yield event;
      }
    }
  }

  public async genSessionName(): Promise<string | null> {
    const useMsgs = this.messages
      .filter((v) => v.role === "user")
      .filter((v) => v.content.length > 0)
      .slice(0, 3)
      .map((m) => ({ role: "user", content: m.content }));

    if (useMsgs.length > 0) {
      const messages = [
        { role: "system", content: this.genSessionNamePrompt },
        ...useMsgs,
      ];
      const name = await this.provider.chat(
        this.model,
        messages,
        {},
        {
          reqId: `llm_chat_${Date.now()}_${genReqId()}`,
          logTime: new Date().toISOString(),
        },
        // 不设 maxTokens：推理模型（deepseek 等）的思考会占用输出配额，
        // 过小会导致 content 为空从而拿不到名称；命名 prompt 已约束只输出短标题。
        {},
      );
      return name;
    }
    return null;
  }

  /** 从持久化消息历史中重建未完成的 tool_calls */
  private _unansweredTrailingToolCalls(): ToolCall[] {
    const answered = new Set(
      this.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === "user") return [];
      if (m.role === "assistant" && m.tool_calls) {
        return m.tool_calls
          .filter((tc) => !answered.has(tc.id))
          .map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: (() => {
              try {
                return JSON.parse(tc.function.arguments);
              } catch {
                return {};
              }
            })(),
          }));
      }
    }
    return [];
  }

  // ===================== 核心循环 =====================

  /**
   * 中断收尾：保留已流式输出的内容、记一条 interrupted 提示，
   * 产出 INTERRUPTED + TURN_END 事件并结束本轮。
   *
   * 两处调用：流式结束后发现取消标记、以及流被 abort 中断抛错时。
   */
  private *_finishInterrupted(args: {
    iterations: number;
    reqId: string;
    streamed: string;
    streamedThinking: string;
  }): Generator<WsEvent, void, unknown> {
    const { iterations, reqId, streamed, streamedThinking } = args;
    if (streamed) {
      this.messages.push(
        assistantMessage(
          {
            text: streamed,
            toolCalls: [],
            finishReason: null,
            reasoning: streamedThinking || null,
            usage: null,
          },
          this.model,
          this.taskId,
        ),
      );
    }
    this._appendNotice("interrupted");
    this._emitHook((h) => h.onInterrupted?.(iterations));
    yield {
      type: EventType.INTERRUPTED,
      data: { iterations, reqId, taskId: this.taskId },
    };
    const files = this._buildProducedFiles();
    yield {
      type: EventType.TURN_END,
      data: {
        status: "interrupted",
        iterations,
        produced_files: files,
        taskId: this.taskId,
      },
    };
    this._emitHook((h) => h.onTurnEnd?.("interrupted", iterations, files));
  }

  /**
   * 核心迭代循环
   *
   * 每轮迭代：LLM 流式调用（收集文本/推理/工具调用）→ 追加 assistant
   * 消息 → 无工具调用则结束 Turn（或注入 steering 继续）→ 有工具调用
   * 则执行（_handleToolCalls）→ ITERATION_END → 检查中断与 steering。
   */
  private async *_loop(): AsyncGenerator<WsEvent> {
    let iterations = 0;
    // run / retry / resume 都会进到这里：每进入一次循环就是新一轮，收尾只跑一次
    this._finalized = false;
    /** 连续网络重试计数（一次成功调用后清零） */
    let netRetries = 0;
    const netMax = networkRetryMax();

    while (true) {
      // 最大迭代数检查
      if (iterations >= this.maxIterations) {
        // 子代理：先让模型把已有发现写成报告，再结束（见 finalizeOnMaxIterations）
        if (this._finalizeOnMaxIterations && !this._finalized) {
          for await (const event of this._finalizeAtLimit(iterations)) {
            yield event;
          }
          return;
        }
        const files = this._buildProducedFiles();

        yield {
          type: EventType.TURN_END,
          data: {
            taskId: this.taskId,
            status: "max_iterations_exceeded",
            iterations,
            produced_files: files,
          },
        };
        this._emitHook((h) =>
          h.onTurnEnd?.("max_iterations_exceeded", iterations, files),
        );
        return;
      }
      iterations++;

      // ---- 自动上下文压缩（预防性检查） ----
      let compactionNotice: string | null = null;
      if (this._compactionDue()) {
        const compactReqId = `compact_${Date.now()}_${genReqId()}`;
        const llmReqData = {
          reqId: compactReqId,
          taskId: this.taskId,
          model: this.model,
          msgCount: "compaction_span",
          toolCount: 0,
          compact: true,
        };
        this._emitHook((h) => h.onEvent?.(EventType.LLM_REQUEST, llmReqData));
        yield { type: EventType.LLM_REQUEST, data: llmReqData };

        const startInfo = this._compactionStartInfo("threshold");
        this._emitHook((h) => h.onCompacting?.(startInfo));
        yield {
          type: EventType.COMPACTING,
          data: { taskId: this.taskId, ...startInfo },
        };

        const result = await this._compactNow(compactReqId);
        if (result.notice) {
          compactionNotice = result.notice;
          this._appendNotice("compacted", result.notice);
          const doneInfo = this._compactionDoneInfo(result);
          this._emitHook((h) => h.onCompacted?.(result.notice!, doneInfo));
          yield {
            type: EventType.COMPACTED,
            data: {
              reqId: compactReqId,
              taskId: this.taskId,
              method: result.method,
              messagesBefore: doneInfo.messagesBefore,
              messagesAfter: doneInfo.messagesAfter,
              ...(result.boundaryIndex !== undefined
                ? { boundaryIndex: result.boundaryIndex }
                : {}),
              ...(result.modelUsed ? { model: result.modelUsed } : {}),
              ...(result.summaryPreview
                ? { summaryPreview: result.summaryPreview }
                : {}),
              ...(result.keptUserMessages !== undefined
                ? { keptUserMessages: result.keptUserMessages }
                : {}),
              ...(result.droppedUserMessages !== undefined
                ? { droppedUserMessages: result.droppedUserMessages }
                : {}),
            },
          };
        }
      }

      // ---- LLM 流式调用 ----
      let turn: AssistantTurn | null = null;
      let streamed = "";
      let streamedThinking = "";

      const reqId = `llm_${Date.now()}_${genReqId()}`;
      const logTime = new Date().toISOString();

      try {
        const outbound = this._outboundMessages();
        const schemas = this.registry.schemas();

        // 产出 LLM_REQUEST 审计事件
        const llmReqData = {
          reqId,
          taskId: this.taskId,
          logTime,
          model: this.model,
          msgCount: outbound.length,
          toolCount: schemas.length,
        };
        this._emitHook((h) => h.onEvent?.(EventType.LLM_REQUEST, llmReqData));
        yield { type: EventType.LLM_REQUEST, data: llmReqData };

        // 为本次流式请求挂上中止句柄：requestInterrupt() 可立即掐断它。
        // （中断发生在建流之前时，_cancel 已置位 → 建完即 abort。）
        this._llmAbort = new AbortController();
        if (this._cancel) this._llmAbort.abort();
        const chunks = await this.provider.stream(
          this.model,
          outbound,
          schemas,
          {
            reqId,
            logTime,
            reasoningEffort: this._reasoningEffort,
            signal: this._llmAbort.signal,
          },
        );

        for await (const chunk of chunks) {
          if (this._cancel) break;

          // 文本 delta：累积并实时产出
          if (chunk.content) {
            const delta = chunk.content;
            streamed += delta;
            this._emitHook((h) => h.onAssistantDelta?.(delta));
            yield {
              type: EventType.ASSISTANT_DELTA,
              data: { text: delta, reqId, taskId: this.taskId },
            };
          }

          // 推理 delta：实时产出（CLI 默认不显示）
          if (chunk.reasoning) {
            const delta = chunk.reasoning;
            streamedThinking += delta;
            this._emitHook((h) => h.onReasoningDelta?.(delta));
            yield {
              type: EventType.REASONING_DELTA,
              data: { text: delta, reqId, taskId: this.taskId },
            };
          }

          // 最终 chunk（流结束）→ 提取完整 turn
          if (chunk.toolCalls !== null || chunk.finishReason) {
            turn = {
              text: streamed || null,
              toolCalls: chunk.toolCalls ?? [],
              finishReason: chunk.finishReason,
              reasoning: streamedThinking || null,
              usage: chunk.usage,
            };
          }
        }
      } catch (exc) {
        // 用户中断触发了流 abort（或流早已挂死被中止）→ 按中断收尾，不要误报为错误
        if (this._cancel && turn === null) {
          yield* this._finishInterrupted({
            iterations,
            reqId,
            streamed,
            streamedThinking,
          });
          return;
        }
        // 上下文溢出？→ 强制压缩后重试，不对外报错
        const overflow = compaction.isContextOverflow(exc);
        if (overflow && !this._cancel) {
          const overflowReqId = `compact_${Date.now()}_${genReqId()}`;
          const llmReqData = {
            reqId: overflowReqId,
            taskId: this.taskId,
            model: this.model,
            msgCount: "compaction_span",
            toolCount: 0,
            compact: true,
          };
          this._emitHook((h) => h.onEvent?.(EventType.LLM_REQUEST, llmReqData));
          yield { type: EventType.LLM_REQUEST, data: llmReqData };

          const startInfo = this._compactionStartInfo("overflow");
          this._emitHook((h) => h.onCompacting?.(startInfo));
          yield {
            type: EventType.COMPACTING,
            data: { taskId: this.taskId, ...startInfo },
          };

          const result = await this._compactNow(overflowReqId, true);
          if (result.notice) {
            const notice = result.notice;
            this._appendNotice("compacted", notice);
            const doneInfo = this._compactionDoneInfo(result);
            this._emitHook((h) => h.onCompacted?.(notice, doneInfo));
            yield {
              type: EventType.COMPACTED,
              data: {
                reqId: overflowReqId,
                taskId: this.taskId,
                method: result.method,
                messagesBefore: doneInfo.messagesBefore,
                messagesAfter: doneInfo.messagesAfter,
                ...(result.boundaryIndex !== undefined
                  ? { boundaryIndex: result.boundaryIndex }
                  : {}),
                ...(result.modelUsed ? { model: result.modelUsed } : {}),
                ...(result.summaryPreview
                  ? { summaryPreview: result.summaryPreview }
                  : {}),
                ...(result.keptUserMessages !== undefined
                  ? { keptUserMessages: result.keptUserMessages }
                  : {}),
                ...(result.droppedUserMessages !== undefined
                  ? { droppedUserMessages: result.droppedUserMessages }
                  : {}),
              },
            };
            // 保留已流式输出的部分
            if (streamed) {
              this.messages.push(
                assistantMessage(
                  {
                    text: streamed,
                    toolCalls: [],
                    finishReason: null,
                    reasoning: streamedThinking || null,
                    usage: null,
                  },
                  this.model,
                  this.taskId,
                ),
              );
            }
            continue; // ⟳ 回到循环顶部重新调用 LLM
          }
        }

        // 瞬时网络错误（连接重置/超时/DNS 抖动）→ 自动重试，避免整轮任务失败
        if (!this._cancel && !streamed && isTransientNetworkError(exc) && netRetries < netMax) {
          netRetries++;
          const reason = `${exc instanceof Error ? exc.message : String(exc)}`.slice(0, 200);
          const waitMs = networkRetryBaseMs() * 2 ** (netRetries - 1);
          this._appendNotice("retry", `网络中断，正在重试（${netRetries}/${netMax}）：${reason}`);
          this._emitHook((h) => h.onRetry?.(netRetries, netMax, reason));
          yield {
            type: EventType.LLM_RETRY,
            data: { attempt: netRetries, max: netMax, reason, waitMs, iteration: iterations, reqId },
          };
          iterations--; // 重试不消耗迭代预算
          await sleepMs(waitMs);
          continue;
        }

        const errMsg = exc instanceof Error ? exc.message : String(exc);
        const errorType =
          exc instanceof Error ? exc.constructor.name : "unknown";
        const errorStack = exc instanceof Error ? exc.stack : undefined;
        // 上下文溢出但压缩也失败 → 附加上下文，避免调用方困惑
        const displayMsg = overflow
          ? `${errMsg}（上下文溢出且压缩失败，建议清理会话后重试）`
          : errMsg;
        // 可重试：溢出（引擎会先压缩再重试）或 429/5xx/网络类瞬时错误
        const retriable = overflow || isRetriableError(exc);

        // 保留已流式输出的部分（避免上下文丢失）
        if (streamed) {
          this.messages.push(
            assistantMessage(
              {
                text: streamed,
                toolCalls: [],
                finishReason: null,
                reasoning: streamedThinking || null,
                usage: null,
              },
              this.model,
              this.taskId,
            ),
          );
        }
        this._appendNotice("error", errMsg);
        this._emitHook((h) =>
          h.onError?.(displayMsg, errorType, {
            retriable,
            iteration: iterations,
            ...(errorStack ? { stack: errorStack } : {}),
          }),
        );
        yield {
          type: EventType.ERROR,
          data: {
            error: displayMsg,
            error_type: errorType,
            retriable,
            iteration: iterations,
            reqId,
            logTime,
            taskId: this.taskId,
            ...(errorStack ? { stack: errorStack } : {}),
          },
        };
        // 错误终止也补齐 TURN_END，保证消费方状态机闭合
        const files = this._buildProducedFiles();
        yield {
          type: EventType.TURN_END,
          data: {
            status: "error",
            iterations,
            produced_files: files,
            taskId: this.taskId,
          },
        };
        this._emitHook((h) => h.onTurnEnd?.("error", iterations, files));
        return;
      }

      netRetries = 0; // 本轮 LLM 调用成功，清零网络重试计数

      // 用户中断（流式中间按下 Stop）
      if (this._cancel && turn === null) {
        yield* this._finishInterrupted({
          iterations,
          reqId,
          streamed,
          streamedThinking,
        });
        return;
      }

      // 兜底：流未产生最终 chunk 时用已累积文本构造 turn
      if (turn === null) {
        turn = {
          text: streamed || null,
          toolCalls: [],
          finishReason: null,
          reasoning: streamedThinking || null,
          usage: null,
        };
      }

      // ---- 追加 assistant 消息到历史 ----
      this.messages.push(assistantMessage(turn, this.model, this.taskId));

      // 记录精确的上下文 token 用量（优先采信 API 返回值）
      if (turn.usage) {
        this._lastContextTokens = contextTokens(turn.usage);
      }

      // 产出完整 assistant 消息事件（含工具名列表与用量）
      this._emitHook((h) =>
        h.onAssistantMessage?.(
          turn.text,
          turn.toolCalls.map((tc) => tc.name),
          turn.usage ?? undefined,
        ),
      );
      yield {
        type: EventType.ASSISTANT_MESSAGE,
        data: {
          text: turn.text,
          reasoning: turn.reasoning,
          tool_calls: turn.toolCalls.map((tc) => tc.name),
          ...(turn.usage
            ? { usage: { model: this.model, ...turn.usage } }
            : {}),
          reqId,
          taskId: this.taskId,
          logTime,
        },
      };

      // ---- 无工具调用？→ Turn 完成 ----
      if (!turn.toolCalls.length) {
        // 有排队的 steering 时先注入，继续下一轮迭代
        if (this._steering.length > 0) {
          for (const s of this._steering) {
            this.messages.push({
              role: "user",
              content: s.text,
              ...(s.attachments?.length ? { attachments: s.attachments } : {}),
              ...(s.attachmentRefs?.length ? { attachmentRefs: s.attachmentRefs } : {}),
              ts: Date.now(),
              taskId: this.taskId,
            });
            yield {
              type: EventType.QUEUE_STEERING,
              data: {
                text: s.text,
                taskId: this.taskId,
                ...(s.attachmentRefs?.length ? { attachments: s.attachmentRefs } : {}),
              },
            };
          }
          this._steering = [];

          continue;
        }
        const files = this._buildProducedFiles();
        yield {
          type: EventType.TURN_END,
          data: {
            status: "completed",
            iterations,
            produced_files: files,
            taskId: this.taskId,
          },
        };
        this._emitHook((h) => h.onTurnEnd?.("completed", iterations, files));
        return;
      }

      // ---- 执行工具 ----
      for await (const event of this._handleToolCalls(turn.toolCalls)) {
        yield event;
      }

      yield {
        type: EventType.ITERATION_END,
        data: { iteration: iterations, taskId: this.taskId },
      };
      this._emitHook((h) => h.onIterationEnd?.(iterations));

      // 检查中断
      if (this._cancel) {
        this._appendNotice("interrupted");
        this._emitHook((h) => h.onInterrupted?.(iterations));
        yield {
          type: EventType.INTERRUPTED,
          data: { iterations, reqId, taskId: this.taskId },
        };
        const files = this._buildProducedFiles();
        yield {
          type: EventType.TURN_END,
          data: {
            status: "interrupted",
            iterations,
            produced_files: files,
            taskId: this.taskId,
          },
        };
        this._emitHook((h) => h.onTurnEnd?.("interrupted", iterations, files));
        return;
      }

      // 注入 steering
      if (this._steering.length > 0) {
        for (const s of this._steering) {
          this.messages.push({
            role: "user",
            content: s.text,
            ...(s.attachments?.length ? { attachments: s.attachments } : {}),
            ...(s.attachmentRefs?.length ? { attachmentRefs: s.attachmentRefs } : {}),
            ts: Date.now(),
            taskId: this.taskId,
          });
          yield {
            type: EventType.QUEUE_STEERING,
            data: {
              text: s.text,
              taskId: this.taskId,
              ...(s.attachmentRefs?.length ? { attachments: s.attachmentRefs } : {}),
            },
          };
        }
        this._steering = [];
      }
    }
  }

  /**
   * 撞上限后的收尾轮（仅 finalizeOnMaxIterations）。
   *
   * 与正常迭代的区别只有两点：追加一条「停止探索、输出报告」的指令，
   * 以及**不提供任何工具**（schemas 传空）。这样模型没有可调用的工具，
   * 只能把已经读到的内容写成正文；正文会像正常轮次一样产出
   * ASSISTANT_MESSAGE，explore 据此取到报告。
   *
   * 收尾轮失败不改变结束状态：已流出的正文照样交给调用方，比直接丢弃好。
   */
  private async *_finalizeAtLimit(iterations: number): AsyncGenerator<WsEvent> {
    this._finalized = true;
    this.messages.push({
      role: "user",
      content: FINALIZE_ON_LIMIT_PROMPT,
      ts: Date.now(),
      taskId: this.taskId,
    });

    const reqId = `llm_final_${Date.now()}_${genReqId()}`;
    const logTime = new Date().toISOString();
    let streamed = "";
    let streamedThinking = "";
    let usage: AssistantTurn["usage"] = null;

    const llmReqData = {
      reqId,
      taskId: this.taskId,
      logTime,
      model: this.model,
      msgCount: this._outboundMessages().length,
      toolCount: 0,
      finalize: true,
    };
    this._emitHook((h) => h.onEvent?.(EventType.LLM_REQUEST, llmReqData));
    yield { type: EventType.LLM_REQUEST, data: llmReqData };

    try {
      this._llmAbort = new AbortController();
      if (this._cancel) this._llmAbort.abort();
      const chunks = await this.provider.stream(
        this.model,
        this._outboundMessages(),
        [],
        {
          reqId,
          logTime,
          reasoningEffort: this._reasoningEffort,
          signal: this._llmAbort.signal,
        },
      );
      for await (const chunk of chunks) {
        if (this._cancel) break;
        if (chunk.content) {
          streamed += chunk.content;
          this._emitHook((h) => h.onAssistantDelta?.(chunk.content!));
          yield {
            type: EventType.ASSISTANT_DELTA,
            data: { text: chunk.content, reqId, taskId: this.taskId },
          };
        }
        if (chunk.reasoning) streamedThinking += chunk.reasoning;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch {
      // 收尾轮失败（网络 / 溢出）：下面的 TURN_END 仍按上限结束，不额外报错
    }

    if (streamed) {
      this.messages.push(
        assistantMessage(
          {
            text: streamed,
            toolCalls: [],
            finishReason: "stop",
            reasoning: streamedThinking || null,
            usage,
          },
          this.model,
          this.taskId,
        ),
      );
      this._emitHook((h) =>
        h.onAssistantMessage?.(streamed, [], usage ?? undefined),
      );
      yield {
        type: EventType.ASSISTANT_MESSAGE,
        data: {
          text: streamed,
          reasoning: streamedThinking || null,
          tool_calls: [],
          ...(usage ? { usage: { model: this.model, ...usage } } : {}),
          reqId,
          taskId: this.taskId,
          logTime,
          finalized: true,
        },
      };
    }

    const files = this._buildProducedFiles();
    // 状态仍是 max_iterations_exceeded（如实反映「被上限截断」），
    // finalized 表示报告已由收尾轮补全。
    yield {
      type: EventType.TURN_END,
      data: {
        taskId: this.taskId,
        status: "max_iterations_exceeded",
        iterations,
        produced_files: files,
        finalized: true,
      },
    };
    this._emitHook((h) =>
      h.onTurnEnd?.("max_iterations_exceeded", iterations, files),
    );
  }

  // ===================== 工具执行 =====================

  /**
   * 处理一轮迭代中的全部工具调用
   *
   * 分两个阶段：
   *   A. 逐个授权：对每个调用做权限评估；需要审批时产出
   *      PERMISSION_REQUIRED 事件并调用 approver；被拒/未知工具
   *      直接产出错误结果，不进入执行。
   *   B. 分类执行：低风险工具并发执行（Promise.all），其余串行；
   *      交互类工具（ask_user / propose_plan / request_directory）虽然
   *      风险级别为 low，但需要用户逐条作答，一律串行；
   *      每个结果都转成 tool 消息追加到历史并产出 TOOL_FINISHED。
   */
  private async *_handleToolCalls(
    toolCalls: ToolCall[],
  ): AsyncGenerator<WsEvent> {
    // 本轮工具执行的中止句柄：中断时由 requestInterrupt() abort，
    // 传给工具后让其立即终止正在运行的子进程（run_shell）
    const abort = new AbortController();
    this._toolAbort = abort;
    if (this._cancel) abort.abort();

    // ---- 阶段 A：逐个授权 ----
    const cleared: ToolCall[] = [];

    for (const tc of toolCalls) {
      tc.id = tc.id || `tool_${Date.now()}_${genReqId()}`;
      if (this._cancel) {
        this.messages.push(toolErrorMessage(tc, "用户中断！", this.taskId));
        yield {
          type: EventType.TOOL_FINISHED,
          data: {
            reqId: tc.id,
            name: tc.name,
            status: "interrupted",
            reason: "stopped",
            taskId: this.taskId,
          },
        };
        continue;
      }

      yield {
        type: EventType.TOOL_PROPOSED,
        data: {
          reqId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          taskId: this.taskId,
        },
      };
      this._emitHook((h) =>
        h.onToolProposed?.(tc.name, tc.arguments as Record<string, unknown>),
      );

      // 用户交互工具：产出专用事件（外部可通过事件流感知，无需依赖全局 handler）
      if (tc.name === "ask_user") {
        const data = {
          taskId: this.taskId,
          question: tc.arguments["question"],
          options: (tc.arguments["options"] as string[]) ?? [],
          allowText: tc.arguments["allow_text"] !== false,
          multi: tc.arguments["multi"] === true,
        };
        this._emitHook((h) => h.onEvent?.(EventType.ASK_USER_QUESTION, data));
        yield { type: EventType.ASK_USER_QUESTION, data };
      } else if (tc.name === "propose_plan") {
        const data = { plan: tc.arguments["plan"] };
        this._emitHook((h) => h.onEvent?.(EventType.PLAN_PROPOSED, data));
        yield { type: EventType.PLAN_PROPOSED, data };
      } else if (tc.name === "request_directory") {
        const data = {
          reason: tc.arguments["reason"],
          path: tc.arguments["path"],
          writable: tc.arguments["writable"] === true,
        };
        this._emitHook((h) => h.onEvent?.(EventType.DIRECTORY_REQUESTED, data));
        yield { type: EventType.DIRECTORY_REQUESTED, data };
      }

      const spec = this.registry.get(tc.name);
      const decision = this.permissions.evaluate(
        tc.name,
        tc.arguments as Record<string, unknown>,
        spec?.metadata,
      );

      // 需要审批且存在 approver → 走审批流程
      if (!decision.allowed && decision.needsUser && this.approver) {
        this._emitHook((h) =>
          h.onPermissionRequired?.(tc.name, decision.reason),
        );
        yield {
          type: EventType.PERMISSION_REQUIRED,
          data: {
            taskId: this.taskId,
            reqId: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            reason: decision.reason,
            category: spec?.metadata.category ?? "",
          },
        };

        const outcome = await this.approver({
          toolName: tc.name,
          arguments: tc.arguments as Record<string, unknown>,
          metadata: spec?.metadata ?? null,
          reason: decision.reason,
          toolCallId: tc.id,
        });

        if (outcome === ApprovalOutcome.DENY) {
          this.messages.push(
            toolErrorMessage(
              tc,
              this._cancel ? "用户中断" : "用户拒绝",
              this.taskId,
            ),
          );
          yield {
            type: EventType.TOOL_FINISHED,
            data: {
              taskId: this.taskId,
              reqId: tc.id,
              name: tc.name,
              status: "denied",
              reason: this._cancel ? "stopped" : "denied",
            },
          };
          continue;
        }
        // 用户选择「总是允许」→ 记入会话白名单
        if (outcome === ApprovalOutcome.ALWAYS_TOOL) {
          this.permissions.allowToolForSession(tc.name);
        }
        if (outcome === ApprovalOutcome.ALWAYS_COMMAND) {
          this.permissions.allowCommandForSession(
            String(tc.arguments["command"] ?? ""),
          );
        }
        cleared.push(tc);
        continue;
      }

      // 被权限引擎直接拒绝（无需审批）
      if (!decision.allowed) {
        this.messages.push(toolErrorMessage(tc, decision.reason, this.taskId));
        yield {
          type: EventType.TOOL_FINISHED,
          data: {
            taskId: this.taskId,
            reqId: tc.id,
            name: tc.name,
            status: "denied",
            reason: decision.reason,
          },
        };
        continue;
      }

      // 工具未注册
      if (!spec) {
        this.messages.push(
          toolErrorMessage(tc, `unknown tool: ${tc.name}`, this.taskId),
        );
        yield {
          type: EventType.TOOL_FINISHED,
          data: {
            taskId: this.taskId,
            reqId: tc.id,
            name: tc.name,
            status: "error",
            reason: "unknown tool",
          },
        };
        continue;
      }

      cleared.push(tc);
    }

    // ---- 阶段 B：分类执行 ----
    // 低风险 = 并发；高风险 = 串行
    const concurrent = cleared.filter((tc) => {
      const spec = this.registry.get(tc.name);
      return (
        spec?.metadata.riskLevel === "low" &&
        !spec.metadata.requiresApproval &&
        !INTERACTIVE_TOOLS.has(tc.name)
      );
    });

    const serial = cleared.filter((tc) => !concurrent.includes(tc));

    // 并发组：先全部产出 TOOL_STARTED，再 Promise.all 并行执行
    if (concurrent.length > 0) {
      for (const tc of concurrent) {
        yield {
          type: EventType.TOOL_STARTED,
          data: { reqId: tc.id, name: tc.name, taskId: this.taskId },
        };
        this._emitHook((h) => h.onToolStarted?.(tc.name));
      }
      const results = await Promise.all(
        concurrent.map(async (tc) => {
          try {
            let result = this.registry.execute(
              tc.name,
              tc.arguments as Record<string, unknown>,
              { signal: abort.signal },
            );
            if (result instanceof Promise) result = await result;
            return { result, status: "ok" as const };
          } catch (exc) {
            return {
              result: {
                error: String(exc),
                error_type:
                  exc instanceof Error ? exc.constructor.name : "unknown",
              },
              status: "error" as const,
            };
          }
        }),
      );
      for (let i = 0; i < concurrent.length; i++) {
        const tc = concurrent[i];
        const { result, status } = results[i];
        this.messages.push(
          toolResultMessage(tc, result, this.taskId, this._toolResultDir),
        );
        this._trackProducedFile(
          tc,
          result as string | Record<string, unknown>,
          status,
        );
        this._emitHook((h) =>
          h.onToolFinished?.(
            tc.name,
            status,
            preview(result as string | Record<string, unknown>),
          ),
        );
        yield {
          type: EventType.TOOL_FINISHED,
          data: {
            taskId: this.taskId,
            reqId: tc.id,
            name: tc.name,
            status,
            result_preview: preview(result),
          },
        };
      }
    }

    // 串行组：逐个执行（执行前检查中断）
    for (const tc of serial) {
      if (this._cancel) {
        this.messages.push(toolErrorMessage(tc, "用户中断！", this.taskId));
        yield {
          type: EventType.TOOL_FINISHED,
          data: {
            taskId: this.taskId,
            reqId: tc.id,
            name: tc.name,
            status: "interrupted",
            reason: "stopped",
          },
        };
        continue;
      }
      const startTime = Date.now();
      yield {
        type: EventType.TOOL_STARTED,
        data: { taskId: this.taskId, reqId: tc.id, name: tc.name, startTime },
      };
      this._emitHook((h) => h.onToolStarted?.(tc.name));

      let result: unknown;
      let status: "ok" | "error";
      try {
        result = this.registry.execute(
          tc.name,
          tc.arguments as Record<string, unknown>,
          { signal: abort.signal },
        );
        if (result instanceof Promise) result = await result;
        status = "ok";
      } catch (exc) {
        result = {
          error: String(exc),
          error_type: exc instanceof Error ? exc.constructor.name : "unknown",
        };
        status = "error";
      }
      this.messages.push(
          toolResultMessage(tc, result, this.taskId, this._toolResultDir),
        );
      this._trackProducedFile(
        tc,
        result as string | Record<string, unknown>,
        status,
      );
      this._emitHook((h) =>
        h.onToolFinished?.(
          tc.name,
          status,
          preview(result as string | Record<string, unknown>),
        ),
      );
      yield {
        type: EventType.TOOL_FINISHED,
        data: {
          taskId: this.taskId,
          reqId: tc.id,
          name: tc.name,
          status,
          // 耗时, 毫秒
          duration: Date.now() - startTime,
          result_preview: preview(result),
        },
      };
    }

    if (this._toolAbort === abort) this._toolAbort = null;
  }

  // ===================== 辅助方法 =====================

  /**
   * 构建发送给模型的 outbound view
   *
   * 过滤 notice 消息；tool 消息只保留必要字段；
   * 其余消息剥离 display-only sidecar 字段（source/_display/ts/
   * reasoning/usage），避免污染模型上下文。
   *
   * 达到软阈值时先淘汰旧工具结果（零 LLM 成本），再产出最终视图。
   */
  private _outboundMessages(): Message[] {
    // 应用压缩（outbound-only，不修改持久化历史）
    const base = compaction.applyToOutbound(this.messages, this.compactionState);
    // 重复读取同一文件时，旧结果已被后续读取覆盖，直接替换（信息无损）
    const deduped = this._dedupEnabled
      ? compaction.applyReadFileDedup(base).messages
      : base;
    let view = this._finalizeOutbound(deduped);

    if (!this._elisionEnabled) return view;
    // 用最终视图估算水位：reasoning 等字段发送前会被剥离，按 base 估算会高估
    if (compaction.estimateTokens(view) < this._softTriggerTokens()) {
      return view;
    }

    // 1) 优先淘汰旧 git_diff：一次性消费、价值衰减最快，先让出空间
    const oneShot = compaction.applyOneShotElision(deduped);
    if (oneShot.freedChars > 0) {
      view = this._finalizeOutbound(oneShot.messages);
      if (compaction.estimateTokens(view) < this._softTriggerTokens()) {
        return view;
      }
    }

    // 2) 仍超软阈值：按保留预算淘汰其余旧工具结果
    //    （淘汰需要 tool_call_name，finalize 时已丢弃，因此基于未 finalize 的视图）
    const keepChars = compaction.elisionKeepChars(
      compaction.triggerTokens(
        this._getContextWindow(),
        this._thresholdPct,
        this._capTokens,
      ),
    );
    const elided = compaction.applyToolResultElision(
      oneShot.messages,
      keepChars,
    );
    if (elided.freedChars === 0) return view;
    return this._finalizeOutbound(elided.messages);
  }

  /** 过滤 notice + 剥离 display-only 字段，得到最终发送视图 */
  private _finalizeOutbound(sourceMessages: Message[]): Message[] {
    // display-only sidecar 字段 (发送给模型前剥离)
    const _STRIP = new Set(["source", "_display", "ts", "reasoning", "usage", "attachmentRefs"]);

    return sourceMessages
      .filter((m) => m.role !== "notice")
      .map((m) => {
        // tool 消息：只保留 role, tool_call_id, content
        if (m.role === "tool") {
          return {
            role: "tool" as const,
            tool_call_id: m.tool_call_id ?? "",
            content: m.content,
          };
        }
        // 附件只随产生它的那一轮发送：历史轮次的附件（ts 早于本轮开始）一律剥离。
        // 否则每轮都会把同一张图重新计费，且与「附件不落盘」的语义不一致。
        const staleAttachments =
          Boolean(m.attachments?.length) && (m.ts ?? 0) < this._turnStartTime;
        // assistant/user/system 消息：只剥离 sidecar 字段，保留 tool_calls
        const stripped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(m)) {
          if (staleAttachments && k === "attachments") continue;
          if (!_STRIP.has(k)) {
            stripped[k] = v;
          }
        }
        return stripped as unknown as Message;
      });
  }

  /** 软阈值（token 数）：达到它只淘汰旧工具结果 */
  private _softTriggerTokens(): number {
    return compaction.softTriggerTokens(
      this._getContextWindow(),
      this._thresholdPct,
      this._capTokens,
      this._softThresholdPct,
    );
  }

  /** 通知消息：仅用于日志/展示，不发给模型 */
  private _appendNotice(
    kind: "error" | "interrupted" | "compacted" | "model_switch" | "retry",
    text?: string,
  ): void {
    this.messages.push({
      role: "notice",
      kind,
      text,
      content: text ?? "",
      ts: Date.now(),
      taskId: this.taskId,
    });
  }

  /**
   * 安全调用 hook 回调
   *
   * hook 由调用方注入（控制台打印/日志/广播等），其内部异常
   * 不应影响引擎核心逻辑——统一在此捕获并降级为警告。
   */
  private _emitHook(call: (h: EngineHook) => void): void {
    if (!this._hook) return;
    try {
      call(this._hook);
    } catch (exc) {
      console.warn(`[TurnEngine] hook 异常已忽略: ${exc}`);
    }
  }

  /**
   * 历史末尾是否是可重试的错误
   *
   * 从末尾往前扫描：跳过 model_switch 通知；一旦遇到非 notice
   * 消息即停止；只有末尾全部是 error 通知才返回 true。
   */
  private _tailIsRetriableError(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "notice") return false;
      if (m.kind === "model_switch") continue;
      return m.kind === "error";
    }
    return false;
  }

  // ===================== 自动压缩 =====================

  /**
   * 当前上下文 token 用量。
   *
   * API 返回的 `usage.input` 是精确值，但反映的是「上一次请求」——工具结果
   * 与淘汰/压缩都会让它过时。因此同时估算当前 outbound 视图，取较大者：
   * 宁可早一点压缩，也不要漏判导致溢出。
   */
  private _compactionTokens(): { tokens: number; estimated: boolean } {
    const estimated = compaction.estimateTokens(this._outboundMessages());
    if (this._lastContextTokens == null) {
      return { tokens: estimated, estimated: true };
    }
    if (estimated > this._lastContextTokens) {
      return { tokens: estimated, estimated: true };
    }
    return { tokens: this._lastContextTokens, estimated: false };
  }

  /** 压缩后重置精确计数：后续按估算值判断 */
  private _resetContextTokens(): void {
    this._lastContextTokens = null;
  }

  /** 当前 outbound 视图的估算 token 数 */
  private _estimateContextTokens(): number {
    return compaction.estimateTokens(this._outboundMessages());
  }

  /** 检查是否需要压缩（每轮 LLM 调用前） */
  private _compactionDue(): boolean {
    // 上一轮压缩没能把水位降下来：等历史继续增长再试，避免每轮空转
    if (
      this._compactStalledAt >= 0 &&
      this.messages.length < this._compactStalledAt + COMPACT_STALL_RETRY_DELTA
    ) {
      return false;
    }
    const { tokens } = this._compactionTokens();
    return compaction.shouldCompact(
      tokens,
      this._getContextWindow(),
      this._thresholdPct,
      this._capTokens,
    );
  }

  /** 组装压缩开始时的用量信息（供 hook 与 COMPACTING 事件携带） */
  private _compactionStartInfo(trigger: CompactionTrigger): CompactionStartInfo {
    const { tokens, estimated } = this._compactionTokens();
    const contextWindow = this._getContextWindow();
    return {
      trigger,
      tokens,
      estimated,
      contextWindow,
      thresholdPct: this._thresholdPct,
      thresholdTokens: compaction.triggerTokens(
        contextWindow,
        this._thresholdPct,
        this._capTokens,
      ),
      outboundMessages: this._outboundMessages().length,
    };
  }

  /** 组装压缩结果信息（供 hook 与 COMPACTED 事件携带） */
  private _compactionDoneInfo(result: CompactResult): CompactionDoneInfo {
    return {
      method: result.method === "trimmed" ? "trimmed" : "summarized",
      messagesBefore: result.messagesBefore ?? 0,
      messagesAfter: result.messagesAfter ?? 0,
      ...(result.modelUsed ? { model: result.modelUsed } : {}),
      ...(result.keptUserMessages !== undefined
        ? { keptUserMessages: result.keptUserMessages }
        : {}),
      ...(result.droppedUserMessages !== undefined
        ? { droppedUserMessages: result.droppedUserMessages }
        : {}),
    };
  }

  /** 获取当前模型的上下文窗口大小（token 数）。优先级：显式配置 > 自动检测 > 默认值 128K。 */
  private _getContextWindow(): number {
    if (this._contextWindow !== undefined) return this._contextWindow;
    return compaction.lookupContextWindow(this.model);
  }

  /** 执行压缩策略（对齐 Python 版 _compact_now） */
  private async _compactNow(
    reqId: string,
    force = false,
  ): Promise<CompactResult> {
    const contextWindow = this._getContextWindow();
    const messagesBefore = this._outboundMessages().length;
    const trigger = compaction.triggerTokens(
      contextWindow,
      this._thresholdPct,
      this._capTokens,
    );
    // 收敛目标：溢出时压到半水位；常规压缩留 10% 余量，避免贴着阈值反复触发
    const target = Math.floor(
      trigger * (force ? OVERFLOW_TARGET_RATIO : 0.9),
    );
    // 摘要用到独立模型时可用 COMPACTION_MODEL 指定（如更便宜的小模型）
    const model = process.env.COMPACTION_MODEL?.trim() || this.model;
    const reasoningEffort = compaction.summarizerReasoningEffort();

    // 每轮压低保留量：尾部单条消息可能就超过 keep，必须逐步收缩才能推进边界
    let keep = Math.floor(compaction.KEEP_RECENT_FRACTION * trigger);
    let method: "summarized" | "trimmed" | null = null;
    let lastState: CompactionState | null = null;
    let progressed = false;

    for (let round = 0; round < MAX_COMPACT_ROUNDS; round++) {
      // 第一轮无条件执行（触发者已判定超阈值）；后续轮先看是否已收敛
      if (round > 0 && this._estimateContextTokens() <= target) break;

      // 尝试 LLM 摘要（最多 2 次）
      let state: CompactionState | null = null;
      for (let attempt = 0; attempt < 2 && !state; attempt++) {
        try {
          const logTime = new Date().toISOString();
          state = await compaction.buildState(
            this.messages,
            this.provider,
            model,
            keep,
            this.compactionState,
            { reqId, logTime, reasoningEffort },
          );
        } catch {
          /* 下一次尝试；仍失败则走裁剪降级 */
        }
      }

      if (state) {
        this.compactionState = state;
        lastState = state;
        method = "summarized";
        progressed = true;
      } else {
        // 摘要不可用 → 裁剪降级（溢出时一次让出 50%）
        const trimmed = compaction.trimState(
          this.messages,
          this.compactionState,
          force ? OVERFLOW_TRIM_FRACTION : 0.25,
        );
        if (!trimmed) break;
        this.compactionState = trimmed;
        lastState = trimmed;
        method = "trimmed";
        progressed = true;
      }

      this._resetContextTokens();

      // 已回到阈值以下就收敛
      if (this._estimateContextTokens() <= trigger) break;
      // 仍然超限：降低保留量再压一轮
      keep = Math.max(Math.floor(trigger * 0.05), Math.floor(keep / 2));
    }

    // 没有任何可压缩空间（历史还太短、尾部尚未形成边界）：
    // 这是正常状态，不做冷却——消息继续增长后下一轮自然会可压
    if (!progressed || !lastState) return { notice: null, method: null };

    // 压不动了 → 冷却，避免每轮重新进入压缩（后续真溢出由 overflow 路径兜底）
    this._compactStalledAt =
      this._estimateContextTokens() >= trigger ? this.messages.length : -1;

    const messagesAfter = this._outboundMessages().length;
    const common = {
      boundaryIndex: lastState.boundaryIndex,
      messagesBefore,
      messagesAfter,
    };

    if (method === "summarized") {
      return {
        notice: "上下文已压缩 — 早期轮次已摘要",
        method: "summarized",
        modelUsed: lastState.modelUsed,
        summaryPreview: lastState.summaryText.slice(0, 200),
        keptUserMessages: lastState.userMessages.length,
        droppedUserMessages: lastState.userMessagesDropped,
        ...common,
      };
    }

    return {
      notice: "上下文已裁剪 — 最旧的轮次已丢弃（摘要不可用）",
      method: "trimmed",
      ...common,
    };
  }

  /** 追踪文件写入工具成功产生的文件 */
  private _trackProducedFile(
    tc: ToolCall,
    result: string | Record<string, unknown>,
    status: string,
  ): void {
    if (status !== "ok" || !TurnEngine.FILE_WRITE_TOOLS.has(tc.name)) return;

    // write_file 返回相对路径字符串
    if (typeof result === "string" && result) {
      this._producedFiles.push(result);
      return;
    }

    // replace_in_file/apply_patch/apply_unified_diff 返回 { path, changed_files } 等
    if (result && typeof result === "object") {
      const path = (result as Record<string, unknown>).path as
        string | undefined;
      if (path) {
        this._producedFiles.push(path);
        return;
      }
      const changed = (result as Record<string, unknown>).changed_files as
        string[] | undefined;
      if (changed) this._producedFiles.push(...changed);
    }
  }

  /** 合并精确追踪和文件系统扫描的产出文件，去重并剔除已被删除的文件 */
  private _buildProducedFiles(): string[] {
    const scanned = this._scanRecentFiles();
    const ws = this.permissions.workspaceRoot;
    const merged = new Set([...this._producedFiles, ...scanned]);
    const files: string[] = [];
    for (const f of merged) {
      if (files.length >= 50) break;
      // AI 可能在执行过程中删除自己产生的临时脚本等，剔除已不存在的文件
      if (!this._fileExists(f, ws)) continue;
      files.push(f);
    }
    return files;
  }

  /** 检查产出文件是否仍存在；相对路径基于 workspaceRoot 解析 */
  private _fileExists(f: string, ws: string | undefined): boolean {
    // 无法解析相对路径时保守保留（不误删）
    if (!ws && !_path.isAbsolute(f)) return true;
    try {
      return fs.existsSync(_path.isAbsolute(f) ? f : _path.join(ws!, f));
    } catch {
      return false;
    }
  }

  /** 兜底扫描：查找工作区中本轮修改过的文件（捕获 shell 命令产生的文件） */
  private _scanRecentFiles(): string[] {
    const ws = this.permissions.workspaceRoot;
    if (!ws) return [];

    const results: string[] = [];
    const since = this._turnStartTime - 1000; // 1 秒容差

    // 忽略的文件
    const skip = new Set([
      "node_modules",
      "target",
      "dist",
      "__pycache__",
      ".git",
    ]);

    try {
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || results.length >= 50) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const e of entries) {
          if (results.length >= 50) return;
          if (e.name.startsWith(".") || skip.has(e.name)) continue; // 忽略

          const full = _path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else if (e.isFile()) {
            const dotIdx = e.name.lastIndexOf(".");
            const ext = dotIdx !== -1 ? e.name.slice(dotIdx).toLowerCase() : "";
            if (!TurnEngine.SCAN_SUFFIXES.has(ext)) continue;

            try {
              const st = fs.statSync(full);
              if (st.mtimeMs >= since) {
                results.push(
                  _path.relative(_path.resolve(ws), _path.resolve(full)),
                );
              }
            } catch (e) {
              console.error(e);
            }
          }
        }
      };

      walk(ws, 0);
    } catch (e) {
      /* workspace scan is best-effort */
      console.error(e);
    }

    return results;
  }
}
