/**
 * LLM 可用模型列表（OpenAI 兼容 /models 接口）
 *
 * 供 CLI（/connect 刷新模型列表）与 Server（GET /api/v1/models）共用。
 * 支持 SOCKS5_PROXY 走代理出口；单个端点 10s 超时。
 */
import { makeSocksFetch, socksAgent } from "./proxy.js";
import {
  cleanLlmValue,
  isReasoningModel,
  normalizeBaseURL,
} from "./diagnostics.js";
import {
  capabilitiesOf,
  normalizeCapabilities,
  type ModelCapability,
} from "@zqagent/shared/model-capabilities";

/** 统一 HTTP 请求封装：配置了 SOCKS5 代理时用 node-fetch + agent，否则用全局 fetch。 */
async function doFetch(url: string, init?: Record<string, unknown>): Promise<unknown> {
  const agent = socksAgent();
  if (agent) {
    const f = makeSocksFetch(agent);
    return f(url, init as RequestInit);
  }
  return (globalThis as unknown as { fetch: typeof fetch }).fetch(url, init as RequestInit);
}

/** 单个模型的元数据（从 /models 响应中提取，部分供应商提供） */
export interface ModelMeta {
  /** 模型 id */
  id: string;
  /** 上下文窗口大小（token 数）；仅当供应商在 /models 响应中返回时才有值 */
  contextWindow?: number;
  /**
   * 该模型可接收的输入类型（用户在「节点配置 → LLM」里勾选）。
   * 未配置时按纯文本处理，见 `modelCapabilities`。
   */
  capabilities?: ModelCapability[];
}

/**
 * 规范化模型元数据列表（按 id 去重；仅保留合法的上下文长度）。
 * 供配置持久化（`llmConfig.ts`）与 Server 视图（`server/nodeLlm.ts`）共用。
 */
