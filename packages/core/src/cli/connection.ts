/**
 * /connect — LLM 供应商连接配置（CLI 侧视图）
 *
 * 配置本身由 `../llmConfig.js` 统一持有：CLI、Server（`/api/v1/node/llm`）、
 * 桌面端读写的是**同一份** `~/.config/zqagent/connections.json`。
 * 本模块只负责把它转换成 CLI 需要的形态（解密后的连接、摘要列表等），
 * 并保留 /connect 的既有交互语义。
 */
import { cliWarn } from "../terminal.js";
import {
  autoProviderName,
  commonLegacyFiles,
  decryptKey,
  encryptKey,
  llmConfigFile,
  newProviderId,
  readLlmConfig,
  writeLlmConfig,
} from "../llmConfig.js";
import type { ReasoningEffort } from "../engine/types.js";
import type { ModelMeta } from "../providers/models.js";
import { LLM_PRESETS, llmPreset } from "@zqagent/shared/llm-presets";

/** 统一配置文件路径（惰性：读取时解析，支持环境变量覆盖） */
export const CONNECTION_FILE = llmConfigFile;

// ===================== Provider 预置（唯一来源：@zqagent/shared/llm-presets） =====================

export interface ProviderPreset {
  label: string;
  baseURL: string;
  supportsReasoningEffort: boolean;
  hint?: string;
}

/**
 * 预置供应商表。与 Web/桌面「节点配置」的「添加供应商」按钮共用
 * `LLM_PRESETS`，保证两端完全一致。
 */
export const PROVIDERS: Record<string, ProviderPreset> = Object.fromEntries(
  LLM_PRESETS.map((p) => [
    p.id,
    {
      label: p.name,
      baseURL: p.baseURL,
      supportsReasoningEffort: p.supportsReasoningEffort,
      ...(p.hint ? { hint: p.hint } : {}),
    },
  ]),
);

// ===================== 类型 =====================

/** 连接配置（解密后的内存形态） */
export interface ConnectionConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  /** 上次刷新 `/models` 得到的模型元数据（含真实上下文长度；供压缩阈值精确化） */
  modelMeta?: ModelMeta[];
}

/** 列表视图（不含明文 key） */
export interface ConnectionSummary {
  id: string;
  name: string;
  provider: string;
  baseURL: string;
  model: string;
  active: boolean;
}

// ===================== 读写 =====================

/** 读取统一配置（含旧 server 数据目录的自动迁移） */
function read() {
  return readLlmConfig({ legacyFiles: commonLegacyFiles() });
}

const decrypt = decryptKey;
const encrypt = encryptKey;

function toConfig(
  p: {
    type: string;
    baseURL: string;
    model: string;
    apiKeyEnc: string;
    reasoningEffort: ReasoningEffort | null;
    modelMeta?: ModelMeta[];
  },
  apiKey: string,
): ConnectionConfig {
  return {
    provider: p.type,
    baseURL: p.baseURL,
    apiKey,
    model: p.model,
    reasoningEffort: p.reasoningEffort,
    ...(p.modelMeta ? { modelMeta: p.modelMeta } : {}),
  };
}

// ===================== 公共 API =====================

/** 当前生效的连接（解密）；无配置/解密失败返回 null */
export function loadConnection(): ConnectionConfig | null {
  const f = read();
  const active = f.providers.find((p) => p.id === f.activeId) ?? f.providers[0];
  if (!active) return null;
  const apiKey = decrypt(active.apiKeyEnc);
  if (apiKey === null) {
    cliWarn("⚠️  API key 解密失败（主密钥可能已变化），请重新运行 /connect");
    return null;
  }
  return toConfig(active, apiKey);
}

/** 供应商列表（不含明文 key），active 标记当前生效项 */
export function listConnections(): ConnectionSummary[] {
  const f = read();
  return f.providers.map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.type,
    baseURL: p.baseURL,
    model: p.model,
    active: p.id === f.activeId,
  }));
}

