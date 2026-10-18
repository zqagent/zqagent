/**
 * RESTful 路由层（原生 Node http，零依赖）
 *
 * 所有业务路由挂 /api/v1，需 `Authorization: Bearer <apiKey>` 认证；
 * /healthz 公开。响应统一 JSON：
 *   成功 { data: ... }；失败 { error: { code, message, retriable? } }
 * GET /sessions/:id/events 在 Accept: text/event-stream 时切换为 SSE。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as path from "path";
import { ApprovalOutcome } from "../engine/events.js";
import { SecretBox } from "../crypto/secrets.js";
import { Store, newId } from "./store.js";
import {
  allProjectSummaries,
  allSessionStates,
  applyProvidersPatch,
  buildNodeInfo,
  createProject,
  providerViews,
  toProjectSummary,
} from "./projects.js";
import { SessionManager, ApiError } from "./session.js";
import {
  authenticate,
  extractApiKey,
  extractProjectId,
  isAdminKey,
} from "./auth.js";
import { setupServerHandlers } from "./interact.js";
import { handleHubProxy, hubProxyEnabled, isHubProxyPath } from "./hubProxy.js";
import { applyNodeLlmPatch, findNodeProvider, nodeLlmView } from "./nodeLlm.js";
import { hasServerMcpConfig } from "./mcpConfig.js";
import { fetchModels } from "../providers/models.js";
import { listDirs, searchDirs, makeDirIn } from "./fsBrowser.js";
import {
  listProjectFiles,
  readProjectFile,
  downloadProjectFile,
  writeProjectFile,
  createProjectDir,
  createProjectFile,
  searchProjectFiles,
} from "./projectFiles.js";
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
} from "./projectOps.js";
import { listShellTasks, killShellTask } from "../tools/shell.js";
import { buildToolCatalog } from "./toolsCatalog.js";
import { loadServerMcpConfigs } from "./mcpConfig.js";
import { projectStats } from "./projectStats.js";
import { buildNodeHost } from "./nodeHost.js";
import type { NotificationHub } from "./notify/NotificationHub.js";
import {
  decryptNotifications,
  saveNotifications,
} from "./notify/tenantNotifications.js";
import type { QqManager } from "./qq/QqManager.js";
import type { FleetController } from "./fleet-config.js";
import type {
  DeviceRecord,
  NotificationChannelConfig,
  NodeInfo,
  ProjectSummary,
  TenantConfig,
} from "./types.js";

type RouteFn = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    tenant: TenantConfig;
    params: Record<string, string>;
    body: unknown;
    /** 请求是否以管理员密钥认证（可跨项目操作） */
    isAdmin: boolean;
  },
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string[];
  fn: RouteFn;
  /** 仅管理员密钥可访问（如项目 CRUD） */
  adminOnly?: boolean;
  /** 管理员可不带 X-Project-Id 访问（如节点元信息），此时 tenant 为 null */
  projectOptional?: boolean;
}

const API_PREFIX = "/api/v1";

/** 请求体大小上限（10MB），防止恶意大 payload 拖垮进程 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, "payload_too_large", "请求体超过 10MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new ApiError(400, "bad_request", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** 统一 CORS 头（web 端跨域调试用；预检在 handle 中处理） */
function corsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Project-Id, Cache-Control, Accept",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function ok(res: ServerResponse, data: unknown): void {
  json(res, 200, { data });
}

function error(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    json(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  json(res, 500, {
    error: { code: "internal", message: msg, retriable: false },
  });
}

/** 路由模式匹配：/api/v1/sessions/:id/turns → 参数提取 */
function match(
  pattern: string[],
  segs: string[],
): Record<string, string> | null {
  if (pattern.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]!);
    else if (p !== segs[i]) return null;
  }
  return params;
}

/** 租户配置的非敏感视图（供桌面端设置页读取；绝不回传 apiKey 明文） */
function configView(tenant: TenantConfig) {
  const active = (tenant.llmProviders ?? []).find((p) => p.id === tenant.activeProviderId);
  return {
    name: tenant.name ?? null,
    model: tenant.model,
    baseURL: tenant.provider?.baseURL ?? "",
    hasApiKey: Boolean(tenant.provider?.apiKey),
    /** 上次刷新的候选模型（active 供应商优先，其次默认 provider） */
    models: active?.models ?? tenant.provider?.models ?? [],
    /** 候选模型的元数据（上下文长度等） */
    modelMeta: active?.modelMeta ?? tenant.provider?.modelMeta ?? [],
    workspaceRoot: tenant.workspaceRoot ?? null,
    ...providerViews(tenant),
  };
}

