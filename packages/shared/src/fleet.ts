/**
 * MQTT 节点管理协议 v2（控制台 ↔ 多终端设备）
 *
 * 与 v1（`protocol.ts`，按租户、deviceId 的手机控制）并存。v2 面向
 * 「公网控制台管理多台终端 Agent 实例」：
 *
 *   - **按节点寻址**：topic 含 `node/{nodeId}`，每个节点只订阅自己的 cmd；
 *   - **在线状态**：`status` retained + LWT（遗嘱）自动上线/离线，`info` retained
 *     （能力/项目快照，上线即重建节点管理视图）；
 *   - **请求-响应关联**：命令带 `reqId`，回执（ack）回带同一 `reqId`；
 *   - **签名密钥**：节点管理级 `fleetSecret`（自托管单所有者模型；每节点独立密钥留待 P3）。
 *
 * 安全前提同 v1：broker 可无认证/ACL，隔离靠「高熵 fleetToken 命名空间 + HMAC 签名」。
 */
import * as crypto from "crypto";
import {
  DEFAULT_CLOCK_SKEW_MS,
  NonceTracker,
  generateToken,
  isFreshTimestamp,
} from "./common.js";

export { NonceTracker, generateToken, isFreshTimestamp, DEFAULT_CLOCK_SKEW_MS };

/** topic 根前缀 */
export const FLEET_TOPIC_PREFIX = "zqagent/fleet";

/**
 * 会话状态条目（跨节点总览的唯一数据形状）。
 *
 * 刻意只包含「标识 + 状态」：消息、模型、token 等明细由会话详情页按需拉取。
 * 节点经 info `detail.sessions` 上报全量快照，状态变化经 notify `session_status`
 * 增量推送；接口（REST / 指令）也用同一形状。
 */
/**
 * 会话状态条目（跨节点总览的唯一数据形状）。
 *
 * - `status` 取 `SessionStatus` 的状态值；另有一个**伪状态** `"deleted"`：
 *   会话已删除，只出现在 `session_status` 通知里（不落盘、不进状态机），
 *   供常开的总览页面立即移除该行。
 * - 只含标识与状态：消息、模型、token 等明细由会话详情页按需拉取。
 */
export interface SessionStateEntry {
  projectId: string;
  /** 项目展示名（节点侧填充；详情快照里由 projects 补齐） */
  projectName: string;
  sessionId: string;
  name: string | null;
  status: string;
  /** 用户最近一条发送给 Agent 的消息（截断，供总览列表展示；无消息时 null） */
  lastUserMessage?: string | null;
  /**
   * 最近一次**任务请求的开始时刻**（ISO 8601；从未发起过任务时 null）。
   *
   * 工作台的节点/项目/任务列表统一按它倒序——用户找的是「最近在跑什么」，
   * 而不是「最近什么时候跑完的」：长任务运行中时 lastCompletedAt 还是上一轮的，
   * 按它排会把正在干活的排到后面。
   */
  lastStartedAt?: string | null;
  /** 最近一次任务成功完成的时刻（ISO 8601；从未完成时 null） */
  lastCompletedAt?: string | null;
}

