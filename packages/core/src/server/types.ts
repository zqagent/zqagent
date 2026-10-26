/**
 * 云端 Server 类型定义
 *
 * 多租户 Agent 服务：每租户独立工作区 / 模型配置 / 状态存储。
 * 会话采用「物化状态 + 挂起-恢复」模型——审批与提问等交互点
 * 全部落盘，内存中的 run 任务可随时回收（超时/进程重启），
 * 之后通过 engine.resume() 从磁盘状态精确恢复继续执行。
 */

import type { ApprovalOutcome } from "../engine/events.js";
import type { StoredAttachment } from "../engine/attachments.js";
import type { NotificationChannelConfig } from "@zqagent/shared";
import type { McpServerConfig } from "../mcp/McpClient.js";
import type { ModelMeta } from "../providers/models.js";
import type { ShellPolicy } from "../permissions/PermissionEngine.js";
import type { SandboxMode } from "../tools/sandbox.js";
import type { VcsConfigMode } from "../vcs/plan.js";

// 通知相关类型已迁移至 @zqagent/shared（core 与 hub 共用），此处再导出保持兼容。
export type {
  NotifyKind,
  NotifyEvent,
  NotificationChannelType,
  NotificationChannelConfig,
} from "@zqagent/shared";

/**
 * `session_status` 通知里的伪状态：会话已删除。
 *
 * 不属于 `SessionStatus` 状态机（不落盘、不出现在会话详情里），只用于让常开的
 * 总览页面立即移除该行。前端同名常量在 `@zqagent/console-core` 的 types。
 */
export const SESSION_STATUS_DELETED = "deleted";

/** 会话状态机 */
export type SessionStatus =
  | "idle" // 已创建，尚未运行
  | "running" // 正在执行 run 任务
  | "waiting_approval" // 等待用户审批（可能已回收内存任务）
  | "waiting_question" // 等待用户回答提问（ask_user 等）
  | "completed" // 最后一轮 Turn 正常结束
  | "stopped" // 达到最大迭代次数等非 error 的提前终止
  | "error" // 出错
  | "interrupted"; // 被用户中断
/** LLM 供应商条目（项目可配置多个，择一为当前生效） */
export interface LlmProviderEntry {
  id: string;
  /** 展示名（如 DeepSeek / 通义千问） */
  name: string;
  /** 类型标识（openai/deepseek/qwen/zhipu/...；仅展示用途） */
  type?: string;
  baseURL: string;
  model: string;
  /** API Key（落盘存储；API 只回 hasApiKey） */
  apiKey?: string;
  /** 推理强度（仅部分供应商支持；未设置为 null） */
  reasoningEffort?: "low" | "medium" | "high" | null;
  /** 上次「刷新模型」得到的候选列表（持久化；避免每次打开会话都请求供应商） */
  models?: string[];
  /** 上述候选中「非对话模型」的子集（向量/语音/图像/专用通道…），供控制台标记 */
  nonChat?: string[];
  /** 候选模型的元数据（上下文长度等；部分供应商的 /models 响应提供），用于精确计算压缩阈值 */
  modelMeta?: ModelMeta[];
}

/** 租户配置（服务端预置，不通过 API 暴露） */
export interface TenantConfig {
  id: string;
  /** 展示名（项目名；缺省时前端回退用 id） */
  name?: string;
  /** API Key（Bearer 认证），调用方凭此访问本租户 */
  apiKey: string;
  /** 默认模型 */
  model: string;
  /** LLM Provider 配置（每租户独立，可指向不同端点/Key） */
  provider: { apiKey?: string; baseURL?: string; models?: string[]; modelMeta?: ModelMeta[] };
  /** 多 LLM 供应商（可选）：active 项的 baseURL/apiKey/model 会同步写入 provider/model */
  llmProviders?: LlmProviderEntry[];
  /** 当前生效的供应商 id（对应 llmProviders 中一项） */
  activeProviderId?: string;
  /** 工作区根目录（可选）。设置后所有会话共享此目录，否则每会话独立沙箱 */
  workspaceRoot?: string;
  /** 本租户生效的 MCP 服务器（可由 zcode-server 下发；未设置时回退 MCP_CONFIG_PATH） */
  mcpServers?: McpServerConfig[];
  /** 命令白名单（可省略，默认空） */
  allowedCommands?: string[];
  /** shell 免审策略（默认 approve；开启后配合 sandbox 可减少审批） */
  shellPolicy?: ShellPolicy;
  /** OS 级沙箱（默认关闭，保持既有部署行为） */
  sandbox?: {
    mode?: SandboxMode;
    /** 额外可写路径（工作区之外） */
    extraWritable?: string[];
  };
  /**
   * 变更追踪（默认 auto）：记录每个会话每轮改了什么。
   * 项目本身是 git 仓库时复用（独立 index + refs/agent/*，不影响用户分支），
   * 否则在 .agent/vcs 建影子仓库；off 可关闭。
   */
  vcs?: {
    mode?: VcsConfigMode;
  };
  /** 指令签名密钥（密文，AES-256-GCM）。内存态由运行时解密持有 */
  tenantSecretEnc?: string;
  /** 通知通道配置（敏感字段密文存储） */
  notifications?: NotificationChannelConfig[];
  /** notifications 的整体加密形态（AES-256-GCM），落盘用；内存态用 notifications */
  notificationsEnc?: string;
  /** 已配对设备（多设备订阅） */
  devices?: DeviceRecord[];
}

