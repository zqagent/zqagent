/**
 * MCP 管理器（McpManager）
 *
 * 管理多个 MCP 服务器（stdio / http）的配置与连接生命周期，
 * 并负责把各服务器的工具动态注入到 ToolRegistry（带 `mcp__<server>__<tool>`
 * 前缀），支持运行时增删改查与刷新 —— 引擎每次请求都实时拉取
 * registry.schemas()，因此工具的注入/替换/移除对下一次 LLM 调用立即生效。
 *
 * 与 AgentRegistry 一致：本类只做内存管理，持久化（如 .agent/mcp.json）
 * 由调用方（CLI）负责。
 */

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { McpClient, mcpToolKey, type McpServerConfig } from "./McpClient.js";

/** connectAll / refresh 的结果统计 */
export interface McpConnectResult {
  connected: string[];
  failed: { name: string; error: string }[];
}

export class McpManager {
  private registry: ToolRegistry;
  private configs = new Map<string, McpServerConfig>();
  private clients = new Map<string, McpClient>();
  /** server → 已注册到 ToolRegistry 的工具 key 列表 */
  private registeredTools = new Map<string, string[]>();

  constructor(registry: ToolRegistry, configs: McpServerConfig[] = []) {
    this.registry = registry;
    for (const c of configs) this.configs.set(c.name, { ...c });
  }

  /**
   * 更换关联的 ToolRegistry（如 CLI 清空会话后引擎重建）。
   * 会把已连接服务器的工具从旧 registry 卸载、注册到新 registry，
   * 保持连接不中断。
   */
  attach(registry: ToolRegistry): void {
    const old = this.registry;
    for (const keys of this.registeredTools.values()) {
      for (const k of keys) old.remove(k);
    }
    this.registry = registry;
    for (const [server, client] of this.clients) {
      this.registerServerTools(server, client);
    }
  }

  // ===================== 配置管理 =====================

  /** 全部服务器配置（副本） */
  listConfigs(): McpServerConfig[] {
    return [...this.configs.values()].map((c) => ({ ...c }));
  }

  getConfig(name: string): McpServerConfig | undefined {
    const c = this.configs.get(name);
    return c ? { ...c } : undefined;
  }

  hasConfig(name: string): boolean {
    return this.configs.has(name);
  }

  /**
   * 添加服务器配置；enabled（默认）时立即连接并注入工具。
   * 同名已存在时抛错。
   */
  async addConfig(config: McpServerConfig): Promise<void> {
    if (this.configs.has(config.name)) {
      throw new Error(`MCP server "${config.name}" 已存在`);
    }
    this.configs.set(config.name, { ...config });
    if (config.enabled !== false) {
      await this.connectServer(config.name);
    }
  }

  /**
   * 更新配置：断开旧连接 → 应用补丁 → enabled 时重连并重新注入工具。
   */
  async updateConfig(name: string, patch: Partial<McpServerConfig>): Promise<void> {
    const cur = this.configs.get(name);
    if (!cur) throw new Error(`MCP server "${name}" 不存在`);
    await this.disconnectServer(name);
    this.configs.set(name, { ...cur, ...patch, name });
    if (patch.enabled !== false && this.configs.get(name)!.enabled !== false) {
      await this.connectServer(name);
    }
  }

  /** 移除配置：断开连接、卸载工具、删除配置。@returns 是否移除成功 */
  async removeConfig(name: string): Promise<boolean> {
    if (!this.configs.has(name)) return false;
    await this.disconnectServer(name);
    this.configs.delete(name);
    return true;
  }

