/**
 * 节点管理指令分发（控制台 → 节点）
 *
 * 与 MQTT I/O 解耦的纯分发逻辑：给定一条已通过结构+签名+nonce 校验的
 * 指令信封，调用 Store / SessionManager 执行并返回回执（ack）。
 * 便于在不依赖 broker 的情况下单测。
 */
import { ApprovalOutcome } from "../../engine/events.js";
import { createHash } from "node:crypto";
import { Store } from "../store.js";
import {
  applyNodeLlmPatch,
  findNodeProvider,
  nodeLlmView,
  normalizeModelList,
  normalizeModelMeta,
} from "../nodeLlm.js";
import { SessionManager, ApiError } from "../session.js";
import {
  allProjectSummaries,
  allSessionStates,
  applyProvidersPatch,
  buildNodeInfo,
  createProject,
  providerViews,
  toProjectSummary,
} from "../projects.js";
import { fetchModelContext, fetchModels } from "../../providers/models.js";
import { listDirs, searchDirs, makeDirIn } from "../fsBrowser.js";
import {
  listProjectFiles,
  readProjectFile,
  downloadProjectFile,
  writeProjectFile,
  createProjectDir,
  createProjectFile,
  searchProjectFiles,
} from "../projectFiles.js";
import {
  runProjectCommand,
  projectGitStatus,
  projectGitDiff,
  projectGitBranches,
  projectGitLog,
  projectGitShow,
  projectGitRefs,
  projectGitFetch,
  projectGitStage,
  projectGitUnstage,
  projectGitCommit,
  projectGitCheckout,
  projectGitPull,
  projectGitPush,
  projectGitRepos,
} from "../projectOps.js";
import { generateGitCommitMessage } from "../gitCommitMessage.js";
import { buildToolCatalog } from "../toolsCatalog.js";
import { listShellTasks, killShellTask } from "../../tools/shell.js";
import { loadServerMcpConfigs } from "../mcpConfig.js";
import { projectStats } from "../projectStats.js";
import { buildNodeHost } from "../nodeHost.js";
import type { SessionRecord, TenantConfig } from "../types.js";
import type { FleetAckPayload, FleetCmdEnvelope } from "@zqagent/shared/fleet";
import type { FleetCredential } from "@zqagent/shared/fleet";

/**
 * 模型列表缓存 + 限时：LLM 端点不可达/慢时 fetchModels 单次可阻塞 10-20s，
 * 控制台每次打开会话都会查询，会长时间占住节点事件循环并拖慢所有指令
 * （曾表现为指令超时、保活丢包）。成功缓存 5 分钟，失败缓存 30s。
 */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_FAIL_TTL_MS = 30 * 1000;
const MODEL_FETCH_TIMEOUT_MS = 6000;
const modelCache = new Map<
  string,
  { at: number; ttl: number; result: Awaited<ReturnType<typeof fetchModels>> }
>();

