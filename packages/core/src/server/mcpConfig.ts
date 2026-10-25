/**
 * Server 侧 MCP 配置加载 / 维护
 *
 * VM 内 agent server 需要按配置装配 MCP（此前仅 CLI 装配）。来源优先级：
 *   1) 环境变量 MCP_CONFIG_PATH 指向的 JSON（支持裸数组 / {servers} / {mcpServers}）
 *      —— 由沙箱 agent 启动器根据 zcode-server 下发的 agent.json.mcpServers 转写
 *   2) 租户配置 tenant.mcpServers
 *   3) WORKSPACE/.agent/mcp.json（与 CLI 约定一致）
 *
 * 解析逻辑与 CLI 共用 mcp/config.ts；内置服务器（OCR）始终追加，
 * 可用同名配置 { name: "ocr", enabled: false } 关闭。
 *
 * 维护（控制台设置页）：只有「工作区文件」这一来源可写；env / 租户下发的
 * 配置由平台接管，写接口返回只读错误。写入沿用 CLI 的同一份
 * `<workspace>/.agent/mcp.json`，因此控制台与 CLI 互见。
 */

import path from "node:path";
import { McpClient, type McpServerConfig, type McpTransportType } from "../mcp/McpClient.js";
import {
  BUILTIN_MCP_CONFIGS,
  normalizeMcpConfig,
  normalizeMcpConfigs,
  readMcpConfigFile,
  saveMcpConfigFile,
  withBuiltinMcpConfigs,
} from "../mcp/config.js";
import { listBuiltinServers } from "../mcp/builtin/index.js";
import type { TenantConfig } from "./types.js";

/** MCP 配置来源 */
export type McpConfigSource = "env" | "tenant" | "workspace" | "builtin";

/** 控制台展示 / 编辑用的 MCP 条目 */
export interface McpInfoView {
  name: string;
  type: McpTransportType;
  url?: string;
  /** 展示用：stdio 启动命令拼接成一行 */
  command?: string;
  /** 编辑回填：stdio 启动命令参数 */
  commandArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  builtin?: string;
  /** 该条目的配置来源 */
  source: McpConfigSource;
  /** 是否允许在控制台编辑（平台接管时为 false） */
  editable: boolean;
  /** 是否允许删除（内置服务器只能禁用） */
  removable: boolean;
  /** 只读原因（平台接管时给出） */
  readonlyReason?: string;
}

/** 当前项目的 MCP 配置视图 */
export interface ServerMcpInspection {
  configs: McpServerConfig[];
  items: McpInfoView[];
  source: Exclude<McpConfigSource, "builtin"> | "builtin";
  editable: boolean;
  /** 只读原因（editable=false 时给出） */
  reason?: string;
  configPath?: string;
  warnings: string[];
}

/** 写接口可回报的错误（路由层转 ApiError） */
export class McpConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 读取配置文件（静默：/healthz 探针会频繁调用，不刷日志） */
function readConfigFile(file: string | undefined): McpServerConfig[] {
  return readMcpConfigFile(file).configs;
}

/** 项目工作区（租户显式设置，否则进程 WORKSPACE） */
function workspaceOf(tenant: TenantConfig): string | undefined {
  return tenant.workspaceRoot ?? process.env.WORKSPACE;
}

/** 项目配置文件路径 */
export function serverMcpConfigPath(
  tenant: TenantConfig,
): string | undefined {
  const workspace = workspaceOf(tenant);
  return workspace ? path.join(workspace, ".agent", "mcp.json") : undefined;
}

/** 单个配置 → 展示条目 */
export function toMcpInfo(
  config: McpServerConfig,
  source: McpConfigSource,
  opts: { editable: boolean; readonlyReason?: string },
): McpInfoView {
  const builtin = config.type === "builtin";
  return {
    name: config.name,
    type: config.type,
    url: config.type === "stdio" || builtin ? undefined : config.url,
    command:
      config.type === "stdio" ? (config.command ?? []).join(" ") : undefined,
    commandArgs:
      config.type === "stdio" ? [...(config.command ?? [])] : undefined,
    cwd: config.type === "stdio" ? config.cwd : undefined,
    env: config.type === "stdio" ? config.env : undefined,
    headers:
      config.type === "stdio" || builtin ? undefined : config.headers,
    enabled: config.enabled !== false,
    builtin: builtin ? (config.builtin ?? config.name) : undefined,
    source,
    editable: opts.editable,
    removable: !builtin,
    readonlyReason: opts.readonlyReason,
  };
}

