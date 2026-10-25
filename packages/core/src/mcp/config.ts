/**
 * MCP 配置解析与持久化（CLI / server 共用）
 *
 * 支持多种来源格式，避免「拷一份别人的配置进来却静默失效」：
 *   - 裸数组：[{ name, type, command|url, ... }]
 *   - { servers: [...] } / { servers: { name: {...} } }
 *   - { mcpServers: [...] } / { mcpServers: { name: {...} } }（Claude Desktop / Cursor）
 *
 * 单条配置容错：
 *   - 省略 type 时按 builtin / url / command 推断
 *   - Claude 风格 command(string) + args(string[]) 合并为 command: string[]
 *   - env/headers 值允许数字与布尔（转字符串）
 *   - 字符串中的 ${VAR} / ${env:VAR} 用进程环境变量展开
 *
 * 内置服务器（如 OCR）默认追加：用户配置中存在同名条目时以用户条目为准，
 * 因此可以用 { name: "ocr", enabled: false } 关闭内置能力。
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig, McpTransportType } from "./McpClient.js";

/** 归一化结果 */
export interface McpConfigNormalizeResult {
  configs: McpServerConfig[];
  warnings: string[];
}

/** 归一化选项 */
export interface McpConfigNormalizeOptions {
  /** 环境变量（默认 process.env），用于 ${VAR} 展开 */
  env?: NodeJS.ProcessEnv;
}

const TRANSPORT_TYPES: ReadonlySet<string> = new Set([
  "stdio",
  "http",
  "sse",
  "builtin",
]);

/** 内置 MCP 服务器默认配置（用户同名配置优先） */
export const BUILTIN_MCP_CONFIGS: ReadonlyArray<McpServerConfig> = [
  { name: "ocr", type: "builtin", builtin: "ocr", enabled: true },
];

/** 工作区默认配置文件路径 */
export function defaultMcpConfigPath(workspace: string): string {
  return path.join(workspace, ".agent", "mcp.json");
}

/**
 * 拆分 shell 风格命令行（支持单/双引号与反斜杠转义）。
 * 用于兼容 `command: "npx -y some-server"` 这类单字符串写法。
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += "\\";
  if (cur) out.push(cur);
  return out;
}

function expandEnv(
  value: string,
  env: NodeJS.ProcessEnv,
  name: string,
  warnings: string[],
): string {
  return value.replace(
    /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_m, key: string) => {
      const v = env[key];
      if (v === undefined) {
        warnings.push(`"${name}" 引用了未定义的环境变量 \${${key}}`);
        return "";
      }
      return v;
    },
  );
}

function toStringMap(
  raw: unknown,
  field: string,
  name: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`"${name}".${field} 应为对象，已忽略`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = expandEnv(v, env, name, warnings);
    else if (typeof v === "number" || typeof v === "boolean")
      out[k] = String(v);
    else warnings.push(`"${name}".${field}.${k} 不是字符串，已忽略`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 归一化单条 MCP 配置。
 * @param raw 原始条目（数组元素或 mcpServers 映射的值）
 * @param fallbackName mcpServers 映射的键名
 * @returns 合法配置；无法解析时返回 null（原因写入 warnings）
 */
