/**
 * 测试用 MCP stdio 服务器（echo + add 两个工具）
 *
 * 供 test/mcp.test.ts 通过 stdio 传输连接，验证 McpClient / McpManager
 * 的注入、调用、刷新、卸载等行为。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "原样返回消息",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  }),
);

server.registerTool(
  "add",
  {
    description: "两个数字相加",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(Number(a) + Number(b)) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
