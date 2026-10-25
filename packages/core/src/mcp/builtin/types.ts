/**
 * 内置 MCP 服务器的运行时上下文
 *
 * 内置服务器与外部 stdio/http 服务器不同：它运行在同一个进程内，
 * 通过 SDK 的 InMemoryTransport 与 McpClient 通信。上下文用于向内置
 * 服务器注入工作区、环境变量，以及可选的 LLM（多模态 OCR 兜底）配置。
 */

/** 多模态 LLM 兜底配置（来自当前 provider 连接） */
export interface OcrLlmConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

/** 可注入的运行时依赖（测试用；生产环境使用默认实现） */
export interface OcrRuntimeOverrides {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  which?: (name: string) => string | null;
  /** 执行外部命令（返回 stdout/stderr），失败时抛错 */
  run?: (
    command: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** 抓取远程图片 */
  fetchImpl?: (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  /** 多模态模型调用（默认走 OpenAI 兼容接口） */
  llmComplete?: (req: {
    model: string;
    prompt: string;
    imageDataUrl: string;
    baseURL?: string;
    apiKey?: string;
  }) => Promise<string>;
  /** 临时目录根（默认 os.tmpdir()） */
  tmpDir?: string;
}

/** 内置 MCP 服务器上下文 */
export interface McpBuiltinContext {
  /** 工作区根目录（用于缓存编译产物，如 .agent/bin/ocr-vision） */
  workspace?: string;
  /** 进程环境变量（默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** 多模态 LLM 兜底配置 */
  llm?: OcrLlmConfig;
  /** OCR 运行时依赖覆盖（测试用） */
  ocr?: OcrRuntimeOverrides;
}
