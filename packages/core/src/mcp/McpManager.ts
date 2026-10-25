/**
 * MCP 管理器（McpManager）
 *
 * 管理多个 MCP 服务器（stdio / http / sse / builtin）的配置与连接生命周期，
 * 并负责把各服务器的工具动态注入到 ToolRegistry（带 `mcp__<server>__<tool>`
 * 前缀），支持运行时增删改查与刷新 —— 引擎每次请求都实时拉取
 * registry.schemas()，因此工具的注入/替换/移除对下一次 LLM 调用立即生效。
 *
 * 按需加载（lazy）：
 *   当工具总数或 schema 体积超过阈值时，不再全量下发所有 `mcp__*` 工具，
 *   改为下发 `mcp_search_tools`（检索）与 `mcp_call_tool`（调用）两个元工具，
 *   并在检索命中后渐进注册真实工具（下一轮可直接调用）。
 *   小规模场景保持全量注入，行为与旧版一致。
 *
 * 与 AgentRegistry 一致：本类只做内存管理，持久化（如 .agent/mcp.json）
 * 由调用方（CLI / server）负责。
 */

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  McpClient,
  mcpToolKey,
  type McpServerConfig,
  type McpToolInfo,
} from "./McpClient.js";
import type { McpBuiltinContext } from "./builtin/types.js";

/** connectAll / refresh 的结果统计 */
export interface McpConnectResult {
  connected: string[];
  failed: { name: string; error: string }[];
}

/** 按需加载配置 */
export interface McpLazyOptions {
  /** true=强制启用；false=强制关闭；缺省=按阈值自动判断 */
  enabled?: boolean;
  /** 工具数量阈值（默认 16） */
  thresholdTools?: number;
  /** schema 字符数阈值（默认 24000） */
  thresholdChars?: number;
  /** 懒模式下单会话最多自动加载的工具数（默认 40） */
  maxLoaded?: number;
}

/** McpManager 构造选项 */
export interface McpManagerOptions {
  /** 内置服务器上下文（workspace / env / LLM 兜底） */
  builtin?: McpBuiltinContext;
  /** 按需加载配置 */
  lazy?: McpLazyOptions;
}

const LAZY_DEFAULTS: Required<Omit<McpLazyOptions, "enabled">> = {
  thresholdTools: 16,
  thresholdChars: 24_000,
  maxLoaded: 40,
};

/** 懒加载元工具：检索 */
export const MCP_SEARCH_TOOL = "mcp_search_tools";
/** 懒加载元工具：调用 */
export const MCP_CALL_TOOL = "mcp_call_tool";

const META_KEYS = new Set([MCP_SEARCH_TOOL, MCP_CALL_TOOL]);

export class McpManager {
  private registry: ToolRegistry;
  private configs = new Map<string, McpServerConfig>();
  private clients = new Map<string, McpClient>();
  /** server → 已注册到 ToolRegistry 的工具 key 列表 */
  private registeredTools = new Map<string, string[]>();
  /** server → 该服务器提供的全部工具（连接时拉取） */
  private toolIndex = new Map<string, McpToolInfo[]>();
  /** 当前实际注册到 registry 的全部 key（含元工具） */
  private injectedKeys = new Set<string>();
  /** 懒模式下已加载的真实工具 key */
  private loadedKeys = new Set<string>();
  private lazyActive = false;
  private metaRegistered = false;
  private options: McpManagerOptions;

  constructor(
    registry: ToolRegistry,
    configs: McpServerConfig[] = [],
    options: McpManagerOptions = {},
  ) {
    this.registry = registry;
    this.options = options;
    for (const c of configs) this.configs.set(c.name, { ...c });
  }

