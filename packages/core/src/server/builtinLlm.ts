/**
 * 平台内置大模型（志前 API）在节点侧的装配。
 *
 * 背景：接入 Hub 的节点应当「开箱就能用」，用户不需要自己申请 Key。
 * 控制面在接入响应里下发一次，之后由本模块负责三种补配场景：
 *
 *   1. **老节点升级**：升级前接入的节点本地没有内置项，启动时补一次
 *   2. **凭据轮换**：用户在控制台重置 Key 后旧 Key 失效，遇到 401 时重拉
 *   3. **用户手工刷新**：控制台「刷新内置模型」按钮
 *
 * 为什么必须「节点主动拉」：网关只提供 `/ws` 与只读的 `/state`，
 * 没有 hub → 节点的下行指令通道，控制面无法主动推送。
 *
 * 失败一律静默：未登录、未开户、控制面未配置时都只是「没有内置模型」，
 * 绝不能因此让节点启动失败或报错——用户仍可自己配置其它模型。
 */
import type { FleetCredential } from "@zqagent/shared/fleet";
import type { Store } from "./store.js";
import type { LlmProviderEntry } from "./types.js";
import { BUILTIN_PROVIDER_ID, FALLBACK_MODEL, LEGACY_DEFAULT_MODELS } from "./llmIds.js";
import {
  fetchModelsWithDiagnostics,
  mergeModelMeta,
} from "../providers/models.js";
import { suggestedCapabilities } from "@zqagent/shared/model-capabilities";

/** 拉取超时：控制面在公网，给足时间但不至于拖住调用方 */
const FETCH_TIMEOUT_MS = 8000;
/** 补配失败后的重试间隔（避免控制面抖动时反复请求） */
const RETRY_AFTER_MS = 5 * 60_000;

export type BuiltinLlmResult =
  /** 已就绪（本次新拉取或本地已存在） */
  | { status: "ready"; provider: LlmProviderEntry; refreshed: boolean }
  /** 节点尚未接入 Hub */
  | { status: "disabled"; reason: string }
  /** 已接入但控制面未下发（未配置/未开户/凭据不可用） */
  | { status: "unavailable"; reason: string }
  /** 网络或响应异常 */
  | { status: "error"; reason: string };

interface BuiltinLlmResponse {
  data?: { builtinLlm?: unknown; reason?: unknown };
  error?: { message?: string };
}

function hubBase(cred: FleetCredential): string {
  return (cred.hubUrl ?? "").replace(/\/+$/, "");
}

function asProvider(
  grant: { providerId?: unknown; name?: unknown; baseURL?: unknown; apiKey?: unknown; model?: unknown },
): LlmProviderEntry | null {
  const baseURL = String(grant.baseURL ?? "").trim();
  const apiKey = String(grant.apiKey ?? "").trim();
  const model = String(grant.model ?? "").trim();
  if (!baseURL || !apiKey) return null;
  return {
    id: BUILTIN_PROVIDER_ID,
    name: String(grant.name ?? "").trim() || "志前大模型（内置）",
    type: "builtin",
    baseURL,
    model,
    apiKey,
  };
}