/** 指定供应商的连接参数（解密 key，供 /models 拉取模型列表用）；不存在/解密失败返回 null */
export function loadConnectionById(id: string): ConnectionConfig | null {
  const f = read();
  const p = f.providers.find((x) => x.id === id);
  if (!p) return null;
  const apiKey = decrypt(p.apiKeyEnc);
  if (apiKey === null) {
    cliWarn("⚠️  API key 解密失败（主密钥可能已变化），请重新运行 /connect");
    return null;
  }
  return toConfig(p, apiKey);
}

/** 新增供应商并设为当前生效。返回其 id。 */
export function addConnection(cfg: ConnectionConfig, name?: string): string {
  const f = read();
  const id = newProviderId();
  f.providers.push({
    id,
    name: name?.trim() || autoName(cfg.provider, cfg.model),
    type: cfg.provider,
    baseURL: cfg.baseURL,
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    apiKeyEnc: encrypt(cfg.apiKey),
    ...(cfg.modelMeta ? { modelMeta: cfg.modelMeta } : {}),
  });
  f.activeId = id;
  writeLlmConfig(f);
  return id;
}

/** 自动生成的展示名（供应商标签 · 模型） */
function autoName(provider: string, model: string): string {
  return autoProviderName(provider, model);
}

/** 保存/更新当前生效供应商（无则新增）；CLI /connect 沿用此语义 */
export function saveConnection(cfg: ConnectionConfig): void {
  const f = read();
  const active = f.providers.find((p) => p.id === f.activeId);
  if (active) {
    const wasAutoNamed =
      active.name === autoName(active.type, active.model) ||
      active.name === (PROVIDERS[active.type]?.label ?? active.type);
    active.type = cfg.provider;
    active.baseURL = cfg.baseURL;
    active.apiKeyEnc = encrypt(cfg.apiKey);
    active.model = cfg.model;
    active.reasoningEffort = cfg.reasoningEffort;
    // 本次未刷新模型列表时沿用上次的元数据（与 Server 侧 saveNodeLlm 语义一致）
    if (cfg.modelMeta) active.modelMeta = cfg.modelMeta;
    // 名称随供应商/模型一起刷新：否则把 DeepSeek 连接改成阿里端点后，
    // /providers 列表里它会一直顶着 "DeepSeek" 的旧名字（用户无法分辨）
    if (wasAutoNamed) active.name = autoName(cfg.provider, cfg.model);
    writeLlmConfig(f);
  } else {
    addConnection(cfg);
  }
}

/**
 * 记录某供应商最近一次刷新得到的模型元数据（含上下文长度）。
 *
 * 引擎装配时按当前模型查表，据此精确计算上下文压缩的触发阈值；不落盘则
 * 每次都要重新请求供应商。`modelMeta` 为空（供应商未提供）时不写入，保留旧值。
 * @returns 是否写入
 */
export function saveProviderModelMeta(id: string, modelMeta: ModelMeta[] | undefined): boolean {
  if (!modelMeta?.length) return false;
  const f = read();
  const p = f.providers.find((x) => x.id === id);
  if (!p) return false;
  p.modelMeta = modelMeta;
  writeLlmConfig(f);
  return true;
}

/** 切换当前生效供应商。@returns 是否成功 */
export function useConnection(id: string): boolean {
  const f = read();
  if (!f.providers.some((p) => p.id === id)) return false;
  f.activeId = id;
  writeLlmConfig(f);
  return true;
}

/** 删除指定供应商；删除当前项时自动切到第一个。 */
export function removeConnection(id: string): boolean {
  const f = read();
  const next = f.providers.filter((p) => p.id !== id);
  if (next.length === f.providers.length) return false;
  f.providers = next;
  if (f.activeId === id) f.activeId = next[0]?.id ?? null;
  writeLlmConfig(f);
  return true;
}

/** 清空全部连接配置（不含主密钥） */
export function clearConnection(): void {
  writeLlmConfig({ version: 3, activeId: null, providers: [] });
}

/** 预设查询（供 CLI 展示 hint 等） */
export { llmPreset };

// ===================== 模型列表刷新 =====================

export {
  fetchModels,
  fetchModelContext,
  probeModel,
  isChatModel,
  modelContextWindow,
} from "../providers/models.js";
export type { ModelListResult, ModelProbeResult, ModelMeta } from "../providers/models.js";
