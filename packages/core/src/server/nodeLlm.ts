/**
 * 节点级 LLM 配置
 *
 * 与「项目级」LLM 配置（TenantConfig.llmProviders）并列：节点级保存本节点可用的
 * LLM 列表与一个「默认」配置，新项目/未单独配置的项目默认继承它。
 * API Key 落盘保存，读取时只回 hasApiKey。
 */
import type { Store } from "./store.js";
import type { LlmProviderEntry, TenantConfig } from "./types.js";
import {
  modelContextWindow,
  normalizeModelMeta,
  type ModelMeta,
} from "../providers/models.js";
import { ApiError } from "./session.js";

// 供视图/持久化层沿用同一入口（实现已下移到 providers/models.ts，便于 llmConfig / CLI 复用）
export { modelContextWindow, normalizeModelMeta };

/** 环境变量配置的「节点全局 LLM」在列表中的固定 id（不可删除） */
export const GLOBAL_PROVIDER_ID = "__env__";

/** 环境变量提供的全局 LLM（OPENAI_*），有则展示但不可删除 */
export function envProvider() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    id: GLOBAL_PROVIDER_ID,
    name: process.env.OPENAI_MODEL || process.env.MODEL || "全局 LLM",
    type: "env",
    baseURL: process.env.OPENAI_BASE_URL ?? "",
    model: process.env.OPENAI_MODEL || process.env.MODEL || "",
    apiKey,
  };
}

export interface NodeLlmConfig {
  providers: LlmProviderEntry[];
  defaultProviderId?: string;
}

/** 规范化推理强度；非法/未设置返回 null */
function normReasoningEffort(v: unknown): "low" | "medium" | "high" | null {
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

/** 规范化模型列表（字符串、去重、限长），供持久化与视图复用 */export function normalizeModelList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = String(x ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 500) break;
  }
  return out;
}

/** 非敏感视图（apiKey 只回 hasApiKey） */
export function nodeLlmView(cfg: NodeLlmConfig) {
  const g = envProvider();
  const providers = [
    ...(g
      ? [
          {
            id: g.id,
            name: g.name,
            type: g.type,
            baseURL: g.baseURL,
            model: g.model,
            hasApiKey: true,
            global: true as const,
          },
        ]
      : []),
    ...cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type ?? "",
      baseURL: p.baseURL,
      model: p.model,
      hasApiKey: Boolean(p.apiKey),
      models: p.models ?? [],
      nonChat: p.nonChat ?? [],
      modelMeta: p.modelMeta ?? [],
      reasoningEffort: p.reasoningEffort ?? null,
      global: false as const,
    })),
  ];
  return {
    defaultProviderId: cfg.defaultProviderId ?? null,
    providers,
    /** 未显式设置默认时，是否由环境变量全局配置兜底 */
    globalIsDefault: !cfg.defaultProviderId && Boolean(g),
  };
}