export function normalizeModelMeta(v: unknown): ModelMeta[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ModelMeta[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const rec = x as Record<string, unknown>;
    const id = String(rec.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ctx = Number(rec.contextWindow);
    const capabilities = normalizeCapabilities(rec.capabilities);
    out.push({
      id,
      ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
    if (out.length >= 500) break;
  }
  return out;
}

/** 从模型元数据中查输入能力（精确匹配优先，其次前缀匹配；缺省仅文本） */
export function modelCapabilities(
  meta: ModelMeta[] | undefined,
  model: string,
): ModelCapability[] {
  return capabilitiesOf(meta, model);
}

/**
 * 合并两份模型元数据（按 id）。
 *
 * 用途：刷新 `/models` 拿到新的上下文长度、重新拉取内置模型凭据时，
 * 不能把用户手工勾选的 `capabilities` 覆盖掉——供应商并不返回能力信息。
 * 因此 **base 的 capabilities 始终优先**，patch 只补充其余字段（上下文长度等）。
 *
 * @param base 旧元数据（提供 capabilities）
 * @param patch 新元数据（提供 contextWindow 等）
 */
export function mergeModelMeta(
  base: ModelMeta[] | undefined,
  patch: ModelMeta[] | undefined,
): ModelMeta[] | undefined {
  if (!base?.length) return patch;
  if (!patch?.length) return base;
  const byId = new Map<string, ModelMeta>();
  for (const m of base) byId.set(m.id, { ...m });
  for (const m of patch) {
    const prev = byId.get(m.id);
    byId.set(m.id, {
      ...prev,
      ...m,
      ...(prev?.capabilities?.length ? { capabilities: prev.capabilities } : {}),
    });
  }
  return [...byId.values()];
}

/** 从模型元数据中查上下文长度（精确匹配优先，其次前缀匹配），未命中返回 undefined */
export function modelContextWindow(
  meta: ModelMeta[] | undefined,
  model: string,
): number | undefined {
  if (!model || !meta?.length) return undefined;
  const exact = meta.find((m) => m.id === model && m.contextWindow);
  if (exact?.contextWindow) return exact.contextWindow;
  const prefix = meta.find((m) => m.contextWindow && model.startsWith(m.id));
  return prefix?.contextWindow;
}

/** 模型列表查询结果 */
export interface ModelListResult {
  /** 模型 id 列表（**对话模型优先**，非对话模型排在末尾） */
  models: string[];
  /** 实际命中的端点 */
  endpoint: string;
  /** 疑似非对话模型（向量/语音/图像/专用通道等）；这些模型不能用作 Agent 后端 */
  nonChat: string[];
  /** 模型元数据（上下文长度等）；仅当供应商 /models 响应包含这些信息时才有值 */
  modelMeta?: ModelMeta[];
}

/**
 * 明显**不提供** OpenAI 兼容对话接口的模型特征。
 *
 * 网关的 /models 往往是"全量目录"而非"可用对话模型"：阿里云百炼会把
 * 向量、重排、语音识别/合成、实时音视频、图像生成、以及专用通道
 * （cmaas-* 机密推理、内部运维模型）一并列出。把它们排在前面会让
 * 用户在 /connect 里一眼选到不可用的模型（实测 `cmaas-qwen3.8-flash`
 * 在 /chat/completions 与 /responses 上都回 400 InvalidParameter）。
 */
const NON_CHAT_PATTERNS: RegExp[] = [
  /embedding/i,
  /rerank/i,
  /(^|[-_/.])(asr|tts)([-_/.]|$)/i,
  /speech|voice|unisound|audio-?coding/i,
  /realtime|livetranslate|(^|[-_])s2s([-_]|$)/i,
  /image|wan\d|z-image|paint|draw|flux|kolors|cogview/i,
  /deep-research|search-planning/i,
  /(^|[-_])cmaas[-_]|confidential/i,
  /(^|[-_])test[-_]|auto-handle|gpu-auto/i,
];

/** 是否可作为 Agent 的对话后端（启发式判断，不确定时按"可用"处理） */
export function isChatModel(modelId: string): boolean {
  return !NON_CHAT_PATTERNS.some((re) => re.test(modelId));
}

/** 对话模型在前、非对话模型在后，两组内保持服务端原顺序 */
function rankModels(models: string[]): { ordered: string[]; nonChat: string[] } {
  const chat: string[] = [];
  const nonChat: string[] = [];
  for (const m of models) (isChatModel(m) ? chat : nonChat).push(m);
  return { ordered: [...chat, ...nonChat], nonChat };
}

/** 解析 OpenAI 兼容 /models 响应（{ data: [{ id, ... }] }），提取模型 id 及可选的上下文长度 */
function parseModelList(body: unknown): { models: string[]; meta: ModelMeta[] } {
  if (!body || typeof body !== "object") return { models: [], meta: [] };
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return { models: [], meta: [] };
  const models: string[] = [];
  const meta: ModelMeta[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || !id.trim()) continue;
    models.push(id);
    // 各供应商的字段名不一：OpenRouter=context_length、部分网关=context_window /
    // max_context_length / max_input_tokens、vLLM=max_model_len。取首个合法值。
    const ctx =
      rec.context_length ??
      rec.context_window ??
      rec.max_context_length ??
      rec.max_input_tokens ??
      rec.max_model_len;
    if (typeof ctx === "number" && ctx > 0) {
      meta.push({ id, contextWindow: ctx });
    }
  }
  return { models, meta };
}

/**
 * `/models` 的候选 URL 组合。
 *
 * 各家的「模型列表」路径并不统一，而 Base URL 的写法更是五花八门
 * （`https://api.deepseek.com`、`…/v1`、`…/compatible-mode/v1`，甚至把
 * `/models`、`/chat/completions` 整段粘进来）。只试 `${base}/models`
 * 与 `${base}/v1/models` 两种时，填了 `/v1` 的 DeepSeek、填了网关前缀的
 * 自建服务都会「刷新出 0 个模型」而不报错，用户无从判断哪里错了。
 *
 * 这里按「最可能命中的顺序」生成候选：先原样，再去掉版本段（`/v1`、
 * `/compatible-mode/v1`…）试根路径，最后补 `/api/v1`、`/api` 前缀。
 * 调用方按顺序尝试，命中第一个返回非空列表的端点。
 */
export function modelListCandidates(baseURL: string): string[] {
  const base = baseURL.replace(/\/+$/, "");
  if (!base) return [];
  const out: string[] = [];
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };

  // 1. 用户填的 base 原样（…/v1、…/compatible-mode/v1 都能直接命中）
  add(`${base}/models`);
  // 2. 补标准 /v1 前缀（base 只填到域名时最常见）
  if (!/\/v\d+[a-z0-9]*$/i.test(base)) add(`${base}/v1/models`);

  // 3. 去掉版本段后的根：DeepSeek 官方是 GET /models，不挂在 /v1 下
  const root = stripVersionSuffix(base);
  if (root !== base) {
    add(`${root}/models`);
    add(`${root}/v1/models`);
  }
  // 4. 部分网关把控制面 API 挂在 /api 下
  add(`${root}/api/v1/models`);
  add(`${root}/api/models`);
  return out.slice(0, 6);
}

/** 去掉结尾的版本/兼容模式段（`/v1`、`/v1beta`、`/compatible-mode/v1`、`/openai/v1`…） */
export function stripVersionSuffix(base: string): string {
  const s = base.replace(/\/+$/, "");
  const suffixes = [
    "/compatible-mode/v1",
    "/compatible-mode",
    "/openai/v1",
    "/v1beta",
    "/v1",
    // DeepSeek 的 /beta 只用于前缀补全（FIM），模型列表仍在根路径
    "/beta",
  ];
  for (const suf of suffixes) {
    if (s.toLowerCase().endsWith(suf)) return s.slice(0, -suf.length).replace(/\/+$/, "");
  }
  return s;
}

/** 一次刷新尝试的结果（用于把失败原因回传给界面） */
export interface ModelFetchAttempt {
  /** 尝试的完整 URL */
  url: string;
  /** HTTP 状态码；网络层失败（超时/DNS）时无 */
  status?: number;
  /** 失败原因摘要（供应商错误体 / 网络错误） */
  error?: string;
}

/** 刷新模型列表的诊断结果 */
export interface ModelFetchDiagnostics {
  /** 成功时的结果；全部候选都失败为 null */
  result: ModelListResult | null;
  /** 依次尝试过的端点与原因 */
  attempts: ModelFetchAttempt[];
  /** 是否因鉴权失败提前终止（此时换路径也没有意义） */
  authFailed: boolean;
}

/** 读一小段错误响应体（供提示用），失败不抛 */
async function errorSnippet(resp: unknown): Promise<string | undefined> {
  const r = resp as { text?: () => Promise<string> };
  if (typeof r.text !== "function") return undefined;
  try {
    const text = (await r.text()).trim();
    if (!text) return undefined;
    // 优先取结构化错误里的 message：原样截断会把 JSON 截成半句（很难看）
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const err = body["error"];
      const msg =
        (err && typeof err === "object" ? String((err as Record<string, unknown>)["message"] ?? "") : "") ||
        String(body["message"] ?? "");
      if (msg) {
        // 去掉 request_id 之类的噪声，同一原因在多个候选上重复出现时更易读
        return msg.replace(/\s*\(request_id:[^)]*\)/gi, "").slice(0, 160);
      }
    } catch {
      // 非 JSON 错误体（网关 HTML 等）：按原文截断
    }
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return undefined;
  }
}