/** 命令类型（控制台 → 节点） */
export type FleetCmdType =
  | "ping"
  | "get_node_info"
  | "get_node_host"
  | "list_projects"
  | "create_project"
  | "delete_project"
  | "list_sessions"
  /** 跨项目会话状态（只含标识与 status，供节点首页/工作台总览） */
  | "get_session_states"
  | "create_session"
  | "delete_session"
  | "get_state"
  | "get_events"
  /** 会话轮次汇总（轻量：标题 + 统计，点开某轮再取事件） */
  | "get_session_turns"
  /** 单轮详情：用户消息（含补充）+ 最终回复 + 产出文件 */
  | "get_session_turn_reply"
  /** 读取聊天记录里保存的附件（用户消息的图片 / 文件） */
  | "read_session_attachment"
  /** 变更追踪：本会话的快照列表（每轮一个） */
  | "get_session_changes"
  /** 变更追踪：某个快照的完整 patch */
  | "get_session_change_diff"
  /** 变更追踪：从快照恢复文件（会改工作区） */
  | "restore_session_change"
  | "get_config"
  | "update_config"
  | "list_models"
  | "list_dirs"
  | "make_dir"
  | "search_dirs"
  | "list_files"
  | "read_file"
  | "download_file"
  | "write_file"
  /** 按 base64 写入二进制文件（图片编辑后保存） */
  | "write_file_base64"
  | "create_dir"
  | "create_file"
  | "delete_files"
  | "search_files"
  /** 重命名文件 / 目录（只改同一目录下的名字） */
  | "rename_path"
  /** 把文件 / 目录移动到工作区内的目标目录（拖拽移动） */
  | "move_paths"
  /** 压缩下载：把选中的文件 / 目录打包成 zip（超过上限直接拒绝） */
  | "zip_download"
  | "list_tools"
  | "list_mcp"
  /** 整体替换项目的 MCP 服务器配置（控制台设置页保存） */
  | "update_mcp"
  /** 连接测试单个 MCP 服务器（不落盘） */
  | "test_mcp"
  | "project_stats"
  | "run_command"
  | "list_shell_tasks"
  | "kill_shell_task"
  | "git_repos"
  | "git_status"
  | "git_diff"
  | "git_branches"
  | "git_refs"
  | "git_log"
  | "git_show"
  | "git_fetch"
  | "git_stage"
  | "git_unstage"
  | "git_commit"
  /** AI 生成提交说明（节点侧调用 LLM） */
  | "git_commit_message"
  | "git_checkout"
  | "git_pull"
  | "git_push"
  | "set_node_label"
  | "get_usage_summary"
  /** 大模型账户余额（控制台「余额不足」时查看/充值用） */
  | "get_llm_balance"
  | "get_usage_records"
  | "get_usage_pricing"
  | "update_usage_pricing"
  | "get_node_llm"
  | "update_node_llm"
  /**
   * 节点自更新（自更新仅在「SEA 单文件 + 服务托管 + 配置验签公钥」时可用）：
   *   payload.action = "status" | "check" | "install"
   *   payload.force  = true 时立即安装（不等空闲，会打断运行中的任务）
   *
   * install 先回执、后在后台下载安装并退出进程，由 systemd/launchd 拉起新版本；
   * 因此**回执成功不等于已升级**，需再用 status 确认版本。
   */
  | "self_update"
  /**
   * 重新拉取平台内置模型（志前 API）的凭据。
   *
   * 内置模型在接入 Hub 时下发，正常情况下用户无需关心；这里用于
   * 「Key 在控制台被重置」或用户在控制台点「刷新」时重取。
   * 会改写节点侧的 LLM 配置，属写指令（不参与只读并发池）。
   */
  | "refresh_builtin_llm"
  | "list_node_llm_models"
  | "set_fleet_cred"
  | "rename_session"
  | "set_session_model"
  | "set_session_llm"
  | "set_session_mode"
  | "set_session_draft"
  | "submit_turn"
  | "steer"
  | "unsteer"
  | "interrupt"
  | "resume"
  | "approval_answer"
  | "question_answer"
  /**
   * 批量指令：payload.commands 为子指令数组，节点顺序/并发执行后
   * 在单条回执的 data.results 中按序返回各子指令结果（减少往返与请求数）。
   */
  | "batch";

