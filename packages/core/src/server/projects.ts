/**
 * 项目（= 租户）与节点服务
 *
 * 从 routes.ts 抽出，供 REST 路由与 MQTT 节点管理指令共用，避免重复实现。
 * 「项目」对服务端而言就是一个租户（TenantConfig）。
 */
import * as path from "path";
import type { SessionStateEntry } from "@zqagent/shared/fleet";
import { Store, newId, generateApiKey } from "./store.js";
import { ApiError, LAST_USER_MESSAGE_MAX, type SessionManager } from "./session.js";
import { defaultTenantModel, nodeDefaultProvider, normalizeModelList, normalizeModelMeta } from "./nodeLlm.js";
import type { LlmProviderEntry, NodeInfo, ProjectSummary, TenantConfig } from "./types.js";

/** 租户 → 项目摘要（不含 apiKey 明文） */
export function toProjectSummary(store: Store, tenant: TenantConfig): ProjectSummary {
  return {
    id: tenant.id,
    name: tenant.name ?? tenant.id,
    model: tenant.model,
    baseURL: tenant.provider?.baseURL ?? "",
    hasApiKey: Boolean(tenant.provider?.apiKey),
    workspaceRoot: tenant.workspaceRoot ?? null,
    sessionCount: store.listSessions(tenant.id).length,
  };
}

/** 多 LLM 供应商的非敏感视图（apiKey 只回 hasApiKey） */
export function providerViews(tenant: TenantConfig) {
  return {
    activeProviderId: tenant.activeProviderId ?? null,
    providers: (tenant.llmProviders ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type ?? "",
      baseURL: p.baseURL,
      model: p.model,
      models: p.models ?? [],
      modelMeta: p.modelMeta ?? [],
      hasApiKey: Boolean(p.apiKey),
    })),
  };
}

/**
 * 应用「多供应商」补丁（与 REST PUT /config 语义一致）：
 * - providers 数组整体替换；每项 apiKey 为空时保留旧值；
 * - activeProviderId 指定当前项，并把其 baseURL/apiKey/model 同步到 provider/model。
 */
export function applyProvidersPatch(
  tenant: TenantConfig,
  raw: Record<string, unknown>,
): void {
  if (Array.isArray(raw.providers)) {
    const existing = new Map((tenant.llmProviders ?? []).map((p) => [p.id, p]));
    const next: LlmProviderEntry[] = [];
    for (const item of raw.providers) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = String(o.id ?? "").trim() || newId();
      const prev = existing.get(id);
      const apiKey =
        typeof o.apiKey === "string" && o.apiKey.trim() ? o.apiKey.trim() : prev?.apiKey;
      const models = normalizeModelList(o.models) ?? prev?.models;
      const modelMeta = normalizeModelMeta(o.modelMeta) ?? prev?.modelMeta;
      next.push({
        id,
        name: String(o.name ?? "").trim() || id,
        type: typeof o.type === "string" ? o.type : prev?.type,
        baseURL: String(o.baseURL ?? "").trim(),
        model: String(o.model ?? "").trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(models ? { models } : {}),
        ...(modelMeta ? { modelMeta } : {}),
      });
    }
    tenant.llmProviders = next;
  }
  if (typeof raw.activeProviderId === "string") {
    const activeId = raw.activeProviderId.trim();
    tenant.activeProviderId = activeId || undefined;
    const entry = (tenant.llmProviders ?? []).find((p) => p.id === activeId);
    if (entry) {
      tenant.provider = tenant.provider ?? {};
      tenant.provider.baseURL = entry.baseURL || undefined;
      if (entry.apiKey) tenant.provider.apiKey = entry.apiKey;
      if (entry.model) tenant.model = entry.model;
    }
  }
}

/** 全部项目摘要（管理员视图） */export function allProjectSummaries(store: Store): ProjectSummary[] {
  return store
    .listTenants()
    .map((id) => store.loadTenant(id))
    .filter((t): t is TenantConfig => t !== null)
    .map((t) => toProjectSummary(store, t));
}

/**
 * 跨项目汇总会话状态（只含标识与 status）。
 *
 * 供「节点首页 / 工作台」建立初始视图：`session_status` 通知负责增量，
 * 这里只补一次全量快照。不含消息、模型、token —— 明细去会话详情页拉。
 */