/**
 * 刷新模型列表（带诊断）。
 *
 * 与 `fetchModels` 的区别：全部失败时仍返回「试过哪些 URL、各自为什么失败」，
 * 让上层能把原因写进错误提示——静默返回 null 只会让界面显示「✓ 0」。
 *
 * @param opts.budgetMs 总预算；超出后剩余候选直接标记为未尝试（避免一次点击
 *        把节点事件循环占住几十秒，FleetCommands 的 6s 上限依赖它）
 * @param opts.timeoutMs 单个端点超时（默认 8s）
 */
export async function fetchModelsWithDiagnostics(
  baseURL: string,
  apiKey: string,
  preferredModel?: string,
  opts: { budgetMs?: number; timeoutMs?: number } = {},
): Promise<ModelFetchDiagnostics> {
  // 归一化：补协议、去端点后缀；Key 去掉 CRLF/引号（Windows/openEuler 粘贴常见）
  const base = normalizeBaseURL(baseURL) ?? baseURL.replace(/\/+$/, "");
  const key = cleanLlmValue(apiKey) ?? "";
  const budgetMs = opts.budgetMs ?? 25_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const started = Date.now();
  const attempts: ModelFetchAttempt[] = [];
  const candidates = modelListCandidates(base);
  /** 是否见过 401/403：全部候选都失败后据此给出「Key 无效」的提示 */
  let authFailed = false;

  for (const url of candidates) {
    const left = budgetMs - (Date.now() - started);
    if (left < 500) {
      // 预算用尽：不再发请求，但要如实告诉用户哪些端点没试过
      attempts.push({ url, error: "超出重试总预算，未尝试" });
      continue;
    }
    try {
      const resp = (await doFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
      })) as { ok: boolean; status?: number; json: () => Promise<unknown>; text?: () => Promise<string> };

      if (!resp.ok) {
        const status = typeof resp.status === "number" ? resp.status : undefined;
        const detail = await errorSnippet(resp);
        attempts.push({ url, ...(status !== undefined ? { status } : {}), ...(detail ? { error: detail } : {}) });
        // 401/403 也继续试其它组合：少数网关对「路径不存在」也回 401，
        // 早停会漏掉真正的模型列表端点。全部失败后再按此提示 Key 问题。
        if (status === 401 || status === 403) authFailed = true;
        continue;
      }

      const body = (await resp.json()) as unknown;
      const { models, meta } = parseModelList(body);
      if (models.length === 0) {
        // 部分网关对不存在的路径也回 200 + 空目录：继续试下一个组合
        attempts.push({ url, error: "返回的模型列表为空" });
        continue;
      }
      const { ordered, nonChat } = rankModels(models);
      const filled = await fillContextWindow(base, key, ordered, meta, preferredModel, {
        budgetMs: Math.max(1_000, budgetMs - (Date.now() - started)),
      });
      return {
        result: {
          models: ordered,
          endpoint: url,
          nonChat,
          ...(filled.length > 0 ? { modelMeta: filled } : {}),
        },
        attempts,
        authFailed: false,
      };
    } catch (e) {
      // 单端点失败（超时/网络/解析），尝试下一个候选
      attempts.push({ url, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { result: null, attempts, authFailed };
}

/**
 * 把刷新失败翻译成可操作的提示。
 *
 * 典型：Base URL 填成 `https://api.deepseek.com/v1` 时，官方 `GET /models`
 * 不在 /v1 下，旧实现只会显示「刷新出 0 个」，用户完全不知道该怎么办。
 */
export function describeModelFetchFailure(
  baseURL: string,
  diag: ModelFetchDiagnostics,
): string {
  const lines = diag.attempts.map((a) => {
    const why = a.status !== undefined ? `HTTP ${a.status}` : (a.error ?? "请求失败");
    return `  · ${a.url} → ${why}${a.status !== undefined && a.error ? `（${a.error}）` : ""}`;
  });
  if (diag.authFailed) {
    return (
      `模型列表刷新失败：API Key 无效或无权限（Base URL：${baseURL}）。` +
      `\n已尝试：\n${lines.join("\n")}` +
      `\n请检查 Key 是否填写正确、是否已过期，或该 Key 是否有权访问此端点。`
    );
  }
  return (
    `模型列表刷新失败：所有候选端点都没有返回可用模型（Base URL：${baseURL}）。` +
    `\n已尝试：\n${lines.join("\n")}` +
    `\n请确认 Base URL 是否正确（一般填到 /v1 为止，如 https://api.deepseek.com），` +
    `以及该服务是否提供 OpenAI 兼容的 GET /models 接口。`
  );
}

/** `/models` 未给出上下文长度时，对当前（或首个）模型单体探测一次兜底 */
async function fillContextWindow(
  base: string,
  key: string,
  models: string[],
  meta: ModelMeta[],
  preferred?: string,
  opts: { budgetMs?: number } = {},
): Promise<ModelMeta[]> {
  if (meta.length > 0) return meta;
  const target = preferred?.trim() || models[0];
  if (!target) return meta;
  const ctx = await fetchModelContext(base, key, target, opts.budgetMs);
  return ctx ? [{ id: target, contextWindow: ctx }] : meta;
}

/** 刷新模型列表（简单形态）：只要结果，失败返回 null。需要失败原因时用 `fetchModelsWithDiagnostics`。 */
export async function fetchModels(
  baseURL: string,
  apiKey: string,
  /** 当前已选模型：/models 未返回上下文长度时对它单体探测一次兜底 */
  preferredModel?: string,
): Promise<ModelListResult | null> {
  const diag = await fetchModelsWithDiagnostics(baseURL, apiKey, preferredModel);
  return diag.result;
}

/**
 * 兜底：从 `/models/{id}` 端点读取单个模型的上下文长度。
 *
 * 多数 OpenAI 兼容网关并不实现该端点（OpenAI 官方与阿里百炼都不提供），
 * 因此失败时静默返回 undefined，由引擎回退到内置的模型表。
 */
export async function fetchModelContext(
  baseURL: string,
  apiKey: string,
  modelId: string,
  timeoutMs = 10_000,
): Promise<number | undefined> {
  if (!modelId) return undefined;
  const base = normalizeBaseURL(baseURL) ?? baseURL.replace(/\/+$/, "");
  const key = cleanLlmValue(apiKey) ?? "";
  try {
    const resp = (await doFetch(`${base}/models/${encodeURIComponent(modelId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
    })) as { ok: boolean; json: () => Promise<unknown> };
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as unknown;
    // 兼容两种形态：`{ id, context_length }` 与 `{ data: { … } }`
    const rec = (body ?? {}) as Record<string, unknown>;
    const inner = rec.data && typeof rec.data === "object" && !Array.isArray(rec.data) ? rec.data : rec;
    return parseModelList({ data: [inner] }).meta[0]?.contextWindow;
  } catch {
    return undefined;
  }
}

// ===================== 模型可用性自检 =====================

/** 模型自检结果 */
export interface ModelProbeResult {
  /** 该模型能否正常对话 */
  ok: boolean;
  /** 失败原因（provider 的 message + code / 网络错误） */
  error?: string;
  /** provider 返回的错误码（如 InvalidParameter、model_not_found） */
  code?: string;
  /** 自检请求耗时（毫秒） */
  latencyMs: number;
}

/** 从错误响应体里尽量提取可读信息（两种兼容模式风格都支持） */
function extractError(body: unknown): { message: string; code?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const e = (b.error ?? b) as Record<string, unknown>;
  const message = String(e.message ?? b.message ?? "").trim();
  const code = typeof e.code === "string" ? e.code : typeof b.code === "string" ? b.code : undefined;
  const requestId = typeof b.request_id === "string" ? b.request_id : undefined;
  return {
    message: message || "未知错误",
    code: code ? `${code}${requestId ? ` (request_id=${requestId})` : ""}` : undefined,
  };
}

/**
 * 自检：向 `/chat/completions` 发一条最小请求，确认所选模型真的可用。
 *
 * 背景：网关的 /models 是"全量目录"，列出的模型未必能在对话接口上用
 * （阿里兼容模式对专用通道/非对话模型直接回 400 InvalidParameter）。
 * 在 /connect 里选完就跑一次，比让用户在第一次对话时才撞墙要好得多。
 *
 * 用 Chat Completions 而非 Responses：前者是全供应商的公共底线。
 */
export async function probeModel(
  baseURL: string,
  apiKey: string,
  model: string,
): Promise<ModelProbeResult> {
  const base = normalizeBaseURL(baseURL) ?? baseURL.replace(/\/+$/, "");
  const key = cleanLlmValue(apiKey) ?? "";
  const started = Date.now();
  try {
    const resp = (await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        // 与 Provider 共用 isReasoningModel：o 系列 / gpt-5 只接受
        // max_completion_tokens，传 max_tokens 会 400，把可用模型误判成不可用
        ...(isReasoningModel(model)
          ? { max_completion_tokens: 8 }
          : { max_tokens: 8 }),
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })) as { status: number; ok: boolean; json: () => Promise<unknown> };

    const latencyMs = Date.now() - started;
    if (resp.ok) return { ok: true, latencyMs };

    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      // 非 JSON 错误体（网关 HTML 等）
    }
    const { message, code } = extractError(body);
    return {
      ok: false,
      error: `HTTP ${resp.status} ${message}`,
      ...(code ? { code } : {}),
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}