export const FLEET_CMD_TYPES: readonly FleetCmdType[] = [
  "ping",
  "get_node_info",
  "get_node_host",
  "list_projects",
  "create_project",
  "delete_project",
  "list_sessions",
  "get_session_states",
  "create_session",
  "delete_session",
  "get_state",
  "get_events",
  "get_session_turns",
  "get_session_turn_reply",
  "read_session_attachment",
  "get_session_changes",
  "get_session_change_diff",
  "restore_session_change",
  "get_config",
  "update_config",
  "list_models",
  "list_dirs",
  "make_dir",
  "search_dirs",
  "list_files",
  "read_file",
  "download_file",
  "write_file",
  "write_file_base64",
  "create_dir",
  "create_file",
  "delete_files",
  "search_files",
  "rename_path",
  "move_paths",
  "zip_download",
  "list_tools",
  "list_mcp",
  "update_mcp",
  "test_mcp",
  "project_stats",
  "run_command",
  "list_shell_tasks",
  "kill_shell_task",
  "git_repos",
  "git_status",
  "git_diff",
  "git_branches",
  "git_refs",
  "git_log",
  "git_show",
  "git_fetch",
  "git_stage",
  "git_unstage",
  "git_commit",
  "git_commit_message",
  "git_checkout",
  "git_pull",
  "git_push",
  "set_node_label",
  "get_usage_summary",
  "get_llm_balance",
  "get_usage_records",
  "get_usage_pricing",
  "update_usage_pricing",
  "get_node_llm",
  "update_node_llm",
  "self_update",
  "refresh_builtin_llm",
  "list_node_llm_models",
  "set_fleet_cred",
  "rename_session",
  "set_session_model",
  "set_session_llm",
  "set_session_mode",
  "set_session_draft",
  "submit_turn",
  "steer",
  "unsteer",
  "interrupt",
  "resume",
  "approval_answer",
  "question_answer",
  "batch",
];

