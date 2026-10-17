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
    out.push(Number.isFinite(ctx) && ctx > 0 ? { id, contextWindow: ctx } : { id });
    if (out.length >= 500) break;
  }
  return out;
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
 * 通过 baseURL + apiKey 请求 /models 接口刷新可用模型列表。
 *
 * 按常见候选路径逐个尝试（baseURL 不带 /v1 时追加 /v1/models），
 * 命中第一个返回非空列表的端点即返回；全部失败返回 null。
 * 单端点请求带 10s 超时与 Bearer 鉴权。
 */
export async function fetchModels(
  baseURL: string,
  apiKey: string,
  /** 当前已选模型：/models 未返回上下文长度时对它单体探测一次兜底 */
  preferredModel?: string,
): Promise<ModelListResult | null> {
  // 归一化：补协议、去端点后缀；Key 去掉 CRLF/引号（Windows/openEuler 粘贴常见）
  const base = normalizeBaseURL(baseURL) ?? baseURL.replace(/\/+$/, "");
  const key = cleanLlmValue(apiKey) ?? "";
  const candidates: string[] = [`${base}/models`];
  if (!/\/v1$/.test(base)) candidates.push(`${base}/v1/models`);

  for (const url of candidates) {
    try {
      const resp = (await doFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      })) as { ok: boolean; json: () => Promise<unknown> };
      if (!resp.ok) continue;
      const body = (await resp.json()) as unknown;
      const { models, meta } = parseModelList(body);
      if (models.length > 0) {
        const { ordered, nonChat } = rankModels(models);
        const filled = await fillContextWindow(base, key, ordered, meta, preferredModel);
        return {
          models: ordered,
          endpoint: url,
          nonChat,
          ...(filled.length > 0 ? { modelMeta: filled } : {}),
        };
      }
    } catch {
      // 单端点失败（超时/网络/解析），尝试下一个候选
    }
  }
  return null;
}

/** `/models` 未给出上下文长度时，对当前（或首个）模型单体探测一次兜底 */
async function fillContextWindow(
  base: string,
  key: string,
  models: string[],
  meta: ModelMeta[],
  preferred?: string,
): Promise<ModelMeta[]> {
  if (meta.length > 0) return meta;
  const target = preferred?.trim() || models[0];
  if (!target) return meta;
  const ctx = await fetchModelContext(base, key, target);
  return ctx ? [{ id: target, contextWindow: ctx }] : meta;
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
): Promise<number | undefined> {
  if (!modelId) return undefined;
  const base = normalizeBaseURL(baseURL) ?? baseURL.replace(/\/+$/, "");
  const key = cleanLlmValue(apiKey) ?? "";
  try {
    const resp = (await doFetch(`${base}/models/${encodeURIComponent(modelId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
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
