/**
 * Server 侧 MCP 配置加载
 *
 * VM 内 agent server 需要按配置装配 MCP（此前仅 CLI 装配）。来源优先级：
 *   1) 环境变量 MCP_CONFIG_PATH 指向的 JSON（`{servers:[...]}` 或纯数组）
 *      —— 由沙箱 agent 启动器根据 zcode-server 下发的 agent.json.mcpServers 转写
 *   2) 租户配置 tenant.mcpServers
 *   3) WORKSPACE/.agent/mcp.json（与 CLI 约定一致）
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../mcp/McpClient.js";
import type { TenantConfig } from "./types.js";

/** 校验单条配置（name + type 必填） */
function isValidMcpConfig(v: unknown): v is McpServerConfig {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as McpServerConfig).name === "string" &&
    ((v as McpServerConfig).type === "stdio" ||
      (v as McpServerConfig).type === "http")
  );
}

/** 读取配置文件，兼容 `{servers:[...]}` 与纯数组；异常时返回空数组 */
function readConfigFile(file: string | undefined): McpServerConfig[] {
  if (!file) return [];
  try {
    if (!fs.existsSync(file)) return [];
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as { servers?: unknown }).servers)
        ? (raw as { servers: unknown[] }).servers
        : [];
    return list.filter(isValidMcpConfig);
  } catch (err) {
    console.error(`[mcp] 读取配置失败 ${file}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 当前进程是否存在 MCP 配置来源（不依赖租户）
 *
 * 供 /healthz 上报能力：仅当确有配置可加载时才标记支持 MCP，
 * 避免 VM 内实际没有 MCP 时网关误判为已下沉。
 */
export function hasServerMcpConfig(): boolean {
  if (readConfigFile(process.env.MCP_CONFIG_PATH).length > 0) return true;
  const workspace = process.env.WORKSPACE;
  if (!workspace) return false;
  return readConfigFile(path.join(workspace, ".agent", "mcp.json")).length > 0;
}

/** 解析当前进程应装配的 MCP 服务器配置 */
export function loadServerMcpConfigs(tenant: TenantConfig): McpServerConfig[] {
  const fromEnv = readConfigFile(process.env.MCP_CONFIG_PATH);
  if (fromEnv.length > 0) return fromEnv;
  if (Array.isArray(tenant.mcpServers) && tenant.mcpServers.length > 0) {
    return tenant.mcpServers.filter(isValidMcpConfig);
  }
  const workspace = tenant.workspaceRoot ?? process.env.WORKSPACE;
  if (workspace)
    return readConfigFile(path.join(workspace, ".agent", "mcp.json"));
  return [];
}
