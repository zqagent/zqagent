/**
 * Hub REST 客户端（浏览器/桌面共用，纯 fetch，无 Node 依赖）
 *
 * 账号/节点管理/节点/指令代理/消息/事件流。浏览器只持会话令牌，节点密钥留在 Hub。
 * 供 packages/portal（统一控制台：桌面壳内嵌 + 浏览器用户中心）复用。
 */
import type { FleetCredential, FleetNodeStats, SessionStateEntry } from "./fleet.js";

/**
 * 列表排序键：任务请求开始时间优先，旧数据（该字段上线前）回退完成时间。
 *
 * 工作台的节点 / 项目 / 任务三处列表统一用它倒序，保证「最近在跑什么」排最前。
 * 返回空串表示这个条目从没跑过任务，倒序时自然落到最后。
 */
export function activityKey(o: {
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
}): string {
  return o.lastStartedAt ?? o.lastCompletedAt ?? "";
}

/**
 * 按最近一次任务请求的开始时间倒序（最新的在前）。
 *
 * `tieBreak` 只在时间完全相同时使用（如从没跑过的条目之间），保证顺序稳定、
 * 刷新不会跳动。
 */
export function compareByActivity<
  T extends { lastStartedAt?: string | null; lastCompletedAt?: string | null },
>(a: T, b: T, tieBreak?: (x: T, y: T) => number): number {
  const ak = activityKey(a);
  const bk = activityKey(b);
  if (ak !== bk) return bk.localeCompare(ak);
  return tieBreak ? tieBreak(a, b) : 0;
}

/**
 * Hub 基址解析钩子：宿主可把逻辑 Hub 基址映射到「本机引擎中转」地址
 * （桌面端经 127.0.0.1 转发，绕开浏览器跨域）。默认恒等。
 */
let baseUrlResolver: ((baseUrl: string) => string) | null = null;

export function setHubBaseResolver(fn: ((baseUrl: string) => string) | null): void {
  baseUrlResolver = fn;
}

function resolveBase(baseUrl: string): string {
  return baseUrlResolver ? baseUrlResolver(baseUrl) : baseUrl;
}


export interface HubFleetSummary {
  id: string;
  name: string;
  /** 系统内置「未分组」 */
  ungrouped?: boolean;
  nodeCount: number;
  createdAt: string;
}

/** 节点级汇总统计（节点 info 上报） */
export interface HubNodeTotals {
  projects: number;
  sessions: number;
  running: number;
  waiting: number;
}

export interface HubNodeSummary {
  nodeId: string;
  label?: string;
  /** 计费状态；suspended = 余额不足暂停（缺省视为可用） */
  billingStatus?: "active" | "suspended";
  billingSuspendedReason?: "insufficient";
  online: boolean;
  lastSeen?: string;
  platform?: string;
  mode?: string;
  version?: string;
  /** 节点自报主 IP（新版节点上报；旧版缺省） */
  ip?: string;
  projects: Array<{
    id: string;
    name: string;
    sessionCount?: number;
    running?: number;
    waiting?: number;
    /** 项目工作目录（节点上报；旧版节点缺省） */
    workspaceRoot?: string | null;
  }>;
  /** 项目/会话汇总（新版节点上报；旧版为 null） */
  totals?: HubNodeTotals | null;
  /**
   * 会话状态快照（只含 projectId / sessionId / name / status）。
   *
   * 工作台/节点首页用它建立初始视图，之后的变更由账号级 WSS 的
   * `session_status` 通知增量推送。明细（消息/模型/token）不在这里。
   */
  sessions?: SessionStateEntry[] | null;
  /** 累计运行统计（新版节点上报；旧版为 null） */
  stats?: FleetNodeStats | null;
  /**
   * 该节点下任一任务最近一次请求的开始时间（节点列表按它倒序）。
   * 从未发起过任务时为 null（旧版节点也不上报）。
   */
  lastStartedAt?: string | null;
}

/** 节点详情（含节点管理归属与创建时间） */
export interface HubNodeDetail extends HubNodeSummary {
  fleetId: string;
  fleetName: string;
  createdAt: string;
  /** 访问身份：owner = 自己的节点，operator = 别人共享给我 */
  access?: HubNodeAccessView;
}

/** 当前账号对某节点的访问身份 */
export interface HubNodeAccessView {
  role: "owner" | "operator";
  /** 共享到期时刻（ISO）；owner 为 null */
  expiresAt: string | null;
  /** 共享期间是否允许消耗所有者的模型额度 */
  allowModelSpend: boolean;
  /** 所有者账号（掩码）；owner 自己看时为空串 */
  ownerLabel?: string;
}

/** 共享给我的节点（列表项，形状与节点摘要对齐并附加授权信息） */
export interface HubSharedNode extends HubNodeSummary {
  fleetId: string;
  fleetName: string;
  ownerLabel: string;
  grantId: string;
  expiresAt: string;
  allowModelSpend: boolean;
}

/** 共享授权（owner 视角） */
export interface HubNodeGrantView {
  id: string;
  nodeId: string;
  toUser: { id: string; label: string };
  role: "operator";
  allowModelSpend: boolean;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  revokedReason: "owner" | "self" | "node_deleted" | "account_deleted" | null;
}

/** 节点操作记录的一条 */
export interface HubNodeActivityItem {
  id: string;
  ts: string;
  nodeId: string;
  actor: { userId: string; label: string; via: "owner" | "operator" };
  action: string;
  summary: string;
  commandType: string | null;
  projectId: string | null;
  sessionId: string | null;
  result: "ok" | "denied" | "error";
}

/** 项目总览里的单条任务（会话） */
export interface HubProjectTask {
  sessionId: string;
  name: string | null;
  status: string;
  lastUserMessage: string | null;
  /** 该任务最近一次请求的开始时间（排序键） */
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
}

/** 项目总览行：跨节点聚合的项目视图 */
export interface HubProjectRow {
  projectId: string;
  name: string;
  workspaceRoot: string | null;
  nodeId: string;
  nodeLabel: string;
  fleetId: string;
  fleetName: string;
  online: boolean;
  sessionCount: number;
  running: number;
  waiting: number;
  /** 该项目下所有任务里最近一次请求的开始时间（列表按它倒序） */
  lastStartedAt: string | null;
  /** 该项目下所有任务最近一次成功完成的时刻（ISO 8601；从未完成时 null） */
  lastCompletedAt: string | null;
  /** 任务总数（tasks 最多回传前 20 条） */
  taskCount: number;
  tasks: HubProjectTask[];
}

/** 项目总览分页响应 */
export interface HubProjectPage {
  total: number;
  items: HubProjectRow[];
}

/** 任务总览行：跨节点聚合的会话视图（数据来自 Hub 保存的节点快照） */
export interface HubTaskRow {
  sessionId: string;
  name: string | null;
  status: string;
  lastUserMessage: string | null;
  /** 该任务最近一次请求的开始时间（列表按它倒序） */
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  projectId: string;
  projectName: string;
  nodeId: string;
  nodeLabel: string;
  fleetId: string;
  fleetName: string;
  online: boolean;
}

/** 任务筛选口径的计数（始终基于全部任务，不受筛选影响） */
export interface HubTaskCounts {
  all: number;
  running: number;
  waiting: number;
  error: number;
  completed: number;
}

/** 任务总览分页响应 */
export interface HubTaskPage {
  total: number;
  counts: HubTaskCounts;
  items: HubTaskRow[];
}

export interface HubPlan {
  id: "free" | "pro" | "team";
  name: string;
  priceMonthly: number;
  priceYearly: number;
  limits: { maxNodes: number; maxFleets: number; notifications: boolean; historyDays: number };
}

export interface HubSubscriptionView {
  plan: string;
  planExpiresAt: string | null;
  limits: { maxNodes: number; maxFleets: number; notifications: boolean; historyDays: number };
  usage: { fleets: number; nodes: number };
}