/** 用内置项的 Key 拉一次模型列表，补全下拉候选（失败不影响可用性） */
async function enrichModels(p: LlmProviderEntry): Promise<LlmProviderEntry> {
  try {
    const diag = await Promise.race([
      // 预算与外部 race 对齐：多候选端点也不会被外层超时半途砍掉
      fetchModelsWithDiagnostics(p.baseURL, p.apiKey ?? "", p.model, {
        budgetMs: FETCH_TIMEOUT_MS,
        timeoutMs: FETCH_TIMEOUT_MS,
      }),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    const r = diag?.result ?? null;
    if (!r?.models?.length) return p;
    return {
      ...p,
      // 控制面没给默认型号时，取供应商返回的第一个，避免模型为空让用户卡住
      model: p.model || r.models[0],
      models: r.models,
      ...(r.nonChat?.length ? { nonChat: r.nonChat } : {}),
      // 能力由用户勾选，但首次下发时给已知视觉模型一个合理初值（如 deepseek-flash）
      ...(r.modelMeta?.length
        ? {
            modelMeta: r.modelMeta.map((m) =>
              m.capabilities?.length
                ? m
                : { ...m, capabilities: suggestedCapabilities(m.id) },
            ),
          }
        : {}),
    };
  } catch {
    return p;
  }
}

/** 把内置项写进 `connections.json`（其余项原样保留） */
function saveBuiltin(store: Store, provider: LlmProviderEntry): void {
  const cfg = store.loadNodeLlm();
  const others = cfg.providers.filter((p) => p.id !== BUILTIN_PROVIDER_ID);
  // 保留用户此前对型号/推理强度的选择：只覆盖托管字段
  const prev = cfg.providers.find((p) => p.id === BUILTIN_PROVIDER_ID);
  const merged: LlmProviderEntry = {
    ...provider,
    // 用户选过的型号/候选列表/推理强度/显示名都保留；只有托管字段（baseURL/key）强制以控制面为准
    ...(prev?.model ? { model: prev.model } : {}),
    ...(prev?.models?.length ? { models: prev.models } : {}),
    // 用户勾选的模型能力必须保留：重新下发凭据时供应商只给上下文长度
    ...(prev?.modelMeta?.length
      ? { modelMeta: mergeModelMeta(prev.modelMeta, provider.modelMeta) }
      : {}),
    ...(prev?.reasoningEffort != null ? { reasoningEffort: prev.reasoningEffort } : {}),
    ...(prev?.name ? { name: prev.name } : {}),
  };
  store.saveNodeLlm({
    providers: [merged, ...others],
    // 之前没有默认且用户也没指定时，让内置模型成为默认——「开箱即用」
    defaultProviderId: cfg.defaultProviderId ?? BUILTIN_PROVIDER_ID,
  });
  adoptBuiltinModelForTenants(store, merged.model);
}

/** 历史上被写成「系统默认」的型号集合（见 llmIds，含空串与两代旧兜底值） */
const LEGACY_DEFAULT_SET = new Set<string>(LEGACY_DEFAULT_MODELS);

/**
 * 内置模型就绪后，把仍停在「系统默认型号」的租户对齐到它。
 *
 * 时序问题：新装节点首次启动时还没有内置模型，演示租户只能先落一个兜底型号；
 * 内置模型是异步拉取的，落盘后若不同步，用户第一次发请求仍会带着那个型号——
 * 而它很可能不是志前 API 的型号，直接 404。
 *
 * 只迁移「系统默认值」且租户没有自己的 Key 的情形：有 apiKey 说明连的是
 * 用户自己选的供应商，型号可能是对方真实支持的，不能动。
 */
export function adoptBuiltinModelForTenants(store: Store, model: string): void {
  if (!model) return;
  for (const id of store.listTenants()) {
    const tenant = store.loadTenant(id);
    if (!tenant || !LEGACY_DEFAULT_SET.has(tenant.model)) continue;
    if (tenant.provider?.apiKey) continue;
    tenant.model = model;
    store.saveTenant(tenant);
  }
}

/**
 * 没有任何可用型号时，把仍停在「历史系统默认值」的租户清空为「未选择」。
 *
 * 旧版本把兜底型号写成了 `gpt-4o` / `deepseek-v4-flash`，这些值会随项目一起落盘，
 * 于是控制台的模型下拉里平白多出一个用户从没配置过的模型，看着像系统替他选好了，
 * 实际一发请求就报错。新版本已不再写这种默认值（见 llmIds），但老节点磁盘上的
 * 数据还得清一次，否则升级后照样看得见。
 *
 * 只清「系统自己写的」且用户没有自己的 Key 的租户：有 apiKey 说明连的是用户自己
 * 选的供应商，那个型号可能是对方真实支持的。
 */
export function dropLegacyDefaultModels(store: Store): void {
  for (const id of store.listTenants()) {
    const tenant = store.loadTenant(id);
    if (!tenant || tenant.model === FALLBACK_MODEL) continue;
    if (!LEGACY_DEFAULT_SET.has(tenant.model)) continue;
    if (tenant.provider?.apiKey) continue;
    tenant.model = FALLBACK_MODEL;
    store.saveTenant(tenant);
  }
}

/**
 * 确保节点上有内置模型配置。
 *
 * - `force=false`：本地已有则直接返回（启动时用，避免每次启动都请求控制面）
 * - `force=true`：无论本地有没有都重新拉（Key 轮换/手工刷新用）
 */
export async function ensureBuiltinProvider(
  store: Store,
  opts: { force?: boolean } = {},
): Promise<BuiltinLlmResult> {
  const cred = store.loadFleetCredential();
  if (!cred?.fleetToken || !cred.fleetSecret) {
    return { status: "disabled", reason: "节点未接入 Hub" };
  }
  const hub = hubBase(cred);
  if (!hub) return { status: "disabled", reason: "缺少 Hub 地址" };

  const local = store.loadNodeLlm().providers.find((p) => p.id === BUILTIN_PROVIDER_ID);
  if (local && !opts.force) {
    // 老节点升级上来的情形：内置项早已落盘，但演示租户的型号还停在旧默认值。
    // 这里顺手迁移一次，否则用户会以为「升了级还是报错」。
    adoptBuiltinModelForTenants(store, local.model);
    return { status: "ready", provider: local, refreshed: false };
  }

  // 接入响应里带过的快照：控制面暂时不可达时先用它兜底
  const cached = cred.builtinLlm ? asProvider(cred.builtinLlm) : null;

  let res: Response;
  try {
    res = await fetch(`${hub}/api/hub/node/builtin-llm`, {
      headers: {
        Authorization: `Bearer ${cred.fleetToken}`,
        "X-Fleet-Secret": cred.fleetSecret,
        "X-Node-Id": cred.nodeId,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (cached) {
      const provider = await enrichModels(cached);
      saveBuiltin(store, provider);
      return { status: "ready", provider, refreshed: true };
    }
    return { status: "error", reason: `连接 Hub 失败：${(e as Error).message}` };
  }

  let body: BuiltinLlmResponse | null = null;
  try {
    body = (await res.json()) as BuiltinLlmResponse;
  } catch {
    // 非 JSON 响应按状态码处理
  }

  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    // 凭据失效（例如换了 Hub 地址）：不是网络问题，直接报出来便于排查
    if (res.status === 401 || res.status === 403) {
      return { status: "unavailable", reason: msg };
    }
    if (cached) {
      const provider = await enrichModels(cached);
      saveBuiltin(store, provider);
      return { status: "ready", provider, refreshed: true };
    }
    return { status: "error", reason: msg };
  }

  const grant = body?.data?.builtinLlm as
    | { providerId?: unknown; name?: unknown; baseURL?: unknown; apiKey?: unknown; model?: unknown }
    | null
    | undefined;
  if (!grant) {
    const why = String(body?.data?.reason ?? "").trim();
    return { status: "unavailable", reason: why || "控制面未下发内置模型" };
  }

  const parsed = asProvider(grant);
  if (!parsed) return { status: "unavailable", reason: "内置模型配置不完整" };

  const provider = await enrichModels(parsed);
  saveBuiltin(store, provider);
  return { status: "ready", provider, refreshed: true };
}

export interface LlmBalance {
  /** 可用余额（元）；null = 查不到（未开户/账本不可用） */
  available: number | null;
  currency: string;
  /** 预扣中（在途请求占用） */
  reserved?: number;
  /** 充值页深链；落不到 Hub 公网地址时缺省，由前端用 hubUrl 拼 */
  topupUrl?: string;
  /** available 为 null 时的原因 */
  reason?: string;
}

/**
 * 查「大模型账户余额」。
 *
 * 控制台要一个「余额不足 → 看一眼还剩多少 → 立刻充值」的闭环，因此这个查询
 * 必须便宜（单次 HTTP）、可失败（返回 reason 而不是抛错）、且不依赖浏览器登录。
 *
 * 用节点凭据向 Hub 代查，原因见 hub 侧 `/node/balance` 的注释。
 */
export async function fetchLlmBalance(store: Store): Promise<LlmBalance> {
  const cred = store.loadFleetCredential();
  const hub = cred ? hubBase(cred) : "";
  if (!cred?.fleetToken || !cred.fleetSecret || !hub) {
    return { available: null, currency: "CNY", reason: "节点未接入 Hub" };
  }
  try {
    const res = await fetch(`${hub}/api/hub/node/balance`, {
      headers: {
        Authorization: `Bearer ${cred.fleetToken}`,
        "X-Fleet-Secret": cred.fleetSecret,
        "X-Node-Id": cred.nodeId,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | {
          data?: { available?: unknown; currency?: unknown; reserved?: unknown; topupUrl?: unknown; reason?: unknown };
          error?: { message?: unknown };
        }
      | null;
    if (!res.ok) {
      /*
       * 优先透出控制面给的原因（「节点凭据无效」这类），而不是「HTTP 401」。
       * 余额查不到时前端会把这句话直接显示给用户，状态码对他没有意义。
       */
      const msg = typeof body?.error?.message === "string" ? body.error.message.trim() : "";
      return {
        available: null,
        currency: "CNY",
        reason: msg || `HTTP ${res.status}`,
      };
    }
    const d = body?.data ?? {};
    const available = typeof d.available === "number" ? d.available : null;
    return {
      available,
      currency: typeof d.currency === "string" && d.currency ? d.currency : "CNY",
      ...(typeof d.reserved === "number" ? { reserved: d.reserved } : {}),
      // Hub 没配 HUB_PUBLIC_URL 时退回用接入时的 hubUrl
      topupUrl:
        typeof d.topupUrl === "string" && d.topupUrl ? d.topupUrl : `${hub}/topup`,
      ...(available === null && typeof d.reason === "string" ? { reason: d.reason } : {}),
    };
  } catch (e) {
    return {
      available: null,
      currency: "CNY",
      reason: `连接 Hub 失败：${(e as Error).message}`,
    };
  }
}

/** 自愈节流：同一进程内 60s 最多重拉一次 */
const AUTH_RETRY_THROTTLE_MS = 60_000;
let lastAuthRetryAt = 0;

/**
 * 运行期遇到「凭据无效」时自动重拉一次内置模型。
 *
 * 典型场景：用户在控制台重置了 Key（旧 Key 立即吊销），节点上这份就失效了。
 * 若不自愈，用户会一直看到 401，还以为节点坏了。
 *
 * 只做一次、带节流、静默失败：调用方是 turn 的错误路径，不能在这里放大问题。
 */
export function healBuiltinOnAuthFailure(store: Store, message: string): void {
  if (!/401|unauthorized|invalid[_\s]*api[_\s]*key|api[\s_-]*key\s*(?:无效|invalid)/i.test(message)) return;
  if (!store.loadFleetCredential()) return; // 未接入 Hub：无内置模型可修
  if (!store.loadNodeLlm().providers.some((p) => p.id === BUILTIN_PROVIDER_ID)) return;
  if (Date.now() - lastAuthRetryAt < AUTH_RETRY_THROTTLE_MS) return;
  lastAuthRetryAt = Date.now();
  void ensureBuiltinProvider(store, { force: true }).catch(() => {});
}

/** 最近一次失败时间，用于退避（进程内，不落盘） */
let lastFailureAt = 0;

/**
 * 启动补配。异步、失败静默、带退避——绝不能影响服务启动。
 */
export function scheduleBuiltinProvider(store: Store, log: (msg: string) => void = () => {}): void {
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return;
  void ensureBuiltinProvider(store)
    .then((r) => {
      if (r.status === "ready") {
        if (r.refreshed) log(`[builtin-llm] 已下发内置模型：${r.provider.name}（${r.provider.model}）`);
        return;
      }
      if (r.status === "disabled") return; // 未接入 Hub 是正常状态，不刷日志
      lastFailureAt = Date.now();
      // 不属于故障：控制面未开户时用户自己配模型即可
      if (r.status === "unavailable") log(`[builtin-llm] 暂无内置模型：${r.reason}`);
      else log(`[builtin-llm] 拉取内置模型失败：${r.reason}`);
    })
    .catch(() => {
      lastFailureAt = Date.now();
    });
}
