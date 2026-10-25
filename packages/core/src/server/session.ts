/**
 * SessionManager — 会话生命周期与云端编排核心
 *
 * 模型：会话 = 磁盘上的物化状态（SessionRecord）+ 内存中可回收的 run 任务。
 *
 *   - 提交 turn → 装配引擎 → drive(engine.run(input)) 后台消费事件流
 *   - 引擎遇到审批/提问 → 挂起式 approver/handler 返回未决 Promise，
 *     run 任务停在内存，同时全量状态落盘（含未回答的 assistant tool_calls）
 *   - 用户回答 → 有挂起 Promise 则原地 resolve（瞬时继续）；
 *     否则走 engine.resume() 精确重放未执行的 tool call 后继续
 *   - 长时间未回答 → 回收内存 run 任务（释放引用交给 GC），
 *     磁盘保持 pending，之后回答仍可通过 resume() 恢复 —— 进程重启同理
 */
import * as path from "path";
import { AsyncLocalStorage } from "async_hooks";
import type { ServerResponse } from "http";
import { TurnEngine } from "../engine/TurnEngine.js";
import {
  DEFAULT_MAX_ITERATIONS,
  parseMaxIterations,
  parseOptionalPositiveNumber,
  parseRatio,
} from "../engine/limits.js";
import {
  EventType,
  type WsEvent,
  type Approver,
  ApprovalOutcome,
  type EngineHook,
} from "../engine/events.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { McpManager } from "../mcp/McpManager.js";
import { loadServerMcpConfigs } from "./mcpConfig.js";
import { PermissionEngine, Mode } from "../permissions/PermissionEngine.js";
import { OpenAIProvider } from "../providers/OpenAIProvider.js";
import { buildInstructions } from "../prompts/index.js";
import { registerFileTools } from "../tools/files.js";
import { ConflictGuard } from "../tools/conflictGuard.js";
import { SessionVcs, resolveVcsPlan, VcsHook } from "../vcs/index.js";
import type { TurnCommit, RestoreResult } from "../vcs/index.js";
import { getShellCwd, registerShellTool } from "../tools/shell.js";
import { resolveSandbox } from "../tools/sandbox.js";
import { registerSearchTool } from "../tools/search.js";
import { registerWebTools } from "../tools/web.js";
import { registerGitTools } from "../tools/git.js";
import { registerDiffTools } from "../tools/diff.js";
import { registerAskTool } from "../tools/ask.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerDirectoryTool } from "../tools/directories.js";
import { registerTodoTool, TodoList } from "../tools/todo.js";
import { registerExploreTool } from "../tools/explore.js";
import { registerMediaTool } from "../tools/media.js";
import { Store, newId } from "./store.js";
import { findNodeProvider, modelContextWindow, resolveSessionProvider } from "./nodeLlm.js";
import { healBuiltinOnAuthFailure } from "./builtinLlm.js";
import { modelCapabilities } from "../providers/models.js";
import {
  MAX_ATTACHMENTS,
  readStoredAttachment,
  saveAttachments,
  stripAttachments,
  type MessageAttachment,
  type StoredAttachment,
} from "../engine/attachments.js";
import {
  CAPABILITY_LABELS_ZH,
  capabilityOfMime,
} from "@zqagent/shared/model-capabilities";
import { UsageLedger, resolveVendor, type TokenCounts } from "./usage.js";
import {
  shouldAutoName,
  sanitizeSessionName,
  type SessionNameSource,
} from "../engine/sessionNaming.js";
import type { ProviderClient } from "../providers/OpenAIProvider.js";
import type { ReasoningEffort } from "../engine/types.js";
import {
  SESSION_STATUS_DELETED,
  type ApprovalRecord,
  type EventEntry,
  type NotifyEvent,
  type NotifyKind,
  type PendingApproval,
  type PendingQuestion,
  type QuestionRecord,
  type SessionRecord,
  type SessionTurnIndexEntry,
  type SessionTurnInput,
  type SessionUsage,
  type SessionStatus,
  type TenantConfig,
} from "./types.js";
import { dbgMs, dbgNow } from "./dbgTrace.js"; // [dbg] 临时调试，定位后可删

/** 运行中的会话上下文（供模块级交互 handler 分派到所属会话） */
export const sessionContext = new AsyncLocalStorage<string>();

/** 内存事件缓冲上限（超出丢弃最旧，全量在 events.jsonl） */
const EVENT_BUFFER_MAX = 2000;
/**
 * 流式 delta 的合并窗口（毫秒）。
 *
 * 模型逐 token 产出时，每个 delta 原本各占一条事件：一次几百 token 的回复
 * 会产生几百条 SSE 帧、几百次异步写盘，并让浏览器对每条都做一次全量重渲染
 * （长会话下会卡住输入框）。这里把同一窗口内同类 delta 拼成一条。
 *
 * 0 = 关闭合并（逐条发出），排查渲染/顺序问题时用。
 */
const DELTA_FLUSH_MS = (() => {
  const raw = process.env.SESSION_DELTA_FLUSH_MS;
  if (raw === undefined || raw === "") return 16;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 16;
})();
/**
 * get_events 回执的字节预算。
 *
 * 该回执经 MQTT/WS 单包传输（EMQX max_packet_size 默认 1MB），历史过大时
 * 整包会被 broker 以 frame_too_large 终止连接（节点侧表现为 write EPIPE 刷屏）。
 * 这里按字节预算只回传「最近的」事件；更早历史仍在 events.jsonl，仅 UI 无需渲染。
 */
const EVENTS_ACK_MAX_BYTES = 512 * 1024;
/** 审批/提问挂起超时（毫秒），超时后回收内存 run 任务 */
const APPROVAL_TIMEOUT_MS = (Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 15 * 60) * 1000;
/** 总览列表展示的用户消息长度上限（超出截断，避免通知/快照体积膨胀） */
export const LAST_USER_MESSAGE_MAX = 200;

/** 轮次索引里单条用户消息 / 回复预览的截断长度（正文点开再取） */
const TURN_TEXT_MAX = 500;
/** 取「本轮最终回复」时的字节预算（回复通常紧邻 turn_end，256KB 足够） */
const TURN_REPLY_MAX_BYTES = 256 * 1024;
/** 单轮回复正文的回执上限（避免 MQTT 单包过大） */
const TURN_REPLY_MAX_TEXT = 256 * 1024;
/** 轮次汇总单次默认返回条数 */
const TURNS_DEFAULT_LIMIT = 20;

/** 会话详情里的一轮（轻量：不含事件正文） */
export interface SessionTurnSummary {
  /** 本轮 turn_start 的 seq（点开该轮时用它定位事件区间） */
  startSeq: number;
  /** 本轮最后一条事件的 seq */
  endSeq: number;
  startedAt: string;
  /** 未结束时为 null */
  endedAt: string | null;
  /** running / completed / error / interrupted */
  status: string;
  /** 用户输入（截断；完整内容在该轮详情里） */
  input: string;
  /** 最后一次助手回复（截断） */
  reply: string;
  /** 本轮 LLM 调用次数 */
  llmCalls: number;
  /** 本轮工具调用次数（按 reqId 去重） */
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** 引擎上报的迭代次数（turn_end） */
  iterations?: number;
  durationMs?: number;
  error?: string;
  /** 本轮的用户消息（含运行中补充），按时间升序 */
  inputs?: SessionTurnInput[];
  /** 用户消息条数（turn_start + 补充消息） */
  userCount?: number;
  /** 最后一条非空 assistant_message 的 seq（取完整回复用） */
  replySeq?: number;
  /** 本轮产出文件（来自 turn_end.data.produced_files） */
  producedFiles?: string[];
}

/** 轮次列表回执 */
export interface SessionTurnsPage {
  turns: SessionTurnSummary[];
  /** 更早是否还有轮次 */
  hasMore: boolean;
  /** 本页最早一轮的 startSeq */
  earliestSeq: number;
  /** 会话总轮次（不受分页影响） */
  total: number;
  /** 用户消息总数（含补充消息） */
  userTotal: number;
}

/** 一轮的用户消息 + 最终回复（点开某一轮时按需取） */
export interface SessionTurnReply {
  startSeq: number;
  endSeq: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  /** 本轮全部用户消息（含补充） */
  userMessages: SessionTurnInput[];
  /** 最终回复正文；本轮没有文本回复时为 null */
  reply: { seq: number; ts: string; text: string } | null;
  /** 回复正文超出回执上限被截断 */
  truncated: boolean;
  /** 本轮产出文件 */
  producedFiles: string[];
}

function clip(text: string, max = LAST_USER_MESSAGE_MAX): string {
  const s = text ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 事件里的附件引用（`turn_start` / `queue_steering` 的 data.attachments）。
 *
 * 旧版本节点没有这个字段、或事件被手工改坏时退回空数组，不让索引构建失败。
 */
function asStoredAttachments(v: unknown): StoredAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: StoredAttachment[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const p = String(rec.path ?? "").trim();
    const mimeType = String(rec.mimeType ?? "").trim();
    if (!p || !mimeType) continue;
    out.push({
      name: String(rec.name ?? "").trim() || "附件",
      mimeType,
      size: asNum(rec.size),
      path: p,
    });
  }
  return out;
}

