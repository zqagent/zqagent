/**
 * @zqagent/core — AI Agent 核心库
 *
 * 提供构建 AI Agent 应用所需的核心组件。其他项目通过 import
 * 直接使用 TurnEngine、ToolRegistry、PermissionEngine 等。
 *
 * 使用方式：
 *
 *   方式一（一键装配）：
 *     import { createDefaultEngine, Mode } from "@zqagent/core";
 *     const engine = createDefaultEngine({ workspace: ".", mode: Mode.AUTO });
 *
 *   方式二（完全自定义）：
 *     import { TurnEngine, ToolRegistry, PermissionEngine, OpenAIProvider, Mode } from "@zqagent/core";
 *     const provider = new OpenAIProvider({ apiKey: "sk-xxx" });
 *     const registry = new ToolRegistry();
 *     // ... 注册自定义工具
 *     const permissions = new PermissionEngine({ workspaceRoot: ".", mode: Mode.AUTO });
 *     const engine = new TurnEngine({ provider, registry, permissions, model: "gpt-4o", instructions: "..." });
 */

// ===================== 核心引擎 =====================

export { TurnEngine } from "./engine/TurnEngine.js";
export type { TurnEngineOpts } from "./engine/TurnEngine.js";

// ===================== 事件与审批 =====================

export { EventType, ApprovalOutcome } from "./engine/events.js";
export type {
  WsEvent,
  PermissionRequest,
  Approver,
  EngineHook,
  EngineErrorInfo,
  CompactionTrigger,
  CompactionStartInfo,
  CompactionDoneInfo,
} from "./engine/events.js";

// ===================== 基础类型 =====================

export type {
  Message,
  ToolCall,
  AssistantTurn,
  TokenUsage,
  StreamChunk,
  ToolSchema,
  ReasoningEffort,
} from "./engine/types.js";

// ===================== LLM Provider =====================

export { OpenAIProvider } from "./providers/OpenAIProvider.js";
export type { ProviderClient } from "./providers/OpenAIProvider.js";

// ===================== 工具注册表 =====================

export { ToolRegistry, RiskClass } from "./tools/ToolRegistry.js";
export type { ToolSpec, ToolMetadata } from "./tools/ToolRegistry.js";

// ===================== 权限引擎 =====================

export { PermissionEngine, Mode } from "./permissions/PermissionEngine.js";
export type { Decision } from "./permissions/PermissionEngine.js";

// ===================== 内置钩子 =====================

export { ConsoleHook } from "./engine/ConsoleHook.js";
export type { ConsoleHookOptions } from "./engine/ConsoleHook.js";
export { SubagentHook } from "./engine/SubagentHook.js";
export { CompositeHook } from "./engine/CompositeHook.js";
export { MarkdownRenderer } from "./engine/MarkdownRenderer.js";
export {
  approvalFields,
  approvalInputFromData,
  approvalToHtmlTable,
  approvalToMarkdownTable,
  APPROVAL_COLUMNS,
  APPROVAL_VALUE_MAX,
} from "./engine/approvalView.js";
export type { ApprovalField, ApprovalViewInput } from "./engine/approvalView.js";
export { FileLogHook } from "./engine/FileLogHook.js";
export type { SavedState } from "./engine/FileLogHook.js";

// ===================== 提示词 =====================

export {
  buildInstructions,
  buildEnvBlock,
  CODE_INSTRUCTIONS,
  COWORK_INSTRUCTIONS,
  EXPLORER_INSTRUCTIONS,
  PLAN_MODE_CONTEXT,
  DISCUSS_MODE_CONTEXT,
} from "./prompts/index.js";

// ===================== Agent 注册表 =====================

export { AgentRegistry, BUILTIN_AGENTS } from "./agents/AgentRegistry.js";
export type { AgentDef } from "./agents/AgentRegistry.js";

// ===================== MCP =====================