/** 批量指令的子指令（不含嵌套 batch） */
export interface FleetBatchSubCmd {
  type: Exclude<FleetCmdType, "batch">;
  projectId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

/** 批量指令结果项（与请求按序对应） */
export interface FleetBatchResult {
  type: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 命令信封 v2（含 HMAC 签名） */
export interface FleetCmdEnvelope {
  /** 时间戳（毫秒，±60s 窗口） */
  t: number;
  /** 一次性随机串（防重放） */
  nonce: string;
  /** 请求 ID（回执关联） */
  reqId: string;
  type: FleetCmdType;
  /** 发起控制台客户端 ID */
  clientId: string;
  /** 目标节点 ID */
  nodeId: string;
  /** 目标项目 ID（项目级命令） */
  projectId?: string;
  /** 目标会话 ID（会话级命令） */
  sessionId?: string;
  payload: Record<string, unknown>;
  /** HMAC-SHA256(fleetSecret, 规范化串) base64url */
  sig: string;
}

/** 命令回执（点对点回给 clientId） */
export interface FleetAckPayload {
  reqId: string;
  type: FleetCmdType;
  ok: boolean;
  error?: string;
  data?: unknown;
}

/** 节点在线状态（retained + LWT） */
export interface FleetStatus {
  nodeId: string;
  online: boolean;
  ts: string;
  /** 节点展示名（本地配置；Hub 改名后回写并随之上报） */
  label?: string;
  platform?: string;
  mode?: string;
  version?: string;
  /**
   * 节点自报的主 IP（网卡地址：首个非回环 IPv4，缺省 IPv6）。
   *
   * 它是内网地址，控制台展示节点公网 IP 时应以网关观察到的连接来源为准
   * （见 gateway `NodeStateInfo.peer_ip`）。
   */
  ip?: string;
}

/** 节点累计运行统计（info 上报；进程启动后累计） */
export interface FleetNodeStats {
  /** 完成的回合数（turn_end） */
  turns: number;
  /** 工具调用完成数（tool_finished） */
  toolCalls: number;
  /** 错误事件数（error） */
  errors: number;
  /** 累计输入 token（assistant_message.usage.input） */
  tokensIn: number;
  /** 累计输出 token */
  tokensOut: number;
  /** 统计起点（节点进程启动/桥接建立时间） */
  since: string;
}

/** 节点管理配对凭据（pairing API 下发） */
export interface FleetPairing {
  fleetToken: string;
  fleetSecret: string;
  nodeId: string;
  /** Rust 网关 wss 地址（控制面配置了才下发；节点据此直连网关） */
  gatewayUrl?: string;
}

/**
 * 节点本地持久化的云端接入凭据（`{DATA_DIR}/fleet.json`）。
 *
 * 由「凭注册码接入」（`POST /api/hub/enroll`）返回后落盘；节点启动时优先
 * 读取此文件，其次回退到环境变量（`FLEET_TOKEN` / `FLEET_SECRET`）。
 *
 * 「去 EMQX」后不再有 per-fleet broker 账号：网关鉴权用**全局** `GATEWAY_FLEET_SECRET`，
 * 因此凭据只需 fleetToken/fleetSecret（前者仅作命名空间标识）与网关地址。
 */
export interface FleetCredential {
  /** Hub 控制面地址（接入时使用，便于日后重新配对/展示） */
  hubUrl?: string;
  fleetToken: string;
  fleetSecret: string;
  nodeId: string;
  /**
   * Rust 网关 wss 地址（控制面在配对/接入时下发）。
   *
   * 它是节点接入云端的**唯一**传输，环境变量 `FLEET_GATEWAY_URL` 仅作覆盖。
   */
  gatewayUrl?: string;
  /** 节点展示名（可选） */
  label?: string;
  /** 接入时间（ISO 字符串） */
  enrolledAt?: string;
  /**
   * 平台内置大模型（志前 API）：接入 Hub 时由控制面下发，节点侧落盘为
   * `id=__zqai__` 的不可删除供应商。
   *
   * 这里只是「接入那一刻的快照」；凭据轮换或首次缺失时，节点会调用
   * `GET /api/hub/node/builtin-llm` 重新拉取（见 core 的 builtinLlm.ts）。
   */
  builtinLlm?: BuiltinLlmGrant;
}

/** 平台内置模型的接入凭据（下发给节点） */
export interface BuiltinLlmGrant {
  /** 固定为 `__zqai__` */
  providerId: string;
  /** 展示名 */
  name: string;
  /** OpenAI 兼容基址，如 https://zqai-api.cd-zq.com/v1 */
  baseURL: string;
  /** 用户的 API Key（节点侧加密落盘） */
  apiKey: string;
  /** 默认模型 */
  model: string;
  /** 该账号可用的模型列表 */
  models?: string[];
}

/** topic 构建 */
export function fleetCmdTopic(fleetToken: string, nodeId: string): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/cmd`;
}
export function fleetNotifyTopic(fleetToken: string, nodeId: string): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/notify`;
}
export function fleetEventsTopic(fleetToken: string, nodeId: string): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/events`;
}
export function fleetStatusTopic(fleetToken: string, nodeId: string): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/status`;
}
export function fleetInfoTopic(fleetToken: string, nodeId: string): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/info`;
}
export function fleetAckTopic(
  fleetToken: string,
  nodeId: string,
  clientId: string,
): string {
  return `${FLEET_TOPIC_PREFIX}/${fleetToken}/node/${nodeId}/ack/${clientId}`;
}

/** 签名前的规范化串（字段顺序固定，两侧一致） */
function canonical(env: Omit<FleetCmdEnvelope, "sig">): string {
  return JSON.stringify([
    env.t,
    env.nonce,
    env.reqId,
    env.type,
    env.clientId,
    env.nodeId,
    env.projectId ?? "",
    env.sessionId ?? "",
    env.payload,
  ]);
}

/** 计算 HMAC-SHA256 签名 */
export function signFleetCmd(
  secret: string,
  env: Omit<FleetCmdEnvelope, "sig">,
): string {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(canonical(env))
    .digest("base64url");
}

/** 常量时间比较校验签名 */
export function verifyFleetSig(secret: string, env: FleetCmdEnvelope): boolean {
  if (typeof env.sig !== "string" || env.sig.length === 0) return false;
  const expected = signFleetCmd(secret, env);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(env.sig, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 解析并校验命令信封结构（不校验签名；签名由调用方验） */
export function parseFleetEnvelope(raw: unknown): FleetCmdEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.t !== "number" ||
    typeof o.nonce !== "string" ||
    typeof o.reqId !== "string" ||
    typeof o.type !== "string" ||
    typeof o.clientId !== "string" ||
    typeof o.nodeId !== "string" ||
    typeof o.sig !== "string"
  ) {
    return null;
  }
  if (!FLEET_CMD_TYPES.includes(o.type as FleetCmdType)) return null;
  if (!o.payload || typeof o.payload !== "object") return null;
  return {
    t: o.t,
    nonce: o.nonce,
    reqId: o.reqId,
    type: o.type as FleetCmdType,
    clientId: o.clientId,
    nodeId: o.nodeId,
    projectId: typeof o.projectId === "string" ? o.projectId : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    payload: o.payload as Record<string, unknown>,
    sig: o.sig,
  };
}