/**
 * 会话里用户最后一条消息（跳过空内容；没有则 null）。
 *
 * 优先用 `lastInput`：它在发送时（含运行中补充信息）立即写入并落盘，
 * 比 `messages` 早一拍——刚发出的指令不必等引擎推进 history 就能在列表看到。
 *
 * 除 `allSessionStates` 外，节点 info 快照（`FleetNodeBridge._publishInfo`）
 * 也用它，让跨节点工作台的任务行显示最后一轮用户消息。
 */
export function lastUserMessage(rec: {
  lastInput?: string;
  messages: unknown[];
}): string | null {
  const sent = (rec.lastInput ?? "").trim();
  if (sent) {
    return sent.length > LAST_USER_MESSAGE_MAX
      ? `${sent.slice(0, LAST_USER_MESSAGE_MAX)}…`
      : sent;
  }
  const msgs = rec.messages as Array<{ role?: string; content?: unknown }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    const text = m.content.trim();
    if (!text) continue;
    return text.length > LAST_USER_MESSAGE_MAX
      ? `${text.slice(0, LAST_USER_MESSAGE_MAX)}…`
      : text;
  }
  return null;
}

/**
 * 会话最近一次成功完成的时刻（ISO 8601；没有则 null）。
 *
 * 新会话直接读 `lastCompletedAt`；该字段上线前的历史会话没有记录，
 * 用「状态为已完成 + 最后一条 assistant 消息的时间」近似（同一轮内，
 * 误差通常在秒级），避免列表整列显示为空。零 IO，只扫已在内存的记录。
 */
function lastCompletedAt(rec: {
  status: string;
  lastCompletedAt?: string;
  messages: unknown[];
}): string | null {
  if (rec.lastCompletedAt) return rec.lastCompletedAt;
  if (rec.status !== "completed") return null;
  const msgs = rec.messages as Array<{ role?: string; ts?: unknown }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.ts === "number" && Number.isFinite(m.ts)) {
      return new Date(m.ts).toISOString();
    }
    return null;
  }
  return null;
}

export function allSessionStates(
  store: Store,
  manager: SessionManager,
): SessionStateEntry[] {
  const out: SessionStateEntry[] = [];
  for (const id of store.listTenants()) {
    const t = store.loadTenant(id);
    if (!t) continue;
    try {
      for (const s of manager.listSessions(t.id)) {
        out.push({
          projectId: t.id,
          projectName: t.name ?? t.id,
          sessionId: s.sessionId,
          name: s.name ?? null,
          status: s.status,
          lastUserMessage: lastUserMessage(s),
          lastStartedAt: s.lastStartedAt ?? null,
          lastCompletedAt: lastCompletedAt(s),
        });
      }
    } catch {
      // 单个项目读取失败不影响其它项目
    }
  }
  return out;
}

/** 确保节点具备稳定 ID（首次调用生成并落盘） */
export function ensureNodeId(store: Store): string {
  let id = store.loadNodeId();
  if (!id) {
    id = newId();
    store.saveNodeId(id);
  }
  return id;
}

export interface CreateProjectInput {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  baseURL?: unknown;
  providerApiKey?: unknown;
  workspaceRoot?: unknown;
  allowedCommands?: unknown;
  /** shell 免审策略 / 沙箱 / 变更追踪（与 .agent/permissions.json 同名） */
  shellPolicy?: unknown;
  sandbox?: unknown;
  vcs?: unknown;
}

/**
 * 让项目显示名不重复：重名时追加「 2」「 3」…
 *
 * 新建项目默认名都叫「我的工作区」这类通用词，不去重的话列表里会出现
 * 两个一模一样的条目，用户无从分辨。
 */