export { McpClient, mcpToolKey, sanitizeToolName } from "./mcp/McpClient.js";
export type { McpServerConfig, McpToolInfo } from "./mcp/McpClient.js";
export { McpManager } from "./mcp/McpManager.js";
export type { McpConnectResult } from "./mcp/McpManager.js";

// ===================== 内置工具注册函数 =====================

export { registerFileTools } from "./tools/files.js";
export { registerReadOnlyFileTools } from "./tools/files.js";
export { registerShellTool } from "./tools/shell.js";
export { registerSearchTool } from "./tools/search.js";
export { registerWebTools } from "./tools/web.js";
export { registerGitTools } from "./tools/git.js";
export { registerDiffTools } from "./tools/diff.js";
export { registerTodoTool, TodoList } from "./tools/todo.js";
export { registerExploreTool } from "./tools/explore.js";
export { registerMediaTool } from "./tools/media.js";
export {
  resolveMedia,
  downloadFfmpeg,
  installHints,
  resetFfmpegCache,
} from "./tools/ffmpegRuntime.js";
export type { ResolvedMedia, ResolvedBin, DownloadResult } from "./tools/ffmpegRuntime.js";
export { registerAskTool, setQuestionHandler, parsePicks } from "./tools/ask.js";
export type { QuestionHandler } from "./tools/ask.js";
export { registerPlanTool, setPlanHandler } from "./tools/plan.js";
export type { PlanHandler } from "./tools/plan.js";
export {
  registerDirectoryTool,
  setDirectoryHandler,
} from "./tools/directories.js";
export type { DirectoryHandler } from "./tools/directories.js";

// ===================== 工厂函数 =====================

import type { TurnEngineOpts } from "./engine/TurnEngine.js";
import type { EngineHook, Approver } from "./engine/events.js";
import { TurnEngine } from "./engine/TurnEngine.js";
import type { ProviderClient } from "./providers/OpenAIProvider.js";
import { OpenAIProvider } from "./providers/OpenAIProvider.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { TodoList } from "./tools/todo.js";
import { PermissionEngine, Mode } from "./permissions/PermissionEngine.js";
import {
  buildInstructions,
  GEN_SESSION_NAME_INSTRUCTIONS,
} from "./prompts/index.js";
import type { Message, ReasoningEffort } from "./engine/types.js";
import { registerFileTools } from "./tools/files.js";
import { registerShellTool } from "./tools/shell.js";
import { registerSearchTool } from "./tools/search.js";
import { registerWebTools } from "./tools/web.js";
import { registerGitTools } from "./tools/git.js";
import { registerDiffTools } from "./tools/diff.js";
import { registerTodoTool } from "./tools/todo.js";
import { registerExploreTool } from "./tools/explore.js";
import { registerMediaTool } from "./tools/media.js";
import { registerAskTool } from "./tools/ask.js";
import { registerPlanTool } from "./tools/plan.js";
import { registerDirectoryTool } from "./tools/directories.js";

/** createDefaultEngine 参数 */
export interface CreateEngineOpts {
  /** 工作区根目录 */
  workspace: string;
  /** 模型标识（默认取环境变量 OPENAI_MODEL，否则 gpt-4o） */
  model?: string;
  /** LLM Provider（缺省时自动创建 OpenAIProvider） */
  provider?: ProviderClient;
  /** 运行模式（默认 INTERACTIVE） */
  mode?: Mode;
  /** 单轮最大迭代次数（默认 300） */
  maxIterations?: number;
  /**
   * 推理强度（可选）。缺省时取环境变量 OPENAI_REASONING_EFFORT
   * （low|medium|high，非法值忽略）。OpenAI 系模型生效，
   * DeepSeek 自动跳过。
   */
  reasoningEffort?: ReasoningEffort;
  /** 命令白名单（Auto 模式下自动放行的命令前缀，默认空数组） */
  allowedCommands?: string[];
  /** 系统提示词（缺省时使用 buildInstructions("code", ...) 生成） */
  instructions?: string;
  /** 代理类型：code=编程助手 / cowork=通用协作（影响默认 instructions） */
  agentType?: "code" | "cowork";
  /** 初始对话历史（可选） */
  messages?: Message[];
  /** 引擎生命周期钩子（可选） */
  hook?: EngineHook;
  /**
   * explore 子代理的钩子工厂（可选）：每次 explore 调用生成一个新实例，
   * 用于渲染子代理的执行过程（如 CLI 的 SubagentHook）。
   * 不传时子代理保持静默（只有最终报告返回给主代理）。
   */
  subagentHookFactory?: () => EngineHook;
  /** 模型上下文窗口大小（token 数），设置后覆盖自动检测与默认值 */
  contextWindow?: number;
  /** 压缩触发阈值比例（占窗口比例，默认 0.8） */
  thresholdPct?: number;
  /** 压缩触发阈值绝对上限（token 数；缺省不限制） */
  capTokens?: number | null;
  /** LLM 请求日志根目录（按日期分目录），不传则不记录 */
  logDir?: string;
}

