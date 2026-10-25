/**
 * MCP 安装模板
 *
 * 用于 `/mcp add` 交互式向导：把常见官方服务器的启动命令与参数固化，
 * 用户只需按提示填写少量占位符。`{{key}}` 会在安装时被替换。
 */

import type { McpServerConfig } from "./McpClient.js";

/** 模板占位符 */
export interface McpPresetField {
  /** 替换 config 中的 {{key}} */
  key: string;
  /** 提示文案 */
  label: string;
  /** 必填（为空则取消安装） */
  required?: boolean;
  /** 隐藏输入（写入 env/headers 的密钥） */
  secret?: boolean;
  /** 默认值 */
  default?: string;
}

/** 安装模板 */
export interface McpPreset {
  id: string;
  title: string;
  description: string;
  /** name 缺省时使用 id */
  config: Omit<McpServerConfig, "name"> & { name?: string };
  fields?: McpPresetField[];
}

/** 内置模板（官方服务器为主，命令与包名可被用户覆盖） */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    title: "Filesystem（本地文件）",
    description: "让 MCP 读写指定目录，npx 自动拉取官方 server",
    config: {
      name: "filesystem",
      type: "stdio",
      command: [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "{{dir}}",
      ],
      enabled: true,
    },
    fields: [
      {
        key: "dir",
        label: "允许访问的目录（绝对路径）",
        required: true,
      },
    ],
  },
  {
    id: "memory",
    title: "Memory（知识图谱记忆）",
    description: "官方 memory server，提供实体/关系记忆",
    config: {
      name: "memory",
      type: "stdio",
      command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
      enabled: true,
    },
  },
  {
    id: "sequential-thinking",
    title: "Sequential Thinking（分步推理）",
    description: "官方分步思考 server",
    config: {
      name: "sequential-thinking",
      type: "stdio",
      command: [
        "npx",
        "-y",
        "@modelcontextprotocol/server-sequential-thinking",
      ],
      enabled: true,
    },
  },
  {
    id: "github",
    title: "GitHub",
    description: "官方 GitHub server（需要 Personal Access Token）",
    config: {
      name: "github",
      type: "stdio",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{token}}" },
      enabled: true,
    },
    fields: [
      {
        key: "token",
        label: "GitHub Personal Access Token",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "fetch",
    title: "Fetch（网页抓取）",
    description: "官方 Python server，需要 uvx（pip install uv）",
    config: {
      name: "fetch",
      type: "stdio",
      command: ["uvx", "mcp-server-fetch"],
      enabled: true,
    },
  },
  {
    id: "postgres",
    title: "PostgreSQL（只读查询）",
    description: "官方 postgres server（需要连接串）",
    config: {
      name: "postgres",
      type: "stdio",
      command: [
        "npx",
        "-y",
        "@modelcontextprotocol/server-postgres",
        "{{dsn}}",
      ],
      enabled: true,
    },
    fields: [
      {
        key: "dsn",
        label: "连接串（postgresql://user:pass@host/db）",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "ocr",
    title: "OCR（内置，开箱即用）",
    description:
      "进程内 OCR：macOS Vision / tesseract / 多模态模型自动降级，无需安装",
    config: {
      name: "ocr",
      type: "builtin",
      builtin: "ocr",
      enabled: true,
    },
  },
];

function replacePlaceholders(
  value: string,
  values: Record<string, string>,
): string {
  return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, key: string) => {
    return values[key] ?? "";
  });
}

/** 用填写的占位符生成最终配置（不会修改模板对象） */
export function applyMcpPreset(
  preset: McpPreset,
  values: Record<string, string>,
): McpServerConfig {
  const base = preset.config;
  const config: McpServerConfig = {
    ...base,
    name: base.name ?? preset.id,
  };
  if (config.command)
    config.command = config.command.map((c) =>
      replacePlaceholders(c, values),
    );
  if (config.url) config.url = replacePlaceholders(config.url, values);
  if (config.cwd) config.cwd = replacePlaceholders(config.cwd, values);
  if (config.env) {
    config.env = Object.fromEntries(
      Object.entries(config.env).map(([k, v]) => [
        k,
        replacePlaceholders(v, values),
      ]),
    );
  }
  if (config.headers) {
    config.headers = Object.fromEntries(
      Object.entries(config.headers).map(([k, v]) => [
        k,
        replacePlaceholders(v, values),
      ]),
    );
  }
  return config;
}