/** 审批记录（持久化） */
export interface ApprovalRecord {
  /** 审批请求 ID（== toolCallId，唯一） */
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  /** cancelled = 被用户中断，既不是回答也不是待决（不再计入待办） */
  status: "pending" | "answered" | "cancelled";
  /** 用户回答的审批结果（answered 时有值） */
  outcome?: ApprovalOutcome;
  createdAt: string;
  answeredAt?: string;
}

/** 提问记录（ask_user / propose_plan / request_directory，持久化） */
export interface QuestionRecord {
  /** 提问 ID（唯一） */
  id: string;
  /** 提问类型：ask=ask_user 问答 / plan=计划提案 / directory=目录请求 */
  kind: "ask" | "plan" | "directory";
  question: string;
  options: string[];
  allowText: boolean;
  multi: boolean;
  /** directory 专用：建议路径 / 是否可写 */
  suggestedPath?: string;
  writable?: boolean;
  /** cancelled = 被用户中断（不再计入待办，也不会被 resume 复用） */
  status: "pending" | "answered" | "cancelled";
  /** 用户回答内容（answered 时有值；plan/directory 按类型解析） */
  answer?: string;
  /** 解析后的结构化回答 */
  parsed?: {
    approved?: boolean;
    granted?: boolean;
    path?: string;
    feedback?: string;
    /** 计划提案：用户既没批准也没拒绝，而是提出了补充要求（修订后重新提案） */
    revised?: boolean;
  };
  /**
   * 回答已被引擎消费（工具 handler 已取走答案）。resume 重放提问工具时，
   * 只复用「已回答且未消费」的记录——避免超时回收恢复后重复挂起提问，
   * 同时保证后续新 turn 的提问不会被旧答案误复用。
   */
  consumed?: boolean;
  createdAt: string;
  answeredAt?: string;
}

/** 会话物化状态（持久化到 session.json） */
export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  model: string;
  /** 会话名（AI 自动生成或用户指定） */
  name?: string;
  /** 名称来源：auto=自动（可被后续覆盖）；user=用户手动（不再自动生成） */
  nameSource?: "auto" | "user";
  /** 已成功完成的任务数（用于第 1/3/5 次自动命名） */
  taskCount?: number;
  /**
   * 最近一次任务请求的开始时刻（ISO 8601；从未发起过任务时缺省）。
   *
   * 工作台按它排序「最近在跑什么」。不能用 lastCompletedAt 代替：任务运行中时
   * 后者仍是上一轮的时间，长任务会被排到后面。
   */
  lastStartedAt?: string;
  /** 最近一次任务成功完成的时刻（ISO 8601；从未完成时缺省） */
  lastCompletedAt?: string;
  /** 会话 model 是否由用户显式指定（非继承自租户配置） */
  modelOverridden: boolean;
  /**
   * 会话级 LLM 配置 id：引用「节点级 LLM」中的某项（`__env__` = 环境变量全局项）。
   * 缺省/空 = 用项目配置，项目无 Key 时回退节点默认。
   */
  providerId?: string;
  /** 权限模式：plan / interactive / auto / discuss（缺省 interactive） */
  permissionMode?: string;
  /** 输入框草稿（未发送内容，服务端保存；发送/清空后为空） */
  draft?: string;
  /**
   * 最近一次用户指令（提交 turn 或补充信息时立即写入）。
   *
   * 存在的意义是「发送即落盘」：`messages` 要等引擎启动并推进后才包含本条输入，
   * 首页会话列表读的是磁盘记录，直接扫 messages 会慢一拍（看不到刚发的指令）。
   */
  lastInput?: string;
  /** 对话历史（含 system 首条；恢复时直接喂给引擎） */
  messages: unknown[];
  /** 压缩状态（引擎 compactionState 快照） */
  compaction: Record<string, unknown> | null;
  status: SessionStatus;
  /** 未完成/已完成的审批（按 toolCallId 索引） */
  approvals: ApprovalRecord[];
  /** 未完成/已回答的提问 */
  questions: QuestionRecord[];
  /** 会话级「总是允许」持久化（approver 回答 always_* 时累积） */
  sessionAllowTools: string[];
  sessionAllowCommands: string[];
  /** 用量累计（账本口径；供统计快速读取） */
  usage?: SessionUsage;
  savedAt: string;
}