export interface HubOrderView {
  id: string;
  plan: string;
  period: string;
  amount: number;
  provider: string;
  status: string;
  createdAt: string;
  paidAt?: string;
  /** plan=套餐（已停售）；wallet/api_topup=账户充值 */
  purpose?: "plan" | "wallet" | "api_topup";
}

export interface HubUserView {
  id: string;
  email: string | null;
  phone: string | null;
  /** 可选昵称（仅展示；缺省时前端回退到邮箱/手机号） */
  nickname?: string | null;
  plan: string;
  /** 是否已设置可用密码（短信登录自动注册后为 false） */
  passwordSet?: boolean;
  /** 系统管理员角色（缺省 user）；仅 admin 可进入 /admin */
  role?: "user" | "admin";
  /** 账号状态（缺省 active） */
  status?: "active" | "disabled" | "deleted";
}

export interface HubCaptchaView {
  captchaId: string;
  svg: string;
  /** 仅调试模式返回（HUB_SMS_DEBUG=1） */
  debugCode?: string;
}

export type HubSmsPurpose = "register" | "login" | "reset";

export interface HubAuthInput {
  email?: string;
  phone?: string;
  password?: string;
  code?: string;
  emailCode?: string;
  /** 注册时可选填写的昵称（最长 32 个字符；之后可在个人中心修改） */
  nickname?: string;
}

export interface HubPairingView {
  /** 对外可达的网关 wss 地址（节点凭此直连 Rust 网关；Hub 未配置时为缺省） */
  gatewayUrl?: string;
  fleetToken: string;
  fleetSecret: string;
  expiresAt?: string;
}

export interface HubEnrollmentView {
  code: string;
  expiresAt: string;
}

export interface HubNotificationView {
  id: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  readAt?: string;
  createdAt: string;
}

async function req(
  baseUrl: string,
  token: string | null,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${resolveBase(baseUrl).replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Hub 响应非法（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } })?.error;
    const e = new Error(err?.message ?? `HTTP ${res.status}`) as Error & { code?: string };
    e.code = err?.code;
    throw e;
  }
  return (payload as { data?: unknown })?.data;
}

export async function hubRegister(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ token: string }> {
  return hubRegisterAccount(baseUrl, { email, password });
}

/** 注册（邮箱或手机号；手机号需先获取短信验证码；可选填写昵称） */
export async function hubRegisterAccount(
  baseUrl: string,
  input: HubAuthInput,
): Promise<{ token: string; user?: HubUserView }> {
  return (await req(baseUrl, null, "/api/hub/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { token: string; user?: HubUserView };
}

export async function hubLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ token: string }> {
  return hubLoginAccount(baseUrl, { email, password });
}

/** 登录（邮箱+密码，或手机号+密码/短信验证码；手机号验证码登录未注册时自动注册） */
export async function hubLoginAccount(
  baseUrl: string,
  input: HubAuthInput,
): Promise<{ token: string; user?: HubUserView; autoRegistered?: boolean }> {
  return (await req(baseUrl, null, "/api/hub/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { token: string; user?: HubUserView; autoRegistered?: boolean };
}

/** 图形验证码（发送短信前必填） */
export async function hubCaptcha(baseUrl: string): Promise<HubCaptchaView> {
  return (await req(baseUrl, null, "/api/hub/auth/captcha")) as HubCaptchaView;
}

/** 发送短信验证码（purpose：register/login/reset；当天第二次起需图形验证码） */
export async function hubSendSms(
  baseUrl: string,
  input: {
    phone: string;
    purpose: HubSmsPurpose;
    captchaId?: string;
    captcha?: string;
  },
): Promise<{ sent: boolean; expiresIn: number; debugCode?: string }> {
  return (await req(baseUrl, null, "/api/hub/auth/sms/send", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { sent: boolean; expiresIn: number; debugCode?: string };
}

/** 短信发送状态：当天是否已发过（决定是否需要图形验证码） */
export async function hubSmsStatus(
  baseUrl: string,
  phone: string,
): Promise<{ captchaRequired: boolean }> {
  return (await req(
    baseUrl,
    null,
    `/api/hub/auth/sms/status?phone=${encodeURIComponent(phone)}`,
  )) as { captchaRequired: boolean };
}

/** 发送邮箱验证码（注册校验 / 找回密码，需图形验证码） */
export async function hubSendEmailCode(
  baseUrl: string,
  input: {
    email: string;
    /** 缺省 register；reset 用于找回密码（要求邮箱已注册） */
    purpose?: "register" | "reset";
    captchaId: string;
    captcha: string;
  },
): Promise<{ sent: boolean; expiresIn: number; debugCode?: string }> {
  return (await req(baseUrl, null, "/api/hub/auth/email/send", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { sent: boolean; expiresIn: number; debugCode?: string };
}

/** 忘记密码：手机号 + 短信验证码，或邮箱 + 邮箱验证码 */
export async function hubResetPassword(
  baseUrl: string,
  input: { phone?: string; email?: string; code: string; newPassword: string },
): Promise<{ changed: boolean }> {
  return (await req(baseUrl, null, "/api/hub/auth/password/reset", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { changed: boolean };
}

/** 当前用户（id/email/nickname/生效套餐） */
export async function hubMe(baseUrl: string, token: string): Promise<HubUserView> {
  return (await req(baseUrl, token, "/api/hub/me")) as HubUserView;
}

/** 更新个人资料（目前仅昵称；空字符串表示清除昵称） */
export async function hubUpdateProfile(
  baseUrl: string,
  token: string,
  input: { nickname: string },
): Promise<{ nickname: string | null }> {
  return (await req(baseUrl, token, "/api/hub/me", {
    method: "PATCH",
    body: JSON.stringify(input),
  })) as { nickname: string | null };
}

/** 网关账号级订阅涉及的节点（nodeId → 归属节点管理） */
export interface HubGatewayFleet {
  id: string;
  nodes: string[];
}

/** 账号级实时通道的网关凭据（M5：控制台/用户中心直连 Rust 网关） */
export interface HubGatewayCredentialView {
  /** 对外可达的网关 wss 地址 */
  url: string;
  /**
   * 已签名终端令牌（scope = 本人全部节点）。
   *
   * `null` 表示账号下没有任何节点——不必建连接（网关会拒绝空 scope 的令牌）。
   */
  credential: {
    /** base64(wire `Auth`)，原样作为 AUTH 帧载荷 */
    auth: string;
    /** 过期时刻（毫秒） */
    expires: number;
    scope: string[];
    kind: "terminal";
    client: string;
  } | null;
  fleets: HubGatewayFleet[];
}

/** 单节点终端凭据（`POST .../terminal-credential` 的返回体） */
export interface HubTerminalCredential {
  /** 对外可达的网关 wss 地址（与令牌一并返回，客户端一次请求即可建连） */
  url: string;
  /** base64(wire `Auth`)，原样作为 AUTH 帧载荷 */
  auth: string;
  expires: number;
  scope: string[];
  kind: "terminal";
  client: string;
}

/**
 * 获取**单个节点**的终端网关凭据（节点控制台页用）。
 *
 * 与 `hubRealtimeCredential`（账号级，覆盖本人全部节点）的区别是授权范围：
 * 这里只授权该节点，最小权限。
 */
export async function hubTerminalCredential(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  client = "web",
): Promise<HubTerminalCredential> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}/terminal-credential`,
    { method: "POST", body: JSON.stringify({ client }) },
  )) as HubTerminalCredential;
}

/**
 * 获取账号级终端网关凭据。
 *
 * 取代从前那套 broker 直连账号：令牌授权范围
 * = 本人全部节点，供账号级实时通道一条 WSS 订阅所有节点。
 */
export async function hubRealtimeCredential(
  baseUrl: string,
  token: string,
  client = "web",
): Promise<HubGatewayCredentialView> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/realtime-credential?client=${encodeURIComponent(client)}`,
  )) as HubGatewayCredentialView;
}

/** 修改密码（手机号账号需短信验证码，可附原密码） */
export async function hubChangePassword(
  baseUrl: string,
  token: string,
  input: { oldPassword?: string; newPassword: string; code?: string },
): Promise<{ changed: boolean }> {
  return (await req(baseUrl, token, "/api/hub/auth/password", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { changed: boolean };
}

export async function hubListFleets(
  baseUrl: string,
  token: string,
): Promise<HubFleetSummary[]> {
  return (await req(baseUrl, token, "/api/hub/fleets")) as HubFleetSummary[];
}

export async function hubCreateFleet(
  baseUrl: string,
  token: string,
  name: string,
): Promise<HubFleetSummary> {
  return (await req(baseUrl, token, "/api/hub/fleets", {
    method: "POST",
    body: JSON.stringify({ name }),
  })) as HubFleetSummary;
}

export async function hubDeleteFleet(
  baseUrl: string,
  token: string,
  fleetId: string,
): Promise<void> {
  await req(baseUrl, token, `/api/hub/fleets/${fleetId}`, { method: "DELETE" });
}

/** 重命名分组 */
export async function hubUpdateFleet(
  baseUrl: string,
  token: string,
  fleetId: string,
  name: string,
): Promise<HubFleetSummary> {
  return (await req(baseUrl, token, `/api/hub/fleets/${fleetId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  })) as HubFleetSummary;
}

/** 节点管理配对凭据（网关地址 + fleetToken/fleetSecret，供手工接入节点） */
export async function hubFleetPairing(
  baseUrl: string,
  token: string,
  fleetId: string,
): Promise<HubPairingView> {
  return (await req(baseUrl, token, `/api/hub/fleets/${fleetId}/pairing`)) as HubPairingView;
}

/** 生成一次性注册码（15 分钟有效） */
export async function hubCreateEnrollment(
  baseUrl: string,
  token: string,
  fleetId: string,
): Promise<HubEnrollmentView> {
  return (await req(baseUrl, token, `/api/hub/fleets/${fleetId}/enrollment`, {
    method: "POST",
  })) as HubEnrollmentView;
}

export async function hubListNodes(
  baseUrl: string,
  token: string,
  fleetId: string,
): Promise<HubNodeSummary[]> {
  return (await req(baseUrl, token, `/api/hub/fleets/${fleetId}/nodes`)) as HubNodeSummary[];
}

/** 项目总览（跨节点聚合，按最后完成任务时间倒序分页；`q` 按项目 / 节点 / 路径模糊过滤） */
export async function hubListProjects(
  baseUrl: string,
  token: string,
  opts: { limit?: number; offset?: number; q?: string } = {},
): Promise<HubProjectPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const q = (opts.q ?? "").trim();
  return (await req(
    baseUrl,
    token,
    `/api/hub/projects?limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  )) as HubProjectPage;
}

/**
 * 任务总览（跨节点聚合，按需要人处理 / 运行中 / 完成时间排序分页）。
 *
 * `status` 与工作台筛选条一致：all / running / waiting / error / completed。
 * `q` 按任务名 / 项目 / 节点 / 最近消息模糊过滤（服务端过滤，分页与总数才准确）。
 */
export async function hubListTasks(
  baseUrl: string,
  token: string,
  opts: { limit?: number; offset?: number; status?: string; q?: string } = {},
): Promise<HubTaskPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const status = opts.status ?? "all";
  const q = (opts.q ?? "").trim();
  return (await req(
    baseUrl,
    token,
    `/api/hub/tasks?limit=${limit}&offset=${offset}&status=${encodeURIComponent(status)}` +
      (q ? `&q=${encodeURIComponent(q)}` : ""),
  )) as HubTaskPage;
}

/** 单节点详情（状态/统计/项目/归属） */
export async function hubGetNode(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
): Promise<HubNodeDetail> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}`,
  )) as HubNodeDetail;
}

/**
 * 单节点详情（不依赖 fleetId 的统一入口）。
 *
 * 共享成员手里只有 nodeId + owner 的 fleetId（从共享列表拿到）；新代码用这条，
 * 避免为了读详情先拼一条自己无权访问的 fleet 路径。
 */
export async function hubGetNodeById(
  baseUrl: string,
  token: string,
  nodeId: string,
): Promise<HubNodeDetail> {
  return (await req(baseUrl, token, `/api/hub/nodes/${encodeURIComponent(nodeId)}`)) as HubNodeDetail;
}

/** 共享给我的节点列表 */
export async function hubSharedNodes(baseUrl: string, token: string): Promise<HubSharedNode[]> {
  return (await req(baseUrl, token, "/api/hub/shared/nodes")) as HubSharedNode[];
}

/** 共享授权列表（仅节点所有者可调） */
export async function hubListNodeGrants(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
): Promise<HubNodeGrantView[]> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}/grants`,
  )) as HubNodeGrantView[];
}

/**
 * 新建 / 延长共享授权。
 *
 * `expiresAt` 为 ISO 字符串（前端 datetime-local 给出，**精确到分**）；
 * `expiresInDays` 是快捷天数（两者二选一，服务端统一收敛为绝对时刻）。
 * 同一账号重复授权 = 延长，不会产生第二条记录。
 */
export async function hubCreateNodeGrant(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  input: { account: string; expiresAt?: string; expiresInDays?: number; allowModelSpend?: boolean },
): Promise<{ grant: HubNodeGrantView }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}/grants`,
    { method: "POST", body: JSON.stringify(input) },
  )) as { grant: HubNodeGrantView };
}

/** 撤销共享授权（仅节点所有者） */
export async function hubRevokeNodeGrant(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  grantId: string,
): Promise<{ revoked: boolean }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}/grants/${grantId}`,
    { method: "DELETE" },
  )) as { revoked: boolean };
}