/**
 * 当前项目的 MCP 配置来源与可编辑性。
 *
 * 与 loadServerMcpConfigs 的优先级判断保持一致：env 有有效条目即接管，
 * 其次 tenant.mcpServers，最后才是工作区文件。
 */
export function inspectServerMcpConfigs(
  tenant: TenantConfig,
): ServerMcpInspection {
  const fromEnv = readMcpConfigFile(process.env.MCP_CONFIG_PATH);
  if (fromEnv.configs.length > 0) {
    const reason = "MCP 配置由环境变量 MCP_CONFIG_PATH 下发，无法在控制台修改";
    const merged = withBuiltinMcpConfigs(fromEnv.configs);
    return {
      configs: merged,
      items: merged.map((c) =>
        toMcpInfo(c, c.type === "builtin" ? "builtin" : "env", {
          editable: false,
          readonlyReason: reason,
        }),
      ),
      source: "env",
      editable: false,
      reason,
      configPath: process.env.MCP_CONFIG_PATH,
      warnings: fromEnv.warnings,
    };
  }

  if (Array.isArray(tenant.mcpServers) && tenant.mcpServers.length > 0) {
    const reason = "MCP 配置由平台下发，无法在控制台修改";
    const normalized = normalizeMcpConfigs(tenant.mcpServers);
    const merged = withBuiltinMcpConfigs(normalized.configs);
    return {
      configs: merged,
      items: merged.map((c) =>
        toMcpInfo(c, c.type === "builtin" ? "builtin" : "tenant", {
          editable: false,
          readonlyReason: reason,
        }),
      ),
      source: "tenant",
      editable: false,
      reason,
      warnings: normalized.warnings,
    };
  }

  const file = serverMcpConfigPath(tenant);
  const fromFile = readMcpConfigFile(file);
  const merged = withBuiltinMcpConfigs(fromFile.configs);
  return {
    configs: merged,
    items: merged.map((c) =>
      toMcpInfo(c, c.type === "builtin" ? "builtin" : "workspace", {
        editable: true,
      }),
    ),
    source: merged.some((c) => c.type !== "builtin") ? "workspace" : "builtin",
    editable: true,
    configPath: file,
    warnings: fromFile.warnings,
  };
}

/** 校验并归一化待保存的服务器列表 */
function normalizeForSave(
  raw: unknown,
): { configs: McpServerConfig[]; warnings: string[] } {
  const { configs, warnings } = normalizeMcpConfigs(raw);
  const dropped = warnings.filter(
    (w) => w.includes("已跳过") || w.includes("重复"),
  );
  if (dropped.length > 0) {
    throw new McpConfigError(
      400,
      "invalid_mcp_config",
      dropped.join("；"),
    );
  }
  for (const c of configs) {
    if (c.type === "builtin" && !listBuiltinServers().includes(c.builtin ?? c.name)) {
      throw new McpConfigError(
        400,
        "invalid_mcp_config",
        `未知的内置 MCP server "${c.builtin ?? c.name}"（可用: ${listBuiltinServers().join(", ")}）`,
      );
    }
    if (c.type === "stdio" && (c.command ?? []).length === 0) {
      throw new McpConfigError(
        400,
        "invalid_mcp_config",
        `MCP "${c.name}" 缺少启动命令`,
      );
    }
    if ((c.type === "http" || c.type === "sse") && !c.url) {
      throw new McpConfigError(
        400,
        "invalid_mcp_config",
        `MCP "${c.name}" 缺少 URL`,
      );
    }
  }
  return { configs, warnings };
}

