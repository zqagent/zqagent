/**
 * Hub REST 客户端（浏览器/桌面共用，纯 fetch，无 Node 依赖）
 *
 * 账号/节点管理/节点/指令代理/消息/事件流。浏览器只持会话令牌，节点密钥留在 Hub。
 * 供 packages/portal（统一控制台：桌面壳内嵌 + 浏览器用户中心）复用。
 */
import type { FleetCredential, FleetNodeStats, SessionStateEntry } from "./fleet.js";

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
}

/** 节点详情（含节点管理归属与创建时间） */
export interface HubNodeDetail extends HubNodeSummary {
  fleetId: string;
  fleetName: string;
  createdAt: string;
}

/** 项目总览里的单条任务（会话） */
export interface HubProjectTask {
  sessionId: string;
  name: string | null;
  status: string;
  lastUserMessage: string | null;
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
}

export interface HubUserView {
  id: string;
  email: string | null;
  phone: string | null;
  plan: string;
  /** 是否已设置可用密码（短信登录自动注册后为 false） */
  passwordSet?: boolean;
  /** 系统管理员角色（缺省 user）；仅 admin 可进入 /#/admin */
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

/** 注册（邮箱或手机号；手机号需先获取短信验证码） */
export async function hubRegisterAccount(
  baseUrl: string,
  input: HubAuthInput,
): Promise<{ token: string }> {
  return (await req(baseUrl, null, "/api/hub/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { token: string };
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

/** 发送邮箱验证码（注册校验，需图形验证码） */
export async function hubSendEmailCode(
  baseUrl: string,
  input: { email: string; captchaId: string; captcha: string },
): Promise<{ sent: boolean; expiresIn: number; debugCode?: string }> {
  return (await req(baseUrl, null, "/api/hub/auth/email/send", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { sent: boolean; expiresIn: number; debugCode?: string };
}

/** 忘记密码：手机号 + 短信验证码重置 */
export async function hubResetPassword(
  baseUrl: string,
  input: { phone: string; code: string; newPassword: string },
): Promise<{ changed: boolean }> {
  return (await req(baseUrl, null, "/api/hub/auth/password/reset", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { changed: boolean };
}

/** 当前用户（id/email/生效套餐） */
export async function hubMe(baseUrl: string, token: string): Promise<HubUserView> {
  return (await req(baseUrl, token, "/api/hub/me")) as HubUserView;
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

/** 项目总览（跨节点聚合，按最后完成任务时间倒序分页） */
export async function hubListProjects(
  baseUrl: string,
  token: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<HubProjectPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  return (await req(
    baseUrl,
    token,
    `/api/hub/projects?limit=${limit}&offset=${offset}`,
  )) as HubProjectPage;
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

/** 发起支付 */
export async function hubCheckout(
  baseUrl: string,
  token: string,
  input: { plan: "pro" | "team"; period: "monthly" | "yearly"; provider: string },
): Promise<{ order: HubOrderView; mode: string; qrContent: string | null; plan: string }> {
  return (await req(baseUrl, token, "/api/hub/checkout", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { order: HubOrderView; mode: string; qrContent: string | null; plan: string };
}

/** 我的订单 */
export async function hubOrders(baseUrl: string, token: string): Promise<HubOrderView[]> {
  return (await req(baseUrl, token, "/api/hub/orders")) as HubOrderView[];
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
  nodes: { nodeId: string; agg: HubUsageAgg; updatedAt: string }[];
  days: { key: string; agg: HubUsageAgg }[];
  from?: string;
  to?: string;
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
  payload: { total?: unknown; byDay?: Record<string, unknown>; since?: string },
): Promise<void> {
  await req(baseUrl, token, `/api/hub/nodes/${nodeId}/usage`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ===================== 系统管理员（/#/admin；仅 role=admin） =====================

export type HubAdminRole = "user" | "admin";
export type HubAdminUserStatus = "active" | "disabled" | "deleted";

/** 管理端用户行（列表与详情共用） */
export interface HubAdminUserRow {
  id: string;
  email: string | null;
  phone: string | null;
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