/** 退出共享（被授权人主动放弃） */
export async function hubLeaveSharedNode(
  baseUrl: string,
  token: string,
  nodeId: string,
): Promise<{ left: boolean }> {
  return (await req(baseUrl, token, `/api/hub/shared/nodes/${encodeURIComponent(nodeId)}/leave`, {
    method: "POST",
  })) as { left: boolean };
}

/**
 * 节点操作记录（owner 与共享成员看到**同一份**）。
 *
 * 命令级条目由网关回写（`GATEWAY_HUB_ACTIVITY_URL`）；未配置时只有控制面操作
 * （改名/挪组/进入控制台/共享关系变更）。
 */
export async function hubNodeActivity(
  baseUrl: string,
  token: string,
  nodeId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ total: number; items: HubNodeActivityItem[] }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  return (await req(
    baseUrl,
    token,
    `/api/hub/nodes/${encodeURIComponent(nodeId)}/activity?limit=${limit}&offset=${offset}`,
  )) as { total: number; items: HubNodeActivityItem[] };
}

export async function hubEnrollNode(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  label?: string,
): Promise<void> {
  await req(baseUrl, token, `/api/hub/fleets/${fleetId}/nodes`, {
    method: "POST",
    body: JSON.stringify({ nodeId, label }),
  });
}

/**
 * 凭一次性注册码接入节点管理（公开接口，无需登录令牌）。
 *
 * 成功后返回节点管理密钥与网关地址，供节点写入 `fleet.json` 并连接。
 * 注册码一次性、短时有效；同一 nodeId 不可被其他节点管理纳管（防抢注）。
 */
export async function hubEnrollByCode(
  baseUrl: string,
  input: { code: string; nodeId: string; label?: string },
): Promise<FleetCredential> {
  const data = (await req(baseUrl, null, "/api/hub/enroll", {
    method: "POST",
    body: JSON.stringify(input),
  })) as Omit<FleetCredential, "hubUrl">;
  return { hubUrl: baseUrl.replace(/\/$/, ""), ...data };
}

/**
 * 凭 Hub 账号接入节点（公开接口，无需令牌）。
 *
 * 节点首次启动时交互式输入账号，校验通过即领取节点管理密钥并绑定 nodeId；
 * 节点默认归入内置「未分组」（分组为空的节点在控制台集中显示）。
 */
