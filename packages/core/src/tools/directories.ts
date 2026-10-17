import { ToolRegistry } from "./ToolRegistry.js";

/**
 * request_directory — 请求文件夹访问权限
 * 对齐 Python 版 tools/directories.py
 * CLI 模式下通过 readline Y/N 实现
 */

export type DirectoryHandler = (reason: string, suggestedPath: string, writable: boolean) => Promise<{ granted: boolean; path?: string }>;

let _directoryHandler: DirectoryHandler | null = null;

export function setDirectoryHandler(handler: DirectoryHandler): void {
  _directoryHandler = handler;
}

function makeRequestDirectory() {
  return async function request_directory(args: Record<string, unknown>) {
    const reason = String(args.reason ?? "");
    const suggestedPath = String(args.path ?? "");
    const writable = args.writable === true;

    if (!reason.trim()) {
      return { granted: false, error: "需要说明请求访问的原因" };
    }

    if (!_directoryHandler) {
      return { granted: false, error: "当前环境不支持目录访问请求" };
    }

    try {
      const result = await _directoryHandler(reason, suggestedPath, writable);
      if (result.granted) {
        return {
          granted: true,
          path: result.path ?? suggestedPath,
          writable,
          note: `已授予对 ${result.path ?? suggestedPath} 的${writable ? "读写" : "只读"}访问权限`,
        };
      }
      return { granted: false, error: "用户拒绝了目录访问请求" };
    } catch {
      return { granted: false, error: "目录访问请求已取消" };
    }
  };
}

/** 注册 request_directory 工具 */
export function registerDirectoryTool(registry: ToolRegistry): void {
  const dirFunc = makeRequestDirectory();

  registry.register(
    (args) => dirFunc(args),
    { category: "filesystem", riskLevel: "low", capabilities: ["request_directory"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "request_directory",
        description: "当任务需要访问当前工作区之外的文件时，请求用户授予目录访问权限（例如读取用户提到的项目，或将交付物保存到特定位置）。在 reason 中解释原因；可选地建议一个 path 以及是否需要 writable 访问权限。用户选择/批准文件夹；结果告知是否被授予。不要用此工具去规避沙箱限制——只为服务用户的请求而使用。",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "为什么需要访问此目录" },
            path: { type: "string", description: "建议的目录路径（可选）" },
            writable: { type: "boolean", description: "是否需要写入权限（默认 false）" },
          },
          required: ["reason"],
        },
      },
    },
  );
}
