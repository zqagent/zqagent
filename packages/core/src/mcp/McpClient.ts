/**
 * MCP 客户端（McpClient）
 *
 * 基于 @modelcontextprotocol/sdk 封装单个 MCP 服务器的连接与工具调用，
 * 支持两种传输：
 *   - stdio：本地子进程（如 `npx -y @some/mcp-server`）
 *   - http ：远程 streamable HTTP 端点
 *
 * 提供工具列表拉取、工具调用（结果归一化为文本）、连接生命周期管理，
 * 以及 OpenAI 工具名兼容的命名工具（sanitize + 前缀）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** MCP 服务器配置 */
export interface McpServerConfig {
  /** 服务器名称（唯一标识，也是注册到 ToolRegistry 的工具名前缀） */
  name: string;
  /** 传输类型：stdio=本地子进程 / http=远程端点 */
  type: "stdio" | "http";
  /** stdio 传输：启动命令，如 ["npx","-y","@modelcontextprotocol/server-filesystem","/tmp"] */
  command?: string[];
  /** http 传输：远程端点 URL */
  url?: string;
  /** http 传输：自定义请求头（如 Authorization） */
  headers?: Record<string, string>;
  /** stdio 传输：子进程环境变量 */
  env?: Record<string, string>;
  /** 是否启用（默认 true；禁用时不连接、不注册工具） */
  enabled?: boolean;
}

/** 从服务器拉取到的单个工具信息 */
export interface McpToolInfo {
  /** 原始工具名（未加前缀） */
  name: string;
  description?: string;
  /** JSON Schema 参数定义 */
  inputSchema: Record<string, unknown>;
}

/**
 * 工具名净化：OpenAI 工具名仅允许 [a-zA-Z0-9_-]，
 * 其余字符替换为 `_` 并截断到 maxLen。
 * 净化后不含任何字母/数字（纯符号）时回退为 "tool"。
 */
export function sanitizeToolName(name: string, maxLen = 60): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/[a-zA-Z0-9]/.test(cleaned)) return "tool";
  return cleaned.slice(0, maxLen);
}

/**
 * 注册到 ToolRegistry 的完整工具键：
 * `mcp__<server>__<tool>`（server 与 tool 均净化，避免冲突与非法字符）
 */
export function mcpToolKey(server: string, tool: string): string {
  const s = sanitizeToolName(server, 24);
  const t = sanitizeToolName(tool, 34);
  return `mcp__${s}__${t}`;
}

export class McpClient {
  readonly config: McpServerConfig;
  private client: Client | null = null;
  private transport: { close(): Promise<void> } | null = null;
  private _tools: McpToolInfo[] = [];

  constructor(config: McpServerConfig) {
    this.config = { ...config };
  }

  get name(): string {
    return this.config.name;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /**
   * 建立连接并拉取工具列表。
   * 已连接时幂等（直接返回）。
   */
  async connect(): Promise<void> {
    if (this.client) return;

    const client = new Client({ name: "zqagent", version: "0.1.0" });
    let transport: Transport;

    if (this.config.type === "stdio") {
      const [command, ...args] = this.config.command ?? [];
      if (!command) {
        throw new Error(`MCP server "${this.config.name}" 缺少 command`);
      }
      transport = new StdioClientTransport({
        command,
        args,
        env: this.config.env,
        stderr: "inherit",
      });
    } else {
      if (!this.config.url) {
        throw new Error(`MCP server "${this.config.name}" 缺少 url`);
      }
      transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        {
          requestInit: this.config.headers
            ? { headers: this.config.headers }
            : undefined,
        },
      );
    }

    await client.connect(transport);
    this.client = client;
    this.transport = transport;

    // 拉取工具列表
    const res = await client.listTools();
    this._tools = (res.tools ?? []).map((t) => ({
      name: t.name,
      description:
        typeof t.description === "string" ? t.description : undefined,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
  }

  /** 当前服务器提供的工具列表（副本） */
  listTools(): McpToolInfo[] {
    return [...this._tools];
  }

  /**
   * 调用工具，把 MCP 结果归一化为文本（或错误对象）。
   *
   * 服务器返回 isError=true 时不抛异常，而是返回
   * `{ error, isError: true }`，让模型看到错误信息继续处理。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error(`MCP server "${this.config.name}" 未连接`);
    }
    const res = await this.client.callTool({ name, arguments: args });
    const contents = Array.isArray(res.content) ? res.content : [];
    const text = contents
      .map((c) => {
        if (c.type === "text") return c.text;
        return `[${c.type}] ${JSON.stringify(c)}`;
      })
      .join("\n");
    if (res.isError) {
      return { error: text || `MCP 工具 ${name} 执行失败`, isError: true };
    }
    return text;
  }

  /** 关闭连接，释放子进程/HTTP 会话 */
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // 忽略关闭错误
    }
    try {
      await this.transport?.close();
    } catch {
      // 忽略关闭错误
    }
    this.client = null;
    this.transport = null;
    this._tools = [];
  }
}
