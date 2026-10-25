/**
 * 内置 OCR MCP 服务器
 *
 * 以标准 MCP server 形式暴露 recognize 工具，经 InMemoryTransport 与
 * McpClient 通信，因此与外部 MCP 服务器共享同一套注入/审批/懒加载逻辑。
 * 工具名固定为 recognize，配合默认 server 名 ocr 得到 `mcp__ocr__recognize`。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { recognizeOcr, type OcrInput } from "./ocrEngine.js";
import type { McpBuiltinContext } from "./types.js";

const TOOL_NAME = "recognize";

const TOOL_DESCRIPTION = [
  "从图片、扫描件或 PDF 中提取文字（OCR）。",
  "优先传 imagePath（工作区内的文件路径），也支持 imageBase64（可带 data URL 前缀）或 imageUrl。",
  "传入 PDF 会逐页识别（maxPages 默认 5，dpi 默认 150）。",
  "识别引擎自动选择：macOS Vision / tesseract+pdftoppm / 已配置的多模态模型。",
].join("\n");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    imagePath: {
      type: "string",
      description: "本地图片或 PDF 路径（相对路径按工作区解析）",
    },
    imageBase64: {
      type: "string",
      description: "图片的 base64 编码（可带 data URL 前缀）",
    },
    imageUrl: {
      type: "string",
      description: "远程图片或 PDF 的 URL",
    },
    maxPages: {
      type: "number",
      description: "PDF 最多识别页数（默认 5，上限 50）",
    },
    dpi: {
      type: "number",
      description: "PDF 渲染 DPI（默认 150，上限 400）",
    },
    lang: {
      type: "string",
      description: "tesseract 语言包（默认 chi_sim+eng）",
    },
  },
} as const;

/** 创建内置 OCR MCP 服务器 */
export function createOcrServer(ctx: McpBuiltinContext = {}): Server {
  const server = new Server(
    { name: "zqagent-ocr", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `未知工具 "${request.params.name}"，可用工具：${TOOL_NAME}`,
            }),
          },
        ],
        isError: true,
      };
    }

    const args = (request.params.arguments ?? {}) as OcrInput;
    const result = await recognizeOcr(args, ctx);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: result.error,
                how_to_fix: result.how_to_fix,
                attempts: result.attempts,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.text }],
    };
  });

  return server;
}