export async function hubEnrollByAccount(
  baseUrl: string,
  input: {
    email?: string;
    phone?: string;
    password?: string;
    code?: string;
    nodeId: string;
    label?: string;
  },
): Promise<FleetCredential> {
  const data = (await req(baseUrl, null, "/api/hub/enroll/account", {
    method: "POST",
    body: JSON.stringify(input),
  })) as Omit<FleetCredential, "hubUrl">;
  return { hubUrl: baseUrl.replace(/\/$/, ""), ...data };
}

/**
 * 凭「已登录的 Hub 令牌」接入节点（需登录）。
 *
 * 桌面端在用户登录成功后调用。相比 `/enroll/account` 的优势：短信验证码
 * 登录时验证码已被消费，无法再拿它校验一次；而登录令牌在手，就能直接换取
 * 节点管理凭据——「登录后本机自动接入、可直接用内置模型」因此覆盖所有登录方式。
 */
export async function hubEnrollByToken(
  baseUrl: string,
  token: string,
  input: { nodeId: string; label?: string },
): Promise<FleetCredential> {
  const data = (await req(baseUrl, token, "/api/hub/enroll/token", {
    method: "POST",
    body: JSON.stringify(input),
  })) as Omit<FleetCredential, "hubUrl">;
  return { hubUrl: baseUrl.replace(/\/$/, ""), ...data };
}

export async function hubDeleteNode(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
): Promise<void> {
  await req(baseUrl, token, `/api/hub/fleets/${fleetId}/nodes/${nodeId}`, { method: "DELETE" });
}

/** 重命名节点：Hub 更新 label 并下发节点写入本地配置 */
export async function hubUpdateNode(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  label: string,
): Promise<{ nodeId: string; label: string | null }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: JSON.stringify({ label }) },
  )) as { nodeId: string; label: string | null };
}

/**
 * 节点自助改名：节点用自身的 fleetToken 鉴权，把显示名写进 Hub 记录。
 *
 * 与 `hubUpdateNode`（用户令牌）落在同一份数据上，区别只是鉴权主体：
 * 本机没登录 Hub 用户态时（`zqagent rename`），节点只能凭自己的凭据改。
 */
export async function hubUpdateNodeLabelSelf(
  baseUrl: string,
  fleetToken: string,
  input: { nodeId: string; label: string },
): Promise<{ nodeId: string; label: string }> {
  return (await req(baseUrl, fleetToken, "/api/hub/nodes/self/label", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { nodeId: string; label: string };
}

/** 将节点移动到目标分组（仅改 Hub 记录；分组是控制面元数据，无需下发节点） */
export async function hubMoveNode(
  baseUrl: string,
  token: string,
  fleetId: string,
  nodeId: string,
  targetFleetId: string,
): Promise<{ nodeId: string; fleetId: string }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/fleets/${fleetId}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: JSON.stringify({ fleetId: targetFleetId }) },
  )) as { nodeId: string; fleetId: string };
}

/** 套餐列表（公开） */
export async function hubPlans(baseUrl: string): Promise<HubPlan[]> {
  return (await req(baseUrl, null, "/api/hub/plans")) as HubPlan[];
}

/** 当前订阅（套餐/到期/限额/用量） */
export async function hubSubscription(
  baseUrl: string,
  token: string,
): Promise<HubSubscriptionView> {
  return (await req(baseUrl, token, "/api/hub/subscription")) as HubSubscriptionView;
}

/** 可用支付渠道 */
export async function hubChannels(
  baseUrl: string,
  token: string,
): Promise<Array<{ name: string; configured: boolean }>> {
  return (await req(baseUrl, token, "/api/hub/billing/channels")) as Array<{
    name: string;
    configured: boolean;
  }>;
}

/** 我的订单 */
export async function hubOrders(baseUrl: string, token: string): Promise<HubOrderView[]> {
  return (await req(baseUrl, token, "/api/hub/orders")) as HubOrderView[];
}

/**
 * 主动同步订单状态。
 *
 * 扫码支付后前端轮询这里：回调可能丢失或延迟，后端会向渠道查询真实状态
 * 并在支付成功时完成入账。
 */
export async function hubSyncOrder(
  baseUrl: string,
  token: string,
  orderId: string,
): Promise<{ order: HubOrderView; paid: boolean }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/orders/${encodeURIComponent(orderId)}/sync`,
  )) as { order: HubOrderView; paid: boolean };
}



/** 站内消息列表（含未读数） */
export async function hubNotifications(
  baseUrl: string,
  token: string,
  limit = 50,
): Promise<{ items: HubNotificationView[]; unread: number }> {
  return (await req(baseUrl, token, `/api/hub/notifications?limit=${limit}`)) as {
    items: HubNotificationView[];
    unread: number;
  };
}

/** 标记站内消息已读（all=true 或指定 ids） */
export async function hubMarkNotificationsRead(
  baseUrl: string,
  token: string,
  input: { ids?: string[]; all?: boolean },
): Promise<{ updated: number; unread: number }> {
  return (await req(baseUrl, token, "/api/hub/notifications/read", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { updated: number; unread: number };
}

/** 账户级用量聚合（跨节点） */
export interface HubUsageAgg {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpriced: number;
}

export interface HubUsageView {
  total: HubUsageAgg;
  nodes: HubUsageNodeRow[];
  days: { key: string; agg: HubUsageAgg }[];
  /**
   * 按项目拆分（同一项目在不同节点上分多条）。
   * `projectName` 由 Hub 从节点项目快照补齐；旧版节点不上报项目维度时为空数组。
   */
  projects?: HubUsageProjectRow[];
  from?: string;
  to?: string;
}

/** 用量按节点拆分行 */
export interface HubUsageNodeRow {
  nodeId: string;
  /** 节点展示名（Hub 节点记录里的 label；未命名时为 null，前端回退到 nodeId） */
  nodeLabel?: string | null;
  agg: HubUsageAgg;
  updatedAt: string;
}

/** 用量按项目拆分行 */
export interface HubUsageProjectRow {
  nodeId: string;
  /** 所属节点展示名（用于「项目已删除只剩 id」时定位） */
  nodeLabel?: string | null;
  projectId: string;
  /** 项目展示名（节点快照里取；节点已删除或旧版节点为 null） */
  projectName: string | null;
  agg: HubUsageAgg;
}

export async function hubGetUsage(
  baseUrl: string,
  token: string,
  params: { from?: string; to?: string; groupBy?: "node" | "day" } = {},
): Promise<HubUsageView> {
  const q = new URLSearchParams();
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.groupBy) q.set("groupBy", params.groupBy);
  const qs = q.toString();
  return (await req(baseUrl, token, `/api/hub/usage${qs ? `?${qs}` : ""}`)) as HubUsageView;
}

/** 节点上报用量（按天覆盖，幂等） */
export async function hubNodeUsageReport(
  baseUrl: string,
  token: string,
  nodeId: string,
  payload: {
    total?: unknown;
    byDay?: Record<string, unknown>;
    /** 项目维度：projectId → { total, byDay } */
    projects?: Record<string, unknown>;
    since?: string;
  },
): Promise<void> {
  await req(baseUrl, token, `/api/hub/nodes/${nodeId}/usage`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ===================== 系统管理员（/admin；仅 role=admin） =====================

export type HubAdminRole = "user" | "admin";
export type HubAdminUserStatus = "active" | "disabled" | "deleted";

/** 管理端用户行（列表与详情共用） */
export interface HubAdminUserRow {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  plan: string;
  planExpiresAt: string | null;
  role: HubAdminRole;
  status: HubAdminUserStatus;
  disabledAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  passwordSet: boolean;
  fleetCount: number;
  nodeCount: number;
  onlineCount: number;
  subscription: {
    plan: string;
    period: string;
    startedAt: string;
    expiresAt: string;
    channel: string;
    amount: number;
  } | null;
  ordersCount: number;
  paidCount: number;
  paidCents: number;
  /** 仅列表 ?withUsage=1 时返回 */
  usage?: HubUsageAgg;
}

/** 管理端总览 */
export interface HubAdminOverview {
  users: {
    total: number;
    active: number;
    disabled: number;
    deleted: number;
    admins: number;
    newLast7d: number;
  };
  fleets: { total: number };
  nodes: { total: number; online: number };
  orders: {
    total: number;
    paid: number;
    created: number;
    refunded: number;
    revenueCents: number;
    revenue30dCents: number;
    byProvider: Array<{ provider: string; count: number; amount: number }>;
  };
  plans: { free: number; pro: number; team: number };
  usage: HubUsageAgg | null;
}

/** 管理端节点（含网关实时状态） */
export interface HubAdminNode {
  nodeId: string;
  fleetId: string;
  label?: string;
  createdAt: string;
  state: {
    nodeId: string;
    online: boolean;
    lastSeen?: string;
    platform?: string;
    mode?: string;
    version?: string;
    ip?: string;
    projects?: Array<{ id: string; name: string; sessionCount?: number; running?: number; waiting?: number }>;
    totals?: HubNodeTotals | null;
    stats?: FleetNodeStats | null;
  };
}

/** 管理端订单行（含下单用户标识） */
export interface HubAdminOrderRow {
  id: string;
  userId: string;
  plan: string;
  period: string;
  amount: number;
  currency: string;
  provider: string;
  status: string;
  createdAt: string;
  paidAt?: string;
  providerTxnId?: string;
  user: { id: string; email: string | null; phone: string | null } | null;
}

/** 管理端用户详情 */
export interface HubAdminUserDetail {
  summary: HubAdminUserRow;
  fleets: Array<{
    id: string;
    ownerId: string;
    name: string;
    ungrouped?: boolean;
    nodeCount: number;
    createdAt: string;
  }>;
  nodes: HubAdminNode[];
  orders: HubAdminOrderRow[];
  subscription: HubAdminUserRow["subscription"];
  usage: HubUsageView | null;
}

export interface HubAdminAuditEntry {
  ts: string;
  userId?: string;
  action: string;
  detail?: Record<string, unknown>;
}

function adminQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** 总览统计 */
export async function hubAdminOverview(
  baseUrl: string,
  token: string,
): Promise<HubAdminOverview> {
  return (await req(baseUrl, token, "/api/hub/admin/overview")) as HubAdminOverview;
}

/** 用户列表（q 匹配 id/邮箱/手机号） */
export async function hubAdminUsers(
  baseUrl: string,
  token: string,
  params: {
    q?: string;
    status?: string;
    role?: string;
    plan?: string;
    withUsage?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ total: number; items: HubAdminUserRow[] }> {
  const qs = adminQuery({
    q: params.q,
    status: params.status,
    role: params.role,
    plan: params.plan,
    withUsage: params.withUsage ? 1 : undefined,
    limit: params.limit,
    offset: params.offset,
  });
  return (await req(baseUrl, token, `/api/hub/admin/users${qs}`)) as {
    total: number;
    items: HubAdminUserRow[];
  };
}

/** 用户详情（分组/节点/订单/订阅/用量） */
export async function hubAdminUserDetail(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<HubAdminUserDetail> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/admin/users/${encodeURIComponent(userId)}`,
  )) as HubAdminUserDetail;
}