/** 整体替换语义：每项 apiKey 为空时保留旧值 */
export function applyNodeLlmPatch(
  cfg: NodeLlmConfig,
  raw: { providers?: unknown; defaultProviderId?: unknown } | undefined,
): NodeLlmConfig {
  const next: NodeLlmConfig = { providers: cfg.providers, defaultProviderId: cfg.defaultProviderId };
  if (Array.isArray(raw?.providers)) {
    const old = new Map(cfg.providers.map((p) => [p.id, p]));
    next.providers = raw.providers
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .filter((x) => x.global !== true && String(x.id ?? "") !== GLOBAL_PROVIDER_ID)
      .map((x) => {
        const id = String(x.id ?? "").trim();
        if (!id) throw new ApiError(400, "bad_request", "供应商 id 不能为空");
        const prev = old.get(id);
        const apiKey = String(x.apiKey ?? "").trim();
        const models = normalizeModelList(x.models) ?? prev?.models;
        const nonChat = normalizeModelList(x.nonChat) ?? prev?.nonChat;
        const modelMeta = normalizeModelMeta(x.modelMeta) ?? prev?.modelMeta;
        return {
          id,
          name: String(x.name ?? prev?.name ?? id).trim(),
          type: x.type == null ? prev?.type : String(x.type),
          baseURL: String(x.baseURL ?? prev?.baseURL ?? "").trim(),
          model: String(x.model ?? prev?.model ?? "").trim(),
          apiKey: apiKey || prev?.apiKey,
          reasoningEffort:
            x.reasoningEffort === undefined
              ? (prev?.reasoningEffort ?? null)
              : normReasoningEffort(x.reasoningEffort),
          ...(models ? { models } : {}),
          ...(nonChat ? { nonChat } : {}),
          ...(modelMeta ? { modelMeta } : {}),
        };
      });
  }
  if (typeof raw?.defaultProviderId === "string") {
    const id = raw.defaultProviderId.trim();
    next.defaultProviderId = id || undefined;
  } else if (raw?.defaultProviderId === null) {
    next.defaultProviderId = undefined;
  }
  return next;
}

/**
 * 按 id 取节点级 LLM 配置项（含环境变量全局项 `__env__`）；不存在返回 null。
 * 供「会话级 LLM 选择」解析实际使用的 provider。
 */
export function findNodeProvider(store: Store, id: string): LlmProviderEntry | null {
  if (!id) return null;
  if (id === GLOBAL_PROVIDER_ID) return envProvider();
  return store.loadNodeLlm().providers.find((p) => p.id === id) ?? null;
}

/** 节点默认 LLM（未指定默认时取第一个） */
export function nodeDefaultProvider(store: Store): LlmProviderEntry | null {
  const cfg = store.loadNodeLlm();
  if (cfg.providers.length === 0) return null;
  return (
    cfg.providers.find((p) => p.id === cfg.defaultProviderId) ?? cfg.providers[0] ?? null
  );
}

/**
 * 会话实际使用的 provider，优先级：**会话级配置** > 项目配置 > 节点默认。
 *
 * 供「会话装配引擎」与控制台输入区共用，保证界面显示与实际调用一致。
 */
export function resolveSessionProvider(
  store: Store,
  tenant: TenantConfig,
  providerId?: string | null,
): {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  providerId?: string;
  reasoningEffort?: "low" | "medium" | "high" | null;
  /** 所选供应商的模型元数据（含上下文长度；供引擎按实际模型精确计算压缩阈值） */
  modelMeta?: ModelMeta[];
} {
  const own = tenant.provider ?? {};
  if (providerId) {
    const picked = findNodeProvider(store, providerId);
    if (picked) {
      return {
        apiKey: picked.apiKey || own.apiKey,
        baseURL: picked.baseURL || own.baseURL,
        model: picked.model,
        providerId,
        reasoningEffort: picked.reasoningEffort ?? null,
        ...(picked.modelMeta ? { modelMeta: picked.modelMeta } : {}),
      };
    }
  }
  if (own.apiKey) return { ...own, model: tenant.model };
  const def = nodeDefaultProvider(store);
  if (def?.apiKey) {
    return {
      apiKey: def.apiKey,
      baseURL: own.baseURL || def.baseURL,
      model: def.model || tenant.model,
      reasoningEffort: def.reasoningEffort ?? null,
      ...(def.modelMeta ? { modelMeta: def.modelMeta } : {}),
    };
  }
  return { ...own, model: tenant.model };
}

/**
 * 项目实际使用的 provider：项目自身有 API Key 时优先，否则回退到节点默认。
 * 供会话装配引擎时使用（新项目/未配置项目自动继承节点默认）。
 */
export function effectiveProvider(
  store: Store,
  tenant: TenantConfig,
): { apiKey?: string; baseURL?: string } {
  const r = resolveSessionProvider(store, tenant);
  return { apiKey: r.apiKey, baseURL: r.baseURL };
}