function uniqueProjectName(store: Store, wanted: string): string {
  const taken = new Set(
    store.listTenants().map((id) => store.loadTenant(id)?.name?.trim() || id),
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted} ${Date.now()}`;
}

/** shell 免审策略：非法值丢弃（回落默认 approve） */
function parseShellPolicy(raw: unknown): Pick<TenantConfig, "shellPolicy"> {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "approve" || v === "sandbox" || v === "workspace" || v === "all"
    ? { shellPolicy: v }
    : {};
}

/** 沙箱配置：mode 与 extraWritable 独立解析，非法项各自丢弃 */
function parseSandbox(raw: unknown): Pick<TenantConfig, "sandbox"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const mode = String(obj.mode ?? "").trim().toLowerCase();
  const extraWritable = Array.isArray(obj.extraWritable)
    ? obj.extraWritable.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0)
    : [];
  const out: NonNullable<TenantConfig["sandbox"]> = {};
  if (mode === "auto" || mode === "off" || mode === "required") {
    out.mode = mode;
  }
  if (extraWritable.length) out.extraWritable = extraWritable;
  return Object.keys(out).length ? { sandbox: out } : {};
}

/** 变更追踪配置 */
function parseVcs(raw: unknown): Pick<TenantConfig, "vcs"> {
  let mode: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    mode = (raw as Record<string, unknown>).mode;
  }
  const v = String(mode ?? "").trim().toLowerCase();
  return v === "auto" || v === "native" || v === "shadow" || v === "off"
    ? { vcs: { mode: v } }
    : {};
}

/**
 * 新建项目（= 租户）。返回的 TenantConfig 含自动生成的 apiKey，
 * 调用方按需决定是否回传给客户端（仅创建时一次）。
 */
export function createProject(store: Store, input: CreateProjectInput): TenantConfig {
  const raw = input ?? {};
  const id = String(raw.id ?? "").trim() || newId();
  if (store.loadTenant(id)) {
    throw new ApiError(409, "project_exists", `项目 ${id} 已存在`);
  }
  // 未指定目录时回退到节点默认工作区（WORKSPACE）：
  // 会话本来就跑在那里，不回填的话「文件」面板会因为 workspaceRoot 为空而整块消失，
  // 用户看到的是「新建了项目，但看不到任何文件」。
  const defaultWorkspace = (process.env.WORKSPACE ?? "").trim();
  const workspaceRoot =
    typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim()
      ? path.resolve(raw.workspaceRoot.trim())
      : defaultWorkspace
        ? path.resolve(defaultWorkspace)
        : undefined;
  // 默认名：用户未填时用工作目录名（basename）；无目录则用稳定 id。
  const explicitName =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  const defaultName = workspaceRoot ? path.basename(workspaceRoot) : id;
  const tenant: TenantConfig = {
    id,
    name: uniqueProjectName(store, explicitName || defaultName),
    apiKey: generateApiKey(),
    model:
      typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : defaultTenantModel(store),
    provider: {
      apiKey:
        typeof raw.providerApiKey === "string" && raw.providerApiKey.trim()
          ? raw.providerApiKey.trim()
          : undefined,
      baseURL:
        typeof raw.baseURL === "string" && raw.baseURL.trim()
          ? raw.baseURL.trim()
          : undefined,
    },
    workspaceRoot,
    allowedCommands: Array.isArray(raw.allowedCommands)
      ? raw.allowedCommands.map((c) => String(c))
      : [],
    // 以下三项此前只在类型里声明、建项目时没解析，导致「配置写了却不生效」。
    // 非法值一律丢弃（回落到会话装配时的默认值），不因一个脏字段拒绝建项目。
    ...parseShellPolicy(raw.shellPolicy),
    ...parseSandbox(raw.sandbox),
    ...parseVcs(raw.vcs),
  };
  // 新项目继承「节点默认 LLM」：未显式提供 provider 时带上节点默认的 baseURL/model/apiKey，
  // 并把节点级 LLM 列表复制为该项目的初始供应商（默认项置为当前）。
  const def = nodeDefaultProvider(store);
  if (def) {
    if (!tenant.provider?.apiKey && def.apiKey) tenant.provider = { ...tenant.provider, apiKey: def.apiKey };
    if (!tenant.provider?.baseURL && def.baseURL) tenant.provider = { ...tenant.provider, baseURL: def.baseURL };
    if (!(typeof raw.model === "string" && raw.model.trim()) && def.model) tenant.model = def.model;
    const nodeCfg = store.loadNodeLlm();
    tenant.llmProviders = nodeCfg.providers.map((p) => ({ ...p }));
    tenant.activeProviderId = nodeCfg.defaultProviderId ?? nodeCfg.providers[0]?.id;
  }
  store.saveTenant(tenant);
  return tenant;
}

/** 节点元信息（管理员=全部项目；否则仅传入的项目） */
export function buildNodeInfo(
  store: Store,
  opts: { admin: boolean; projects: ProjectSummary[]; nodeId?: string },
): NodeInfo {
  return {
    nodeId: opts.nodeId ?? ensureNodeId(store),
    platform: process.platform,
    mode: process.env.NODE_MODE ?? "standalone",
    version: process.env.ZQAGENT_VERSION ?? "dev",
    admin: opts.admin,
    projects: opts.projects,
  };
}
