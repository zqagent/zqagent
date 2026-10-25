/**
 * 内置 MCP 服务器注册表与进程内传输
 *
 * 内置服务器通过 InMemoryTransport 与客户端通信：无需子进程、跨平台、
 * 对 SEA 单文件打包友好。新增内置能力时只需在此登记工厂。
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../McpClient.js";
import { createOcrServer } from "./ocr.js";
import type { McpBuiltinContext } from "./types.js";

export type BuiltinMcpFactory = (ctx: McpBuiltinContext) => Server;

const FACTORIES: Record<string, BuiltinMcpFactory> = {
  ocr: createOcrServer,
};

/** 已注册的内置服务器标识 */
export function listBuiltinServers(): string[] {
  return Object.keys(FACTORIES);
}

/**
 * 创建内置服务器的客户端侧传输（已建立连接）。
 * 服务端实例与客户端共享进程，随传输关闭而释放。
 */
export async function createBuiltinTransport(
  config: McpServerConfig,
  ctx: McpBuiltinContext,
): Promise<Transport> {
  const id = config.builtin ?? config.name;
  const factory = FACTORIES[id];
  if (!factory) {
    throw new Error(
      `未知的内置 MCP server "${id}"（可用: ${listBuiltinServers().join(", ")}）`,
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = factory(ctx);
  await server.connect(serverTransport);
  return clientTransport;
}

export type { McpBuiltinContext } from "./types.js";