function parseApprovalDecision(raw: unknown): ApprovalOutcome {
  const v = String(raw ?? "");
  switch (v) {
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

export function createApp(
  store: Store,
  manager: SessionManager,
  opts: {
    /** 凭据加密盒（通知配置加解密；缺省时明文存） */
    secretBox?: SecretBox | null;
    /** 通知中枢（预留，用于后续渠道健康检查等） */
    notificationHub?: NotificationHub | null;
    /** QQ 机器人（配对码 + 热配置） */
    qq?: QqManager | null;
    /** 管理员密钥（可跨项目操作 / 项目管理；缺省时管理员接口不可用） */
    adminKey?: string | null;
    /** 监听地址（决定 /hub-proxy 本机中转是否默认开启） */
    host?: string;
    /** 节点管理控制器（运行时热接入 / 查询 / 解绑；未启用节点管理时为 null/缺省） */
    fleet?: FleetController | null;
    /** 云端接入配对信息（静态回退；优先用 fleet.pairing()） */
    fleetPairing?: {
      gatewayUrl?: string;
      fleetToken: string;
      fleetSecret: string;
      nodeId: string;
    } | null;
  } = {},
) {
  setupServerHandlers(manager);

  const routes: Route[] = [
    // ---------- 会话管理 ----------
    {
      method: "POST",
      pattern: ["sessions"],
      fn: (_req, res, { tenant, body }) => {
        const model = (body as { model?: string } | undefined)?.model;
        ok(res, manager.createSession(tenant, { model }));
      },
    },
    {
      method: "GET",
      pattern: ["sessions"],
      fn: (_req, res, { tenant }) => {
        ok(res, manager.listSessions(tenant.id));
      },
    },
    {
      method: "GET",
      pattern: ["sessions", ":id"],
      fn: (_req, res, { tenant, params }) => {
        const rec = manager.getSession(tenant.id, params["id"]!);
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        ok(res, rec);
      },
    },
    {
      method: "DELETE",
      pattern: ["sessions", ":id"],
      fn: (_req, res, { tenant, params }) => {
        manager.deleteSession(tenant.id, params["id"]!);
        ok(res, { deleted: true });
      },
    },
    {
      method: "PATCH",
      pattern: ["sessions", ":id", "model"],
      fn: (_req, res, { tenant, params, body }) => {
        const newModel = String(
          (body as { model?: unknown } | undefined)?.model ?? "",
        );
        if (!newModel) throw new ApiError(400, "bad_request", "model 不能为空");
        const rec = manager.updateSessionModel(tenant, params["id"]!, newModel);
        ok(res, { sessionId: rec.sessionId, model: rec.model });
      },
    },
    {
      // 会话级 LLM：providerId（节点级 LLM 配置 id，"project" 清除）+ 可选 model
      method: "PATCH",
      pattern: ["sessions", ":id", "llm"],
      fn: (_req, res, { tenant, params, body }) => {
        const b = (body ?? {}) as { providerId?: unknown; model?: unknown };
        const rec = manager.updateSessionLlm(tenant, params["id"]!, {
          ...("providerId" in b ? { providerId: b.providerId } : {}),
          ...("model" in b ? { model: b.model } : {}),
        });
        ok(res, {
          sessionId: rec.sessionId,
          model: rec.model,
          providerId: rec.providerId ?? null,
        });
      },
    },
    {
      method: "PATCH",
      pattern: ["sessions", ":id", "mode"],
      fn: (_req, res, { tenant, params, body }) => {
        const mode = String(
          (body as { mode?: unknown } | undefined)?.mode ?? "",
        );
        const rec = manager.setSessionMode(tenant, params["id"]!, mode);
        ok(res, { sessionId: rec.sessionId, permissionMode: rec.permissionMode });
      },
    },
    {
      method: "PATCH",
      pattern: ["sessions", ":id", "draft"], // 保存输入框草稿（服务端持久化）
      fn: (_req, res, { tenant, params, body }) => {
        const draft = String((body as { draft?: unknown } | undefined)?.draft ?? "");
        const rec = manager.setSessionDraft(tenant, params["id"]!, draft);
        ok(res, { sessionId: rec.sessionId, draft: rec.draft ?? "" });
      },
    },
    {
      method: "PATCH",
      pattern: ["sessions", ":id"], // 重命名会话（用户手动，置 nameSource=user）
      fn: async (_req, res, { tenant, params, body }) => {
        const name = String(
          (body as { name?: unknown } | undefined)?.name ?? "",
        );
        const rec = await manager.renameSession(tenant, params["id"]!, name);
        ok(res, {
          sessionId: rec.sessionId,
          name: rec.name,
          nameSource: rec.nameSource,
        });
      },
    },

    // ---------- 运行驱动 ----------
    {
      method: "POST",
      pattern: ["sessions", ":id", "turns"], // 提交输入：空闲则开始新任务，运行中则作为补充信息
      fn: (_req, res, { tenant, params, body }) => {
        const input = String(
          (body as { input?: unknown } | undefined)?.input ?? "",
        );
        if (!input.trim())
          throw new ApiError(400, "bad_request", "input 不能为空");
        const result = manager.submitOrSteer(tenant, params["id"]!, input);
        ok(res, {
          accepted: true,
          status: result === "steered" ? "steering" : "running",
        });
      },
    },
    {
      method: "POST",
      pattern: ["sessions", ":id", "resume"], // 恢复会话
      fn: (_req, res, { tenant, params }) => {
        manager.resumeSession(tenant, params["id"]!);
        ok(res, { accepted: true, status: "running" });
      },
    },
    {
      method: "POST",
      pattern: ["sessions", ":id", "steer"], // 引导
      fn: (_req, res, { tenant, params, body }) => {
        const text = String(
          (body as { text?: unknown } | undefined)?.text ?? "",
        );
        if (!text.trim())
          throw new ApiError(400, "bad_request", "text 不能为空");
        manager.steer(tenant, params["id"]!, text);
        ok(res, { accepted: true });
      },
    },
    {
      method: "POST",
      pattern: ["sessions", ":id", "interrupt"],
      fn: (_req, res, { tenant, params }) => {
        manager.interrupt(tenant, params["id"]!);
        ok(res, { accepted: true });
      },
    },

    // ---------- 审批 ----------
    {
      method: "GET",
      pattern: ["sessions", ":id", "approvals"],
      fn: (_req, res, { tenant, params }) => {
        const rec = manager.getSession(tenant.id, params["id"]!);
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        ok(
          res,
          rec.approvals.filter((a) => a.status === "pending"),
        );
      },
    },
    {
      method: "POST",
      pattern: ["sessions", ":id", "approvals", ":aid"],
      fn: (_req, res, { tenant, params, body }) => {
        const outcome = parseApprovalDecision(
          (body as { decision?: unknown } | undefined)?.decision,
        );
        manager.answerApproval(tenant, params["id"]!, params["aid"]!, outcome);
        ok(res, { answered: true, decision: outcome });
      },
    },

    // ---------- 提问（ask_user 等） ----------
    {
      method: "GET",
      pattern: ["sessions", ":id", "questions"],
      fn: (_req, res, { tenant, params }) => {
        const rec = manager.getSession(tenant.id, params["id"]!);
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        ok(
          res,
          rec.questions.filter((q) => q.status === "pending"),
        );
      },
    },
    {
      method: "POST",
      pattern: ["sessions", ":id", "questions", ":qid"],
      fn: (_req, res, { tenant, params, body }) => {
        const answer = String(
          (body as { answer?: unknown } | undefined)?.answer ?? "",
        );
        manager.answerQuestion(tenant, params["id"]!, params["qid"]!, answer);
        ok(res, { answered: true });
      },
    },

    // 云端接入配对：管理员获取网关地址 + 命名空间/密钥 + 本节点 ID。
    // 「去 EMQX」后控制台不再直连 broker，而是由控制面签发终端令牌后直连网关。
    {
      method: "GET",
      pattern: ["fleet", "pairing"],
      adminOnly: true,
      fn: (_req, res) => {
        const pairing = opts.fleet?.pairing() ?? opts.fleetPairing ?? null;
        if (!pairing) {
          throw new ApiError(
            503,
            "fleet_disabled",
            "云端接入未启用（可用 /link 凭注册码接入，或设置 FLEET_TOKEN + FLEET_SECRET + FLEET_GATEWAY_URL）",
          );
        }
        ok(res, pairing);
      },
    },
    // 节点管理状态：是否已接入 / 节点 ID / broker / 在线态（不含密钥）
    {
      method: "GET",
      pattern: ["fleet", "status"],
      adminOnly: true,
      fn: (_req, res) => {
        if (!opts.fleet) {
          throw new ApiError(503, "fleet_disabled", "节点管理控制器未启用");
        }
        ok(res, opts.fleet.status());
      },
    },
    // 运行时热接入：凭一次性注册码接入 Hub（落盘 fleet.json + 立即连接，免重启）
    {
      method: "POST",
      pattern: ["fleet", "enroll"],
      adminOnly: true,
      fn: async (_req, res, { body }) => {
        if (!opts.fleet) {
          throw new ApiError(503, "fleet_disabled", "节点管理控制器未启用");
        }
        const raw = (body ?? {}) as {
          hubUrl?: unknown;
          code?: unknown;
          label?: unknown;
        };
        const hubUrl = String(raw.hubUrl ?? "")
          .trim()
          .replace(/\/$/, "");
        const code = String(raw.code ?? "").trim();
        if (!hubUrl || !code) {
          throw new ApiError(400, "bad_request", "hubUrl 与 code 必填");
        }
        const label =
          typeof raw.label === "string" ? raw.label.trim() : undefined;
        try {
          ok(res, await opts.fleet.enroll({ hubUrl, code, label }));
        } catch (e) {
          const code2 = (e as { code?: string }).code;
          const status =
            code2 === "code_expired"
              ? 410
              : code2 === "code_used" || code2 === "node_taken"
                ? 409
                : code2 === "not_found"
                  ? 404
                  : code2 === "plan_limit" || code2 === "subscription_required"
                    ? 402
                    : 400;
          const msg = e instanceof Error ? e.message : String(e);
          throw new ApiError(
            status,
            code2 ?? "enroll_failed",
            `接入失败：${msg}`,
          );
        }
      },
    },
    // 解绑：断开节点管理连接并清除本地 fleet.json（回退到环境变量）
    {
      method: "POST",
      pattern: ["fleet", "unlink"],
      adminOnly: true,
      fn: (_req, res) => {
        if (!opts.fleet) {
          throw new ApiError(503, "fleet_disabled", "节点管理控制器未启用");
        }
        opts.fleet.unlink();
        ok(res, { unlinked: true });
      },
    },
    {
      method: "GET",
      pattern: ["devices"],
      fn: (_req, res, { tenant }) => {
        ok(res, tenant.devices ?? []);
      },
    },
    {
      method: "POST",
      pattern: ["devices"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as Partial<DeviceRecord>;
        const deviceId = String(raw.deviceId ?? "");
        if (!deviceId)
          throw new ApiError(400, "bad_request", "deviceId 不能为空");
        const devices = tenant.devices ?? [];
        const idx = devices.findIndex((d) => d.deviceId === deviceId);
        const rec: DeviceRecord = {
          deviceId,
          label: raw.label,
          platform: raw.platform,
          createdAt:
            idx >= 0 ? devices[idx]!.createdAt : new Date().toISOString(),
        };
        if (idx >= 0) devices[idx] = rec;
        else devices.push(rec);
        tenant.devices = devices;
        store.saveTenant(tenant);
        ok(res, rec);
      },
    },
    {
      method: "DELETE",
      pattern: ["devices", ":id"],
      fn: (_req, res, { tenant, params }) => {
        tenant.devices = (tenant.devices ?? []).filter(
          (d) => d.deviceId !== params["id"],
        );
        store.saveTenant(tenant);
        ok(res, { deleted: true });
      },
    },

    // ---------- QQ 机器人（配对 + 热配置） ----------
    {
      method: "POST",
      pattern: ["qq", "pairing-code"],
      fn: (_req, res, { tenant }) => {
        if (!opts.qq) {
          throw new ApiError(503, "qq_disabled", "QQ 机器人未启用");
        }
        ok(res, opts.qq.issuePairingCode(tenant.id));
      },
    },
    {
      method: "GET",
      pattern: ["qq", "config"],
      fn: (_req, res) => {
        if (!opts.qq) {
          throw new ApiError(503, "qq_disabled", "QQ 机器人未启用");
        }
        ok(res, { configured: opts.qq.getConfig() });
      },
    },
    {
      method: "POST",
      pattern: ["qq", "config"],
      fn: (_req, res, { body }) => {
        if (!opts.qq) {
          throw new ApiError(503, "qq_disabled", "QQ 机器人未启用");
        }
        const raw = (body ?? {}) as {
          appId?: unknown;
          appSecret?: unknown;
          sandbox?: unknown;
        };
        const appId = String(raw.appId ?? "").trim();
        const appSecret = String(raw.appSecret ?? "").trim();
        if (!appId || !appSecret) {
          throw new ApiError(400, "bad_request", "appId 和 appSecret 必填");
        }
        opts.qq.updateConfig({
          appId,
          appSecret,
          sandbox: raw.sandbox === true,
        });
        ok(res, { configured: opts.qq.getConfig() });
      },
    },
    {
      method: "DELETE",
      pattern: ["qq", "config"],
      fn: (_req, res) => {
        opts.qq?.clearConfig();
        ok(res, { deleted: true });
      },
    },

    // ---------- 通知配置 ----------
    {
      method: "GET",
      pattern: ["notifications"],
      fn: (_req, res, { tenant }) => {
        ok(res, decryptNotifications(tenant, opts.secretBox ?? null));
      },
    },
    {
      method: "POST",
      pattern: ["notifications"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as Partial<NotificationChannelConfig>;
        if (!raw || typeof raw.type !== "string") {
          throw new ApiError(
            400,
            "bad_request",
            "channel 配置非法（缺少 type）",
          );
        }
        const list = decryptNotifications(tenant, opts.secretBox ?? null);
        const normalized: NotificationChannelConfig = {
          id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
          type: raw.type,
          enabled: raw.enabled !== false,
          config: raw.config ?? {},
          events: {
            approval: raw.events?.approval !== false,
            question: raw.events?.question !== false,
            completed: raw.events?.completed !== false,
            error: raw.events?.error !== false,
          },
        };
        const idx = list.findIndex((c) => c.id === normalized.id);
        if (idx >= 0) list[idx] = normalized;
        else list.push(normalized);
        saveNotifications(tenant, opts.secretBox ?? null, list);
        store.saveTenant(tenant);
        ok(res, normalized);
      },
    },
    {
      method: "DELETE",
      pattern: ["notifications", ":id"],
      fn: (_req, res, { tenant, params }) => {
        const list = decryptNotifications(tenant, opts.secretBox ?? null);
        const next = list.filter((c) => c.id !== params["id"]);
        saveNotifications(tenant, opts.secretBox ?? null, next);
        store.saveTenant(tenant);
        ok(res, { deleted: true });
      },
    },

    // ---------- 租户配置（桌面端「设置」：模型 / LLM 端点与密钥） ----------
    // 说明：TenantConfig 默认不由 API 暴露；这里仅暴露模型与 provider 的非敏感摘要，
    // apiKey 只回 hasApiKey。写入后新会话/新 turn 会现取 provider（session.ts），无需重启。
    {
      method: "GET",
      pattern: ["config"],
      fn: (_req, res, { tenant }) => {
        ok(res, configView(tenant));
      },
    },
    {
      method: "PUT",
      pattern: ["config"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as {
          name?: unknown;
          model?: unknown;
          baseURL?: unknown;
          apiKey?: unknown;
          providers?: unknown;
          activeProviderId?: unknown;
          workspaceRoot?: unknown;
        };
        tenant.provider = tenant.provider ?? {};
        // 多供应商（整体替换 + 选定当前项；会把 active 同步到 provider/model）
        applyProvidersPatch(tenant, raw as Record<string, unknown>);
        // workspaceRoot：非空字符串=设为工作目录；空串=清除（回退每会话沙箱）
        if (typeof raw.workspaceRoot === "string") {
          const ws = raw.workspaceRoot.trim();
          if (ws) tenant.workspaceRoot = path.resolve(ws);
          else delete tenant.workspaceRoot;
        }
        // name：非空字符串即改名（项目 id 不变）
        if (typeof raw.name === "string" && raw.name.trim()) {
          tenant.name = raw.name.trim();
        }
        if (typeof raw.model === "string" && raw.model.trim()) {
          tenant.model = raw.model.trim();
        }
        // baseURL：字符串即覆盖（空串=清除，回落 provider 默认端点）
        if (typeof raw.baseURL === "string") {
          const v = raw.baseURL.trim();
          if (v) tenant.provider.baseURL = v;
          else delete tenant.provider.baseURL;
        }
        // apiKey：非空覆盖；null 显式清除；空串/缺省=保持不变（前端留空不改）
        if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
          tenant.provider.apiKey = raw.apiKey.trim();
        } else if (raw.apiKey === null) {
          delete tenant.provider.apiKey;
        }
        store.saveTenant(tenant);
        ok(res, configView(tenant));
      },
    },

    // ---------- 可用模型列表（LLM 模型选择） ----------
    // 用项目当前 baseURL + apiKey 请求 OpenAI 兼容 /models；未配 key 返回空列表。
    {
      method: "GET",
      pattern: ["models"],
      projectOptional: true,
      fn: async (_req, res, { tenant }) => {
        if (!tenant) {
          throw new ApiError(400, "bad_request", "缺少项目上下文");
        }
        const baseURL =
          tenant.provider?.baseURL ||
          process.env.OPENAI_BASE_URL ||
          "https://api.openai.com/v1";
        const apiKey = tenant.provider?.apiKey || process.env.OPENAI_API_KEY || "";
        if (!apiKey) {
          ok(res, { models: [], endpoint: "" });
          return;
        }
        const r = await fetchModels(baseURL, apiKey, tenant.model);
        ok(res, {
          models: r?.models ?? [],
          endpoint: r?.endpoint ?? "",
          nonChat: r?.nonChat ?? [],
          modelMeta: r?.modelMeta ?? [],
        });
      },
    },

    // ---------- 目录浏览（项目工作目录选择） ----------
    // 管理员密钥；仅返回目录/文件名称与路径。
    {
      method: "GET",
      pattern: ["fs", "list"],
      adminOnly: true,
      fn: (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? "";
        try {
          ok(res, listDirs(p));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    // 目录内按关键字模糊搜索（节点侧过滤：超大目录只回传命中项）
    {
      method: "GET",
      pattern: ["fs", "search"],
      adminOnly: true,
      fn: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? "";
        const q = url.searchParams.get("q") ?? "";
        const raw = url.searchParams.get("limit");
        try {
          ok(res, await searchDirs(p, q, raw ? Number(raw) : undefined));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    {
      method: "POST",
      pattern: ["fs", "mkdir"], // 目录浏览时新建目录（管理员密钥）
      adminOnly: true,
      fn: (_req, res, { body }) => {
        const b = (body ?? {}) as { path?: unknown; name?: unknown };
        try {
          ok(res, makeDirIn(String(b.path ?? ""), String(b.name ?? "")));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    // ---------- 项目工作区文件（只读：目录树 / 文件预览） ----------
    // 严格限定在项目 workspaceRoot 内（含 symlink 防逃逸）；项目级接口，
    // 管理员需带 X-Project-Id。
    {
      method: "GET",
      pattern: ["files"],
      fn: (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? "";
        try {
          ok(res, listProjectFiles(tenant.workspaceRoot ?? null, p));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },
    {
      method: "GET",
      pattern: ["files", "content"],
      fn: (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? "";
        try {
          ok(res, readProjectFile(tenant.workspaceRoot ?? null, p));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },
    {
      method: "GET",
      pattern: ["files", "download"],
      fn: (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? "";
        try {
          ok(res, downloadProjectFile(tenant.workspaceRoot ?? null, p));
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },
    {
      method: "PUT",
      pattern: ["files", "content"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { path?: unknown; content?: unknown };
        try {
          ok(
            res,
            writeProjectFile(
              tenant.workspaceRoot ?? null,
              String(raw.path ?? ""),
              String(raw.content ?? ""),
            ),
          );
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    // ---------- 项目终端（在工作区执行命令） ----------
    {
      method: "POST",
      pattern: ["shell"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { command?: unknown; timeoutSeconds?: unknown };
        const command = String(raw.command ?? "");
        try {
          ok(
            res,
            await runProjectCommand(
              tenant.workspaceRoot ?? null,
              command,
              typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    // ---------- 后台 shell 任务（run_in_background 启动的长驻进程） ----------
    {
      method: "GET",
      pattern: ["shell", "tasks"],
      fn: (_req, res, { tenant }) => {
        ok(res, { tasks: listShellTasks(tenant.id) });
      },
    },
    {
      method: "POST",
      pattern: ["shell", "tasks", ":id", "kill"],
      fn: (_req, res, { tenant, params }) => {
        ok(res, killShellTask(params["id"]!, tenant.id));
      },
    },

    // ---------- 项目 Git（只读） ----------
    {
      method: "GET",
      pattern: ["git", "repos"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const depth = Number(url.searchParams.get("depth") ?? 0) || undefined;
        try {
          ok(res, await projectGitRepos(tenant.workspaceRoot ?? null, depth));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "GET",
      pattern: ["git", "status"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? undefined;
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(res, await projectGitStatus(tenant.workspaceRoot ?? null, p ?? undefined, repo));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "GET",
      pattern: ["git", "diff"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? undefined;
        const staged = url.searchParams.get("staged") === "1";
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(
            res,
            await projectGitDiff(tenant.workspaceRoot ?? null, p ?? undefined, staged, repo),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ---------- 项目 Git（控制台 Git 面板：引用 / 历史 / 提交详情 / 写操作；在项目工作区内执行） ----------
    {
      method: "GET",
      pattern: ["git", "branches"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(res, await projectGitBranches(tenant.workspaceRoot ?? null, repo));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "GET",
      pattern: ["git", "refs"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(res, await projectGitRefs(tenant.workspaceRoot ?? null, repo));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "GET",
      pattern: ["git", "log"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const p = url.searchParams.get("path") ?? undefined;
        const max = Number(url.searchParams.get("max") ?? 0) || undefined;
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(res, await projectGitLog(tenant.workspaceRoot ?? null, p ?? undefined, max, repo));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "GET",
      pattern: ["git", "show"],
      fn: async (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const hash = url.searchParams.get("hash") ?? "";
        if (!hash.trim()) throw new ApiError(400, "bad_request", "hash 不能为空");
        const p = url.searchParams.get("path") ?? undefined;
        const context = Number(url.searchParams.get("context") ?? 0) || undefined;
        const repo = url.searchParams.get("repo") ?? undefined;
        try {
          ok(
            res,
            await projectGitShow(tenant.workspaceRoot ?? null, hash, p ?? undefined, context, repo),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "fetch"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { repo?: unknown };
        try {
          ok(
            res,
            await projectGitFetch(
              tenant.workspaceRoot ?? null,
              String(raw.repo ?? "") || undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "stage"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { paths?: unknown; repo?: unknown };
        const paths = Array.isArray(raw.paths) ? raw.paths.map((p) => String(p)) : [];
        try {
          ok(
            res,
            await projectGitStage(
              tenant.workspaceRoot ?? null,
              paths,
              String(raw.repo ?? "") || undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "unstage"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { paths?: unknown; repo?: unknown };
        const paths = Array.isArray(raw.paths) ? raw.paths.map((p) => String(p)) : [];
        try {
          ok(
            res,
            await projectGitUnstage(
              tenant.workspaceRoot ?? null,
              paths,
              String(raw.repo ?? "") || undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "commit"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { message?: unknown; repo?: unknown };
        try {
          ok(
            res,
            await projectGitCommit(
              tenant.workspaceRoot ?? null,
              String(raw.message ?? ""),
              String(raw.repo ?? "") || undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "checkout"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { branch?: unknown; create?: unknown; repo?: unknown };
        try {
          ok(
            res,
            await projectGitCheckout(
              tenant.workspaceRoot ?? null,
              String(raw.branch ?? ""),
              raw.create === true,
              String(raw.repo ?? "") || undefined,
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "pull"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { repo?: unknown };
        try {
          ok(
            res,
            await projectGitPull(tenant.workspaceRoot ?? null, String(raw.repo ?? "") || undefined),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["git", "push"],
      fn: async (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { repo?: unknown };
        try {
          ok(
            res,
            await projectGitPush(tenant.workspaceRoot ?? null, String(raw.repo ?? "") || undefined),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ---------- 当前项目可用工具 / MCP（配置页展示，只读） ----------
    {
      method: "GET",
      pattern: ["tools"],
      fn: (_req, res, { tenant }) => {
        ok(res, buildToolCatalog(tenant.workspaceRoot ?? process.cwd()));
      },
    },
    {
      method: "GET",
      pattern: ["mcp"],
      fn: (_req, res, { tenant }) => {
        ok(
          res,
          loadServerMcpConfigs(tenant).map((m) => ({
            name: m.name,
            type: m.type,
            url: m.type === "http" ? m.url : undefined,
            command: m.type === "stdio" ? (m.command ?? []).join(" ") : undefined,
          })),
        );
      },
    },

    // ---------- 项目首页统计（会话/token/运行等待汇总） ----------
    {
      method: "GET",
      pattern: ["project", "stats"],
      fn: (_req, res, { tenant }) => {
        ok(res, projectStats(manager, tenant.id));
      },
    },

    {
      method: "GET",
      pattern: ["files", "search"],
      fn: (req, res, { tenant }) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const q = url.searchParams.get("q") ?? "";
        try {
          ok(res, searchProjectFiles(tenant.workspaceRoot ?? null, q));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["files", "dir"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { path?: unknown };
        try {
          ok(res, createProjectDir(tenant.workspaceRoot ?? null, String(raw.path ?? "")));
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "POST",
      pattern: ["files", "create"],
      fn: (_req, res, { tenant, body }) => {
        const raw = (body ?? {}) as { path?: unknown; content?: unknown };
        try {
          ok(
            res,
            createProjectFile(
              tenant.workspaceRoot ?? null,
              String(raw.path ?? ""),
              String(raw.content ?? ""),
            ),
          );
        } catch (e) {
          throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ---------- 项目（= 租户）管理：控制台多项目视图 ----------
    // 仅管理员密钥可用；项目级与会话级接口仍用项目自己的 tenant API Key
    // （或管理员密钥 + X-Project-Id 头），互不暴露明文密钥。
    {
      method: "GET",
      pattern: ["projects"],
      adminOnly: true,
      fn: (_req, res) => {
        ok(res, allProjectSummaries(store));
      },
    },
    {
      method: "POST",
      pattern: ["projects"],
      adminOnly: true,
      fn: (_req, res, { body }) => {
        const tenant = createProject(
          store,
          (body ?? {}) as Record<string, unknown>,
        );
        // apiKey 仅在创建时回传一次（控制台用它完成后续项目级调用）
        ok(res, { ...toProjectSummary(store, tenant), apiKey: tenant.apiKey });
      },
    },
    {
      method: "DELETE",
      pattern: ["projects", ":id"],
      adminOnly: true,
      fn: (_req, res, { params }) => {
        const id = params["id"]!;
        if (!store.loadTenant(id)) {
          throw new ApiError(404, "not_found", "项目不存在");
        }
        manager.deleteTenant(id);
        ok(res, { deleted: true });
      },
    },

    // ---------- 节点级 LLM 配置（节点默认；新项目继承） ----------
    {
      method: "GET",
      pattern: ["node", "llm"],
      adminOnly: true,
      fn: (_req, res) => {
        ok(res, nodeLlmView(store.loadNodeLlm()));
      },
    },
    {
      method: "PUT",
      pattern: ["node", "llm"],
      adminOnly: true,
      fn: (_req, res, { body }) => {
        const next = applyNodeLlmPatch(
          store.loadNodeLlm(),
          body as { providers?: unknown; defaultProviderId?: unknown } | undefined,
        );
        store.saveNodeLlm(next);
        ok(res, nodeLlmView(next));
      },
    },

    // ---------- 用量（账本 + 汇总 + 价格） ----------
    {
      method: "GET",
      pattern: ["usage", "summary"],
      projectOptional: true,
      fn: (req, res, { tenant }) => {
        const ledger = manager.usageLedger();
        const url = new URL(req.url ?? "/", "http://localhost");
        const groupByRaw = url.searchParams.get("groupBy");
        const groupBy =
          groupByRaw === "day" || groupByRaw === "model" || groupByRaw === "project"
            ? groupByRaw
            : undefined;
        if (!ledger) {
          ok(res, {
            currency: "USD",
            rate: 1,
            since: null,
            total: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0 },
            groups: [],
          });
          return;
        }
        ok(
          res,
          ledger.summary({
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
            groupBy,
            currency: url.searchParams.get("currency") ?? undefined,
            // 项目密钥只能看自己的项目；管理员可显式指定
            projectId: tenant?.id ?? url.searchParams.get("projectId") ?? undefined,
            sessionId: url.searchParams.get("sessionId") ?? undefined,
          }),
        );
      },
    },
    {
      method: "GET",
      pattern: ["usage", "records"],
      projectOptional: true,
      fn: (req, res, { tenant }) => {
        const ledger = manager.usageLedger();
        if (!ledger) {
          ok(res, { rows: [], total: 0 });
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const numOr = (k: string, d: number) => {
          const v = Number(url.searchParams.get(k));
          return Number.isFinite(v) && v >= 0 ? v : d;
        };
        ok(
          res,
          ledger.records({
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
            projectId: tenant?.id ?? url.searchParams.get("projectId") ?? undefined,
            sessionId: url.searchParams.get("sessionId") ?? undefined,
            model: url.searchParams.get("model") ?? undefined,
            limit: numOr("limit", 200),
            offset: numOr("offset", 0),
          }),
        );
      },
    },
    {
      method: "GET",
      pattern: ["usage", "export"], // CSV 导出
      projectOptional: true,
      fn: (req, res, { tenant }) => {
        const ledger = manager.usageLedger();
        const url = new URL(req.url ?? "/", "http://localhost");
        const csv = ledger
          ? ledger.exportCsv({
              from: url.searchParams.get("from") ?? undefined,
              to: url.searchParams.get("to") ?? undefined,
              currency: url.searchParams.get("currency") ?? undefined,
            })
          : "ts,projectId,sessionId,vendor,model,input,output,cacheRead,cacheWrite,cost,priced,ok\n";
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="usage-${tenant?.id ?? "node"}.csv"`,
        });
        res.end(csv);
      },
    },
    {
      method: "GET",
      pattern: ["usage", "pricing"],
      adminOnly: true,
      fn: (_req, res) => {
        const ledger = manager.usageLedger();
        ok(res, ledger ? ledger.getPricing() : null);
      },
    },
    {
      method: "PUT",
      pattern: ["usage", "pricing"],
      adminOnly: true,
      fn: (_req, res, { body }) => {
        const ledger = manager.usageLedger();
        if (!ledger) throw new ApiError(400, "bad_request", "用量账本未启用");
        ok(res, ledger.updatePricing((body ?? {}) as never));
      },
    },
    {
      method: "POST",
      pattern: ["usage", "rebuild"],
      adminOnly: true,
      fn: (_req, res) => {
        const ledger = manager.usageLedger();
        if (!ledger) throw new ApiError(400, "bad_request", "用量账本未启用");
        ok(res, ledger.rebuild());
      },
    },
    {
      method: "POST",
      pattern: ["usage", "verify"],
      adminOnly: true,
      fn: (_req, res) => {
        const ledger = manager.usageLedger();
        if (!ledger) throw new ApiError(400, "bad_request", "用量账本未启用");
        ok(res, ledger.verify());
      },
    },

    {
      method: "POST",
      pattern: ["node", "llm", "models"], // 按 Base URL + Key 刷新模型列表（保存前也可用）
      adminOnly: true,
      fn: async (_req, res, { body }) => {
        const b = (body ?? {}) as { baseURL?: unknown; apiKey?: unknown; providerId?: unknown };
        const picked = b.providerId ? findNodeProvider(store, String(b.providerId)) : null;
        let apiKey = String(b.apiKey ?? "").trim() || picked?.apiKey || "";
        const baseURL = String(b.baseURL ?? "").trim() || picked?.baseURL || "";
        if (!baseURL) throw new ApiError(400, "bad_request", "缺少 Base URL");
        if (!apiKey) throw new ApiError(400, "bad_request", "缺少 API Key");
        try {
          const r = await fetchModels(baseURL, apiKey, picked?.model);
          ok(res, {
            models: r?.models ?? [],
            endpoint: r?.endpoint ?? "",
            nonChat: r?.nonChat ?? [],
            modelMeta: r?.modelMeta ?? [],
          });
        } catch (e) {
          throw new ApiError(
            400,
            "bad_request",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    // ---------- 节点级会话状态（跨项目；只含标识与 status） ----------
    // 供节点首页 / 工作台建立初始视图，后续变化由 session_status 通知增量推送。
    {
      method: "GET",
      pattern: ["node", "session-states"],
      projectOptional: true,
      fn: (_req, res) => {
        ok(res, { sessions: allSessionStates(store, manager) });
      },
    },

    // ---------- 节点宿主信息（CPU/内存/网络/存储/版本/会话概览） ----------
    {
      method: "GET",
      pattern: ["node", "host"],
      projectOptional: true,
      fn: (_req, res, { tenant }) => {
        ok(res, buildNodeHost(store, manager, tenant?.workspaceRoot ?? undefined));
      },
    },

    // ---------- 节点元信息（管理员=全部项目；租户=自身） ----------
    {
      method: "GET",
      pattern: ["node", "info"],
      projectOptional: true,
      fn: (_req, res, { tenant, isAdmin }) => {
        const projects = isAdmin
          ? allProjectSummaries(store)
          : tenant
            ? [toProjectSummary(store, tenant)]
            : [];
        const info: NodeInfo = buildNodeInfo(store, {
          admin: isAdmin,
          projects,
        });
        ok(res, info);
      },
    },

    // ---------- 全局通知流（控制台通知中心） ----------
    // Accept: text/event-stream 时返回 SSE；管理员=全部项目，租户=自身。
    {
      method: "GET",
      pattern: ["notifications", "stream"],
      projectOptional: true,
      fn: (req, res, { tenant, isAdmin }) => {
        const accept = req.headers.accept ?? "";
        if (!accept.includes("text/event-stream")) {
          throw new ApiError(
            400,
            "bad_request",
            "需要 Accept: text/event-stream",
          );
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, X-Project-Id, Cache-Control, Accept",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        manager.subscribeNotifications(res, isAdmin ? undefined : tenant?.id);
      },
    },

    // ---------- 节点级事件流（控制台一条连接订阅全部会话） ----------
    // Accept: text/event-stream 时返回 SSE；管理员=全部项目，租户=自身。
    // 帧格式：event=<类型>，data={sessionId,seq,ts,data}——客户端按 sessionId 分派。
    {
      method: "GET",
      pattern: ["events", "stream"],
      projectOptional: true,
      fn: (req, res, { tenant, isAdmin }) => {
        const accept = req.headers.accept ?? "";
        if (!accept.includes("text/event-stream")) {
          throw new ApiError(
            400,
            "bad_request",
            "需要 Accept: text/event-stream",
          );
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, X-Project-Id, Cache-Control, Accept",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        manager.subscribeEvents(res, isAdmin ? undefined : tenant?.id);
      },
    },

    // ---------- 状态与事件 ----------
    {
      method: "GET",
      pattern: ["sessions", ":id", "state"], // 获取会话状态
      fn: (_req, res, { tenant, params }) => {
        const rec = manager.getSession(tenant.id, params["id"]!);
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        const { latestSeq } = manager.eventsSince(
          tenant.id,
          params["id"]!,
          Number.MAX_SAFE_INTEGER,
        );
        ok(res, {
          sessionId: rec.sessionId,
          status: rec.status,
          model: rec.model,
          providerId: rec.providerId ?? null,
          name: rec.name ?? null,
          nameSource: rec.nameSource ?? null,
          taskCount: rec.taskCount ?? 0,
          permissionMode: rec.permissionMode ?? "interactive",
          draft: rec.draft ?? "",
          pendingSteers: manager.pendingSteers(params["id"]!),
          seq: latestSeq,
          messageCount: (rec.messages as unknown[]).length,
          compaction: rec.compaction,
          approvals: rec.approvals,
          questions: rec.questions,
          savedAt: rec.savedAt,
        });
      },
    },
    {
      method: "GET",
      pattern: ["sessions", ":id", "messages"], // 获取完整消息历史（调试/对账）
      fn: (_req, res, { tenant, params }) => {
        const rec = manager.getSession(tenant.id, params["id"]!);
        if (!rec) throw new ApiError(404, "not_found", "会话不存在");
        ok(res, { sessionId: rec.sessionId, messages: rec.messages });
      },
    },
    {
      method: "PUT",
      pattern: ["sessions", ":id", "messages"], // 导入历史消息（会话重建后回放上下文）
      fn: (_req, res, { tenant, params, body }) => {
        const messages = (body as { messages?: unknown } | undefined)?.messages;
        manager.setMessages(
          tenant,
          params["id"]!,
          Array.isArray(messages) ? messages : [],
        );
        ok(res, { ok: true });
      },
    },
    {
      method: "GET",
      pattern: ["sessions", ":id", "events"], // 获取事件
      fn: (req, res, { tenant, params }) => {
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/event-stream")) {
          // SSE 长连接必须显式带 CORS 头：Node.js writeHead 不会自动合并
          // setHeader 设置的 Access-Control-* 头，浏览器无此头会阻塞流读取
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, X-Project-Id, Cache-Control, Accept",
            // 阻止反向代理（nginx 等）缓冲 SSE 流
            "X-Accel-Buffering": "no",
          });
          const sinceRaw = new URL(
            req.url!,
            "http://localhost",
          ).searchParams.get("since");
          manager.subscribe(
            tenant.id,
            params["id"]!,
            res,
            sinceRaw ? Number(sinceRaw) : 0,
          );
          return;
        }
        const since = Number(
          new URL(req.url!, "http://localhost").searchParams.get("since") ?? 0,
        );
        const { events, latestSeq } = manager.eventsSince(
          tenant.id,
          params["id"]!,
          since,
        );
        ok(res, { events, latestSeq });
      },
    },
  ];

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // 请求/响应日志：进入即打一行，结束时打状态码/耗时/租户
    // （SSE 等长连接不触发 finish，连接关闭时经 close 记录）
    console.log(
      `[api] ${new Date().toISOString()} → ${method} ${path}${url.search}`,
    );
    let tenantId: string | null = null;
    let logged = false;
    const logDone = (extra: string) => {
      if (logged) return;
      logged = true;
      console.log(
        `[api] ${new Date().toISOString()} ← ${method} ${path} ${extra} (${Date.now() - startedAt}ms) tenant=${tenantId ?? "-"}`,
      );
    };
    res.on("finish", () => logDone(`HTTP ${res.statusCode}`));
    res.on("close", () => logDone("connection closed"));

    corsHeaders(res);

    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查（公开）——附带能力标记，供 zcode-server 判断能否把 MCP 下沉到 VM
    // mcp 仅在当前进程确有可加载的 MCP 配置时为 true（不做静态声明）
    if (req.method === "GET" && path === "/healthz") {
      json(res, 200, {
        status: "ok",
        // 版本让运维/探针能确认线上跑的是哪个构建（更新与回滚据此判断）
        version: process.env.ZQAGENT_VERSION ?? "dev",
        features: { mcp: hasServerMcpConfig() },
      });
      return;
    }

    // 本机引擎中转：/hub-proxy/<enc>/... → 云端 Hub（绕开浏览器 CORS）
    if (hubProxyEnabled(opts.host) && isHubProxyPath(path)) {
      void handleHubProxy(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "hub_proxy_error", message: "Hub 中转失败" } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return;
    }

    if (!path.startsWith(API_PREFIX)) {
      json(res, 404, { error: { code: "not_found", message: "未知路径" } });
      return;
    }
    const segs = path.slice(API_PREFIX.length).split("/").filter(Boolean);

    const apiKey = extractApiKey(req);
    if (!apiKey) {
      json(res, 401, {
        error: { code: "unauthorized", message: "无效的 API Key" },
      });
      return;
    }

    const route = routes.find(
      (r) => r.method === req.method && match(r.pattern, segs) !== null,
    );
    if (!route) {
      json(res, 404, { error: { code: "not_found", message: "未知路由" } });
      return;
    }
    const params = match(route.pattern, segs)!;

    // 认证：管理员密钥 vs 项目（租户）密钥
    const isAdmin = isAdminKey(opts.adminKey, apiKey);
    let tenant: TenantConfig | null = null;

    if (route.adminOnly) {
      if (!isAdmin) {
        json(res, 403, {
          error: { code: "admin_required", message: "需要管理员密钥" },
        });
        return;
      }
    } else if (isAdmin) {
      // 管理员在项目级接口上操作：必须用 X-Project-Id 指明目标项目
      // （projectOptional 路由除外，如 node/info，此时 tenant 保持 null）
      const projectId = extractProjectId(req);
      if (!projectId && !route.projectOptional) {
        json(res, 400, {
          error: {
            code: "project_required",
            message: "管理员请求项目级接口需带 X-Project-Id 头",
          },
        });
        return;
      }
      if (projectId) {
        tenant = store.loadTenant(projectId);
        if (!tenant) {
          json(res, 404, {
            error: { code: "not_found", message: "项目不存在" },
          });
          return;
        }
      }
    } else {
      tenant = authenticate(store, apiKey);
      if (!tenant) {
        json(res, 401, {
          error: { code: "unauthorized", message: "无效的 API Key" },
        });
        return;
      }
    }
    tenantId = tenant?.id ?? null;

    readBody(req)
      .then((body) =>
        route.fn(req, res, {
          tenant: tenant as TenantConfig,
          params,
          body,
          isAdmin,
        }),
      )
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[api] ${new Date().toISOString()} ! ${method} ${path} ERROR: ${msg}`,
        );
        error(res, err);
      });
  }

  return createServer(handle);
}
