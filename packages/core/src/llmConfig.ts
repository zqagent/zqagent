/**
 * LLM 配置统一存储（CLI `/connect` 与 Server「节点配置」共用同一份文件）
 *
 * 位置：`~/.config/zqagent/connections.json`（可用 `XDG_CONFIG_HOME` 覆盖；
 * 或用 `ZQAGENT_LLM_CONFIG_FILE` 直接指定文件，便于测试与自定义部署）。
 * 同一台机器上，CLI、以本机用户身份运行的 server、桌面端内嵌 sidecar 读写的都是这一份，
 * 因此任一端的增删改都会立即表现在其它端。
 *
 * 格式 v3：
 *   { version: 3, activeId, providers: [{ id, name, type, baseURL, model,
 *     reasoningEffort, apiKeyEnc, models, nonChat, modelMeta }], migratedFrom }
 *
 * - `apiKeyEnc`：AES-256-GCM 密文（主密钥与配置同目录，0600）。
 * - `type` 为预设 id（合并了 CLI 的 `provider` 与 Web 的 `type` 两个历史字段名）。
 * - 兼容读取旧格式并自动迁移：CLI 的 v2 / 更早的单连接格式，以及
 *   Server 的 `{DATA_DIR}/node-llm.json`（明文 key → 加密）。
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ReasoningEffort } from "./engine/types.js";
import { loadOrCreateMasterKey, encryptWithKey, decryptWithKey } from "./crypto/secrets.js";
import { normalizeModelMeta, type ModelMeta } from "./providers/models.js";
import { configDir, stateDir } from "./paths.js";
import { llmPreset } from "@zqagent/shared/llm-presets";

/**
 * 统一配置文件路径（惰性解析：读取时才计算，便于测试注入环境变量）。
 * 优先级：`ZQAGENT_LLM_CONFIG_FILE` → `configDir()/connections.json`。
 */
export function llmConfigFile(): string {
  const override = process.env.ZQAGENT_LLM_CONFIG_FILE?.trim();
  if (override) return override;
  return path.join(configDir(), "connections.json");
}

/** 单个供应商条目（含加密后的 key） */
export interface LlmProviderEntry {
  id: string;
  /** 展示名 */
  name: string;
  /** 预设 id（`llmPresets` 的 id；历史 provider/type 合并到此） */
  type: string;
  baseURL: string;
  model: string;
  /** 推理强度；不支持或未设置时为 null */
  reasoningEffort: ReasoningEffort | null;
  /** API Key 密文（AES-256-GCM，`v1:iv:tag:ciphertext`） */
  apiKeyEnc: string;
  /** 上次刷新得到的候选模型（可选） */
  models?: string[];
  /** 候选中非对话模型的子集（可选，仅用于提示） */
  nonChat?: string[];
  /**
   * 刷新模型列表时从供应商 `/models` 拿到的元数据（含真实上下文长度）。
   * 落盘后供引擎按实际模型精确计算压缩阈值（见 `providers/models.ts`）。
   */
  modelMeta?: ModelMeta[];
}

export interface LlmConfigFile {
  version: 3;
  activeId: string | null;
  providers: LlmProviderEntry[];
  /** 已导入过的旧配置来源（绝对路径），避免重复合并 */
  migratedFrom?: string[];
}

// ===================== 加解密 =====================

/** 主密钥按「配置目录」缓存（不同配置目录用不同密钥；测试隔离后互不影响） */
const keyCache = new Map<string, Buffer>();

function masterKeyFileFor(file: string): string {
  return path.join(path.dirname(file), "secret.key");
}

function getMasterKey(file: string): Buffer {
  const keyFile = masterKeyFileFor(file);
  let key = keyCache.get(keyFile);
  if (!key) {
    key = loadOrCreateMasterKey(keyFile);
    keyCache.set(keyFile, key);
  }
  return key;
}

/** 加密 API Key；`file` 为配置文件路径（缺省用统一路径，决定主密钥位置） */
export function encryptKey(plain: string, file = llmConfigFile()): string {
  return encryptWithKey(getMasterKey(file), plain);
}

/** 解密 API Key；格式非法 / 主密钥变化返回 null */
export function decryptKey(payload: string, file = llmConfigFile()): string | null {
  return decryptWithKey(getMasterKey(file), payload);
}