/** 修改套餐 / 有效期（planExpiresAt 传 null 清除） */
export async function hubAdminUpdateUser(
  baseUrl: string,
  token: string,
  userId: string,
  patch: { plan?: string; planExpiresAt?: string | null },
): Promise<HubAdminUserRow> {
  return (await req(baseUrl, token, `/api/hub/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })) as HubAdminUserRow;
}

export async function hubAdminDisableUser(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<{ id: string; status: string }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/admin/users/${encodeURIComponent(userId)}/disable`,
    { method: "POST" },
  )) as { id: string; status: string };
}

export async function hubAdminEnableUser(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<{ id: string; status: string }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/admin/users/${encodeURIComponent(userId)}/enable`,
    { method: "POST" },
  )) as { id: string; status: string };
}

/** 软删用户（数据保留，可用 enable 恢复） */
export async function hubAdminDeleteUser(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<{ id: string; status: string }> {
  return (await req(baseUrl, token, `/api/hub/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  })) as { id: string; status: string };
}

/** 设置/取消管理员（服务端守卫最后一个管理员） */
export async function hubAdminSetRole(
  baseUrl: string,
  token: string,
  userId: string,
  role: HubAdminRole,
): Promise<{ id: string; role: string }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/admin/users/${encodeURIComponent(userId)}/role`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  )) as { id: string; role: string };
}

/** 给用户发送站内通知 */
export async function hubAdminNotifyUser(
  baseUrl: string,
  token: string,
  userId: string,
  input: { title: string; body?: string; link?: string },
): Promise<{ sent: boolean; notificationId: string | null }> {
  return (await req(
    baseUrl,
    token,
    `/api/hub/admin/users/${encodeURIComponent(userId)}/notify`,
    { method: "POST", body: JSON.stringify(input) },
  )) as { sent: boolean; notificationId: string | null };
}

/** 管理端删除分组（节点归入 owner 的「未分组」） */
export async function hubAdminDeleteFleet(
  baseUrl: string,
  token: string,
  fleetId: string,
): Promise<{ deleted: boolean; movedNodes: number }> {
  return (await req(baseUrl, token, `/api/hub/admin/fleets/${encodeURIComponent(fleetId)}`, {
    method: "DELETE",
  })) as { deleted: boolean; movedNodes: number };
}

/** 管理端删除节点（仅移除 Hub 纳管记录） */
export async function hubAdminDeleteNode(
  baseUrl: string,
  token: string,
  nodeId: string,
): Promise<{ deleted: boolean }> {
  return (await req(baseUrl, token, `/api/hub/admin/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
  })) as { deleted: boolean };
}

/** 全站订单（可按状态/渠道/日期/关键词过滤） */
export async function hubAdminOrders(
  baseUrl: string,
  token: string,
  params: {
    status?: string;
    provider?: string;
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ total: number; items: HubAdminOrderRow[] }> {
  const qs = adminQuery({
    status: params.status,
    provider: params.provider,
    q: params.q,
    from: params.from,
    to: params.to,
    limit: params.limit,
    offset: params.offset,
  });
  return (await req(baseUrl, token, `/api/hub/admin/orders${qs}`)) as {
    total: number;
    items: HubAdminOrderRow[];
  };
}

/** 订单手动标记：paid（激活套餐，幂等）/ refunded（仅状态+通知） */
export async function hubAdminMarkOrder(
  baseUrl: string,
  token: string,
  orderId: string,
  input: { status: "paid" | "refunded"; note?: string },
): Promise<HubAdminOrderRow> {
  return (await req(baseUrl, token, `/api/hub/admin/orders/${encodeURIComponent(orderId)}/mark`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as HubAdminOrderRow;
}

/** 审计日志（最新在前） */
export async function hubAdminAudit(
  baseUrl: string,
  token: string,
  params: { userId?: string; action?: string; limit?: number; offset?: number } = {},
): Promise<{ total: number; entries: HubAdminAuditEntry[] }> {
  const qs = adminQuery({
    userId: params.userId,
    action: params.action,
    limit: params.limit,
    offset: params.offset,
  });
  return (await req(baseUrl, token, `/api/hub/admin/audit${qs}`)) as {
    total: number;
    entries: HubAdminAuditEntry[];
  };
}

/**
 * 账号级站内消息流（fetch 流式读取；EventSource 不能带 Authorization 头）。
 *
 * 「去 EMQX」后这是站内消息**唯一**的实时通道（从前是 MQTT 的账号通知 topic）。
 * 断开期间由 `hubNotifications` 轮询兜底。
 */
export function hubNotificationStream(
  baseUrl: string,
  token: string,
  onNotification: (n: HubNotificationView) => void,
  onClosed?: () => void,
  onActivity?: () => void,
): () => void {
  const controller = new AbortController();
  let cancelled = false;
  const url = `${resolveBase(baseUrl).replace(/\/$/, "")}/api/hub/notifications/stream`;
  (async () => {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      });
      if (!res.ok || !res.body) {
        onClosed?.();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 收到任何字节（含注释心跳）都算活跃，避免误判空闲后频繁重连
        onActivity?.();
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          try {
            onNotification(JSON.parse(data) as HubNotificationView);
          } catch {
            // 忽略非法载荷
          }
        }
      }
    } catch {
      // 连接中断
    } finally {
      if (!cancelled) onClosed?.();
    }
  })();
  return () => {
    cancelled = true;
    controller.abort();
  };
}