export function normalizeMcpConfig(
  raw: unknown,
  fallbackName?: string,
  opts: McpConfigNormalizeOptions = {},
  warnings: string[] = [],
): McpServerConfig | null {
  const env = opts.env ?? process.env;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`MCP 配置条目${fallbackName ? ` "${fallbackName}"` : ""} 不是对象，已跳过`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const name =
    typeof o.name === "string" && o.name.trim()
      ? o.name.trim()
      : fallbackName?.trim();
  if (!name) {
    warnings.push("MCP 配置缺少 name，已跳过");
    return null;
  }

  const rawType = typeof o.type === "string" ? o.type.toLowerCase() : "";
  let type: McpTransportType | undefined;
  if (TRANSPORT_TYPES.has(rawType)) type = rawType as McpTransportType;
  else if (rawType === "streamable-http" || rawType === "streamablehttp")
    type = "http";
  else if (typeof o.builtin === "string") type = "builtin";
  else if (typeof o.url === "string")
    type = /\/sse(?:[?#]|$)/i.test(o.url) ? "sse" : "http";
  else if (o.command !== undefined) type = "stdio";

  if (!type) {
    warnings.push(`MCP "${name}" 无法推断传输类型（需要 builtin/command/url）`);
    return null;
  }

  const enabled =
    o.enabled === false || o.disabled === true ? false : true;
  const config: McpServerConfig = { name, type, enabled };

  if (type === "stdio") {
    const command: string[] = [];
    if (Array.isArray(o.command)) {
      for (const part of o.command) {
        if (typeof part === "string") command.push(part);
        else warnings.push(`MCP "${name}" 的 command 含非字符串项，已忽略`);
      }
    } else if (typeof o.command === "string") {
      command.push(...splitCommandLine(o.command));
    }
    if (Array.isArray(o.args)) {
      for (const part of o.args) {
        if (typeof part === "string") command.push(part);
        else warnings.push(`MCP "${name}" 的 args 含非字符串项，已忽略`);
      }
    } else if (typeof o.args === "string") {
      command.push(...splitCommandLine(o.args));
    }
    if (command.length === 0) {
      warnings.push(`MCP "${name}" 缺少 command，已跳过`);
      return null;
    }
    config.command = command.map((c) => expandEnv(c, env, name, warnings));
    if (typeof o.cwd === "string" && o.cwd.trim())
      config.cwd = expandEnv(o.cwd, env, name, warnings);
    const stdioEnv = toStringMap(o.env, "env", name, env, warnings);
    if (stdioEnv) config.env = stdioEnv;
  } else if (type === "builtin") {
    config.builtin =
      typeof o.builtin === "string" && o.builtin.trim()
        ? o.builtin.trim()
        : name;
  } else {
    if (typeof o.url !== "string" || !o.url.trim()) {
      warnings.push(`MCP "${name}" 缺少 url，已跳过`);
      return null;
    }
    config.url = expandEnv(o.url.trim(), env, name, warnings);
    const headers = toStringMap(o.headers, "headers", name, env, warnings);
    if (headers) config.headers = headers;
  }

  return config;
}

/** 归一化任意受支持的配置形状 */
export function normalizeMcpConfigs(
  raw: unknown,
  opts: McpConfigNormalizeOptions = {},
): McpConfigNormalizeResult {
  const warnings: string[] = [];
  const configs: McpServerConfig[] = [];

  const add = (item: unknown, fallbackName?: string): void => {
    const cfg = normalizeMcpConfig(item, fallbackName, opts, warnings);
    if (!cfg) return;
    const idx = configs.findIndex((c) => c.name === cfg.name);
    if (idx >= 0) {
      warnings.push(`MCP "${cfg.name}" 重复出现，后者覆盖前者`);
      configs[idx] = cfg;
    } else {
      configs.push(cfg);
    }
  };

  if (Array.isArray(raw)) {
    for (const item of raw) add(item);
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const objectMap = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        add(v, k);
      return true;
    };
    if (Array.isArray(o.servers)) {
      for (const item of o.servers) add(item);
    } else if (Array.isArray(o.mcpServers)) {
      for (const item of o.mcpServers) add(item);
    } else if (objectMap(o.mcpServers)) {
      // Claude Desktop / Cursor: { mcpServers: { name: { command, args } } }
    } else if (objectMap(o.servers)) {
      // { servers: { name: {...} } }
    } else {
      // 单条配置对象
      add(o);
    }
  } else {
    warnings.push("MCP 配置必须是 JSON 对象或数组");
  }

  return { configs, warnings };
}

/**
 * 读取配置文件并归一化。文件不存在时返回空结果（不视为错误）。
 * @param file 配置文件路径；未提供时返回空结果
 */
export function readMcpConfigFile(
  file: string | undefined,
  opts: McpConfigNormalizeOptions = {},
): McpConfigNormalizeResult {
  if (!file) return { configs: [], warnings: [] };
  try {
    if (!fs.existsSync(file)) return { configs: [], warnings: [] };
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeMcpConfigs(raw, opts);
  } catch (err) {
    return {
      configs: [],
      warnings: [`读取 MCP 配置失败 ${file}: ${(err as Error).message}`],
    };
  }
}

/** 保存配置（统一写为数组格式，自动创建目录） */
export function saveMcpConfigFile(
  file: string,
  configs: McpServerConfig[],
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      configs.map((c) => JSON.parse(JSON.stringify(c)) as McpServerConfig),
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/** 追加内置默认配置（同名用户配置优先） */
export function withBuiltinMcpConfigs(
  configs: McpServerConfig[],
): McpServerConfig[] {
  const existing = new Set(configs.map((c) => c.name));
  const builtin = BUILTIN_MCP_CONFIGS.filter((c) => !existing.has(c.name)).map(
    (c) => ({ ...c }),
  );
  return [...configs, ...builtin];
}

/** 读取配置文件并追加内置默认配置 */
export function loadMcpConfigFile(
  file: string | undefined,
  opts: McpConfigNormalizeOptions = {},
): McpConfigNormalizeResult {
  const result = readMcpConfigFile(file, opts);
  return { configs: withBuiltinMcpConfigs(result.configs), warnings: result.warnings };
}