/**
 * 一键装配完整的 TurnEngine
 *
 * 自动创建 OpenAIProvider（若未传入），注册全部 18 个内置工具，
 * 构建权限引擎，生成默认系统提示词，组装并返回 TurnEngine 实例。
 *
 * **注意：返回的 engine 未设置 approver（审核回调），
 * 调用方需要自行调用 engine.setApprover(...) 注入审批逻辑。**
 *
 * @param opts 装配参数
 * @returns 已装配好的 TurnEngine 实例
 */
export function createDefaultEngine(opts: CreateEngineOpts): TurnEngine {
  const {
    workspace,
    model = process.env.OPENAI_MODEL ?? "gpt-4o",
    provider,
    mode = Mode.INTERACTIVE,
    maxIterations = 300,
    reasoningEffort,
    allowedCommands = [],
    instructions,
    agentType = "code",
    messages,
    hook,
    subagentHookFactory,
    contextWindow,
    thresholdPct,
    capTokens,
    logDir,
  } = opts;

  // 推理强度：显式参数 > 环境变量 OPENAI_REASONING_EFFORT（非法值忽略）
  const envEffort = process.env.OPENAI_REASONING_EFFORT?.toLowerCase();
  const effectiveEffort: ReasoningEffort | undefined =
    reasoningEffort ??
    (envEffort === "low" || envEffort === "medium" || envEffort === "high"
      ? envEffort
      : undefined);

  // 1. Provider
  const effectiveProvider = provider ?? new OpenAIProvider({ logDir });

  // 2. 工具注册表
  const registry = new ToolRegistry();
  registerFileTools(registry, workspace);
  registerShellTool(registry, workspace);
  registerSearchTool(registry, workspace);
  registerWebTools(registry);
  registerGitTools(registry, workspace);
  registerDiffTools(registry, workspace);
  registerAskTool(registry);
  registerPlanTool(registry);
  registerDirectoryTool(registry);
  registerMediaTool(registry, workspace);

  const todo = new TodoList();
  registerTodoTool(registry, todo);

  registerExploreTool(registry, {
    workspace,
    provider: effectiveProvider,
    model,
    hookFactory: subagentHookFactory,
  });

  // 3. 权限引擎
  const permissions = new PermissionEngine({
    workspaceRoot: workspace,
    mode,
    allowedCommands,
  });

  // 4. 系统提示词
  const today = new Date().toISOString().split("T")[0]!;
  const effectiveInstructions =
    instructions ?? buildInstructions(agentType, workspace, today);

  // 5. 组装引擎
  const engine = new TurnEngine({
    provider: effectiveProvider,
    registry,
    permissions,
    model,
    instructions: effectiveInstructions,
    genSessionNamePrompt: GEN_SESSION_NAME_INSTRUCTIONS,
    maxIterations,
    reasoningEffort: effectiveEffort,
    messages,
    hook,
    contextWindow,
    thresholdPct,
    capTokens,
  });

  return engine;
}