/** 缓存键：baseURL + apiKey 摘要（不落明文 Key） */
function modelCacheKey(baseURL: string, apiKey: string): string {
  return `${baseURL}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

async function cachedFetchModels(
  baseURL: string,
  apiKey: string,
): Promise<Awaited<ReturnType<typeof fetchModels>>> {
  const key = modelCacheKey(baseURL, apiKey);
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  let result: Awaited<ReturnType<typeof fetchModels>> = null;
  try {
    result = await Promise.race([
      fetchModels(baseURL, apiKey),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), MODEL_FETCH_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  } catch {
    result = null;
  }
  modelCache.set(key, {
    at: Date.now(),
    ttl: result ? MODEL_CACHE_TTL_MS : MODEL_FAIL_TTL_MS,
    result,
  });
  if (modelCache.size > 100) {
    const keys = [...modelCache.keys()];
    for (const k of keys.slice(0, keys.length - 50)) modelCache.delete(k);
  }
  return result;
}

/**
 * 刷新模型列表，并在供应商未返回上下文长度时对当前（或首个）模型单体探测一次。
 * 探测同样受 6s 限制，超时即放弃，不影响列表本身的返回。
 *
 * 探测结果（含失败）都回写缓存：多数网关并不实现 `/models/{id}`，若不缓存，
 * 控制台每次打开会话都会重新等满 6s，重回「查询阻塞节点事件循环」的老问题。
 */
async function cachedFetchModelsEnriched(
  baseURL: string,
  apiKey: string,
  preferred?: string,
): Promise<Awaited<ReturnType<typeof fetchModels>>> {
  const r = await cachedFetchModels(baseURL, apiKey);
  if (!r || (r.modelMeta?.length ?? 0) > 0) return r;
  const target = preferred?.trim() || r.models[0];
  if (!target) return r;
  const ctx = await Promise.race([
    fetchModelContext(baseURL, apiKey, target),
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), MODEL_FETCH_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
  const enriched = ctx ? { ...r, modelMeta: [{ id: target, contextWindow: ctx }] } : r;
  modelCache.set(modelCacheKey(baseURL, apiKey), {
    at: Date.now(),
    ttl: ctx ? MODEL_CACHE_TTL_MS : MODEL_FAIL_TTL_MS,
    result: enriched,
  });
  return enriched;
}

export interface FleetDeps {
  store: Store;
  manager: SessionManager;
  /** 本节点 ID（桥使用的权威标识；缺省回退 store node.json） */
  nodeId?: string;
  /** 应用新的设备分组凭据（改名/换组：写本地 fleet.json 并重连） */
  applyFleetCred?: (cred: FleetCredential) => Promise<void> | void;
}

function parseDecision(v: unknown): ApprovalOutcome {
  switch (String(v ?? "")) {
    case "once":
      return ApprovalOutcome.ONCE;
    case "always_tool":
      return ApprovalOutcome.ALWAYS_TOOL;
    case "always_command":
      return ApprovalOutcome.ALWAYS_COMMAND;
    case "deny":
      return ApprovalOutcome.DENY;
    default:
      throw new ApiError(
        400,
        "invalid_decision",
        "decision 必须是 once / always_tool / always_command / deny 之一",
      );
  }
}

function sessionSummary(s: SessionRecord) {
  return {
    sessionId: s.sessionId,
    status: s.status,
    model: s.model,
    name: s.name ?? null,
    messageCount: (s.messages as unknown[]).length,
    savedAt: s.savedAt,
  };
}

function stateView(rec: SessionRecord, pendingSteers: string[], seq: number) {
  return {
    sessionId: rec.sessionId,
    status: rec.status,
    model: rec.model,
    providerId: rec.providerId ?? null,
    name: rec.name ?? null,
    nameSource: rec.nameSource ?? null,
    taskCount: rec.taskCount ?? 0,
    permissionMode: rec.permissionMode ?? "interactive",
    draft: rec.draft ?? "",
    pendingSteers,
    seq,
    messageCount: (rec.messages as unknown[]).length,
    approvals: rec.approvals,
    questions: rec.questions,
    savedAt: rec.savedAt,
  };
}

function configView(t: TenantConfig) {
  const active = (t.llmProviders ?? []).find((p) => p.id === t.activeProviderId);
  return {
    name: t.name ?? null,
    model: t.model,
    baseURL: t.provider?.baseURL ?? "",
    hasApiKey: Boolean(t.provider?.apiKey),
    /** 上次刷新的候选模型（active 供应商优先，其次默认 provider） */
    models: active?.models ?? t.provider?.models ?? [],
    workspaceRoot: t.workspaceRoot ?? null,
    ...providerViews(t),
  };
}

/** 应用配置补丁（与 REST PUT /config 语义一致） */
function applyConfigPatch(tenant: TenantConfig, raw: Record<string, unknown>): void {
  tenant.provider = tenant.provider ?? {};
  applyProvidersPatch(tenant, raw);
  if (typeof raw.workspaceRoot === "string") {
    const ws = raw.workspaceRoot.trim();
    if (ws) tenant.workspaceRoot = ws;
    else delete tenant.workspaceRoot;
  }
  if (typeof raw.name === "string" && raw.name.trim()) tenant.name = raw.name.trim();
  if (typeof raw.model === "string" && raw.model.trim()) tenant.model = raw.model.trim();
  if (typeof raw.baseURL === "string") {
    const v = raw.baseURL.trim();
    if (v) tenant.provider.baseURL = v;
    else delete tenant.provider.baseURL;
  }
  if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
    tenant.provider.apiKey = raw.apiKey.trim();
  } else if (raw.apiKey === null) {
    delete tenant.provider.apiKey;
  }
}

/** 舰队指令 payload.paths（数组/字符串）→ 路径数组（git_stage / git_unstage） */
function gitPaths(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((p) => String(p)).filter((p) => p.length > 0);
}

/** 舰队指令 payload.repo（工作区相对路径；空 = 工作区根） */
function gitRepo(raw: unknown): string | undefined {
  return String(raw ?? "").trim() || undefined;
}

/**
 * 执行一条节点管理指令，返回回执。任何异常都转成 ok=false 的回执（不抛出），
 * 由调用方发布到 ack topic。
 */
export async function dispatchFleetCommand(
  deps: FleetDeps,
  env: FleetCmdEnvelope,
): Promise<FleetAckPayload> {
  const { store, manager } = deps;
  const payload = env.payload;
  const fail = (error: string): FleetAckPayload => ({
    reqId: env.reqId,
    type: env.type,
    ok: false,
    error,
  });
  const ok = (data?: unknown): FleetAckPayload => ({
    reqId: env.reqId,
    type: env.type,
    ok: true,
    data,
  });

  const project = (): TenantConfig => {
    if (!env.projectId) throw new ApiError(400, "project_required", "该命令需要 projectId");
    const t = store.loadTenant(env.projectId);
    if (!t) throw new ApiError(404, "not_found", "项目不存在");
    return t;
  };
  const sessionId = (): string => {
    const id = env.sessionId ?? "";
    if (!id) throw new ApiError(400, "session_required", "该命令需要 sessionId");
    return id;
  };

  try {
    switch (env.type) {
      case "ping":
        return ok({ pong: true, ts: Date.now() });

      case "get_node_info":
        return ok(
          buildNodeInfo(store, {
            admin: true,
            projects: allProjectSummaries(store),
            nodeId: deps.nodeId,
          }),
        );

      case "get_node_host": {
        const projectId = env.projectId ?? "";
        const t = projectId ? store.loadTenant(projectId) : null;
        return ok(buildNodeHost(store, manager, t?.workspaceRoot ?? undefined));
      }

      case "get_node_llm":
        return ok(nodeLlmView(store.loadNodeLlm()));

      case "list_node_llm_models": {
        const cfg = store.loadNodeLlm();
        const picked =
          typeof payload.providerId === "string" && payload.providerId
            ? findNodeProvider(store, payload.providerId)
            : null;
        const apiKey =
          (typeof payload.apiKey === "string" ? payload.apiKey.trim() : "") ||
          picked?.apiKey ||
          "";
        const baseURL = String(payload.baseURL ?? "").trim() || picked?.baseURL || "";
        if (!baseURL) throw new ApiError(400, "bad_request", "缺少 Base URL");
        if (!apiKey) throw new ApiError(400, "bad_request", "缺少 API Key");
        const r = await cachedFetchModelsEnriched(baseURL, apiKey, picked?.model);
        // 刷新结果写回节点 LLM 配置：后续会话直接从配置读取，不再请求供应商
        const models = normalizeModelList(r?.models);
        const modelMeta = normalizeModelMeta(r?.modelMeta);
        const pid = typeof payload.providerId === "string" ? payload.providerId : "";
        if (pid && (models || modelMeta)) {
          const target = cfg.providers.find((p) => p.id === pid);
          if (target) {
            if (models) target.models = models;
            if (modelMeta) target.modelMeta = modelMeta;
            store.saveNodeLlm(cfg);
          }
        }
        return ok({
          models: r?.models ?? [],
          endpoint: r?.endpoint ?? "",
          nonChat: r?.nonChat ?? [],
          modelMeta: r?.modelMeta ?? [],
        });
      }

      case "update_node_llm": {
        const next = applyNodeLlmPatch(
          store.loadNodeLlm(),
          payload as { providers?: unknown; defaultProviderId?: unknown },
        );
        store.saveNodeLlm(next);
        return ok(nodeLlmView(next));
      }

      case "get_usage_summary": {
        const ledger = manager.usageLedger();
        if (!ledger) return ok({ total: null, groups: [] });
        return ok(
          ledger.summary({
            from: typeof payload.from === "string" ? payload.from : undefined,
            to: typeof payload.to === "string" ? payload.to : undefined,
            groupBy:
              payload.groupBy === "day" || payload.groupBy === "model" || payload.groupBy === "project"
                ? payload.groupBy
                : undefined,
            currency: typeof payload.currency === "string" ? payload.currency : undefined,
            projectId: env.projectId ?? (typeof payload.projectId === "string" ? payload.projectId : undefined),
            sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
          }),
        );
      }

      case "get_usage_records": {
        const ledger = manager.usageLedger();
        if (!ledger) return ok({ rows: [], total: 0 });
        return ok(
          ledger.records({
            from: typeof payload.from === "string" ? payload.from : undefined,
            to: typeof payload.to === "string" ? payload.to : undefined,
            projectId: env.projectId ?? (typeof payload.projectId === "string" ? payload.projectId : undefined),
            sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
            model: typeof payload.model === "string" ? payload.model : undefined,
            limit: Number(payload.limit ?? 200) || 200,
            offset: Number(payload.offset ?? 0) || 0,
          }),
        );
      }

      case "get_usage_pricing": {
        const ledger = manager.usageLedger();
        return ok(ledger ? ledger.getPricing() : null);
      }

      case "update_usage_pricing": {
        const ledger = manager.usageLedger();
        if (!ledger) throw new ApiError(400, "bad_request", "用量账本未启用");
        return ok(ledger.updatePricing(payload as never));
      }

      case "list_projects":
        return ok(allProjectSummaries(store));

      case "create_project": {
        const t = createProject(store, payload as Record<string, unknown>);
        return ok({ ...toProjectSummary(store, t), apiKey: t.apiKey });
      }

      case "delete_project": {
        const id = env.projectId ?? String(payload.projectId ?? "");
        if (!id) throw new ApiError(400, "project_required", "delete_project 需要 projectId");
        if (!store.loadTenant(id)) throw new ApiError(404, "not_found", "项目不存在");
        manager.deleteTenant(id);
        return ok({ deleted: true });
      }

      case "list_sessions":
        return ok(manager.listSessions(project().id).map(sessionSummary));

      // 跨项目会话状态（只含标识与 status）：节点首页 / 工作台建立初始视图
      case "get_session_states":
        return ok({ sessions: allSessionStates(store, manager) });

      case "create_session": {
        const model = payload.model ? String(payload.model) : undefined;
        const rec = manager.createSession(project(), { model });
        return ok({ sessionId: rec.sessionId });
      }

      case "delete_session": {
        manager.deleteSession(project().id, sessionId());
        return ok({ deleted: true });
      }

      case "get_state": {
        const rec = manager.getSession(project().id, sessionId());
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        return ok(
          stateView(rec, manager.pendingSteers(sessionId()), manager.sessionSeq(sessionId())),
        );
      }

      case "get_events": {
        const since = Number(payload.since ?? 0) || 0;
        return ok(manager.eventsSince(project().id, sessionId(), since));
      }

      case "get_config":
        return ok(configView(project()));

      case "list_models": {
        const t = project();
        const baseURL =
          t.provider?.baseURL ||
          process.env.OPENAI_BASE_URL ||
          "https://api.openai.com/v1";
        const apiKey = t.provider?.apiKey || process.env.OPENAI_API_KEY || "";
        if (!apiKey) return ok({ models: [], endpoint: "" });
        const r = await cachedFetchModelsEnriched(baseURL, apiKey, t.model);
        // 刷新结果写回项目配置（active 供应商或默认 provider），后续直接读配置
        const models = normalizeModelList(r?.models);
        const modelMeta = normalizeModelMeta(r?.modelMeta);
        const active = (t.llmProviders ?? []).find((p) => p.id === t.activeProviderId);
        if (models || modelMeta) {
          if (active && (!baseURL || active.baseURL === baseURL)) {
            if (models) active.models = models;
            if (modelMeta) active.modelMeta = modelMeta;
          } else {
            t.provider = t.provider ?? {};
            if (models) t.provider.models = models;
            if (modelMeta) t.provider.modelMeta = modelMeta;
          }
          store.saveTenant(t);
        }
        return ok({
          models: r?.models ?? [],
          endpoint: r?.endpoint ?? "",
          nonChat: r?.nonChat ?? [],
          modelMeta: r?.modelMeta ?? [],
        });
      }

      case "list_dirs":
        return ok(listDirs(String(payload.path ?? "")));

      case "search_dirs": {
        const limit = typeof payload.limit === "number" ? payload.limit : undefined;
        return ok(await searchDirs(String(payload.path ?? ""), String(payload.query ?? ""), limit));
      }

      case "make_dir":
        return ok(makeDirIn(String(payload.path ?? ""), String(payload.name ?? "")));

      case "list_files": {
        const t = project();
        return ok(listProjectFiles(t.workspaceRoot ?? null, String(payload.path ?? "")));
      }
      case "read_file": {
        const t = project();
        return ok(readProjectFile(t.workspaceRoot ?? null, String(payload.path ?? "")));
      }

      case "download_file": {
        const t = project();
        return ok(downloadProjectFile(t.workspaceRoot ?? null, String(payload.path ?? "")));
      }

      case "write_file": {
        const t = project();
        return ok(
          writeProjectFile(
            t.workspaceRoot ?? null,
            String(payload.path ?? ""),
            String(payload.content ?? ""),
          ),
        );
      }

      case "create_dir": {
        const t = project();
        return ok(createProjectDir(t.workspaceRoot ?? null, String(payload.path ?? "")));
      }

      case "create_file": {
        const t = project();
        return ok(
          createProjectFile(
            t.workspaceRoot ?? null,
            String(payload.path ?? ""),
            String(payload.content ?? ""),
          ),
        );
      }

      case "search_files": {
        const t = project();
        return ok(searchProjectFiles(t.workspaceRoot ?? null, String(payload.query ?? "")));
      }

      case "list_tools": {
        const t = project();
        return ok(buildToolCatalog(t.workspaceRoot ?? process.cwd()));
      }

      case "list_mcp": {
        const t = project();
        return ok(
          loadServerMcpConfigs(t).map((m) => ({
            name: m.name,
            type: m.type,
            url: m.type === "http" ? m.url : undefined,
            command: m.type === "stdio" ? (m.command ?? []).join(" ") : undefined,
          })),
        );
      }

      case "project_stats":
        return ok(projectStats(manager, project().id));

      case "run_command": {
        const t = project();
        const timeout =
          typeof payload.timeoutSeconds === "number" ? payload.timeoutSeconds : undefined;
        return ok(
          await runProjectCommand(t.workspaceRoot ?? null, String(payload.command ?? ""), timeout),
        );
      }

      case "list_shell_tasks": {
        const t = project();
        return ok({ tasks: listShellTasks(t.id) });
      }

      case "kill_shell_task": {
        const t = project();
        return ok(killShellTask(String(payload.taskId ?? ""), t.id));
      }

      case "git_status": {
        const t = project();
        return ok(
          await projectGitStatus(
            t.workspaceRoot ?? null,
            String(payload.path ?? "") || undefined,
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_diff": {
        const t = project();
        return ok(
          await projectGitDiff(
            t.workspaceRoot ?? null,
            String(payload.path ?? "") || undefined,
            payload.staged === true,
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_repos": {
        const t = project();
        const depth = typeof payload.depth === "number" ? payload.depth : undefined;
        return ok(await projectGitRepos(t.workspaceRoot ?? null, depth));
      }

      case "git_branches": {
        const t = project();
        return ok(await projectGitBranches(t.workspaceRoot ?? null, gitRepo(payload.repo)));
      }

      case "git_refs": {
        const t = project();
        return ok(await projectGitRefs(t.workspaceRoot ?? null, gitRepo(payload.repo)));
      }

      case "git_log": {
        const t = project();
        const max = typeof payload.max === "number" ? payload.max : undefined;
        return ok(
          await projectGitLog(
            t.workspaceRoot ?? null,
            String(payload.path ?? "") || undefined,
            max,
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_show": {
        const t = project();
        const context = typeof payload.context === "number" ? payload.context : undefined;
        return ok(
          await projectGitShow(
            t.workspaceRoot ?? null,
            String(payload.hash ?? ""),
            String(payload.path ?? "") || undefined,
            context,
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_fetch": {
        const t = project();
        return ok(await projectGitFetch(t.workspaceRoot ?? null, gitRepo(payload.repo)));
      }

      case "git_stage": {
        const t = project();
        return ok(
          await projectGitStage(
            t.workspaceRoot ?? null,
            gitPaths(payload.paths),
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_unstage": {
        const t = project();
        return ok(
          await projectGitUnstage(
            t.workspaceRoot ?? null,
            gitPaths(payload.paths),
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_commit": {
        const t = project();
        return ok(
          await projectGitCommit(
            t.workspaceRoot ?? null,
            String(payload.message ?? ""),
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_commit_message": {
        const t = project();
        return ok({
          message: await generateGitCommitMessage({
            store,
            tenant: t,
            workspaceRoot: t.workspaceRoot ?? null,
            repo: gitRepo(payload.repo),
          }),
        });
      }

      case "git_checkout": {
        const t = project();
        return ok(
          await projectGitCheckout(
            t.workspaceRoot ?? null,
            String(payload.branch ?? ""),
            payload.create === true,
            gitRepo(payload.repo),
          ),
        );
      }

      case "git_pull": {
        const t = project();
        return ok(await projectGitPull(t.workspaceRoot ?? null, gitRepo(payload.repo)));
      }

      case "git_push": {
        const t = project();
        return ok(await projectGitPush(t.workspaceRoot ?? null, gitRepo(payload.repo)));
      }

      case "set_node_label": {
        // 节点展示名（Hub 下发改名）：写入本地 node.json，随 status/info 上报。
        const label = String(payload.label ?? "").trim();
        store.saveNodeLabel(label);
        return ok({ label });
      }

      // 注：`set_fleet_cred`（节点被移出分组时换 broker 凭据）已随「去 EMQX」退场——
      // 分组现在只是控制面元数据，网关鉴权用全局密钥，节点无需换凭据。
      // 该枚举值保留在 proto 里（已发布字段号不复用），但不再有处理分支。

      case "update_config": {
        const t = project();
        applyConfigPatch(t, payload);
        store.saveTenant(t);
        return ok(configView(t));
      }

      case "rename_session": {
        const rec = await manager.renameSession(
          project(),
          sessionId(),
          String(payload.name ?? ""),
        );
        return ok({ sessionId: rec.sessionId, name: rec.name });
      }

      case "set_session_model": {
        const model = String(payload.model ?? "").trim();
        if (!model) throw new ApiError(400, "bad_request", "model 不能为空");
        const rec = manager.updateSessionModel(project(), sessionId(), model);
        return ok({ sessionId: rec.sessionId, model: rec.model });
      }

      case "set_session_llm": {
        const rec = manager.updateSessionLlm(project(), sessionId(), {
          ...("providerId" in payload ? { providerId: payload.providerId } : {}),
          ...("model" in payload ? { model: payload.model } : {}),
        });
        return ok({
          sessionId: rec.sessionId,
          model: rec.model,
          providerId: rec.providerId ?? null,
        });
      }

      case "set_session_mode": {
        const rec = manager.setSessionMode(
          project(),
          sessionId(),
          String(payload.mode ?? ""),
        );
        return ok({ sessionId: rec.sessionId, permissionMode: rec.permissionMode });
      }

      case "set_session_draft": {
        const rec = manager.setSessionDraft(
          project(),
          sessionId(),
          String(payload.draft ?? ""),
        );
        return ok({ sessionId: rec.sessionId, draft: rec.draft ?? "" });
      }

      case "submit_turn": {
        const input = String(payload.input ?? "");
        if (!input.trim()) throw new ApiError(400, "bad_request", "input 不能为空");
        const result = manager.submitOrSteer(project(), sessionId(), input);
        return ok({ accepted: true, status: result === "steered" ? "steering" : "running" });
      }

      case "steer": {
        const text = String(payload.text ?? "");
        if (!text.trim()) throw new ApiError(400, "bad_request", "text 不能为空");
        manager.steer(project(), sessionId(), text);
        return ok({ accepted: true });
      }

      case "interrupt":
        manager.interrupt(project(), sessionId());
        return ok({ accepted: true });

      case "resume":
        manager.resumeSession(project(), sessionId());
        return ok({ accepted: true, status: "running" });

      case "approval_answer": {
        const outcome = parseDecision(payload.decision);
        manager.answerApproval(
          project(),
          sessionId(),
          String(payload.approvalId ?? ""),
          outcome,
        );
        return ok({ answered: true, decision: outcome });
      }

      case "question_answer": {
        manager.answerQuestion(
          project(),
          sessionId(),
          String(payload.questionId ?? ""),
          String(payload.answer ?? ""),
        );
        return ok({ answered: true });
      }

      default:
        return fail(`未知指令: ${String(env.type)}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