  /** 启用 / 禁用服务器（禁用=断开并卸载工具；启用=连接并注入工具） */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`MCP server "${name}" 不存在`);
    cfg.enabled = enabled;
    if (enabled) {
      await this.connectServer(name);
    } else {
      await this.disconnectServer(name);
    }
  }

  // ===================== 连接生命周期 =====================

  /** 连接全部 enabled 服务器并注入工具；单个失败不中断整体，返回统计 */
  async connectAll(): Promise<McpConnectResult> {
    const result: McpConnectResult = { connected: [], failed: [] };
    // 并行连接：避免慢服务器（如 npx 首次下载的 MCP）串行阻塞其它服务器，
    // 使快的服务器（如内置 OCR）能尽早注册工具、进入首个 LLM 请求的工具列表。
    const configs = [...this.configs.values()].filter((c) => c.enabled !== false);
    await Promise.all(
      configs.map(async (cfg) => {
        try {
          await this.connectServer(cfg.name);
          result.connected.push(cfg.name);
        } catch (err) {
          result.failed.push({ name: cfg.name, error: String(err) });
        }
      }),
    );
    return result;
  }

  /** 连接单个服务器（已连接则跳过）并注入其工具 */
  async connectServer(name: string): Promise<void> {
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`MCP server "${name}" 不存在`);
    const existing = this.clients.get(name);
    if (existing?.connected) return;
    const client = new McpClient(cfg);
    await client.connect();
    this.clients.set(name, client);
    this.registerServerTools(name, client);
  }

  /** 断开连接并卸载该服务器注入的工具（保留配置） */
  async disconnectServer(name: string): Promise<void> {
    this.unregisterServerTools(name);
    const client = this.clients.get(name);
    if (client) {
      await client.close();
      this.clients.delete(name);
    }
  }

  /**
   * 刷新工具列表：断开 → 重连 → 重新注入（运行时变更工具列表）。
   * name 缺省时刷新全部 enabled 服务器。
   */
  async refresh(name?: string): Promise<McpConnectResult> {
    const targets = name ? [name] : [...this.configs.keys()];
    const result: McpConnectResult = { connected: [], failed: [] };
    for (const n of targets) {
      const cfg = this.configs.get(n);
      if (!cfg || cfg.enabled === false) continue;
      try {
        await this.disconnectServer(n);
        await this.connectServer(n);
        result.connected.push(n);
      } catch (err) {
        result.failed.push({ name: n, error: String(err) });
      }
    }
    return result;
  }

  /** 关闭全部连接并卸载全部 MCP 工具 */
  async closeAll(): Promise<void> {
    for (const name of [...this.configs.keys()]) {
      await this.disconnectServer(name);
    }
  }

  // ===================== 工具查询 =====================

  /** 某服务器注入到 ToolRegistry 的工具 key 列表 */
  serverToolKeys(server: string): string[] {
    return [...(this.registeredTools.get(server) ?? [])];
  }

  /** 全部 MCP 注入的工具 key */
  allToolKeys(): string[] {
    return [...this.registeredTools.values()].flat();
  }

  /** 服务器是否已连接 */
  isConnected(name: string): boolean {
    return this.clients.get(name)?.connected ?? false;
  }

  // ===================== 内部 =====================

  /** 把某服务器全部工具注册到 ToolRegistry（带 mcp__ 前缀，同名替换） */
  private registerServerTools(server: string, client: McpClient): void {
    const keys: string[] = [];
    for (const tool of client.listTools()) {
      const key = mcpToolKey(server, tool.name);
      const params =
        tool.inputSchema &&
        typeof tool.inputSchema === "object" &&
        (tool.inputSchema as { type?: unknown }).type === "object"
          ? tool.inputSchema
          : { type: "object", properties: tool.inputSchema ?? {} };
      this.registry.register(
        (args) => client.callTool(tool.name, args ?? {}),
        {
          category: "mcp",
          riskLevel: "high",
          capabilities: [tool.name],
          requiresApproval: true,
        },
        {
          type: "function",
          function: {
            name: key,
            description: tool.description ?? `MCP 工具 ${server}/${tool.name}`,
            parameters: params,
          },
        },
        `mcp:${server}`,
      );
      keys.push(key);
    }
    this.registeredTools.set(server, keys);
  }

  /** 从 ToolRegistry 卸载某服务器全部工具 */
  private unregisterServerTools(server: string): void {
    for (const key of this.registeredTools.get(server) ?? []) {
      this.registry.remove(key);
    }
    this.registeredTools.delete(server);
  }
}