  /**
   * 更换关联的 ToolRegistry（如 CLI 清空会话后引擎重建）。
   * 会把已连接服务器的工具从旧 registry 卸载、注册到新 registry，
   * 保持连接不中断。
   */
  attach(registry: ToolRegistry): void {
    const old = this.registry;
    for (const k of this.injectedKeys) old.remove(k);
    const previouslyLoaded = new Set(this.loadedKeys);
    this.registry = registry;
    this.injectedKeys.clear();
    this.registeredTools.clear();
    this.loadedKeys.clear();
    this.metaRegistered = false;
    this.applyRegistrationMode();
    if (this.lazyActive) {
      for (const key of previouslyLoaded) this.loadToolByKey(key);
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
  async updateConfig(
    name: string,
    patch: Partial<McpServerConfig>,
  ): Promise<void> {
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
    const configs = [...this.configs.values()].filter(
      (c) => c.enabled !== false,
    );
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
    const client = new McpClient(cfg, { builtin: this.options.builtin });
    await client.connect();
    this.clients.set(name, client);
    this.registerServerTools(name, client);
  }

  /** 断开连接并卸载该服务器注入的工具（保留配置） */
  async disconnectServer(name: string): Promise<void> {
    this.removeServerToolKeys(name);
    this.toolIndex.delete(name);
    const client = this.clients.get(name);
    if (client) {
      await client.close();
      this.clients.delete(name);
    }
    if (this.clients.size === 0) {
      this.removeMetaTools();
      this.lazyActive = false;
    } else {
      this.applyRegistrationMode();
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
    this.removeMetaTools();
  }

  // ===================== 工具查询 =====================

  /** 某服务器注入到 ToolRegistry 的工具 key 列表（懒模式下为已加载的） */
  serverToolKeys(server: string): string[] {
    return [...(this.registeredTools.get(server) ?? [])];
  }

  /** 某服务器提供的工具总数（连接时索引） */
  serverToolTotal(server: string): number {
    return this.toolIndex.get(server)?.length ?? 0;
  }

  /** 全部 MCP 注入的工具 key（不含元工具） */
  allToolKeys(): string[] {
    return [...this.injectedKeys].filter((k) => !META_KEYS.has(k));
  }

  /** 是否处于按需加载模式 */
  isLazyActive(): boolean {
    return this.lazyActive;
  }

  /** 已索引的 MCP 工具总数（连接时） */
  indexedToolCount(): number {
    let n = 0;
    for (const tools of this.toolIndex.values()) n += tools.length;
    return n;
  }

  /** 服务器是否已连接 */
  isConnected(name: string): boolean {
    return this.clients.get(name)?.connected ?? false;
  }

  // ===================== 内部：注册与模式 =====================

  /** 记录服务器工具索引，并按当前模式重建注入 */
  private registerServerTools(server: string, client: McpClient): void {
    this.toolIndex.set(server, client.listTools());
    this.applyRegistrationMode();
  }

  /**
   * 应用注册模式：
   *   - 模式未变化：全量模式下增量重注册；懒模式下只确保元工具存在
   *   - 模式变化：清空后重建（懒模式已加载工具需重新检索，属预期）
   */
  private applyRegistrationMode(): void {
    const shouldLazy = this.shouldUseLazy();
    if (shouldLazy !== this.lazyActive) {
      this.clearInjected();
      this.loadedKeys.clear();
      this.lazyActive = shouldLazy;
    }
    if (this.lazyActive) {
      this.registerMetaTools();
      return;
    }
    for (const [server, tools] of this.toolIndex) {
      const client = this.clients.get(server);
      if (!client) continue;
      this.removeServerToolKeys(server);
      for (const tool of tools) this.registerOneTool(server, tool, client);
    }
  }

  /** 根据配置 / 环境变量 / 阈值判断是否启用按需加载 */
  private shouldUseLazy(): boolean {
    const cfg = this.options.lazy ?? {};
    if (cfg.enabled === true) return true;
    if (cfg.enabled === false) return false;
    const env = (process.env.ZQAGENT_MCP_LAZY ?? "").toLowerCase();
    if (["1", "true", "on", "yes"].includes(env)) return true;
    if (["0", "false", "off", "no"].includes(env)) return false;
    let count = 0;
    let chars = 0;
    for (const tools of this.toolIndex.values()) {
      for (const tool of tools) {
        count += 1;
        chars += JSON.stringify(tool).length;
      }
    }
    return (
      count >= (cfg.thresholdTools ?? LAZY_DEFAULTS.thresholdTools) ||
      chars >= (cfg.thresholdChars ?? LAZY_DEFAULTS.thresholdChars)
    );
  }

  /** 注册单个真实工具 */
  private registerOneTool(
    server: string,
    tool: McpToolInfo,
    client: McpClient,
  ): string {
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
    this.injectedKeys.add(key);
    const keys = this.registeredTools.get(server) ?? [];
    if (!keys.includes(key)) keys.push(key);
    this.registeredTools.set(server, keys);
    return key;
  }

  /** 从 ToolRegistry 卸载某服务器全部工具 */
  private removeServerToolKeys(server: string): void {
    for (const key of this.registeredTools.get(server) ?? []) {
      this.registry.remove(key);
      this.injectedKeys.delete(key);
      this.loadedKeys.delete(key);
    }
    this.registeredTools.delete(server);
  }

  /** 卸载当前注入的全部工具（含元工具） */
  private clearInjected(): void {
    for (const key of this.injectedKeys) this.registry.remove(key);
    this.injectedKeys.clear();
    this.registeredTools.clear();
    this.metaRegistered = false;
  }

  // ===================== 内部：按需加载 =====================

  private registerMetaTools(): void {
    if (this.metaRegistered) return;

    this.registry.register(
      (args) => this.searchTools(args),
      {
        category: "mcp-index",
        riskLevel: "low",
        capabilities: ["search_mcp_tools"],
        requiresApproval: false,
      },
      {
        type: "function",
        function: {
          name: MCP_SEARCH_TOOL,
          description: [
            "搜索已连接的 MCP 服务器工具（当前工具较多，未全量列出）。",
            "当工具列表中缺少所需能力时，先用关键词检索（如 ocr、github、database）；",
            "命中工具会在下一轮出现在工具列表中，也可直接用 mcp_call_tool 调用。",
          ].join(""),
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "关键词（匹配工具名与描述，留空列出全部）",
              },
              server: {
                type: "string",
                description: "只搜索指定 MCP 服务器",
              },
              limit: {
                type: "number",
                description: "返回数量（默认 8，上限 20）",
              },
            },
          },
        },
      },
      "mcp:meta",
    );

    this.registry.register(
      (args) => this.callToolViaMeta(args),
      {
        category: "mcp",
        riskLevel: "high",
        capabilities: ["call_mcp_tool"],
        requiresApproval: true,
      },
      {
        type: "function",
        function: {
          name: MCP_CALL_TOOL,
          description:
            "调用任意已连接的 MCP 工具。name 为 mcp__<server>__<tool> 或工具原名，arguments 为参数对象。",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "工具名（mcp__<server>__<tool> 或原始工具名）",
              },
              arguments: {
                type: "object",
                description: "传给该工具的参数对象",
              },
            },
            required: ["name"],
          },
        },
      },
      "mcp:meta",
    );

    this.injectedKeys.add(MCP_SEARCH_TOOL);
    this.injectedKeys.add(MCP_CALL_TOOL);
    this.metaRegistered = true;
  }

  private removeMetaTools(): void {
    for (const key of META_KEYS) {
      this.registry.remove(key);
      this.injectedKeys.delete(key);
    }
    this.metaRegistered = false;
  }

  /** 懒模式：加载单个工具到 registry（受 maxLoaded 限制） */
  private loadTool(server: string, tool: McpToolInfo): boolean {
    const key = mcpToolKey(server, tool.name);
    if (this.injectedKeys.has(key)) return false;
    const client = this.clients.get(server);
    if (!client) return false;
    const maxLoaded =
      this.options.lazy?.maxLoaded ?? LAZY_DEFAULTS.maxLoaded;
    if (this.loadedKeys.size >= maxLoaded) return false;
    this.registerOneTool(server, tool, client);
    this.loadedKeys.add(key);
    return true;
  }

  private loadToolByKey(key: string): boolean {
    for (const [server, tools] of this.toolIndex) {
      for (const tool of tools) {
        if (mcpToolKey(server, tool.name) === key) {
          this.loadedKeys.delete(key);
          return this.loadTool(server, tool);
        }
      }
    }
    return false;
  }

  /** mcp_search_tools 实现 */
  private searchTools(args: Record<string, unknown>): string {
    const query = String(args.query ?? "").trim().toLowerCase();
    const serverFilter =
      typeof args.server === "string" ? args.server.trim() : "";
    const rawLimit = Number(args.limit ?? 8);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(20, Math.max(1, Math.trunc(rawLimit)))
      : 8;
    const terms = query.split(/\s+/).filter(Boolean);

    const matches: {
      server: string;
      tool: McpToolInfo;
      score: number;
    }[] = [];
    for (const [server, tools] of this.toolIndex) {
      if (serverFilter && server !== serverFilter) continue;
      for (const tool of tools) {
        const name = tool.name.toLowerCase();
        const desc = (tool.description ?? "").toLowerCase();
        let score = 0;
        if (!query) score = 1;
        else if (name === query) score = 100;
        else if (name.includes(query)) score = 50;
        else if (desc.includes(query)) score = 20;
        else if (
          terms.length > 0 &&
          terms.every((t) => name.includes(t) || desc.includes(t))
        )
          score = 10;
        else if (
          terms.some(
            (t) => t.length > 1 && (name.includes(t) || desc.includes(t)),
          )
        )
          score = 5;
        if (score > 0) matches.push({ server, tool, score });
      }
    }
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        a.server.localeCompare(b.server) ||
        a.tool.name.localeCompare(b.tool.name),
    );

    const page = matches.slice(0, limit);
    const loaded: string[] = [];
    for (const m of page.slice(0, Math.min(limit, 8))) {
      const key = mcpToolKey(m.server, m.tool.name);
      if (!this.injectedKeys.has(key) && this.loadTool(m.server, m.tool)) {
        loaded.push(key);
      }
    }

    return JSON.stringify(
      {
        total: matches.length,
        lazy: this.lazyActive,
        loaded,
        tools: page.map((m) => {
          const key = mcpToolKey(m.server, m.tool.name);
          return {
            name: key,
            server: m.server,
            tool: m.tool.name,
            description: m.tool.description ?? "",
            parameters: m.tool.inputSchema,
            loaded: this.injectedKeys.has(key),
          };
        }),
      },
      null,
      2,
    );
  }

  /** 按名称查找工具（完整 key / 原始名 / server/tool） */
  private findTool(
    name: string,
  ): { server: string; tool: McpToolInfo } | null {
    for (const [server, tools] of this.toolIndex) {
      for (const tool of tools) {
        if (mcpToolKey(server, tool.name) === name) return { server, tool };
      }
    }
    if (!name.includes("__")) {
      const sep = name.includes("/") ? "/" : null;
      const [serverPart, toolPart] = sep
        ? [name.slice(0, name.indexOf(sep)), name.slice(name.indexOf(sep) + 1)]
        : ["", name];
      const hits: { server: string; tool: McpToolInfo }[] = [];
      for (const [server, tools] of this.toolIndex) {
        if (serverPart && server !== serverPart) continue;
        for (const tool of tools) {
          if (tool.name === toolPart) hits.push({ server, tool });
        }
      }
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) {
        const loaded = hits.find((h) =>
          this.injectedKeys.has(mcpToolKey(h.server, h.tool.name)),
        );
        return loaded ?? null;
      }
    }
    return null;
  }

  /** mcp_call_tool 实现 */
  private async callToolViaMeta(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { error: "缺少 name 参数", isError: true };
    }
    const hit = this.findTool(name);
    if (!hit) {
      return {
        error: `未找到 MCP 工具 "${name}"。请先调用 ${MCP_SEARCH_TOOL} 检索可用工具。`,
        isError: true,
      };
    }
    const client = this.clients.get(hit.server);
    if (!client?.connected) {
      return { error: `MCP server "${hit.server}" 未连接`, isError: true };
    }
    const callArgs =
      args.arguments &&
      typeof args.arguments === "object" &&
      !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    return client.callTool(hit.tool.name, callArgs);
  }
}