/** 开一轮：turn_start → 索引记录（running 版本，收轮时再补终态） */
function newTurnEntry(ev: EventEntry, input: string): SessionTurnIndexEntry {
  const attachments = asStoredAttachments(ev.data?.["attachments"]);
  return {
    v: 1,
    startSeq: ev.seq,
    endSeq: ev.seq,
    startedAt: ev.ts,
    endedAt: null,
    status: "running",
    inputs: [
      {
        seq: ev.seq,
        ts: ev.ts,
        text: clip(input, TURN_TEXT_MAX),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    ],
    replyPreview: "",
    producedFiles: [],
    llmCalls: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
}

/**
 * 把一条事件累加进当前轮。
 *
 * 索引与「轮次汇总」共用这一处口径：LLM 调用按 assistant_message 计、
 * 工具按 reqId 去重、token 取 usage.input/output。delta 类事件只推进 endSeq，
 * 不参与统计（否则索引行数会随 delta 爆炸）。
 */
function applyTurnEvent(
  turn: SessionTurnIndexEntry,
  ev: EventEntry,
  toolSeen: Set<string>,
): void {
  const d = ev.data ?? {};
  turn.endSeq = ev.seq;
  switch (ev.type) {
    case "queue_steering": {
      // 运行中补充信息也算一条用户消息
      const attachments = asStoredAttachments(d["attachments"]);
      turn.inputs.push({
        seq: ev.seq,
        ts: ev.ts,
        text: clip(String(d["text"] ?? ""), TURN_TEXT_MAX),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      break;
    }
    case "assistant_message": {
      turn.llmCalls += 1;
      const text = String(d["text"] ?? "");
      if (text) {
        turn.replyPreview = clip(text);
        turn.replySeq = ev.seq;
      }
      const u = d["usage"];
      if (u && typeof u === "object") {
        const usage = u as Record<string, unknown>;
        turn.tokensIn += asNum(usage["input"]);
        turn.tokensOut += asNum(usage["output"]);
      }
      break;
    }
    case "tool_started":
    case "tool_finished": {
      // 与 buildSessionStats 一致：按 reqId 去重（缺失时用 name:seq 兜底）
      const key = String(d["reqId"] ?? "") || `${String(d["name"] ?? "")}:${ev.seq}`;
      if (!toolSeen.has(key)) {
        toolSeen.add(key);
        turn.toolCalls += 1;
      }
      break;
    }
    case "error": {
      turn.error = clip(String(d["message"] ?? d["error"] ?? ""));
      break;
    }
    default:
      break;
  }
}

/** 收轮：补齐终态（turn_end / interrupted 同口径） */
function closeTurnEntry(turn: SessionTurnIndexEntry, ev: EventEntry): void {
  const d = ev.data ?? {};
  turn.endSeq = ev.seq;
  turn.endedAt = ev.ts;
  const status = String(d["status"] ?? "");
  turn.status =
    ev.type === "interrupted" ? status || "interrupted" : status || "completed";
  const files = d["produced_files"];
  if (Array.isArray(files)) {
    turn.producedFiles = files.map((x) => String(x ?? "")).filter(Boolean);
  }
  if (typeof d["iterations"] === "number") turn.iterations = d["iterations"];
  const startMs = Date.parse(turn.startedAt);
  const endMs = Date.parse(ev.ts);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    turn.durationMs = endMs - startMs;
  }
}

/**
 * 事件流 → 轮次索引（升序）。
 *
 * 与旧的「从文件尾部反向扫」相比，这里是一次顺序扫描，结果落成 turns.ndjson；
 * 老会话首次访问时重建一次，之后列表读取与事件量无关。
 */
function buildTurnIndex(events: EventEntry[]): SessionTurnIndexEntry[] {
  const out: SessionTurnIndexEntry[] = [];
  let cur: SessionTurnIndexEntry | null = null;
  let toolSeen = new Set<string>();
  for (const ev of events) {
    if (ev.type === "turn_start") {
      cur = newTurnEntry(ev, String(ev.data?.["input"] ?? ""));
      toolSeen = new Set();
      out.push(cur);
      continue;
    }
    if (!cur) continue; // 首个 turn_start 之前的事件（会话命名等）
    if (ev.type === "turn_end" || ev.type === "interrupted") {
      closeTurnEntry(cur, ev);
      cur = null;
      continue;
    }
    applyTurnEvent(cur, ev, toolSeen);
  }
  // 未闭合但有 error 的轮：沿用旧口径标记为 error（而非一直 running）
  for (const t of out) {
    if (!t.endedAt && t.error) t.status = "error";
  }
  return out;
}

/** 索引记录 → 对外汇总（保持旧字段兼容） */
function summaryFromEntry(t: SessionTurnIndexEntry): SessionTurnSummary {
  return {
    startSeq: t.startSeq,
    endSeq: t.endSeq,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    status: t.status,
    input: t.inputs[0]?.text ?? "",
    reply: t.replyPreview,
    llmCalls: t.llmCalls,
    toolCalls: t.toolCalls,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    iterations: t.iterations,
    durationMs: t.durationMs,
    error: t.error,
    inputs: t.inputs,
    userCount: t.inputs.length,
    replySeq: t.replySeq,
    producedFiles: t.producedFiles,
  };
}

/** 会话内存运行时状态 */
interface SessionRuntime {
  tenantId: string; // 租户 ID
  sessionId: string; // 会话 ID
  tenant: TenantConfig; // 配置
  workspace: string; // 会话工作目录（绝对路径）
  status: SessionStatus; // 运行状态
  engine: TurnEngine | null; // 引擎
  runTask: Promise<void> | null; // 引擎运行任务
  /** 引擎绑定的 MCP 管理器（引擎回收时关闭连接） */
  mcpManager?: McpManager;
  /** MCP 连接/工具注入完成信号（首个 turn 前需等待，确保工具进入 LLM 列表） */
  mcpReady?: Promise<unknown>;
  /** 审批记录（callId → record，含磁盘加载的） */
  approvals: Map<string, ApprovalRecord>;
  /** 提问记录（qid → record） */
  questions: Map<string, QuestionRecord>;
  /** 内存挂起的审批（可原地 resolve） */
  pendingApprovals: Map<string, PendingApproval>;
  /** 内存挂起的提问 */
  pendingQuestions: Map<string, PendingQuestion>;
  /** 会话级白名单（引擎回收后仍保留） */
  allowTools: Set<string>;
  allowCommands: Set<string>;
  events: EventEntry[];
  seq: number;
  subscribers: Set<ServerResponse>;
  heartbeats: Map<ServerResponse, NodeJS.Timeout>;
  /** 最近一次持久化的消息历史（引擎回收后 persist 用） */
  lastMessages: unknown[];
  lastModel: string; // 最后使用的模型
  modelOverridden: boolean; // 模型是否由用户显式指定
  /** 会话级 LLM 配置 id（节点级 LLM 中的项；缺省=项目配置/节点默认） */
  providerId?: string;
  /** 权限模式：plan / interactive / auto / discuss */
  permissionMode: string;
  /** 输入框草稿（未发送内容，随会话持久化） */
  draft?: string;
  /** 已提交、尚未注入当前任务的补充信息（steer）；仅内存，随 run 生命周期 */
  pendingSteers: string[];
  /** 本轮被第一条补充信息覆盖前的用户指令；撤销到空队列时还原 lastInput */
  steerBaseInput?: string;
  /** 最近一次用户指令（发送时立即写入并落盘，供列表展示） */
  lastInput?: string;
  /** 用量累计（账本口径） */
  usage?: SessionUsage;
  lastCompaction: Record<string, unknown> | null; // 最后一次执行结果
  /** 会话名（AI 自动生成或用户指定） */
  name?: string;
  /** 名称来源：auto=自动；user=用户手动（不再自动生成） */
  nameSource?: SessionNameSource;
  /** 已成功完成的任务数（用于第 1/3/5 次自动命名） */
  taskCount: number;
  /** 最近一次任务成功完成的时刻（ISO 8601；从未完成时缺省） */
  lastCompletedAt?: string;
  /** 最近一次任务请求的开始时刻（ISO 8601；从未发起时缺省） */
  lastStartedAt?: string;
  /** 命名请求进行中（避免并发重复命名） */
  naming: boolean;
  /** 当前 turn 开始时间（毫秒时间戳，0 表示未运行），用于计算执行时长 */
  turnStartedAt: number;
  /** 运行中轮次的索引记录（收轮后清空） */
  turnIndex?: SessionTurnIndexEntry;
  /** 当前轮已计入的工具调用键（reqId 去重） */
  turnToolKeys?: Set<string>;
  /**
   * 待合并的流式 delta（key = 类型 + reqId + taskId）。
   * 只在 DELTA_FLUSH_MS 窗口内存在，flush 后清空。
   */
  deltaBuffer?: Map<string, PendingDelta>;
  /** delta 合并窗口的定时器（同一时刻只有一个） */
  deltaTimer?: ReturnType<typeof setTimeout>;
}

/** 一个等待合并的 delta 桶 */
interface PendingDelta {
  type: string;
  reqId?: unknown;
  taskId?: unknown;
  text: string;
}

/** 可合并的流式增量事件类型 */
function isDeltaEvent(type: string): boolean {
  return type === EventType.ASSISTANT_DELTA || type === EventType.REASONING_DELTA;
}

/** 判断用户回答是否为「同意」（兼容 approve/yes/y/同意… 及控制台选项值） */
function isAffirmative(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return false;
  if (["y", "yes", "approve", "approved", "ok", "true", "a", "1"].includes(a)) return true;
  return /^(yes|approve|同意|批准|允许|确定|可以|好的|确认)/.test(a);
}

/** 创建一个 Promise，并返回一个原地 resolve 函数 */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>(); // sessionId → runtime
  /** 轮次索引的内存副本（运行中的轮比磁盘索引新；重启后为空） */
  private readonly turnIndexCache = new Map<string, SessionTurnIndexEntry[]>();
  /** 进行中的索引重建任务（并发请求合并到同一个） */
  private readonly turnIndexBuilds = new Map<string, Promise<SessionTurnIndexEntry[]>>();

  /** 全局通知 SSE 订阅者（控制台通知中心） */
  private readonly notificationSubs = new Set<{
    res: ServerResponse;
    tenantId?: string;
    heartbeat: NodeJS.Timeout;
  }>();

  /**
   * 节点级事件 SSE 订阅者（一条连接订阅该租户全部会话的实时事件）。
   *
   * 为什么需要：单会话一条 SSE 时，同屏 N 个会话就要 N 条长连接，会撞上
   * 浏览器同源连接上限；集中到一条连接后，连接数与并发会话数解耦。
   */
  private readonly eventSubs = new Set<{
    res: ServerResponse;
    tenantId?: string;
    heartbeat: NodeJS.Timeout;
  }>();

  /** 通知回调（由节点桥 / NotificationHub 注入） */
  private notifyHandler: ((tenantId: string, ev: NotifyEvent) => void) | null = null;
  /** 事件桥接回调（由节点桥注入，广播实时事件流） */
  private eventHandler: ((tenantId: string, sessionId: string, entry: EventEntry) => void) | null =
    null;

  constructor(
    private readonly store: Store,
    private readonly approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
    private readonly opts: {
      /** 测试注入：自定义 Provider 工厂（默认 OpenAIProvider） */
      providerFactory?: (tenant: TenantConfig) => ProviderClient;
      /** 测试注入：追加自定义工具 */
      extraTools?: (registry: ToolRegistry) => void;
      /** 用量账本（未注入时不记账） */
      usage?: UsageLedger;
    } = {},
  ) {}

  /** 用量账本（未注入时为 null） */
  usageLedger(): UsageLedger | null {
    return this.opts.usage ?? null;
  }

  /**
   * 正在占用节点的会话数：执行中或等待人工输入都算忙。
   * 自动更新据此判断能否安全重启（见 src/update/controller.ts）。
   */
  busySessionCount(): number {
    let busy = 0;
    for (const rt of this.runtimes.values()) {
      if (
        rt.status === "running" ||
        rt.status === "waiting_approval" ||
        rt.status === "waiting_question"
      ) {
        busy++;
      }
    }
    return busy;
  }

  /** 节点是否空闲（无执行中/等待输入的会话） */
  isIdle(): boolean {
    return this.busySessionCount() === 0;
  }

  /** 注入通知回调（节点桥 / NotificationHub 装配后调用） */
  setNotifyHandler(fn: ((tenantId: string, ev: NotifyEvent) => void) | null): void {
    this.notifyHandler = fn;
  }

  /** 注入事件桥接回调（广播实时事件流到 MQTT 等） */
  setEventHandler(
    fn: ((tenantId: string, sessionId: string, entry: EventEntry) => void) | null,
  ): void {
    this.eventHandler = fn;
  }

  /**
   * 更新运行时会话状态，并在**状态真的变化**时广播一条 `session_status`。
   *
   * 跨节点总览（工作台 / 节点首页）只依赖这条轻量通知同步：
   * 挂起、审批、完成、出错都在这里收敛成一个出口，避免在十几处赋值点
   * 各写一遍通知逻辑。data 只带 status，明细由详情页按需拉取。
   */
  private _setStatus(rt: SessionRuntime, status: SessionStatus): void {
    if (rt.status === status) return;
    rt.status = status;
    this._emitNotify(rt, "session_status", this._statusData(rt));
  }

  /**
   * 通知里的「最近一条用户消息」：截断到 LAST_USER_MESSAGE_MAX。
   *
   * 三处共用（session_status / turn_completed / turn_stopped），避免各自写一遍
   * 截断规则后长度不一致——控制台弹窗与任务列表会显示同一句话的两个版本。
   */
  private _lastMessage(rt: SessionRuntime): string | null {
    const text = (rt.lastInput ?? "").trim();
    if (!text) return null;
    return text.length > LAST_USER_MESSAGE_MAX
      ? `${text.slice(0, LAST_USER_MESSAGE_MAX)}…`
      : text;
  }

  /**
   * session_status 通知载荷：状态 + 最近一条用户消息（截断）。
   *
   * 跨节点工作台的任务行要显示「最后一轮任务的用户发送消息」，而该列表
   * 只靠这条轻量通知增量更新，不额外拉状态快照。
   */
  private _statusData(rt: SessionRuntime): Record<string, unknown> {
    const data: Record<string, unknown> = { status: rt.status };
    // 任务请求开始时间随状态通知下发：总览页据此把该会话即时排到最前
    if (rt.lastStartedAt) data.lastStartedAt = rt.lastStartedAt;
    const msg = this._lastMessage(rt);
    if (msg) data.lastUserMessage = msg;
    return data;
  }

  /**
   * 任务结束类通知（完成 / 达到迭代上限）的载荷：在 turn_end 数据之外补上
   * 「会话名 + 最后一条用户消息」。
   *
   * 控制台右下角的完成弹窗要说明「哪个会话、用户让它做了什么」。这些字段
   * 以节点侧为准随通知一起下发，前端就不必依赖快照（nodeInfo / session_status）
   * 是否已经到达——刚打开页面或通知乱序时才不会退化成只剩一句「任务已完成」。
   */
  private _turnEndData(
    rt: SessionRuntime,
    eventData: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { ...eventData, ...extra };
    if (rt.name) data.sessionName = rt.name;
    const msg = this._lastMessage(rt);
    if (msg) data.lastUserMessage = msg;
    return data;
  }

  /** 触发通知回调（无 handler 时为空操作，异常隔离不冒泡） */
  private _emitNotify(rt: SessionRuntime, kind: NotifyKind, data: Record<string, unknown>): void {
    this._publishNotify(rt.tenantId, {
      kind,
      sessionId: rt.sessionId,
      ts: new Date().toISOString(),
      data,
    });
  }

  /**
   * 交付一条通知：节点桥（云端 WSS）+ 本地通知 SSE。
   *
   * 与 `_emitNotify` 的区别是只需要 tenantId/sessionId——新建会话等**尚无内存
   * 运行时**的场景也要能广播状态，否则新会话要等第一次运行才会出现在总览里。
   */
  private _publishNotify(tenantId: string, ev: NotifyEvent): void {
    try {
      this.notifyHandler?.(tenantId, ev);
    } catch {
      // 通知失败不影响核心逻辑
    }
    // 广播给全局通知 SSE 订阅者（控制台通知中心；按租户过滤）
    this._broadcastNotify(tenantId, ev);
  }

  /**
   * 全局通知订阅（控制台通知中心）：审批/提问/完成/停止/错误等事件。
   * tenantId 缺省表示订阅全部租户（管理员）。
   */
  subscribeNotifications(res: ServerResponse, tenantId?: string): void {
    res.socket?.setNoDelay?.(true);
    res.socket?.setTimeout(0);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    const sub = { res, tenantId, heartbeat };
    this.notificationSubs.add(sub);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.notificationSubs.delete(sub);
    };
    res.on("close", cleanup);
    res.on("error", () => {
      res.socket?.destroy();
      cleanup();
    });
  }

  private _broadcastNotify(tenantId: string, ev: NotifyEvent): void {
    const frame = `data: ${JSON.stringify({ ...ev, tenantId })}\n\n`;
    for (const sub of this.notificationSubs) {
      if (sub.tenantId && sub.tenantId !== tenantId) continue;
      if (sub.res.writableEnded) continue;
      try {
        sub.res.write(frame);
      } catch {
        // 忽略写失败
      }
    }
  }

  /**
   * 节点级事件订阅（控制台一个连接订阅该租户下所有会话的实时事件）。
   * tenantId 缺省表示订阅全部租户（管理员）。
   *
   * 帧里带上 sessionId：与单会话 SSE 不同，客户端要按会话把事件分派给各自的视图。
   */
  subscribeEvents(res: ServerResponse, tenantId?: string): void {
    res.socket?.setNoDelay?.(true);
    res.socket?.setTimeout(0);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    const sub = { res, tenantId, heartbeat };
    this.eventSubs.add(sub);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.eventSubs.delete(sub);
    };
    res.on("close", cleanup);
    res.on("error", () => {
      res.socket?.destroy();
      cleanup();
    });
  }

  private _broadcastSessionEvent(tenantId: string, sessionId: string, entry: EventEntry): void {
    if (this.eventSubs.size === 0) return;
    const frame =
      `event: ${entry.type}\n` +
      `data: ${JSON.stringify({ sessionId, seq: entry.seq, ts: entry.ts, data: entry.data })}\n\n`;
    for (const sub of this.eventSubs) {
      if (sub.tenantId && sub.tenantId !== tenantId) continue;
      if (sub.res.writableEnded) continue;
      try {
        sub.res.write(frame);
      } catch {
        // 忽略写失败
      }
    }
  }

  // ===================== 会话 CRUD =====================

  createSession(tenant: TenantConfig, opts: { model?: string }): SessionRecord {
    const sessionId = newId();
    const workspace = this.store.ensureWorkspace(tenant.id, sessionId);
    void workspace;
    const rec: SessionRecord = {
      sessionId,
      tenantId: tenant.id,
      model: opts.model ?? tenant.model,
      modelOverridden: opts.model !== undefined,
      taskCount: 0,
      messages: [],
      compaction: null,
      status: "idle",
      approvals: [],
      questions: [],
      sessionAllowTools: [],
      sessionAllowCommands: [],
      savedAt: new Date().toISOString(),
    };
    void this.store.saveSessionSync(rec);
    // 新建即广播：跨节点总览 / 节点首页无需等首次运行或页面刷新就能看到它
    this._publishNotify(tenant.id, {
      kind: "session_status",
      sessionId,
      ts: rec.savedAt,
      data: { status: rec.status },
    });
    return rec;
  }

  listSessions(tenantId: string): SessionRecord[] {
    return this.store
      .listSessions(tenantId)
      .map((sid) => this.store.loadSession(tenantId, sid))
      .filter((r): r is SessionRecord => r !== null)
      .map((r) => this._healOrphanRunning(r));
  }

  getSession(tenantId: string, sessionId: string): SessionRecord | null {
    const rec = this.store.loadSession(tenantId, sessionId);
    return rec ? this._healOrphanRunning(rec) : null;
  }

  /**
   * 孤儿 running 收敛：磁盘标记为 running，但内存中没有该会话的运行时，
   * 说明是进程重启/崩溃遗留的状态 —— 它永远不会再被推进，界面却会一直显示
   * 「运行中」。这里纠正为 interrupted 并异步回写。
   *
   * 内存有运行时则原样返回：那是权威状态（含「已落盘 running、runTask 尚未挂上」
   * 的短暂窗口），不能插手。
   */
  private _healOrphanRunning(rec: SessionRecord): SessionRecord {
    if (rec.status !== "running" || this.runtimes.has(rec.sessionId)) return rec;
    const healed: SessionRecord = { ...rec, status: "interrupted" };
    void this.store.saveSession(healed);
    return healed;
  }

  deleteSession(tenantId: string, sessionId: string): boolean {
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      this._cancelTimers(rt);
      for (const res of rt.subscribers) this._sseClose(res);
      this.runtimes.delete(sessionId);
    }
    this.store.deleteSession(tenantId, sessionId);
    this.turnIndexCache.delete(sessionId);
    // 删除即广播（伪状态 deleted）：常开的总览页面立即移除该行，
    // 不必等下一次快照刷新。总览消费方按此标记剔除条目。
    this._publishNotify(tenantId, {
      kind: "session_status",
      sessionId,
      ts: new Date().toISOString(),
      data: { status: SESSION_STATUS_DELETED },
    });
    return true;
  }

  /**
   * 删除整个项目（= 租户）：回收其全部会话的内存运行时与订阅，
   * 再删除磁盘目录。供控制台「删除项目」使用。
   */
  deleteTenant(tenantId: string): void {
    for (const sessionId of this.store.listSessions(tenantId)) {
      this.deleteSession(tenantId, sessionId);
    }
    this.store.deleteTenant(tenantId);
  }

  // ===================== 运行驱动 =====================

  /**
   * 提交用户消息并启动（或重建后继续）一轮 Turn。
   * 会话忙碌（run 进行中 / 有未决审批或提问）时抛 409。
   */
  submitTurn(
    tenant: TenantConfig,
    sessionId: string,
    input: string,
    attachments?: MessageAttachment[],
  ): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    this._assertIdle(rt);
    this._assertAttachmentsSupported(tenant, rt, attachments);
    this._startTurn(rt, input, attachments);
  }

  /**
   * 提交消息：会话运行中（内存 run 存活）→ 作为 steering 注入当前任务；
   * 否则开始一个新 Turn。返回 "steered" | "started"。
   *
   * 用于 HTTP POST /turns 与 QQ 等「对话式」入口：任务执行中追加的消息
   * 自然成为补充信息，而不是报 409 busy。存在未决审批/提问时仍走
   * _assertIdle 抛 409（用户应先回答审批/提问）。
   */
  submitOrSteer(
    tenant: TenantConfig,
    sessionId: string,
    input: string,
    attachments?: MessageAttachment[],
  ): "steered" | "started" {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    this._assertAttachmentsSupported(tenant, rt, attachments);
    if (rt.runTask) {
      if (!rt.engine) {
        // 防御：run 任务存活但引擎已被回收（理论上不应发生）
        throw new ApiError(409, "busy", "会话正在运行中");
      }
      rt.engine.queueSteering(input, attachments);
      // 记录被补充信息覆盖前的用户指令，撤销到空队列时用它还原列表展示
      if (rt.pendingSteers.length === 0) rt.steerBaseInput = rt.lastInput;
      rt.pendingSteers.push(input);
      this._recordLastInput(rt, input);
      return "steered";
    }
    this._assertIdle(rt);
    this._startTurn(rt, input, attachments);
    return "started";
  }

  /**
   * 从持久化挂起点恢复 Turn（审批/提问已回答但 run 任务已被回收
   * 或进程重启）。engine.resume() 会重放未回答的 tool_calls，
   * 挂起式 approver 从磁盘答案存储直接返回，然后继续执行。
   */
  resumeSession(tenant: TenantConfig, sessionId: string): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    this._assertIdle(rt);
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec || !this._hasUnansweredTrailingToolCalls(rec)) {
      throw new ApiError(409, "no_pending_task", "没有可恢复的挂起任务");
    }
    this._setStatus(rt, "running");
    rt.turnStartedAt = Date.now();
    const engine = this._buildEngine(tenant, rt);
    rt.engine = engine;
    // 立即落盘 running（同 _startTurn：/state 读磁盘，不落盘会显示为 idle）
    this._persist(rt);
    rt.runTask = this._drive(rt, engine.resume());
  }

  /** 运行中注入 steering 消息（引擎 queueSteering） */
  steer(
    tenant: TenantConfig,
    sessionId: string,
    text: string,
    attachments?: MessageAttachment[],
  ): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    if (!rt.engine) throw new ApiError(409, "not_running", "会话未在运行中");
    this._assertAttachmentsSupported(tenant, rt, attachments);
    // 与开新轮一致：补充信息的附件也落盘，只把引用交给引擎
    const attachmentRefs = saveAttachments(
      this.store.sessionDir(rt.tenantId, rt.sessionId),
      attachments,
    );
    rt.engine.queueSteering(text, attachments, attachmentRefs);
    // 记录被补充信息覆盖前的用户指令，撤销到空队列时用它还原列表展示
    if (rt.pendingSteers.length === 0) rt.steerBaseInput = rt.lastInput;
    rt.pendingSteers.push(text);
    this._recordLastInput(rt, text);
  }

  /**
   * 撤销一条尚未注入的补充信息（用户反悔）。
   *
   * 队列里的项还没进聊天流，此时只能靠中断整个任务来「收回」代价太大。
   * index 取自 GET /state 的 pendingSteers（与前端展示顺序一致），两侧同时删：
   * 只删前端那份，引擎下一迭代仍会把它注入对话；只删引擎那份，队列里会残留
   * 一条永远不注入的条目。
   *
   * 若撤的正是「最近用户指令」，把它还原成队列里的上一条、或本轮被覆盖前的
   * 指令——否则工作台还会显示这条已经被取消的内容。
   *
   * @returns 剩余待注入队列（前端据此刷新提示区）
   */
  unsteer(tenant: TenantConfig, sessionId: string, index: number): string[] {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    if (!rt.engine || !rt.runTask) {
      throw new ApiError(409, "not_running", "会话未在运行中");
    }
    if (!Number.isInteger(index) || index < 0 || index >= rt.pendingSteers.length) {
      // 已注入的项会先从这里移除，再发 queue_steering 事件；点晚了就是这种情况
      throw new ApiError(409, "already_injected", "这条补充信息已进入对话，无法撤销");
    }
    const [removed] = rt.pendingSteers.splice(index, 1);
    if (removed !== undefined) {
      rt.engine.removeSteering(removed);
      if (removed === rt.lastInput) {
        rt.lastInput =
          rt.pendingSteers.length > 0
            ? rt.pendingSteers[rt.pendingSteers.length - 1]
            : rt.steerBaseInput;
        this._persist(rt);
        // 列表展示的是 lastInput，撤销后要让它立刻跟着更新
        this._emitNotify(rt, "session_status", this._statusData(rt));
      }
    }
    return [...rt.pendingSteers];
  }

  /**
   * 已提交、尚未注入当前任务的补充信息。
   *
   * 供 GET /state 使用：前端刷新页面后据此恢复输入区上方的「排队中」提示。
   * 只认内存中还在运行的会话——队列随 turn 结束清空，进程重启后也不会再注入。
   */
  pendingSteers(sessionId: string): string[] {
    const rt = this.runtimes.get(sessionId);
    if (!rt || !rt.runTask) return [];
    return [...rt.pendingSteers];
  }

  /** 内存运行时的最新事件序号（无运行时为 0）：前端据此区分历史回放与新事件 */
  sessionSeq(sessionId: string): number {
    return this.runtimes.get(sessionId)?.seq ?? 0;
  }

  /** 记录最近一次用户指令并立即落盘（不等引擎把消息推进 history） */
  private _recordLastInput(rt: SessionRuntime, input: string): void {
    rt.lastInput = input;
    this._persist(rt);
    // 补充信息不改变 status，但仍需让总览列表立刻看到这条最新指令
    this._emitNotify(rt, "session_status", this._statusData(rt));
  }

  /**
   * 请求中断：终止会话当前的任务。
   *
   * 覆盖三种情形，缺一都会表现为「点了终止没反应」：
   * 1. 运行中：引擎存活 → requestInterrupt()，引擎在下一个安全点收尾为 interrupted；
   * 2. 挂起在审批/提问：引擎存活但阻塞在等待回答的 await 上，安全点不可达，光置标志
   *    无效 → 必须结算挂起的 Promise 把引擎唤醒，它才会走到安全点；
   * 3. 挂起且内存 run 任务已被超时回收（或进程重启遗留）：engine 为空，没有任何人
   *    会把状态改回来 → 直接收敛为 interrupted，否则会话永久停在 waiting_*。
   */
  interrupt(tenant: TenantConfig, sessionId: string): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    const engine = rt.engine;
    if (engine) {
      // 先置中断位：被唤醒的引擎据此按「中断」收尾，而不是当成「用户拒绝」继续跑
      engine.requestInterrupt();
      this._cancelPendingInteractions(rt);
      return; // 由 _drive 收到 INTERRUPTED 后置状态并落盘
    }

    // 无引擎可中断：只处理「挂起但内存任务已被超时回收 / 进程重启遗留」的会话。
    // completed / idle / error 等状态没有任务可终止，不能凭空改写成 interrupted。
    if (rt.status !== "waiting_approval" && rt.status !== "waiting_question") return;
    this._cancelPendingInteractions(rt);
    this._recycleRunTask(rt);
    this._setStatus(rt, "interrupted");
    this._buffer(rt, { type: EventType.INTERRUPTED, data: { iterations: 0 } });
    this._persist(rt);
  }

  /**
   * 结算并清理挂起的审批/提问（中断时调用）。
   *
   * 两件事：
   * - 结算 Promise：引擎阻塞在等待回答的 await 上，只有结算它才能回到中断安全点。
   *   审批按 DENY 结算（引擎走拒绝分支，并用 _cancel 区分「用户中断」文案），
   *   提问按空回答结算；挂起唤醒后引擎会跳过后续未授权工具。
   * - 记录标记为 cancelled：否则 _assertIdle 会一直判定 busy（磁盘 pending 也算），
   *   用户既发不了新消息也无法重新恢复；前端也会一直显示待办卡片。
   *   已被超时回收的记录（内存无 pending、磁盘仍为 pending）同样要标记。
   */
  private _cancelPendingInteractions(rt: SessionRuntime): void {
    const answeredAt = new Date().toISOString();
    for (const [id, pending] of rt.pendingApprovals) {
      clearTimeout(pending.timer);
      rt.pendingApprovals.delete(id);
      pending.record.status = "cancelled";
      pending.record.answeredAt = answeredAt;
      pending.resolve(ApprovalOutcome.DENY);
    }
    for (const [id, pending] of rt.pendingQuestions) {
      clearTimeout(pending.timer);
      rt.pendingQuestions.delete(id);
      pending.record.status = "cancelled";
      pending.record.answeredAt = answeredAt;
      pending.resolve("");
    }
    for (const rec of rt.approvals.values()) {
      if (rec.status !== "pending") continue;
      rec.status = "cancelled";
      rec.answeredAt = answeredAt;
    }
    for (const rec of rt.questions.values()) {
      if (rec.status !== "pending") continue;
      rec.status = "cancelled";
      rec.answeredAt = answeredAt;
    }
  }

  /** 更新会话的 model（同步磁盘 + 内存运行时） */
  updateSessionModel(tenant: TenantConfig, sessionId: string, model: string): SessionRecord {
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");
    rec.model = model;
    rec.modelOverridden = true;
    void this.store.saveSession(rec);

    // 同步内存运行时（如有）
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.lastModel = model;
      rt.modelOverridden = true;
      if (rt.engine) rt.engine.model = model;
    }
    return rec;
  }

  /**
   * 切换会话级 LLM（控制台输入区「先选配置、再选模型」）：
   * `providerId` 引用节点级 LLM 配置（`""`/`project` = 清除，回到项目配置）；
   * 未显式给 `model` 时沿用该配置自身的模型。下一轮任务按新配置装配引擎。
   */
  updateSessionLlm(
    tenant: TenantConfig,
    sessionId: string,
    patch: { providerId?: unknown; model?: unknown },
  ): SessionRecord {
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");

    if (patch.providerId !== undefined) {
      const raw = String(patch.providerId ?? "").trim();
      if (!raw || raw === "project" || raw === "default") {
        rec.providerId = undefined;
      } else {
        if (!findNodeProvider(this.store, raw)) {
          throw new ApiError(400, "bad_request", `未知的 LLM 配置：${raw}`);
        }
        rec.providerId = raw;
      }
    }
    const model = patch.model === undefined ? "" : String(patch.model ?? "").trim();
    const target = rec.providerId ? findNodeProvider(this.store, rec.providerId) : null;
    if (rec.providerId) {
      rec.model = model || target?.model || rec.model;
      rec.modelOverridden = true;
    } else if (model) {
      rec.model = model;
      rec.modelOverridden = true;
    }
    // 用户交互路径：立即同步落盘，避免随后读状态（控制台回显）拿到旧值
    this.store.saveSessionSync(rec);

    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.providerId = rec.providerId;
      if (rec.modelOverridden) {
        rt.lastModel = rec.model;
        rt.modelOverridden = true;
      }
      // 引擎每条任务结束后释放，下一轮按新配置装配；不动正在运行的任务
      if (rt.status !== "running" && rt.engine) rt.engine.model = rec.model;
    }
    return rec;
  }

  /**
   * 切换会话权限模式（plan / interactive / auto / discuss）：
   * 更新持久化记录，并对已装配的引擎即时生效。
   */
  setSessionMode(
    tenant: TenantConfig,
    sessionId: string,
    mode: string,
  ): SessionRecord {
    const allowed = ["discuss", "plan", "interactive", "auto"];
    if (!allowed.includes(mode)) {
      throw new ApiError(400, "bad_request", `mode 必须是 ${allowed.join(" / ")} 之一`);
    }
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");
    rec.permissionMode = mode;
    this.store.saveSessionSync(rec);

    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.permissionMode = mode;
      if (rt.engine) rt.engine.permissions.mode = mode as Mode;
    }
    return rec;
  }

  /** 保存会话输入框草稿（未发送内容；空串表示清空） */
  setSessionDraft(
    tenant: TenantConfig,
    sessionId: string,
    draft: string,
  ): SessionRecord {
    const value = String(draft ?? "");
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");
    rec.draft = value;
    this.store.saveSessionSync(rec);
    const rt = this.runtimes.get(sessionId);
    if (rt) rt.draft = value;
    return rec;
  }

  /**
   * 重命名会话（用户手动）：置 nameSource="user"，此后不再自动命名。
   */  async renameSession(
    tenant: TenantConfig,
    sessionId: string,
    name: string,
  ): Promise<SessionRecord> {
    const clean = sanitizeSessionName(name);
    if (!clean) throw new ApiError(400, "bad_request", "名称不能为空");
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");
    rec.name = clean;
    rec.nameSource = "user";
    // 走异步写链并等待落盘（与 _persist 串行，避免旧快照覆盖）
    await this.store.saveSession(rec);
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.name = clean;
      rt.nameSource = "user";
      rt.lastMessages = rec.messages;
      this._buffer(rt, {
        type: EventType.SESSION_NAMED,
        data: { name: clean, source: "user" },
      });
    }
    return rec;
  }

  /**
   * 后台自动生成会话名（第 1/3/5 次任务完成后触发，参考 CLI 行为）。
   * - 生成期间用户手动改名（nameSource=user）→ 放弃覆盖；
   * - 生成失败（如未配置 LLM）静默忽略，不影响主流程。
   */
  private async _autoName(rt: SessionRuntime, engine: TurnEngine): Promise<void> {
    if (rt.naming) return;
    rt.naming = true;
    try {
      const clean = sanitizeSessionName(await engine.genSessionName());
      if (!clean) return;
      if (rt.nameSource === "user") return; // 生成期间用户已手动改名
      rt.name = clean;
      rt.nameSource = "auto";
      // 走异步写链并等待落盘（与 _persist 串行，避免旧快照覆盖），
      // 落盘完成后再广播事件，保证客户端收到事件后立刻能读到新名称。
      const rec = this._toRecord(rt);
      await this.store.saveSession(rec);
      rt.lastMessages = rec.messages;
      rt.lastModel = rec.model;
      rt.lastCompaction = rec.compaction;
      this._buffer(rt, {
        type: EventType.SESSION_NAMED,
        data: { name: clean, source: "auto" },
      });
    } catch (e) {
      // 命名失败不影响主流程（如未配置 LLM），但记录便于排查
      console.warn(
        `[session] 自动命名失败 ${rt.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      rt.naming = false;
    }
  }

  /**
   * 导入历史消息（供网关侧会话重建后回放上下文，保证"继续执行"时对话连续）。
   * 覆盖当前会话消息历史并落盘。
   */
  setMessages(tenant: TenantConfig, sessionId: string, messages: unknown[]): void {
    if (!Array.isArray(messages)) return;
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    rt.lastMessages = messages as never[];
    this._persist(rt);
  }

  // ===================== 审批 =====================

  /** 挂起式审批实现：有答案直接返回，无则落盘 + 挂起，超时回收 */
  private _makeApprover(rt: SessionRuntime): Approver {
    return async (request) => {
      const callId = request.toolCallId;
      const existing = callId ? rt.approvals.get(callId) : undefined;
      // resume 恢复路径：磁盘已有答案 → 直接返回
      if (existing?.status === "answered" && existing.outcome !== undefined) {
        return existing.outcome;
      }
      // 同一 tool call 重复挂起（防御）→ 复用挂起 Promise
      if (callId) {
        const pending = rt.pendingApprovals.get(callId);
        if (pending) return pending.promise;
      }
      if (!callId) {
        // 极旧调用路径（无 toolCallId）：无法精确关联，按拒绝处理
        return ApprovalOutcome.DENY;
      }

      const id = callId;
      const record: ApprovalRecord = {
        id,
        toolName: request.toolName,
        arguments: request.arguments,
        reason: request.reason,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      const { promise, resolve } = defer<ApprovalOutcome>();
      const timer = setTimeout(() => {
        this._recycleApproval(rt, id);
      }, this.approvalTimeoutMs);
      rt.pendingApprovals.set(id, { promise, resolve, record, timer });
      rt.approvals.set(id, record);
      this._setStatus(rt, "waiting_approval");
      // 挂起点全量落盘：此时 messages 已含未回答的 assistant tool_calls
      this._persist(rt);
      this._emitNotify(rt, "approval_request", {
        approvalId: id,
        toolName: request.toolName,
        arguments: request.arguments,
        reason: request.reason,
      });
      return promise;
    };
  }

  /** 用户回答审批 */
  answerApproval(
    tenant: TenantConfig,
    sessionId: string,
    approvalId: string,
    outcome: ApprovalOutcome,
  ): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    const record = rt.approvals.get(approvalId);
    if (!record) throw new ApiError(404, "not_found", "审批请求不存在");
    if (record.status === "answered") {
      throw new ApiError(409, "already_answered", "该审批已回答");
    }

    // always_command 只对 run_shell 有意义（命令白名单仅在 shell 分支被查询），
    // 其他工具没有 command 参数，直接拒绝而不是静默忽略
    if (outcome === ApprovalOutcome.ALWAYS_COMMAND && record.toolName !== "run_shell") {
      throw new ApiError(400, "invalid_decision", "always_command 仅适用于 run_shell 工具");
    }

    record.status = "answered";
    record.outcome = outcome;
    record.answeredAt = new Date().toISOString();

    // 同步会话级白名单（与引擎内部行为一致，引擎回收后仍保留）
    if (outcome === ApprovalOutcome.ALWAYS_TOOL) rt.allowTools.add(record.toolName);
    if (outcome === ApprovalOutcome.ALWAYS_COMMAND) {
      const cmd = String(record.arguments["command"] ?? "");
      if (cmd) rt.allowCommands.add(cmd);
    }

    const pending = rt.pendingApprovals.get(approvalId);
    if (pending) {
      clearTimeout(pending.timer);
      rt.pendingApprovals.delete(approvalId);
      pending.resolve(outcome);
      this._setStatus(rt, "running");
      this._persist(rt);
    } else {
      // run 任务已被回收或进程重启 → 落盘后走 resume 恢复
      this._persist(rt);
      this.resumeSession(tenant, sessionId);
    }
  }

  /** 挂起审批超时回收：释放内存引用（磁盘保持 pending，可 resume 恢复） */
  private _recycleApproval(rt: SessionRuntime, approvalId: string): void {
    const pending = rt.pendingApprovals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    rt.pendingApprovals.delete(approvalId);
    this._setStatus(rt, "waiting_approval");
    this._recycleRunTask(rt);
  }

  // ===================== 提问（ask_user 等） =====================

  /** 挂起式提问：把问题落盘并挂起，超时回收（供 interact.ts 分派调用） */
  suspendQuestion(
    sessionId: string,
    kind: QuestionRecord["kind"],
    payload: {
      question: string;
      options?: string[];
      allowText?: boolean;
      multi?: boolean;
      suggestedPath?: string;
      writable?: boolean;
    },
  ): Promise<string> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) {
      return Promise.resolve(JSON.stringify({ error: "会话不存在" }));
    }
    // resume 重放路径：该提问已被用户回答（超时回收后经 engine.resume() 重放工具调用），
    // 直接复用已持久化的答案并标记消费，避免再次挂起提问造成重复问答。
    const answered = [...rt.questions.values()]
      .filter((q) => q.kind === kind && q.status === "answered" && !q.consumed)
      .sort((a, b) => (a.answeredAt! < b.answeredAt! ? 1 : -1))[0];
    if (answered) {
      answered.consumed = true;
      return Promise.resolve(answered.answer ?? "");
    }
    const qid = newId();
    const record: QuestionRecord = {
      id: qid,
      kind,
      question: payload.question,
      options: payload.options ?? [],
      allowText: payload.allowText ?? true,
      multi: payload.multi ?? false,
      suggestedPath: payload.suggestedPath,
      writable: payload.writable,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const { promise, resolve } = defer<string>();
    const timer = setTimeout(() => {
      this._recycleQuestion(rt, qid);
    }, this.approvalTimeoutMs);
    rt.pendingQuestions.set(qid, { promise, resolve, record, timer });
    rt.questions.set(qid, record);
    this._setStatus(rt, "waiting_question");
    this._persist(rt);
    this._emitNotify(rt, "question_asked", {
      questionId: qid,
      kind,
      question: payload.question,
      options: payload.options ?? [],
      allowText: payload.allowText ?? true,
      multi: payload.multi ?? false,
      suggestedPath: payload.suggestedPath,
      writable: payload.writable,
    });
    return promise;
  }

  /** 用户回答问题 */
  answerQuestion(
    tenant: TenantConfig,
    sessionId: string,
    questionId: string,
    answer: string,
  ): void {
    const rt = this._getOrLoadRuntime(tenant, sessionId);
    const record = rt.questions.get(questionId);
    if (!record) throw new ApiError(404, "not_found", "提问不存在");
    if (record.status === "answered") {
      throw new ApiError(409, "already_answered", "该提问已回答");
    }

    record.status = "answered";
    record.answer = answer;
    record.parsed = this._parseAnswer(record, answer);
    record.answeredAt = new Date().toISOString();

    const pending = rt.pendingQuestions.get(questionId);
    if (pending) {
      clearTimeout(pending.timer);
      rt.pendingQuestions.delete(questionId);
      // 原地恢复：答案经 promise 直接交回 handler，标记已消费
      record.consumed = true;
      pending.resolve(answer);
      this._setStatus(rt, "running");
      this._persist(rt);
    } else {
      // run 任务已回收：落盘后 resume() 重放 ask 工具，handler 直接取答案
      this._persist(rt);
      this.resumeSession(tenant, sessionId);
    }
  }

  /** 最近一次已回答的提问（供交互 handler 解析结构化结果） */
  getAnsweredQuestion(sessionId: string): QuestionRecord | null {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return null;
    const answered = [...rt.questions.values()]
      .filter((q) => q.status === "answered")
      .sort((a, b) => (a.answeredAt! < b.answeredAt! ? 1 : -1));
    return answered[0] ?? null;
  }

  /** 提问挂起超时回收 */
  private _recycleQuestion(rt: SessionRuntime, questionId: string): void {
    const pending = rt.pendingQuestions.get(questionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    rt.pendingQuestions.delete(questionId);
    this._setStatus(rt, "waiting_question");
    this._recycleRunTask(rt);
  }

  /** 按提问类型解析回答为结构化结果（供引擎 handler 返回） */
  private _parseAnswer(record: QuestionRecord, answer: string): QuestionRecord["parsed"] {
    if (record.kind === "plan") {
      const approved = isAffirmative(answer);
      return {
        approved,
        feedback: approved ? undefined : answer.trim() || "计划被拒绝",
      };
    }
    if (record.kind === "directory") {
      const granted = isAffirmative(answer);
      return {
        granted,
        path: granted ? record.suggestedPath : undefined,
      };
    }
    return undefined;
  }

  // ===================== 事件与 SSE =====================

  /** 运行时诊断（运维/测试）：内存 run 是否存活、挂起数量 */
  runtimeInfo(sessionId: string): {
    inMemoryRun: boolean;
    pendingApprovals: number;
    pendingQuestions: number;
    status: SessionStatus;
  } | null {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return null;
    return {
      inMemoryRun: rt.runTask !== null,
      pendingApprovals: rt.pendingApprovals.size,
      pendingQuestions: rt.pendingQuestions.size,
      status: rt.status,
    };
  }

  /**
   * 事件分页（向前 / 向后两种方向）。
   *
   * - `since`：取 seq > since（实时增量 / 重连补齐）
   * - `before`：取 seq < before（控制台滚到顶部加载更早的对话）
   * - `maxBytes`：单次回执的字节预算（默认沿用 EVENTS_ACK_MAX_BYTES）
   *
   * 两者同时给出时按 `since`（向后）处理。`hasMore` 只对向前翻页有意义：
   * 表示本页最早一条之前还有更早的事件。
   *
   * 向前翻页一律走磁盘：内存缓冲只保留最近 EVENT_BUFFER_MAX 条，
   * 更早的事件只在 events.jsonl 里。
   */
  eventsPage(
    tenantId: string,
    sessionId: string,
    opts: { since?: number; before?: number; maxBytes?: number } = {},
  ): { events: EventEntry[]; latestSeq: number; earliestSeq: number; hasMore: boolean } {
    const __t0 = dbgNow(); // [dbg]
    const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : EVENTS_ACK_MAX_BYTES;
    const rt = this.runtimes.get(sessionId);

    // 向前翻页：只可能是更早的事件，直接读磁盘。
    // 允许同时给 since：取 [since, before) 区间（会话详情点开某一轮时用）。
    if (opts.before !== undefined) {
      const since = opts.since ?? 0;
      const page = this.store.loadEventPage(tenantId, sessionId, {
        before: opts.before,
        maxBytes,
      });
      const ev = since > 0 ? page.events.filter((e) => e.seq > since) : page.events;
      dbgMs("session.eventsPage(before/磁盘)", __t0, // [dbg]
        `sid=${sessionId.slice(0, 8)} since=${since} before=${opts.before} out=${ev.length} more=${page.hasMore}`);
      return {
        events: ev,
        latestSeq: rt?.seq ?? page.events.at(-1)?.seq ?? 0,
        earliestSeq: ev[0]?.seq ?? 0,
        hasMore: page.hasMore,
      };
    }

    const since = opts.since ?? 0;
    if (rt) {
      const ev = this._boundedTail(rt.events.filter((e) => e.seq > since), maxBytes);
      dbgMs("session.eventsPage(内存)", __t0, // [dbg]
        `sid=${sessionId.slice(0, 8)} since=${since} in=${rt.events.length} out=${ev.length}`);
      return {
        events: ev,
        latestSeq: rt.seq,
        earliestSeq: ev[0]?.seq ?? 0,
        // 内存缓冲被截断（或 since 早于缓冲起点）时，磁盘上可能还有更早的
        hasMore: !!ev.length && ev[0]!.seq > (rt.events[0]?.seq ?? 0),
      };
    }
    const all = this.store.loadEventsTail(tenantId, sessionId, EVENTS_ACK_MAX_BYTES * 2);
    const ev = this._boundedTail(
      all.filter((e) => e.seq > since),
      maxBytes,
    );
    dbgMs("session.eventsPage(磁盘)", __t0, // [dbg]
      `sid=${sessionId.slice(0, 8)} since=${since} loaded=${all.length} out=${ev.length}`);
    return {
      events: ev,
      latestSeq: all.at(-1)?.seq ?? 0,
      earliestSeq: ev[0]?.seq ?? 0,
      // 读的是文件尾部窗口：窗口已满说明更早的事件还在文件里
      hasMore: all.length > 0 && ev.length > 0 && ev[0]!.seq > all[0]!.seq,
    };
  }

  /**
   * 兼容旧调用：只按 since 取增量。
   * @deprecated 新代码用 eventsPage（支持 before 向前翻页）
   */
  eventsSince(
    tenantId: string,
    sessionId: string,
    since: number,
  ): { events: EventEntry[]; latestSeq: number } {
    const r = this.eventsPage(tenantId, sessionId, { since });
    return { events: r.events, latestSeq: r.latestSeq };
  }

  /**
   * 「按 turn 汇总」的轻量列表：只回标题与统计，点开某一轮再单独拉该轮回复。
   *
   * 数据来自 turns.ndjson 索引（派生自事件流），读取成本与会话历史长度无关：
   * 老会话首次访问时后台/本请求内重建一次，之后每页只读几 KB。
   *
   * - `before`：只返回 startSeq < before 的轮次（向前翻页）
   * - `turns` 按时间升序；`hasMore` 表示更早还有轮次
   */
  async sessionTurns(
    tenantId: string,
    sessionId: string,
    opts: { before?: number; limit?: number } = {},
  ): Promise<SessionTurnsPage> {
    const limit = Math.min(Math.max(opts.limit ?? TURNS_DEFAULT_LIMIT, 1), 100);
    const entries = await this._ensureTurnIndex(tenantId, sessionId);
    const before = opts.before;
    // 游标语义：startSeq < before（与旧实现的 before 一致）
    const endIdx =
      before === undefined ? entries.length : entries.findIndex((t) => t.startSeq >= before);
    const end = endIdx < 0 ? entries.length : endIdx;
    const start = Math.max(0, end - limit);
    const picked = entries.slice(start, end);
    return {
      turns: picked.map(summaryFromEntry),
      hasMore: start > 0,
      earliestSeq: picked[0]?.startSeq ?? 0,
      total: entries.length,
      userTotal: entries.reduce((n, t) => n + t.inputs.length, 0),
    };
  }

  /**
   * 读取聊天记录里保存的附件字节（用户消息缩略图 / 大图）。
   *
   * 路径限定在会话目录的 `attachments/` 下（`readStoredAttachment` 会校验），
   * 因此前端只能取到自己会话里的附件。
   */
  sessionAttachment(
    tenantId: string,
    sessionId: string,
    relPath: string,
  ): { name: string; mimeType: string; size: number; base64: string } {
    if (!this.store.loadSession(tenantId, sessionId)) {
      throw new ApiError(404, "not_found", "会话不存在");
    }
    try {
      return readStoredAttachment(this.store.sessionDir(tenantId, sessionId), relPath);
    } catch (e) {
      throw new ApiError(404, "not_found", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 某一轮的用户消息与最终回复（含产出文件）。
   *
   * 只读两条索引记录 + 尾部一个事件页，不会因该轮工具输出很大而变慢：
   * 回复正文紧邻 turn_end，按 replySeq 精确读即可。
   */
  async sessionTurnReply(
    tenantId: string,
    sessionId: string,
    startSeq: number,
  ): Promise<SessionTurnReply> {
    const entries = await this._ensureTurnIndex(tenantId, sessionId);
    const turn = entries.find((t) => t.startSeq === startSeq);
    if (!turn) throw new ApiError(404, "not_found", "轮次不存在");

    let reply: SessionTurnReply["reply"] = null;
    let truncated = false;
    // 优先按索引里的 replySeq 精确定位；索引落后/事件被裁剪时退回预览
    if (turn.replySeq !== undefined) {
      const page = this.store.loadEventPage(tenantId, sessionId, {
        before: turn.replySeq + 1,
        maxBytes: TURN_REPLY_MAX_BYTES,
      });
      const ev = page.events.find((e) => e.seq === turn.replySeq);
      if (ev && ev.type === "assistant_message") {
        const text = String(ev.data?.["text"] ?? "");
        if (text.length > TURN_REPLY_MAX_TEXT) {
          reply = { seq: ev.seq, ts: ev.ts, text: text.slice(0, TURN_REPLY_MAX_TEXT) };
          truncated = true;
        } else {
          reply = { seq: ev.seq, ts: ev.ts, text };
        }
      }
    }
    return {
      startSeq: turn.startSeq,
      endSeq: turn.endSeq,
      status: turn.status,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      userMessages: turn.inputs,
      reply,
      truncated,
      producedFiles: turn.producedFiles,
    };
  }

  // ===================== 变更追踪（多会话并行） =====================

  /**
   * 取某个会话的变更追踪器。
   *
   * 会话没有运行时（进程重启后未加载）也要能查：那时用磁盘上的会话目录，
   * 与引擎装配时用的是同一个（`tenant.workspaceRoot ?? 会话独立目录`），
   * 否则查到的会是另一个目录里的 ref。
   */
  private _vcsFor(tenantId: string, sessionId: string): SessionVcs {
    const tenant = this.store.loadTenant(tenantId);
    if (!tenant) throw new ApiError(404, "not_found", "项目不存在");
    const rt = this.runtimes.get(sessionId);
    const workspace =
      tenant.workspaceRoot ?? rt?.workspace ?? this.store.ensureWorkspace(tenantId, sessionId);
    return new SessionVcs(
      resolveVcsPlan(workspace, { mode: tenant.vcs?.mode ?? "auto" }),
      sessionId,
    );
  }

  /**
   * 本会话的变更快照列表（每轮一个）。
   *
   * 返回 `enabled: false` 而不是报错：追踪可以关闭（配置 vcs.mode=off），
   * 控制台据此显示「未启用」而不是错误提示。
   */
  async sessionChanges(
    tenantId: string,
    sessionId: string,
  ): Promise<{
    enabled: boolean;
    mode: string;
    reason: string;
    turns: TurnCommit[];
  }> {
    const vcs = this._vcsFor(tenantId, sessionId);
    if (!vcs.enabled) {
      return { enabled: false, mode: vcs.plan.mode, reason: vcs.plan.reason, turns: [] };
    }
    return {
      enabled: true,
      mode: vcs.plan.mode,
      reason: vcs.plan.reason,
      turns: await vcs.listTurns(),
    };
  }

  /** 某个快照的完整 patch（控制台点开某一轮查看） */
  async sessionChangeDiff(
    tenantId: string,
    sessionId: string,
    turn: number,
  ): Promise<{ turn: number; patch: string }> {
    if (!Number.isFinite(turn) || turn <= 0) {
      throw new ApiError(400, "bad_request", "无效的快照序号");
    }
    const vcs = this._vcsFor(tenantId, sessionId);
    const patch = await vcs.diffTurn(turn);
    if (!patch.trim()) throw new ApiError(404, "not_found", "快照不存在或没有内容");
    return { turn, patch };
  }

  /**
   * 从某个快照恢复文件。
   *
   * 这是**会改工作区**的操作，但因为只写快照里的内容、且会回报覆盖了哪些文件，
   * 所以放在会话级接口里由用户显式触发（控制台按钮）。
   */
  async sessionChangeRestore(
    tenantId: string,
    sessionId: string,
    turn: number,
    opts: { paths?: string[] } = {},
  ): Promise<RestoreResult & { turn: number }> {
    if (!Number.isFinite(turn) || turn <= 0) {
      throw new ApiError(400, "bad_request", "无效的快照序号");
    }
    const vcs = this._vcsFor(tenantId, sessionId);
    if (!vcs.enabled) throw new ApiError(409, "vcs_disabled", "变更追踪未启用");
    const result = await vcs.restoreTurn(turn, opts.paths?.length ? { paths: opts.paths } : {});
    if (!result.restored.length && !result.missing.length) {
      throw new ApiError(404, "not_found", "快照不存在或没有可恢复的文件");
    }
    return { turn, ...result };
  }

  /**
   * 取轮次索引；缺失时从事件流重建（同一会话的并发请求共用一个重建任务）。
   *
   * 索引是派生数据：损坏/落后都只需重建，不影响会话本身。
   */
  /**
   * 取轮次索引；缺失/落后时从事件流重建（同一会话的并发请求共用一个重建任务）。
   *
   * 索引是派生数据：损坏或落后都只需重建，不影响会话本身。
   */
  private async _ensureTurnIndex(
    tenantId: string,
    sessionId: string,
  ): Promise<SessionTurnIndexEntry[]> {
    let entries = this._mergeTurnIndex(tenantId, sessionId);

    // 索引落后/残缺的判定（只在本进程没有该会话运行时时做）：
    //   - 进程重启后事件可能比索引新（崩溃前未落索引）→ 尾部出现新 turn_start
    //   - 崩溃遗留的孤儿 running 轮 → 事件里已闭合，需按事件重算
    if (entries.length > 0 && !this.runtimes.has(sessionId)) {
      const last = entries[entries.length - 1]!;
      const tail = this.store.loadEventsTail(tenantId, sessionId, 64 * 1024);
      const newTurnStarted = tail.some((e) => e.type === "turn_start" && e.seq > last.endSeq);
      if (newTurnStarted || last.status === "running") entries = [];
    }
    if (entries.length > 0) return entries;

    const pending = this.turnIndexBuilds.get(sessionId);
    if (pending) return pending;

    const task = this._rebuildTurnIndex(tenantId, sessionId).finally(() => {
      this.turnIndexBuilds.delete(sessionId);
    });
    this.turnIndexBuilds.set(sessionId, task);
    return task;
  }

  /** 合并磁盘索引与内存索引（内存版本更新，同一 startSeq 以内存为准） */
  private _mergeTurnIndex(tenantId: string, sessionId: string): SessionTurnIndexEntry[] {
    const byStart = new Map<number, SessionTurnIndexEntry>();
    for (const e of this.store.loadTurnIndex(tenantId, sessionId)) byStart.set(e.startSeq, e);
    for (const e of this.turnIndexCache.get(sessionId) ?? []) byStart.set(e.startSeq, e);
    return [...byStart.values()].sort((a, b) => a.startSeq - b.startSeq);
  }

  /** 从 events.jsonl 顺序流式重建轮次索引（一次性，之后增量维护） */
  private async _rebuildTurnIndex(
    tenantId: string,
    sessionId: string,
  ): Promise<SessionTurnIndexEntry[]> {
    const __t0 = dbgNow(); // [dbg]
    const events = await this.store.readEventsAsync(tenantId, sessionId);
    const entries = buildTurnIndex(events);
    if (entries.length > 0) {
      await this.store.saveTurnIndex(tenantId, sessionId, entries);
      // 只在有运行时（后续会有增量写入）时才缓存；纯历史会话读文件即可，避免缓存无界增长
      if (this.runtimes.has(sessionId)) this.turnIndexCache.set(sessionId, entries);
    }
    dbgMs("session._rebuildTurnIndex", __t0, // [dbg]
      `sid=${sessionId.slice(0, 8)} events=${events.length} turns=${entries.length}`);
    return entries;
  }

  /**
   * 按字节预算截取事件「尾部」（至少保留最后一条），确保 MQTT 回执远小于单包上限。
   * 供 get_events 使用：会话历史可任意大，但 MQTT 链路不能承载大包。
   */
  private _boundedTail(events: EventEntry[], maxBytes = EVENTS_ACK_MAX_BYTES): EventEntry[] {
    const __t0 = dbgNow(); // [dbg]
    let total = 0;
    let i = events.length;
    while (i > 0) {
      const size = Buffer.byteLength(JSON.stringify(events[i - 1]));
      if (total > 0 && total + size > maxBytes) break;
      total += size;
      i -= 1;
    }
    const out = i === 0 ? events : events.slice(i);
    dbgMs("session._boundedTail", __t0, // [dbg]
      `in=${events.length} out=${out.length} bytes≈${total}`);
    return out;
  }

  /** 订阅 SSE（自 since 起回放 + 实时增量） */
  subscribe(tenantId: string, sessionId: string, res: ServerResponse, since = 0): void {
    const rt = this._getOrLoadRuntimeStrict(tenantId, sessionId);
    if (!rt) {
      this._sseClose(res);
      return;
    }
    // 禁用 Nagle 算法，确保 SSE 帧即时推送
    res.socket?.setNoDelay?.(true);
    // 禁用 socket 空闲超时（SSE 长连接必须保持）
    res.socket?.setTimeout(0);
    // 自 since 起回放（默认 0=全部；上层传"本轮开始前的 seq"可避免重放上一轮历史）
    for (const entry of rt.events) {
      if (entry.seq > since) this._sseSend(res, entry);
    }
    rt.subscribers.add(res);
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(": ping\n\n");
    }, 15000);
    rt.heartbeats.set(res, heartbeat);
    // 连接异常或主动关闭时清理
    const cleanup = () => {
      rt.subscribers.delete(res);
      clearInterval(heartbeat);
      rt.heartbeats.delete(res);
    };
    res.on("close", cleanup);
    res.on("error", () => {
      // 连接出错（如客户端断网），主动销毁 socket 避免资源泄漏
      res.socket?.destroy();
      cleanup();
    });
  }

  private _sseSend(res: ServerResponse, entry: EventEntry): void {
    if (res.writableEnded) return;
    const frame = `id: ${entry.seq}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry.data)}\n\n`;
    // write 失败意味着连接已断开，不抛异常避免影响其他订阅者
    if (!res.write(frame)) {
      // 内核发送缓冲区满时返回 false，drain 事件后会恢复；
      // SSE 场景帧很小，几乎不会触发，这里仅防御性记录
    }
  }

  private _sseClose(res: ServerResponse): void {
    try {
      res.write("event: closed\ndata: {}\n\n");
      res.end();
    } catch {
      // 忽略已关闭的连接
    }
  }

  // ===================== 内部 =====================

  /** 获取或加载运行时（会话不存在则报错） */
  private _getOrLoadRuntime(tenant: TenantConfig, sessionId: string): SessionRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const rec = this.store.loadSession(tenant.id, sessionId);
    if (!rec) throw new ApiError(404, "not_found", "会话不存在");
    return this._hydrate(tenant, rec);
  }

  /** 获取或加载运行时（会话不存在则返回 null） */
  private _getOrLoadRuntimeStrict(tenantId: string, sessionId: string): SessionRuntime | null {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const rec = this.store.loadSession(tenantId, sessionId);
    if (!rec) return null;
    const tenant = this.store.loadTenant(tenantId);
    if (!tenant) return null;
    return this._hydrate(tenant, rec);
  }

  /** 从磁盘物化状态重建内存运行时（不装配引擎） */
  private _hydrate(tenant: TenantConfig, rec: SessionRecord): SessionRuntime {
    const __t0 = dbgNow(); // [dbg]
    const events = this.store.loadEventsTail(
      rec.tenantId,
      rec.sessionId,
      EVENTS_ACK_MAX_BYTES * 2,
    );
    dbgMs("session._hydrate", __t0, `sid=${rec.sessionId.slice(0, 8)} events=${events.length}`); // [dbg]
    // 磁盘上标记为 running 却需要重新物化 → 没有对应的内存 run 任务
    // （有的话会命中 runtimes 缓存），属于进程重启/崩溃遗留的孤儿状态。
    // 以 interrupted 物化并回写，避免界面一直停在「运行中/推理中」。
    const orphanRunning = rec.status === "running";
    const rt: SessionRuntime = {
      tenantId: rec.tenantId,
      sessionId: rec.sessionId,
      tenant,
      workspace: this.store.ensureWorkspace(rec.tenantId, rec.sessionId),
      status: orphanRunning ? "interrupted" : rec.status,
      engine: null,
      runTask: null,
      approvals: new Map(rec.approvals.map((a) => [a.id, a])),
      questions: new Map(rec.questions.map((q) => [q.id, q])),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      allowTools: new Set(rec.sessionAllowTools),
      allowCommands: new Set(rec.sessionAllowCommands),
      events,
      seq: events.at(-1)?.seq ?? 0,
      subscribers: new Set(),
      heartbeats: new Map(),
      lastMessages: rec.messages,
      lastModel: rec.model,
      modelOverridden: rec.modelOverridden,
      providerId: rec.providerId,
      permissionMode: rec.permissionMode ?? "interactive",
      draft: rec.draft,
      pendingSteers: [],
      lastInput: rec.lastInput,
      usage: rec.usage,
      lastCompaction: rec.compaction,
      name: rec.name,
      nameSource: rec.nameSource,
      taskCount: rec.taskCount ?? 0,
      lastCompletedAt: rec.lastCompletedAt,
      lastStartedAt: rec.lastStartedAt,
      naming: false,
      turnStartedAt: 0,
    };
    this.runtimes.set(rt.sessionId, rt);
    // 修正孤儿状态后再落盘（内部走异步写链，不阻塞本次读取）
    if (orphanRunning) this._persist(rt);
    return rt;
  }

  /** 忙碌检查：run 进行中或有未决审批/提问（含磁盘 pending）时拒绝新 turn */
  private _assertIdle(rt: SessionRuntime): void {
    if (rt.runTask) throw new ApiError(409, "busy", "会话正在运行中");
    const hasPending =
      rt.pendingApprovals.size > 0 ||
      rt.pendingQuestions.size > 0 ||
      [...rt.approvals.values()].some((a) => a.status === "pending") ||
      [...rt.questions.values()].some((q) => q.status === "pending");
    if (hasPending) {
      throw new ApiError(409, "has_pending_interaction", "存在未决的审批或提问");
    }
  }

  /** 装配引擎并启动一轮 Turn（供 submitTurn / submitOrSteer 复用） */
  private _startTurn(
    rt: SessionRuntime,
    input: string,
    attachments?: MessageAttachment[],
  ): void {
    // 先装配引擎：**未配置 LLM 时这里会同步抛错**（`OpenAIProvider` 构造缺 apiKey）。
    // 必须放在改状态之前，否则提交失败后会话会卡在 running——控制台一直显示
    // 「运行中 / 终止」，还会把这条根本没发出去的输入广播成 lastUserMessage。
    //
    // 新 turn：清洗历史中悬空的 tool_calls（无工具结果的），否则 LLM 会报
    // 400 "No tool output found for tool call ..."
    const engine = this._buildEngine(rt.tenant, rt, true);
    // 发送即写入最近指令：引擎要等 run() 首次推进才 push 到 messages，
    // 先记在运行时字段上（_setStatus 的 session_status 也要带上它），
    // 紧跟的 _persist 就能让首页列表立刻看到本条输入。
    // 纯附件（无文本）时用文件名占位，避免列表里显示一条空指令。
    rt.lastInput =
      input || (attachments?.length ? `[附件] ${attachments.map((a) => a.name).join("、")}` : "");
    // 附件先落盘：消息与事件只带轻量引用，控制台据此显示缩略图、详情里回看
    const attachmentRefs = saveAttachments(
      this.store.sessionDir(rt.tenantId, rt.sessionId),
      attachments,
    );
    // 最近一次「任务请求开始时刻」：工作台的节点/项目/任务都按它倒序，
    // 所以必须在 _setStatus 之前写好——那条 session_status 通知要带上它，
    // 总览页才能即时把该会话排到最前，而不必等下一次全量快照。
    rt.turnStartedAt = Date.now();
    rt.lastStartedAt = new Date(rt.turnStartedAt).toISOString();
    this._setStatus(rt, "running");
    rt.engine = engine;
    // 立即落盘 running：GET /state 读的是磁盘上的 record，不落盘会一直是 idle，
    // 导致控制台刚发送时看不到「运行中 / 终止」
    this._persist(rt);
    rt.runTask = this._drive(rt, engine.run(input, undefined, attachments, attachmentRefs));
  }

  /**
   * 附件必须被「当前生效模型」支持。
   *
   * 能力由用户在「节点配置 → LLM」里按模型勾选，随 `modelMeta.capabilities` 落盘。
   * 在提交前挡住，比把图发给不支持视觉的模型、再拿一个供应商的 400 更好排查。
   */
  private _assertAttachmentsSupported(
    tenant: TenantConfig,
    rt: SessionRuntime,
    attachments?: MessageAttachment[],
  ): void {
    if (!attachments?.length) return;
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new ApiError(400, "bad_request", `附件最多 ${MAX_ATTACHMENTS} 个`);
    }
    // 与 _buildEngine 相同的模型解析顺序：会话覆盖 > 所选配置自带模型 > 项目模型
    const eff = resolveSessionProvider(this.store, tenant, rt.providerId);
    const model = rt.modelOverridden
      ? rt.lastModel
      : rt.providerId && eff.model
        ? eff.model
        : tenant.model;
    const caps = new Set(modelCapabilities(eff.modelMeta, model));
    for (const a of attachments) {
      const cap = capabilityOfMime(a.mimeType);
      if (!cap || caps.has(cap)) continue;
      throw new ApiError(
        400,
        "unsupported_attachment",
        `模型 ${model || "（未设置）"} 未启用${CAPABILITY_LABELS_ZH[cap]}输入能力，` +
          `请在「节点配置 → LLM」里为该模型勾选`,
      );
    }
  }

  /**
   * 清洗历史消息用于新 turn：移除「未被工具结果闭合」的 assistant.tool_calls
   * 及其孤立工具结果，保留完整闭合的工具调用。
   */
  private _sanitizeForNewTurn(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    const resultIds = new Set<string>();
    for (const m of list) {
      const mm = m as { role?: string; tool_call_id?: string } | null | undefined;
      if (mm?.role === "tool" && mm.tool_call_id) resultIds.add(String(mm.tool_call_id));
    }
    const out: Array<Record<string, unknown>> = [];
    for (const raw of list) {
      const m = raw as Record<string, unknown> | null | undefined;
      if (!m) continue;
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        const kept = (m.tool_calls as Array<{ id?: string }>).filter(
          (tc) => tc?.id && resultIds.has(String(tc.id)),
        );
        if (kept.length === 0) {
          const { tool_calls, ...rest } = m;
          void tool_calls;
          if (rest.content) out.push(rest);
        } else {
          out.push({ ...m, tool_calls: kept });
        }
        continue;
      }
      out.push(m);
    }
    return out;
  }

  /** 消费事件流：缓冲 + 状态机推进 + 关键点持久化 */
  private async _drive(rt: SessionRuntime, gen: AsyncGenerator<WsEvent>): Promise<void> {
    const engine = rt.engine;
    try {
      await sessionContext.run(rt.sessionId, async () => {
        // 首个 turn 前等待 MCP 工具注入完成，避免 LLM 工具列表里看不到 MCP 工具
        if (rt.mcpReady) {
          await Promise.race([
            rt.mcpReady,
            new Promise((resolve) => setTimeout(resolve, 15000)),
          ]).catch(() => undefined);
        }
        for await (const event of gen) {
          // 收尾类事件要等状态落定之后再对外可见：客户端收到它们会立刻拉一次 /state，
          // 若此刻 rt.status 仍是 running，界面就停在「生成中」/「终止中」，
          // 直到 30s 兜底轮询才恢复。其他事件没有这个依赖，保持即时下发。
          const deferUntilSettled =
            event.type === EventType.TURN_END ||
            event.type === EventType.INTERRUPTED ||
            event.type === EventType.ERROR;
          if (!deferUntilSettled) this._buffer(rt, event);
          switch (event.type) {
            case EventType.TURN_END: {
              const status = event.data.status;
              const summary = this._lastAssistantText(rt);
              const durationMs = rt.turnStartedAt > 0 ? Date.now() - rt.turnStartedAt : undefined;
              if (status === "completed") {
                this._setStatus(rt, "completed");
                rt.taskCount += 1;
                rt.lastCompletedAt = new Date().toISOString();
                this._emitNotify(
                  rt,
                  "turn_completed",
                  this._turnEndData(rt, event.data, { summary, durationMs }),
                );
              } else if (status === "max_iterations_exceeded") {
                this._setStatus(rt, "stopped");
                this._emitNotify(
                  rt,
                  "turn_stopped",
                  this._turnEndData(rt, event.data, { summary, durationMs }),
                );
              }
              this._persist(rt);
              // 第 1/3/5 次任务成功后，后台生成会话名（不阻塞，异常静默）
              if (status === "completed" && engine && shouldAutoName(rt.taskCount, rt.nameSource)) {
                void this._autoName(rt, engine);
              }
              break;
            }
            case EventType.ERROR:
              this._setStatus(rt, "error");
              this._persist(rt);
              // 同样补上会话名/用户消息：错误弹窗也需要说明是哪个任务出的错
              this._emitNotify(rt, "error", this._turnEndData(rt, event.data, {}));
              // 内置模型的 Key 在控制台被重置后本机这份会失效：自动重领一次
              //（节流 + 静默；用户重试即可继续，不必手工去点刷新）
              healBuiltinOnAuthFailure(this.store, String(event.data["error"] ?? ""));
              break;
            case EventType.INTERRUPTED:
              this._setStatus(rt, "interrupted");
              this._persist(rt);
              break;
            case EventType.QUEUE_STEERING: {
              // 已注入聊天流 → 从待注入队列移除（前端据此撤掉排队提示）
              const text = String(event.data["text"] ?? "");
              const i = rt.pendingSteers.indexOf(text);
              if (i >= 0) rt.pendingSteers.splice(i, 1);
              break;
            }
          }
          if (deferUntilSettled) {
            // 事件对外可见之前，先让磁盘快照跟上：客户端收到它会立刻拉 /state。
            // 写盘失败时 saveSession 内部已兜住（不抛），退化为下一条事件或兜底轮询修正。
            await this._persistAndWait(rt);
            this._buffer(rt, event);
          }
        }
      });
    } catch (exc) {
      this._buffer(rt, {
        type: EventType.ERROR,
        data: {
          error: String(exc instanceof Error ? exc.message : exc),
          retriable: false,
        },
      });
      this._setStatus(rt, "error");
      this._persist(rt);
    } finally {
      // 轮次索引：事件流异常中断时不会有 turn_end，这里补一版终态
      if (rt.turnIndex) {
        const turn = rt.turnIndex;
        if (!turn.endedAt && turn.error) turn.status = "error";
        this._appendTurnIndex(rt, turn);
        rt.turnIndex = undefined;
        rt.turnToolKeys = undefined;
      }
      // 任务结束/回收：释放引擎引用，一切状态以磁盘为准
      rt.runTask = null;
      rt.engine = null;
      // 未注入的补充信息随本轮任务结束一起作废
      rt.pendingSteers = [];
      rt.steerBaseInput = undefined;
    }
  }

  /**
   * 记录一条事件：分配 seq → 内存缓冲 → 落盘 → SSE → 广播 → 外部桥接。
   *
   * 流式 delta 不直接走这里：先按窗口合并（见 _bufferDelta），
   * 否则一次几百 token 的回复会变成几百条事件与几百次渲染。
   */
  private _buffer(rt: SessionRuntime, event: WsEvent): void {
    if (DELTA_FLUSH_MS > 0 && isDeltaEvent(event.type)) {
      this._bufferDelta(rt, event, DELTA_FLUSH_MS);
      return;
    }
    // 非 delta 事件自带语义边界（收轮、完整消息、中断…）：
    // 必须先把窗口内累积的 delta 发出去，保证事件顺序与 seq 单调。
    this._flushDelta(rt);
    this._emitEntry(rt, event);
  }

  /** 把 delta 累积进桶，首个 delta 开启合并窗口 */
  private _bufferDelta(rt: SessionRuntime, event: WsEvent, delayMs: number): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const key = `${event.type}|${String(data["reqId"] ?? "")}|${String(data["taskId"] ?? "")}`;
    const buffer = (rt.deltaBuffer ??= new Map<string, PendingDelta>());
    const text = String(data["text"] ?? "");
    const bucket = buffer.get(key);
    if (bucket) {
      bucket.text += text;
    } else {
      buffer.set(key, {
        type: event.type,
        reqId: data["reqId"],
        taskId: data["taskId"],
        text,
      });
    }
    if (rt.deltaTimer) return;
    rt.deltaTimer = setTimeout(() => {
      rt.deltaTimer = undefined;
      this._flushDelta(rt);
    }, delayMs);
    // 合并窗口只是渲染优化，不应该拖住进程退出
    rt.deltaTimer.unref?.();
  }

  /**
   * 把窗口内的 delta 合并成一条事件发出。
   *
   * 按桶的插入顺序发出，因此同类文本的先后关系严格保持；不同类（思考/正文）
   * 之间只可能在同一个窗口内互换位置，视觉上不可感知。
   */
  private _flushDelta(rt: SessionRuntime): void {
    if (rt.deltaTimer) {
      clearTimeout(rt.deltaTimer);
      rt.deltaTimer = undefined;
    }
    const buffer = rt.deltaBuffer;
    if (!buffer || buffer.size === 0) return;
    rt.deltaBuffer = undefined;
    for (const b of buffer.values()) {
      this._emitEntry(rt, {
        type: b.type as EventType,
        data: { text: b.text, reqId: b.reqId, taskId: b.taskId },
      });
    }
  }

  /** 单条事件的落地流程（分配 seq 之后的所有副作用） */
  private _emitEntry(rt: SessionRuntime, event: WsEvent): void {
    const entry: EventEntry = {
      seq: ++rt.seq,
      ts: new Date().toISOString(),
      type: event.type,
      data: event.data,
    };
    rt.events.push(entry);
    if (rt.events.length > EVENT_BUFFER_MAX) rt.events.shift();
    // 异步写磁盘，不阻塞事件循环（SSE 心跳依赖事件循环不被阻塞）
    void this.store.appendEvent(rt.tenantId, rt.sessionId, entry);
    // 轮次索引：只落「开轮 / 补充消息 / 收轮」三个时机，delta 不写盘
    this._trackTurnIndex(rt, entry);
    for (const res of rt.subscribers) this._sseSend(res, entry);
    // 广播给节点级事件流订阅者（控制台单连接多会话）
    this._broadcastSessionEvent(rt.tenantId, rt.sessionId, entry);
    // 桥接给 MQTT 等外部事件消费者（异常隔离）
    try {
      this.eventHandler?.(rt.tenantId, rt.sessionId, entry);
    } catch {
      // 忽略外部消费者异常
    }
  }

  /**
   * 维护运行中轮次的索引（in-memory 记账 + 关键节点落盘）。
   *
   * 落盘只在「开轮 / 补充消息 / 收轮」发生，delta 事件仅推进 endSeq 与统计，
   * 因此索引写入量是每轮 2~3 行，与会话事件量无关。
   */
  private _trackTurnIndex(rt: SessionRuntime, ev: EventEntry): void {
    if (ev.type === "turn_start") {
      const turn = newTurnEntry(ev, String(ev.data?.["input"] ?? ""));
      rt.turnIndex = turn;
      rt.turnToolKeys = new Set();
      this._appendTurnIndex(rt, turn);
      return;
    }
    const turn = rt.turnIndex;
    if (!turn) return;
    if (ev.type === "turn_end" || ev.type === "interrupted") {
      closeTurnEntry(turn, ev);
      this._appendTurnIndex(rt, turn);
      rt.turnIndex = undefined;
      rt.turnToolKeys = undefined;
      return;
    }
    if (!rt.turnToolKeys) rt.turnToolKeys = new Set();
    const inputsBefore = turn.inputs.length;
    applyTurnEvent(turn, ev, rt.turnToolKeys);
    // 补充信息改变了用户消息列表：立即落一版，运行中也能看到
    if (turn.inputs.length !== inputsBefore) this._appendTurnIndex(rt, turn);
  }

  /** 写入一版轮次索引（内存副本 + 异步落盘） */
  private _appendTurnIndex(rt: SessionRuntime, turn: SessionTurnIndexEntry): void {
    const cached = this.turnIndexCache.get(rt.sessionId) ?? [];
    const i = cached.findIndex((t) => t.startSeq === turn.startSeq);
    const next = i >= 0 ? [...cached.slice(0, i), turn, ...cached.slice(i + 1)] : [...cached, turn];
    this.turnIndexCache.set(rt.sessionId, next);
    void this.store.appendTurnIndex(rt.tenantId, rt.sessionId, turn);
  }

  /** 回收内存 run 任务（释放引用交给 GC；磁盘状态保持不动） */
  private _recycleRunTask(rt: SessionRuntime): void {
    rt.runTask = null;
    rt.engine = null;
    // 关闭该引擎绑定的 MCP 连接（工具随 engine.registry 一起丢弃）
    if (rt.mcpManager) {
      void rt.mcpManager.closeAll().catch((err) => console.error("[mcp] 关闭失败:", err));
      rt.mcpManager = undefined;
    }
  }

  private _cancelTimers(rt: SessionRuntime): void {
    // 窗口内的 delta 先落成事件：销毁会话不应留下一段已产出但未记录的文本
    this._flushDelta(rt);
    for (const p of rt.pendingApprovals.values()) clearTimeout(p.timer);
    for (const q of rt.pendingQuestions.values()) clearTimeout(q.timer);
    for (const h of rt.heartbeats.values()) clearInterval(h);
    rt.pendingApprovals.clear();
    rt.pendingQuestions.clear();
    rt.heartbeats.clear();
  }

  /** 从运行时状态组装并落盘物化状态（异步写盘，不阻塞事件循环） */
  private _persist(rt: SessionRuntime): void {
    void this._persistAndWait(rt);
  }

  /**
   * 落盘并返回完成信号。
   *
   * 收尾事件（turn_end / interrupted / error）必须等它完成后再对外可见：
   * 客户端收到事件会立刻拉 /state，而 /state 读的是磁盘。若此时写盘还没完成，
   * 拿到的仍是 running，界面就停在「生成中」直到 30s 兜底轮询。
   */
  private _persistAndWait(rt: SessionRuntime): Promise<void> {
    const rec = this._toRecord(rt);
    rt.lastMessages = rec.messages;
    rt.lastModel = rec.model;
    rt.modelOverridden = rec.modelOverridden;
    rt.lastCompaction = rec.compaction;
    return this.store.saveSession(rec);
  }

  /** 运行时状态转物化状态 */
  private _toRecord(rt: SessionRuntime): SessionRecord {
    const engine = rt.engine;
    return {
      sessionId: rt.sessionId,
      tenantId: rt.tenantId,
      model: engine?.model ?? rt.lastModel,
      name: rt.name,
      nameSource: rt.nameSource,
      taskCount: rt.taskCount,
      lastCompletedAt: rt.lastCompletedAt,
      lastStartedAt: rt.lastStartedAt,
      modelOverridden: rt.modelOverridden,
      providerId: rt.providerId,
      permissionMode: rt.permissionMode,
      draft: rt.draft,
      lastInput: rt.lastInput,
      usage: rt.usage,
      // 附件只随本轮请求发送：落盘前剥离 base64，避免 session.json 膨胀
      messages: stripAttachments(engine?.messages ?? rt.lastMessages),
      compaction: engine?.compactionState
        ? {
            boundaryIndex: engine.compactionState.boundaryIndex,
            summaryText: engine.compactionState.summaryText,
            workingState: engine.compactionState.workingState,
            userMessages: engine.compactionState.userMessages,
            userMessagesDropped: engine.compactionState.userMessagesDropped,
            createdAt: engine.compactionState.createdAt,
            modelUsed: engine.compactionState.modelUsed,
            trimmed: engine.compactionState.trimmed,
          }
        : rt.lastCompaction,
      status: rt.status,
      approvals: [...rt.approvals.values()],
      questions: [...rt.questions.values()],
      sessionAllowTools: [
        ...new Set([
          ...rt.allowTools,
          ...(engine ? [...engine.permissions.sessionAllowTools] : []),
        ]),
      ],
      sessionAllowCommands: [
        ...new Set([
          ...rt.allowCommands,
          ...(engine ? [...engine.permissions.sessionAllowCommands] : []),
        ]),
      ],
      savedAt: new Date().toISOString(),
    };
  }

  /** 提取最后一条 assistant 文本（供完成通知/邮件正文使用） */
  private _lastAssistantText(rt: SessionRuntime): string | undefined {
    const msgs = (rt.engine?.messages ?? rt.lastMessages) as Array<{
      role?: string;
      content?: unknown;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
        return m.content;
      }
    }
    return undefined;
  }

  /** 磁盘消息历史末尾是否有未回答的 assistant tool_calls（可 resume） */
  private _hasUnansweredTrailingToolCalls(rec: SessionRecord): boolean {
    const msgs = rec.messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string }>;
    }>;
    const answered = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "user") return false;
      if (m.role === "assistant" && m.tool_calls) {
        return m.tool_calls.some((tc) => !answered.has(tc.id));
      }
    }
    return false;
  }

  // ===================== 引擎装配 =====================

  /** 为会话装配全新 TurnEngine（工具注册/权限/审批器/持久化 hook） */
  private _buildEngine(
    tenant: TenantConfig,
    rt: SessionRuntime,
    sanitizeForNewTurn = false,
  ): TurnEngine {
    // LLM 供应商解析优先级：会话级指定 > 项目配置 > 节点默认（新项目继承）
    const eff = resolveSessionProvider(this.store, tenant, rt.providerId);
    const effProvider = { apiKey: eff.apiKey, baseURL: eff.baseURL };
    // 模型：会话显式指定 > 所选配置自带模型 > 项目默认模型
    const activeModel = rt.modelOverridden
      ? rt.lastModel
      : rt.providerId && eff.model
        ? eff.model
        : tenant.model;
    const provider = this.opts.providerFactory
      ? this.opts.providerFactory(tenant)
      : new OpenAIProvider(effProvider);
    // 优先使用租户配置的工作区根目录，否则使用会话独立沙箱
    const workspace = tenant.workspaceRoot ?? rt.workspace;

    const registry = new ToolRegistry();
    // 每个会话独立的冲突检测器：多会话共享工作区时，A 读完文件后 B 又改了，
    // A 的写入会被拒绝而不是静默覆盖
    const conflictGuard = new ConflictGuard();
    registerFileTools(registry, workspace, conflictGuard);
    // 服务端默认不启用沙箱（保持既有部署行为），由租户配置显式开启
    const sandboxPlan = resolveSandbox({
      mode: tenant.sandbox?.mode ?? "off",
      extraWritable: tenant.sandbox?.extraWritable ?? [],
      workspace,
    });
    // sessionKey 必须是会话级：多个会话共享同一 workspaceRoot 时，
    // 只按 workspace 做键会让它们的 shell cwd 互相覆盖
    const shellSessionKey = `${tenant.id}/${rt.sessionId}`;
    registerShellTool(registry, workspace, tenant.id, sandboxPlan, shellSessionKey);
    registerSearchTool(registry, workspace);
    registerWebTools(registry);
    registerGitTools(registry, workspace);
    registerDiffTools(registry, workspace, conflictGuard);
    registerAskTool(registry);
    registerPlanTool(registry);
    registerDirectoryTool(registry);
    registerMediaTool(registry, workspace);

    const todo = new TodoList();
    registerTodoTool(registry, todo);
    this.opts.extraTools?.(registry);
    registerExploreTool(registry, {
      workspace,
      provider,
      model: activeModel,
    });

    const permissions = new PermissionEngine({
      workspaceRoot: workspace,
      mode: (["discuss", "plan", "interactive", "auto"].includes(rt.permissionMode)
        ? rt.permissionMode
        : "interactive") as Mode,
      allowedCommands: tenant.allowedCommands ?? [],
      shellPolicy: tenant.shellPolicy ?? "approve",
      sandbox: {
        enforced: sandboxPlan.enforced,
        backend: sandboxPlan.backend,
        reason: sandboxPlan.reason,
      },
      shellCwd: () => getShellCwd(workspace, shellSessionKey),
    });
    for (const t of rt.allowTools) permissions.allowToolForSession(t);
    for (const c of rt.allowCommands) permissions.allowCommandForSession(c);

    const today = new Date().toISOString().split("T")[0];
    const instructions = buildInstructions("code", workspace, today);

    // 变更追踪：每轮结束记一个快照。多会话共享工作区时，
    // 这是事后判断「谁改了什么」的唯一可靠来源（事件日志只有工具意图，没有文件内容）
    const sessionVcs = new SessionVcs(
      resolveVcsPlan(workspace, { mode: tenant.vcs?.mode ?? "auto" }),
      rt.sessionId,
    );
    const vcsHook = new VcsHook(sessionVcs);
    const baseHook = this._makeHook(rt);
    const hook: EngineHook = {
      ...baseHook,
      onTurnEnd: (status, iterations, producedFiles) => {
        baseHook.onTurnEnd?.(status, iterations, producedFiles);
        vcsHook.onTurnEnd(status);
      },
    };

    // 推理强度：优先取所选供应商的配置，回退环境变量 OPENAI_REASONING_EFFORT（非法值忽略）
    const envEffort = process.env.OPENAI_REASONING_EFFORT?.toLowerCase();
    const envReasoning: ReasoningEffort | undefined =
      envEffort === "low" || envEffort === "medium" || envEffort === "high" ? envEffort : undefined;
    const reasoningEffort: ReasoningEffort | undefined =
      eff.reasoningEffort ?? envReasoning;

    const engine = new TurnEngine({
      provider,
      registry,
      permissions,
      model: activeModel,
      instructions,
      maxIterations: parseMaxIterations(
        process.env.MAX_ITERATIONS,
        DEFAULT_MAX_ITERATIONS,
      ),
      reasoningEffort,
      messages: (sanitizeForNewTurn
        ? this._sanitizeForNewTurn(rt.lastMessages)
        : rt.lastMessages) as never[],
      hook,
      // 上下文窗口：环境变量显式覆盖 > 供应商 /models 提供的真实长度 > 引擎内置表
      contextWindow:
        parseOptionalPositiveNumber(process.env.CONTEXT_WINDOW) ??
        modelContextWindow(eff.modelMeta, activeModel),
      thresholdPct: parseRatio(process.env.COMPACTION_THRESHOLD_PCT),
      softThresholdPct: parseRatio(process.env.COMPACTION_SOFT_THRESHOLD_PCT),
      capTokens: parseOptionalPositiveNumber(process.env.COMPACTION_CAP_TOKENS) ?? null,
      // 超预算工具结果按租户/工作区隔离落盘（多租户共用一个状态目录会混内容）
      toolResultDir: path.join(workspace, ".agent", "tool-results"),
    });
    engine.setApprover(this._makeApprover(rt));

    // 装配 MCP：来源 MCP_CONFIG_PATH / tenant.mcpServers / .agent/mcp.json。
    // 后台连接（连接完成后工具对后续 LLM 调用即时生效），单点失败不阻塞引擎。
    const mcpConfigs = loadServerMcpConfigs(tenant);
    if (mcpConfigs.length > 0) {
      const mcpManager = new McpManager(engine.registry, mcpConfigs, {
        builtin: {
          workspace,
          env: process.env,
          // 多模态 OCR 兜底：复用本会话生效的供应商配置
          llm: {
            apiKey: eff.apiKey,
            baseURL: eff.baseURL,
            model: activeModel,
          },
        },
      });
      rt.mcpManager = mcpManager;
      rt.mcpReady = mcpManager
        .connectAll()
        .then((r) => {
          if (r.connected.length > 0) console.log(`[mcp] 已连接: ${r.connected.join(", ")}`);
          if (r.failed.length > 0)
            console.warn(`[mcp] 连接失败: ${r.failed.map((f) => f.name).join(", ")}`);
        })
        .catch((err) => console.error("[mcp] 装配异常:", err));
    } else {
      rt.mcpReady = undefined;
    }

    return engine;
  }

  /** 持久化 hook：迭代结束等关键点保存物化状态；同时登记 LLM 用量 */
  private _makeHook(rt: SessionRuntime): EngineHook {
    return {
      onIterationEnd: () => this._persist(rt),
      onCompacted: () => this._persist(rt),
      onAssistantMessage: (_text, _tools, usage) => {
        if (usage) this._recordUsage(rt, usage);
      },
    };
  }

  /** 登记一次 LLM 调用的用量：写账本 + 更新会话累计（并持久化） */
  private _recordUsage(rt: SessionRuntime, usage: TokenCounts): void {
    const ledger = this.opts.usage;
    const tokens: TokenCounts = {
      input: Number(usage.input ?? 0) || 0,
      output: Number(usage.output ?? 0) || 0,
      cacheRead: Number(usage.cacheRead ?? 0) || 0,
      cacheWrite: Number(usage.cacheWrite ?? 0) || 0,
    };
    const model = rt.engine?.model ?? rt.lastModel ?? rt.tenant.model;
    const { vendor, providerId } = resolveVendor(
      rt.tenant,
      this.store.loadNodeLlm(),
      rt.providerId,
    );
    const costUsd = ledger ? ledger.costOf(vendor, model, tokens) : null;

    const prev: SessionUsage =
      rt.usage ?? {
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        unpriced: 0,
        updatedAt: new Date().toISOString(),
      };
    rt.usage = {
      calls: prev.calls + 1,
      input: prev.input + tokens.input,
      output: prev.output + tokens.output,
      cacheRead: prev.cacheRead + tokens.cacheRead,
      cacheWrite: prev.cacheWrite + tokens.cacheWrite,
      costUsd: prev.costUsd + (costUsd ?? 0),
      unpriced: prev.unpriced + (costUsd == null ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };

    if (ledger) {
      const ts = new Date().toISOString();
      ledger.record({
        ts,
        projectId: rt.tenantId,
        sessionId: rt.sessionId,
        vendor,
        model,
        providerId,
        ...tokens,
        ok: true,
      });
    }
    this._persist(rt);
  }

  /**
   * 历史基线（一次性）：把既有会话消息里的 usage 汇总进账本基线，并补齐会话累计字段。
   * 账本明细从启用当天开始，不伪造历史明细。
   */
  seedUsageBaseline(): { seeded: boolean; calls: number } {
    const ledger = this.opts.usage;
    if (!ledger) return { seeded: false, calls: 0 };
    ledger.init();
    if (ledger.getRollup().legacy) return { seeded: false, calls: 0 };

    const agg = {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      unpriced: 0,
    };
    let throughTs = ledger.getRollup().since;

    for (const tenantId of this.store.listTenants()) {
      const tenant = this.store.loadTenant(tenantId);
      if (!tenant) continue;
      const { vendor } = resolveVendor(tenant, this.store.loadNodeLlm());
      for (const sessionId of this.store.listSessions(tenantId)) {
        const rec = this.store.loadSession(tenantId, sessionId);
        if (!rec) continue;
        // 已带累计（先前迁移过或本账本已记账）→ 直接并入基线
        if (rec.usage) {
          agg.calls += rec.usage.calls;
          agg.input += rec.usage.input;
          agg.output += rec.usage.output;
          agg.cacheRead += rec.usage.cacheRead;
          agg.cacheWrite += rec.usage.cacheWrite;
          agg.costUsd += rec.usage.costUsd;
          agg.unpriced += rec.usage.unpriced;
          if (rec.usage.updatedAt && rec.usage.updatedAt > throughTs) {
            throughTs = rec.usage.updatedAt;
          }
          continue;
        }
        let calls = 0;
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let cost = 0;
        let unpriced = 0;
        for (const m of rec.messages as Array<Record<string, unknown>>) {
          const u = m?.usage as
            | { model?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
            | undefined;
          if (!u) continue;
          const tokens: TokenCounts = {
            input: Number(u.input ?? 0) || 0,
            output: Number(u.output ?? 0) || 0,
            cacheRead: Number(u.cacheRead ?? 0) || 0,
            cacheWrite: Number(u.cacheWrite ?? 0) || 0,
          };
          calls += 1;
          input += tokens.input;
          output += tokens.output;
          cacheRead += tokens.cacheRead;
          cacheWrite += tokens.cacheWrite;
          const c = ledger.costOf(vendor, String(u.model ?? rec.model), tokens);
          if (c == null) unpriced += 1;
          else cost += c;
        }
        if (calls === 0) continue;
        const sessionUsage: SessionUsage = {
          calls,
          input,
          output,
          cacheRead,
          cacheWrite,
          costUsd: cost,
          unpriced,
          updatedAt: rec.savedAt,
        };
        this.store.saveSessionSync({ ...rec, usage: sessionUsage });
        agg.calls += calls;
        agg.input += input;
        agg.output += output;
        agg.cacheRead += cacheRead;
        agg.cacheWrite += cacheWrite;
        agg.costUsd += cost;
        agg.unpriced += unpriced;
        if (rec.savedAt && rec.savedAt > throughTs) throughTs = rec.savedAt;
      }
    }
    if (agg.calls > 0) ledger.seedLegacy(agg, throughTs);
    return { seeded: agg.calls > 0, calls: agg.calls };
  }
}

/** HTTP 层错误（携带状态码与错误码） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 辅助：工作区路径（供路由/文档引用） */
export function workspaceOf(root: string, tenantId: string, sessionId: string): string {
  return path.join(root, "tenants", tenantId, "workspaces", sessionId);
}