/** 生成新的供应商 id */
export function newProviderId(): string {
  return crypto.randomBytes(8).toString("hex");
}

// ===================== 规范化 =====================

function normEffort(v: unknown): ReasoningEffort | null {
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

/** 规范化模型列表（去重、限长） */
function normModelList(v: unknown): string[] | undefined {
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
  return out.length ? out : undefined;
}

/** 由端点反查预设 id（迁移无 type 的旧数据） */
function guessTypeByBaseURL(baseURL: string): string {
  const u = baseURL.toLowerCase().replace(/\/+$/, "");
  if (!u) return "custom";
  for (const p of KNOWN_PRESETS) {
    const b = p.baseURL.toLowerCase().replace(/\/+$/, "");
    if (b && (u === b || u.startsWith(b))) return p.id;
  }
  return "custom";
}

const KNOWN_PRESETS = ["openai", "deepseek", "qwen", "zhipu", "moonshot", "xiaomi"].map(
  (id) => ({ id, baseURL: llmPreset(id)?.baseURL ?? "" }),
);

/** 解析单个条目（兼容 v3 / v2 / server 明文 key 三种形态） */
function parseEntry(o: unknown, file: string): LlmProviderEntry | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const baseURL = typeof r.baseURL === "string" ? r.baseURL : "";
  const model = typeof r.model === "string" ? r.model : "";

  // type：v3 的 type → v2 的 provider → 由 baseURL 反查预设 → custom
  let type = String(r.type ?? r.provider ?? "").trim();
  if (!type) type = guessTypeByBaseURL(baseURL);

  // key：v3/v2 用密文；server 旧格式是明文 apiKey，迁移时加密
  let apiKeyEnc = typeof r.apiKeyEnc === "string" ? r.apiKeyEnc : "";
  const plain = typeof r.apiKey === "string" ? r.apiKey.trim() : "";
  if (!apiKeyEnc && plain) apiKeyEnc = encryptKey(plain, file);

  // 迁移时可能既无 key 也无模型（如未填完的条目）：仍保留，交由 UI 补全
  if (!baseURL && !model && !apiKeyEnc && !type) return null;

  const models = normModelList(r.models);
  const nonChat = normModelList(r.nonChat);
  const modelMeta = normalizeModelMeta(r.modelMeta);
  const name = String(r.name ?? "").trim() || autoProviderName(type, model);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newProviderId(),
    name,
    type,
    baseURL,
    model,
    reasoningEffort: normEffort(r.reasoningEffort),
    apiKeyEnc,
    ...(models ? { models } : {}),
    ...(nonChat ? { nonChat } : {}),
    ...(modelMeta ? { modelMeta } : {}),
  };
}

/** 自动展示名：预设名 · 模型 */
export function autoProviderName(type: string, model: string): string {
  const name = llmPreset(type)?.name ?? type ?? "";
  return model ? `${name} · ${model}` : name;
}

const PRESET_NAMES = new Set(
  ["openai", "deepseek", "qwen", "zhipu", "moonshot", "xiaomi", "custom"].map(
    (id) => llmPreset(id)?.name ?? "",
  ),
);

/**
 * 修正历史遗留的陈旧自动名（供应商标签变了、或模型换了但名字没跟上）。
 * 只动「看起来是自动名 / 顶着别家预设标签」的名字，用户自起的名字保留。
 * @returns 是否发生修改
 */
export function fixStaleName(p: LlmProviderEntry): boolean {
  const label = llmPreset(p.type)?.name ?? p.type;
  const fresh = autoProviderName(p.type, p.model);
  if (p.name === fresh) return false;
  const looksAuto =
    p.name === label || p.name.startsWith(`${label} · `) || PRESET_NAMES.has(p.name);
  if (!looksAuto) return false;
  p.name = fresh;
  return true;
}

// ===================== 读 / 写 =====================

function emptyConfig(): LlmConfigFile {
  return { version: 3, activeId: null, providers: [] };
}

/** 规范化列表：按 id 去重（后者覆盖前者）、activeId 回退到首项 */
function normalize(f: LlmConfigFile): LlmConfigFile {
  const byId = new Map<string, LlmProviderEntry>();
  for (const p of f.providers) byId.set(p.id, p);
  const providers = [...byId.values()];
  const activeId = providers.some((p) => p.id === f.activeId)
    ? f.activeId
    : (providers[0]?.id ?? null);
  return { ...f, providers, activeId };
}