// ===================== 任务通知设置（Hub 订阅网关 NOTIFY 后远程通知） =====================

export type HubNotifyChannelType = "email" | "sms" | "wechat" | "webhook";

export type HubWebhookFormat = "generic" | "onebot" | "wecom" | "dingtalk" | "feishu";

export interface HubNotifyChannelView {
  id: string;
  type: HubNotifyChannelType;
  enabled: boolean;
  /**
   * email: `{ to, subjectPrefix? }`
   * sms: `{ phone, includeLink? }`
   * wechat: `{ openid, templateId?, fields?, url? }`
   * webhook: `{ url, format, targetType?, target? }`
   */
  config: Record<string, string>;
}

export interface HubNotifySettingsView {
  enabled: boolean;
  events: {
    approval: boolean;
    question: boolean;
    completed: boolean;
    error: boolean;
  };
  channels: HubNotifyChannelView[];
  cooldownSeconds?: number;
  /** 聚合窗口（秒）：窗口内事件合并成一封邮件；0 = 每条立即发送 */
  digestSeconds?: number;
  quietHours?: { start: string; end: string };
}

export interface HubNotifyChannelAvailability {
  email: boolean;
  sms: boolean;
  wechat: boolean;
  webhook: boolean;
}

export interface HubNotifySettingsResponse {
  settings: HubNotifySettingsView;
  /** 当前套餐是否允许通知渠道（free 为 false） */
  planAllows: boolean;
  maxChannels: number;
  /** Hub 是否已启用告警订阅（缺网关地址/终端密钥时为 false） */
  alertsEnabled: boolean;
  /** 服务端各渠道后端是否就绪（未配置时发送必然失败） */
  available: HubNotifyChannelAvailability;
}

export interface HubAlertEventView {
  id: string;
  userId: string;
  nodeId: string;
  nodeLabel?: string;
  fleetId: string;
  projectId?: string;
  sessionId: string;
  sessionName?: string | null;
  kind: "approval_request" | "question_asked" | "turn_completed" | "turn_stopped" | "error";
  title: string;
  body: string;
  link?: string;
  createdAt: string;
}

export interface HubNotifyDeliveryResult {
  channelId: string;
  type: HubNotifyChannelType;
  ok: boolean;
  error?: string;
}

/** 读取当前账号的通知设置 */
export async function hubNotifySettings(
  baseUrl: string,
  token: string,
): Promise<HubNotifySettingsResponse> {
  return (await req(baseUrl, token, "/api/hub/notify/settings")) as HubNotifySettingsResponse;
}

/** 保存通知设置（服务端校验；free 套餐返回 402） */
export async function hubSaveNotifySettings(
  baseUrl: string,
  token: string,
  settings: HubNotifySettingsView,
): Promise<{ settings: HubNotifySettingsView }> {
  return (await req(baseUrl, token, "/api/hub/notify/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  })) as { settings: HubNotifySettingsView };
}

/**
 * 工作台置顶项（账号级，跨设备同步）。
 *
 * 键由「层级路径」拼成，用于在服务端排序前置顶项：
 *   nodes    `fleetId/nodeId`
 *   projects `fleetId/nodeId/projectId`
 *   tasks    `fleetId/nodeId/projectId/sessionId`
 *
 * 存用户实体（PG 是 `hub_users.data` jsonb），新增不需要迁移。
 */
export interface HubPins {
  nodes: string[];
  projects: string[];
  tasks: string[];
}

/** 读取当前账号的置顶项 */
export async function hubPins(baseUrl: string, token: string): Promise<HubPins> {
  return (await req(baseUrl, token, "/api/hub/pins")) as HubPins;
}

/** 整体保存置顶项（前端本地已是全量，切换一次就回写一次） */
export async function hubSavePins(
  baseUrl: string,
  token: string,
  pins: HubPins,
): Promise<{ pins: HubPins }> {
  return (await req(baseUrl, token, "/api/hub/pins", {
    method: "PUT",
    body: JSON.stringify(pins),
  })) as { pins: HubPins };
}

/** 向所有启用渠道发送一条测试通知 */
export async function hubTestNotify(
  baseUrl: string,
  token: string,
): Promise<{ alert: HubAlertEventView; results: HubNotifyDeliveryResult[] }> {
  return (await req(baseUrl, token, "/api/hub/notify/test", {
    method: "POST",
  })) as { alert: HubAlertEventView; results: HubNotifyDeliveryResult[] };
}

/** 最近的任务告警（内存记录，用于设置页/排查） */
export async function hubNotifyEvents(
  baseUrl: string,
  token: string,
  limit = 50,
): Promise<{ items: HubAlertEventView[] }> {
  const qs = `?limit=${encodeURIComponent(String(limit))}`;
  return (await req(baseUrl, token, `/api/hub/notify/events${qs}`)) as {
    items: HubAlertEventView[];
  };
}

// ===================== 账号级发件 SMTP（Portal 配置，授权码加密存储） =====================

export interface HubSmtpView {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  from?: string;
  /** 是否已保存授权码（接口永不回传明文） */
  hasPass: boolean;
}

export interface HubSmtpResponse {
  smtp: HubSmtpView | null;
  /** 服务端是否配置了 HUB_SMTP_*（未配账号级时用它发） */
  serverConfigured: boolean;
  /** 是否允许在 Portal 里配置（服务端启用了加密存储） */
  editable: boolean;
}

/** 读取账号级发件配置（脱敏） */
export async function hubSmtpSettings(
  baseUrl: string,
  token: string,
): Promise<HubSmtpResponse> {
  return (await req(baseUrl, token, "/api/hub/notify/smtp")) as HubSmtpResponse;
}

/**
 * 保存账号级发件配置。
 *
 * `pass` 省略表示保留原授权码；传空串表示清空（内网无认证 SMTP）。
 */
export async function hubSaveSmtpSettings(
  baseUrl: string,
  token: string,
  input: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from?: string;
  },
): Promise<{ smtp: HubSmtpView }> {
  return (await req(baseUrl, token, "/api/hub/notify/smtp", {
    method: "PUT",
    body: JSON.stringify(input),
  })) as { smtp: HubSmtpView };
}

/** 清除账号级发件配置（回落到服务端 HUB_SMTP_*） */
export async function hubClearSmtpSettings(
  baseUrl: string,
  token: string,
): Promise<HubSmtpResponse> {
  return (await req(baseUrl, token, "/api/hub/notify/smtp", {
    method: "DELETE",
  })) as HubSmtpResponse;
}

/** 示例邮件预览（服务端用该账号真实节点快照渲染） */
export async function hubNotifyPreview(
  baseUrl: string,
  token: string,
): Promise<{ subject: string; text: string; html: string; nodeCount: number }> {
  return (await req(baseUrl, token, "/api/hub/notify/preview")) as {
    subject: string;
    text: string;
    html: string;
    nodeCount: number;
  };
}

// ---------------------------------------------------------------------------
// 志前大模型 API（余额/用量/充值只读聚合 + 开通申请）
// ---------------------------------------------------------------------------

/** 节点按天计费配置 */
export interface HubNodeBillingConfigView {
  currency: "CNY";
  /** 免费可管理的节点数；0 = 没有免费额度 */
  freeNodes: number;
  /** 每个计费节点每天的价格（分） */
  dailyPriceCents: number;
  /** 余额可维持天数的预警阈值（天），降序 */
  warnDays: number[];
}

export interface HubNodeBillingConfigResponse {
  pricing: HubNodeBillingConfigView;
  isDefault: boolean;
  examples: Array<{
    /** 节点总台数（含免费额度） */
    totalNodes: number;
    billableNodes: number;
    dailyYuan: number;
    monthlyYuan: number;
  }>;
}

/** 官网用户群二维码（管理后台上传，官网运行时按固定 URL 拉取） */
export interface HubCommunityQrView {
  /** `data:image/png;base64,...` */
  dataUrl: string;
  updatedAt: string;
}

export interface HubCommunityQrResponse {
  qr: HubCommunityQrView | null;
}

/** 官网二维码列表项（管理后台；含图片数据，供预览） */
export interface HubSocialQrItem {
  /** 稳定标识，站点用它拼图片地址 `/api/hub/community/qrs/<id>` */
  id: string;
  /** 展示名称，如「企业微信群」「公众号」「抖音」 */
  name: string;
  /** `data:image/png;base64,...` */
  dataUrl: string;
  updatedAt: string;
  /** 是否在官网展示；下线只是隐藏，图片仍保留 */
  online: boolean;
}

export interface HubSocialQrsResponse {
  items: HubSocialQrItem[];
}

export interface HubZqaiApiRequest {
  at: string;
  purpose: string;
  monthlyVolume?: string;
  contact?: string;
  status: "pending" | "approved" | "rejected";
}

export interface HubZqaiBalance {
  currency: string;
  available: number;
  available_micros: number;
  reserved: number;
  ledger_balance: number | null;
  source: string;
  as_of: string;
}

export interface HubZqaiUsageSummary {
  requests: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  charge: number;
  charge_micros: number;
  failed_requests: number;
}

export interface HubZqaiUsageBucket extends HubZqaiUsageSummary {
  day?: string;
  model?: string;
}

export interface HubZqaiUsage {
  from: string;
  to: string;
  group_by: string;
  summary: HubZqaiUsageSummary;
  items: HubZqaiUsageBucket[];
}

export interface HubZqaiRecharge {
  id: number;
  created_at: string;
  amount: number;
  amount_micros: number;
  balance_after: number;
  note: string | null;
  /**
   * 支付渠道（wechat / alipay）。engine 流水本身不带渠道，
   * hub 按 note 里的订单号回查本地订单补出来；运营调账 / 注册赠送为 null。
   */
  provider?: string | null;
}

export interface HubZqaiRecharges {
  count: number;
  total: number;
  total_micros: number;
  items: HubZqaiRecharge[];
}

export interface HubApiServiceView {
  linked: boolean;
  tenantId: number | null;
  gatewayConfigured: boolean;
  request: HubZqaiApiRequest | null;
  balance: HubZqaiBalance | null;
  usage: HubZqaiUsage | null;
  recharges: HubZqaiRecharges | null;
  /** 节点计费概览（没有套餐上限，只有「可用 / 计费 / 免费」三个数） */
  nodes: {
    total: number;
    /** 可用总数（含免费额度） */
    activeTotal: number;
    freeNodes: number;
    billable: number;
    active: number;
  };
  /** 明文 Key（仅返回给本人；页面上默认打码） */
  apiKey?: string | null;
  /** 打码后的 Key，可安全地展示在截图里 */
  apiKeyMasked?: string | null;
  /** 调用地址，页面拼示例代码用 */
  apiBaseUrl?: string;
  /** 自动开通是否启用（关闭时走「提交申请」的老流程） */
  provisionEnabled?: boolean;
  /** 最近一次自动开通失败的原因 */
  provisionError?: string | null;
  /** 累计获得的注册赠金（元） */
  bonusYuan?: number;
}

export async function hubApiService(
  baseUrl: string,
  token: string,
  opts: { from?: string; to?: string; groupBy?: "day" | "model" } = {},
): Promise<HubApiServiceView> {
  const q = new URLSearchParams();
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.groupBy) q.set("groupBy", opts.groupBy);
  const suffix = q.toString() ? `?${q}` : "";
  return (await req(baseUrl, token, `/api/hub/api-service${suffix}`)) as HubApiServiceView;
}