/** 会话累计用量（token + 成本快照） */
export interface SessionUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** 有价格缺失的调用次数 */
  unpriced: number;
  updatedAt: string;
}

/** 挂起中的审批（仅内存，供瞬时恢复） */
export interface PendingApproval {
  promise: Promise<ApprovalOutcome>;
  resolve: (o: ApprovalOutcome) => void;
  record: ApprovalRecord;
  timer: NodeJS.Timeout;
}

/** 挂起中的提问（仅内存，供瞬时恢复） */
export interface PendingQuestion {
  promise: Promise<string>;
  resolve: (a: string) => void;
  record: QuestionRecord;
  timer: NodeJS.Timeout;
}

/** 轮次索引里的一条用户消息（补充消息也在此列） */
export interface SessionTurnInput {
  /** 该消息对应事件的 seq */
  seq: number;
  /** ISO 时间戳 */
  ts: string;
  /** 消息正文（超长截断） */
  text: string;
  /**
   * 这条消息附带的图片 / 文件（落盘引用，非 base64）。
   *
   * 控制台在用户消息上方显示缩略图、聊天详情里回看；字节本体在
   * `sessions/<id>/attachments/`，按需经 `readSessionAttachment` 取。
   */
  attachments?: StoredAttachment[];
}

/**
 * 轮次索引（`sessions/{id}/turns.ndjson` 的一行）。
 *
 * 同一 `startSeq` 可能有多行（running → completed 的版本推进），
 * 读取时取最后一行。索引是 events.jsonl 的派生数据：
 * 丢失或落后时可从事件流重建（`Store.rebuildTurnIndex`）。
 */
export interface SessionTurnIndexEntry {
  /** 格式版本（当前为 1） */
  v: 1;
  /** 本轮 turn_start 的 seq */
  startSeq: number;
  /** 本轮最后一条事件的 seq */
  endSeq: number;
  startedAt: string;
  /** 未结束时为 null */
  endedAt: string | null;
  /** running / completed / error / interrupted */
  status: string;
  /** 用户消息（含运行中补充），按时间升序 */
  inputs: SessionTurnInput[];
  /** 最后一条非空 assistant_message 的 seq（取完整回复用） */
  replySeq?: number;
  /** 最后一条助手回复（截断，供列表展示） */
  replyPreview: string;
  /** 本轮产出文件（来自 turn_end.data.produced_files） */
  producedFiles: string[];
  llmCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  iterations?: number;
  durationMs?: number;
  error?: string;
}

/** 事件缓冲条目 */
export interface EventEntry {
  seq: number; // 事件序号（从 1 开始）
  ts: string; // ISO 时间戳
  type: string; // 事件类型（"turn_start" / "turn_end" / "approval_request" / "approval_answered" / "question_asked" / "question_answered"）
  data: Record<string, unknown>; // 事件负载（结构随事件类型变化）
}

// ===================== 远程控制（MQTT）相关 =====================
// 通知类型（NotifyKind / NotifyEvent / NotificationChannelType /
// NotificationChannelConfig）已迁移至 @zqagent/shared，见文件顶部再导出。

/** 已配对设备 */
export interface DeviceRecord {
  deviceId: string;
  label?: string;
  platform?: "android" | "ios";
  createdAt: string;
}

// ===================== 控制台（项目 / 节点）相关 =====================

/**
 * 项目摘要（= 一个租户的非敏感视图）。
 * 控制台「多项目」视图与桌面管理页使用；绝不携带 apiKey 明文。
 */
export interface ProjectSummary {
  id: string;
  name: string;
  model: string;
  baseURL: string;
  hasApiKey: boolean;
  workspaceRoot: string | null;
  /** 会话数量（列表页展示） */
  sessionCount: number;
  createdAt?: string;
}

/** 节点元信息（GET /api/v1/node/info 返回） */
export interface NodeInfo {
  /** 节点稳定标识（{DATA_DIR}/node.json，首次启动生成） */
  nodeId: string;
  /** 平台（process.platform） */
  platform: string;
  /** 运行形态：desktop / cloud / standalone */
  mode: string;
  /** 版本（env ZQAGENT_VERSION，缺省 "dev"） */
  version: string;
  /** 当前凭据是否为管理员（可管理多个项目） */
  admin: boolean;
  /** 可见项目列表（管理员=全部；租户=自身） */
  projects: ProjectSummary[];
}