/** 内置服务器缺失时补一条禁用项（删除等价于禁用，而不是让它消失） */
function keepBuiltinEntries(configs: McpServerConfig[]): McpServerConfig[] {
  const names = new Set(configs.map((c) => c.name));
  const missing = BUILTIN_MCP_CONFIGS.filter((b) => !names.has(b.name)).map(
    (b) => ({ ...b, enabled: false }),
  );
  return missing.length > 0 ? [...configs, ...missing] : configs;
}

/**
 * 保存配置（整体替换）。
 * @throws McpConfigError 只读来源 / 缺少工作区 / 条目非法
 */
export function saveServerMcpConfigs(
  tenant: TenantConfig,
  raw: unknown,
): ServerMcpInspection {
  const current = inspectServerMcpConfigs(tenant);
  if (!current.editable) {
    throw new McpConfigError(409, "mcp_config_readonly", current.reason ?? "MCP 配置为只读");
  }
  const workspace = workspaceOf(tenant);
  if (!workspace) {
    throw new McpConfigError(
      400,
      "workspace_required",
      "该项目尚未设置工作目录，无法保存 MCP 配置",
    );
  }

  const { configs, warnings } = normalizeForSave(raw);
  const next = keepBuiltinEntries(configs);
  const file = path.join(workspace, ".agent", "mcp.json");
  try {
    saveMcpConfigFile(file, next);
  } catch (err) {
    throw new McpConfigError(
      500,
      "mcp_config_write_failed",
      `写入 MCP 配置失败: ${(err as Error).message}`,
    );
  }

  const inspection = inspectServerMcpConfigs(tenant);
  return { ...inspection, warnings: [...warnings, ...inspection.warnings] };
}

/** 连接测试结果 */
export interface McpTestResult {
  ok: boolean;
  tools: string[];
  error?: string;
}

/**
 * 当前进程是否存在显式 MCP 配置来源（不依赖租户）
 *
 * 供 /healthz 上报能力：仅当确有外部配置可加载时才标记支持 MCP，
 * 避免 VM 内实际没有 MCP 时网关误判为已下沉。内置 OCR 不计入该判断。
 */
export function hasServerMcpConfig(): boolean {
  if (readConfigFile(process.env.MCP_CONFIG_PATH).length > 0) return true;
  const workspace = process.env.WORKSPACE;
  if (!workspace) return false;
  return readConfigFile(path.join(workspace, ".agent", "mcp.json")).length > 0;
}

/** 解析当前进程应装配的 MCP 服务器配置 */
export function loadServerMcpConfigs(tenant: TenantConfig): McpServerConfig[] {
  const { configs, warnings } = inspectServerMcpConfigs(tenant);
  for (const w of warnings) console.error(`[mcp] ${w}`);
  return configs;
}

const TEST_TIMEOUT_MS = 15_000;

/**
 * 连接测试：临时建立一次 MCP 连接并拉取工具列表。
 * 不影响运行中的会话（会话每轮按需新建 McpManager）。
 */
export async function testServerMcpConfig(
  tenant: TenantConfig,
  raw: unknown,
): Promise<McpTestResult> {
  const config = normalizeMcpConfig(raw);
  if (!config) {
    return { ok: false, tools: [], error: "MCP 配置无法解析（需要 name 与 command/url）" };
  }
  if (config.type === "builtin" && !listBuiltinServers().includes(config.builtin ?? config.name)) {
    return {
      ok: false,
      tools: [],
      error: `未知的内置 MCP server "${config.builtin ?? config.name}"`,
    };
  }

  const workspace = workspaceOf(tenant);
  const provider = tenant.provider ?? {};
  const client = new McpClient(config, {
    builtin: {
      workspace,
      env: process.env,
      llm: provider.apiKey
        ? {
            apiKey: provider.apiKey,
            baseURL: provider.baseURL,
            model: tenant.model,
          }
        : undefined,
    },
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`连接超时（${TEST_TIMEOUT_MS / 1000}s）`)),
          TEST_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, tools: client.listTools().map((t) => t.name) };
  } catch (err) {
    return { ok: false, tools: [], error: (err as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close();
  }
}