/**
 * 读取并规范化一个配置文件。
 * @param file 要读取的文件
 * @param keyFile 主密钥所在配置（迁移时应传**目标**配置：导入的明文 key 要用目标密钥加密）
 */
function readRaw(file: string, keyFile = file): LlmConfigFile | null {
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // v3 / v2：providers 列表
  if (Array.isArray(o.providers)) {
    const providers = o.providers
      .map((x) => parseEntry(x, keyFile))
      .filter((p): p is LlmProviderEntry => p !== null);
    const activeId =
      typeof o.activeId === "string"
        ? o.activeId
        : typeof o.defaultProviderId === "string"
          ? o.defaultProviderId
          : null;
    const migratedFrom = Array.isArray(o.migratedFrom)
      ? o.migratedFrom.filter((x): x is string => typeof x === "string")
      : undefined;
    return normalize({
      version: 3,
      activeId,
      providers,
      ...(migratedFrom ? { migratedFrom } : {}),
    });
  }

  // 更早的「单连接对象」格式
  const single = parseEntry(o, keyFile);
  if (single) return { version: 3, activeId: single.id, providers: [single] };
  return null;
}

/** 把外部配置（如 server 的 node-llm.json）合并进主配置 */
function mergeExternal(
  base: LlmConfigFile,
  file: string,
  targetFile: string,
): { config: LlmConfigFile; changed: boolean } {
  const migrated = base.migratedFrom ?? [];
  if (migrated.includes(file)) return { config: base, changed: false };
  // 用目标配置的主密钥加密导入的明文 key，保证之后能被同一密钥解开
  const ext = readRaw(file, targetFile);
  if (!ext || ext.providers.length === 0) {
    return { config: base, changed: false };
  }
  // 同名 id 保留主配置中的那份；其余追加
  const have = new Set(base.providers.map((p) => p.id));
  const added = ext.providers.filter((p) => !have.has(p.id));
  const config = normalize({
    ...base,
    providers: [...base.providers, ...added],
    activeId: base.activeId ?? ext.activeId,
    migratedFrom: [...migrated, file],
  });
  return { config, changed: true };
}

/**
 * 读取统一配置（含自动迁移）。
 *
 * @param opts.file 配置文件路径（缺省 `llmConfigFile()`）
 * @param opts.legacyFiles 需要合并的旧配置文件（如 `{DATA_DIR}/node-llm.json`），
 *                         仅在主配置尚未记录该来源时导入一次
 */
export function readLlmConfig(opts: { file?: string; legacyFiles?: string[] } = {}): LlmConfigFile {
  const file = opts.file ?? llmConfigFile();
  let f = readRaw(file) ?? emptyConfig();
  let changed = false;

  // 顺手修正陈旧自动名
  // 必须遍历完整个列表：fixStaleName 带副作用，some 命中首个 true 会短路
  if (f.providers.map(fixStaleName).some(Boolean)) changed = true;

  for (const legacy of opts.legacyFiles ?? []) {
    const r = mergeExternal(f, legacy, file);
    f = r.config;
    changed = changed || r.changed;
  }

  // v2 / 单连接 / 合并过旧文件：规范化后落盘固化
  if (changed || !fs.existsSync(file)) writeLlmConfig(f, file);
  return f;
}

/** 写入统一配置（0600） */
export function writeLlmConfig(f: LlmConfigFile, file = llmConfigFile()): void {
  const next = normalize(f);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", {
    mode: 0o600,
    encoding: "utf8",
  });
}

/**
 * 常见的历史配置来源（供迁移合并）：
 * 旧版桌面端内嵌 server 的默认数据目录 `{stateDir}/data/node-llm.json`
 * （现默认目录为 `{stateDir}/.zqagent_data`，此处保留旧路径以便老用户配置被自动接管）。
 * 桌面端与 CLI 同属一个登录用户，这样先配桌面端也能被 CLI 立刻看到。
 */
export function commonLegacyFiles(): string[] {
  return [path.join(stateDir(), "data", "node-llm.json")];
}