/**
 * 重置 API Key：旧 Key 立即失效。
 *
 * 注意：engine 每 5 秒轮询配置，**新 Key 生效、旧 Key 失效都有约 5 秒延迟**。
 * 页面上的提示要说明这一点，否则用户重置后立刻测试会看到旧 Key 仍可用。
 */
export async function hubRotateApiKey(
  baseUrl: string,
  token: string,
): Promise<{ apiKey: string; apiKeyMasked: string; tenantId: number }> {
  return (await req(baseUrl, token, "/api/hub/api-service/key/rotate", {
    method: "POST",
  })) as { apiKey: string; apiKeyMasked: string; tenantId: number };
}

export async function hubRequestApiService(
  baseUrl: string,
  token: string,
  input: { purpose: string; monthlyVolume?: string; contact?: string },
): Promise<{ submitted: boolean; request: HubZqaiApiRequest }> {
  return (await req(baseUrl, token, "/api/hub/api-service/request", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { submitted: boolean; request: HubZqaiApiRequest };
}

export async function hubAdminNodeBilling(
  baseUrl: string,
  token: string,
): Promise<HubNodeBillingConfigResponse> {
  return (await req(baseUrl, token, "/api/hub/admin/node-billing")) as HubNodeBillingConfigResponse;
}

export async function hubAdminUpdateNodeBilling(
  baseUrl: string,
  token: string,
  pricing: HubNodeBillingConfigView,
): Promise<{ pricing: HubNodeBillingConfigView }> {
  return (await req(baseUrl, token, "/api/hub/admin/node-billing", {
    method: "PUT",
    body: JSON.stringify(pricing),
  })) as { pricing: HubNodeBillingConfigView };
}

/** 读取官网用户群二维码（管理后台） */
export async function hubAdminCommunity(
  baseUrl: string,
  token: string,
): Promise<HubCommunityQrResponse> {
  return (await req(baseUrl, token, "/api/hub/admin/community")) as HubCommunityQrResponse;
}

/** 保存官网用户群二维码；dataUrl 形如 `data:image/png;base64,...` */
export async function hubAdminUpdateCommunity(
  baseUrl: string,
  token: string,
  dataUrl: string,
): Promise<HubCommunityQrResponse> {
  return (await req(baseUrl, token, "/api/hub/admin/community", {
    method: "PUT",
    body: JSON.stringify({ dataUrl }),
  })) as HubCommunityQrResponse;
}

/** 清除官网用户群二维码（官网回退到内置占位图） */
export async function hubAdminClearCommunity(
  baseUrl: string,
  token: string,
): Promise<HubCommunityQrResponse> {
  return (await req(baseUrl, token, "/api/hub/admin/community", {
    method: "DELETE",
  })) as HubCommunityQrResponse;
}

/** 官网二维码列表（全部项，含未上线；后台预览用） */
export async function hubAdminSocialQrs(
  baseUrl: string,
  token: string,
): Promise<HubSocialQrsResponse> {
  return (await req(baseUrl, token, "/api/hub/admin/community/qrs")) as HubSocialQrsResponse;
}

/** 新增一个二维码（名称 + 图片 data URL） */
export async function hubAdminAddSocialQr(
  baseUrl: string,
  token: string,
  input: { id?: string; name: string; dataUrl: string; online?: boolean },
): Promise<{ item: HubSocialQrItem }> {
  return (await req(baseUrl, token, "/api/hub/admin/community/qrs", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { item: HubSocialQrItem };
}

/** 局部更新：改名 / 换图 / 上线下线，只传需要改的字段 */
export async function hubAdminUpdateSocialQr(
  baseUrl: string,
  token: string,
  id: string,
  patch: { name?: string; dataUrl?: string; online?: boolean },
): Promise<{ item: HubSocialQrItem }> {
  return (await req(baseUrl, token, `/api/hub/admin/community/qrs/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  })) as { item: HubSocialQrItem };
}

/** 删除一个二维码 */
export async function hubAdminRemoveSocialQr(
  baseUrl: string,
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  return (await req(baseUrl, token, `/api/hub/admin/community/qrs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })) as { ok: boolean };
}

/** 绑定 zqai 租户，或驳回申请（reject: true） */
export async function hubAdminLinkZqai(
  baseUrl: string,
  token: string,
  userId: string,
  input: { tenantId?: number; reject?: boolean },
): Promise<Record<string, unknown>> {
  return (await req(baseUrl, token, `/api/hub/admin/users/${encodeURIComponent(userId)}/zqai`, {
    method: "PUT",
    body: JSON.stringify(input),
  })) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 账户余额与节点计费（全系统只有一个余额）
// ---------------------------------------------------------------------------

export interface HubWalletEntryView {
  id: string;
  userId: string;
  deltaCents: number;
  balanceAfterCents: number;
  ref: string;
  note?: string;
  createdAt: string;
  /** 支付渠道（wechat / alipay）；非下单充值（调账 / 赠送）为 null */
  provider?: string | null;
}

/** 节点计费概览：可用台数由余额决定 */
export interface HubNodeBillingView {
  freeNodes: number;
  /** 每个计费节点每天的价格（分） */
  dailyPriceCents: number;
  /** 节点总台数（含免费额度） */
  totalNodes: number;
  /** 当前可用节点总数（含免费额度那几台） */
  activeTotalNodes: number;
  /** 计费节点数 = max(0, totalNodes - freeNodes) */
  billableNodes: number;
  /** 当前可用的计费节点数 */
  activeNodes: number;
  /** 因余额不足被暂停的计费节点数 */
  suspendedNodes: number;
  status: "active" | "suspended";
  /** 已结算到哪一天 */
  billedThrough: string | null;
  /** true = 不参与按天计费（admin 账号 / license 实例），UI 应隐藏余额预警 */
  exempt: boolean;
  /** 余额还能撑几天；无计费可用节点时为 null */
  daysRemaining: number | null;
  /** 预警阈值，降序（如 [15,7,3]） */
  warnDays: number[];
  /** 命中的预警档位；未命中为 null */
  warningTier: number | null;
}

/**
 * 账户余额 + 节点计费概览。
 *
 * 余额只有一份（zqai 租户账本）：API 调用与节点计费都从它扣，
 * 充值也只有一条链路。`balanceCents` 为 null 表示暂时读不到（engine 未接入/抖动），
 * 而不是「余额为 0」。
 */
export interface HubWalletView {
  balanceCents: number | null;
  /** 充值记录（来自 engine 的流水） */
  entries: HubWalletEntryView[];
  nodeBilling: HubNodeBillingView;
}

export async function hubWallet(baseUrl: string, token: string): Promise<HubWalletView> {
  return (await req(baseUrl, token, "/api/hub/wallet")) as HubWalletView;
}

export async function hubWalletTopup(
  baseUrl: string,
  token: string,
  input: { amountYuan: number; provider?: string },
): Promise<{
  order: { id: string; amount: number; status: string };
  mode: string;
  qrContent: string | null;
  redirectUrl: string | null;
}> {
  return (await req(baseUrl, token, "/api/hub/wallet/topup", {
    method: "POST",
    body: JSON.stringify(input),
  })) as never;
}

export async function hubApiTopup(
  baseUrl: string,
  token: string,
  input: { amountYuan: number; provider?: string },
): Promise<{
  order: { id: string; amount: number; status: string };
  mode: string;
  qrContent: string | null;
  redirectUrl: string | null;
}> {
  return (await req(baseUrl, token, "/api/hub/api-service/topup", {
    method: "POST",
    body: JSON.stringify(input),
  })) as never;
}

// ---------------------------------------------------------------------------
// 退款 / 财务报表 / 账单（P3）
// ---------------------------------------------------------------------------

export interface HubBillingReport {
  object: string;
  currency: string;
  from: string;
  to: string;
  wallet: {
    topupCents: number;
    refundCents: number;
    seatCents: number;
    adjustCents: number;
    netCents: number;
    entries: number;
    /** 余额在 engine 侧，hub 不再持有快照；null 表示需要到 engine 查 */
    closingBalanceCents: number | null;
  };
  orders: {
    walletTopup: { count: number; cents: number };
    apiTopup: { count: number; cents: number };
    plan: { count: number; cents: number };
    refundedCount: number;
    refundedCents: number;
  };
  nodeBilling: {
    /** 有计费节点的用户数 */
    billedUsers: number;
    /** 有节点因余额被暂停的用户数 */
    suspendedUsers: number;
    activeBillableNodes: number;
    dailyPriceCents: number;
    freeNodes: number;
    /** 按「可用计费节点 × 日单价 × 30」估算 */
    mrrCents: number;
  };
  users: { total: number; paidInRange: number };
}

export async function hubAdminBillingReport(
  baseUrl: string,
  token: string,
  range: { from?: string; to?: string } = {},
): Promise<HubBillingReport> {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  const suffix = q.toString() ? `?${q}` : "";
  return (await req(baseUrl, token, `/api/hub/admin/reports/billing${suffix}`)) as HubBillingReport;
}

/** 报表 CSV 下载地址（前端直接用带 token 的 fetch 拉，或拼到 a[href]）。 */
export function hubBillingExportUrl(
  baseUrl: string,
  range: { from?: string; to?: string } = {},
): string {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  const suffix = q.toString() ? `?${q}` : "";
  return `${resolveBase(baseUrl).replace(/\/$/, "")}/api/hub/admin/reports/billing/export${suffix}`;
}

export async function hubAdminRefund(
  baseUrl: string,
  token: string,
  userId: string,
  input: { amountYuan: number; reason: string; orderId?: string },
): Promise<{ userId: string; orderId: string | null; amountCents: number; balanceCents?: number }> {
  return (await req(baseUrl, token, `/api/hub/admin/users/${encodeURIComponent(userId)}/refund`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as never;
}

export interface HubStatement {
  object: string;
  currency: string;
  from: string;
  to: string;
  user: { id: string; email: string | null; phone: string | null };
  nodeBilling: {
    freeNodes: number;
    dailyPriceCents: number;
    billableNodes: number;
    status: string;
    billedThrough: string | null;
  };
  totals: {
    walletTopupCents: number;
    nodeChargeCents: number;
    /** 模型调用扣费（engine 按 token 自动扣） */
    modelChargeCents: number;
    /** 总支出 = 节点 + 模型 */
    spendCents: number;
    refundCents: number;
    adjustCents: number;
    /** engine 不可达时为 null（不要当成 0） */
    closingBalanceCents: number | null;
    balanceSource: string | null;
  };
  nodeCharges: Array<{
    at: string;
    /** 计费自然日（东八区） */
    day: string;
    amountCents: number;
    /** 计费节点总数 */
    billableNodes: number;
    /** 当天实际可用（付得起）的计费节点数 */
    activeNodes: number;
    dailyPriceCents: number;
  }>;
  entries: Array<{
    at: string;
    ref: string;
    amountCents: number;
    balanceAfterCents: number | null;
    note: string | null;
    channel: "engine" | "order";
    /** 支付渠道（wechat / alipay）；非下单充值（调账 / 赠送）为 null */
    provider?: string | null;
  }>;
  modelUsage: {
    summary: Record<string, number | string>;
    items: Array<Record<string, unknown>>;
  } | null;
  orders: Array<{
    id: string;
    at: string;
    purpose: string;
    plan: string;
    period: string;
    amountCents: number;
    status: string;
    provider: string;
    paidAt: string | null;
  }>;
}

export async function hubStatement(
  baseUrl: string,
  token: string,
  range: { from?: string; to?: string } = {},
): Promise<HubStatement> {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  const suffix = q.toString() ? `?${q}` : "";
  return (await req(baseUrl, token, `/api/hub/statement${suffix}`)) as HubStatement;
}
