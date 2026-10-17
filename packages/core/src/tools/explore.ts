/**
 * Explore 子代理工具
 *
 * 提供 explore 工具：把广泛的只读研究任务委托给一个独立的
 * TurnEngine 子代理。子代理在自己的上下文中搜索和阅读代码，
 * 只把最终报告返回给调用方——中间的搜索过程不消耗调用方的上下文。
 * 子代理只注册只读工具（read_file / list_files / grep /
 * git_log / git_status / git_diff），并以 Plan 模式运行，
 * 从机制上保证不会写文件或执行命令。
 */
import { ToolRegistry } from "./ToolRegistry.js";
import { TurnEngine } from "../engine/TurnEngine.js";
import { parseMaxIterations } from "../engine/limits.js";
import { EventType, type EngineHook, type WsEvent } from "../engine/events.js";
import { PermissionEngine, Mode } from "../permissions/PermissionEngine.js";
import type { ProviderClient } from "../providers/OpenAIProvider.js";
import { EXPLORER_INSTRUCTIONS } from "../prompts/index.js";
import { registerReadOnlyFileTools } from "./files.js";
import { registerSearchTool } from "./search.js";
import { registerGitTools } from "./git.js";

/**
 * 构建 Explorer 子引擎 (对齐 Python 版 build_explorer_engine)
 *
 * 只注册只读工具，使用 Plan 模式权限引擎（硬阻断所有写入），
 * 迭代上限默认 30 次（环境变量 EXPLORE_MAX_ITERATIONS 可覆盖）。
 *
 * 可选 readonlyRegistrars：外部可注入"只读工具注册器"（例如沙箱远程工具），
 * 用于把 explore 子代理的执行目标从宿主机工作区切换到远程沙箱。
 * 缺省时使用本地文件系统的只读工具（行为与旧版一致）。
 */
export function buildExplorerEngine(opts: {
  workspace: string;
  provider: ProviderClient;
  model: string;
  readonlyRegistrars?: (registry: ToolRegistry) => void;
  /**
   * 子引擎生命周期钩子（可选）：注入后子代理的执行过程（工具活动、终态）
   * 会回调给调用方渲染（如 CLI 的 SubagentHook）；不传则与旧版一致（静默）。
   */
  hook?: EngineHook;
}): TurnEngine {
  const registry = new ToolRegistry();

  if (opts.readonlyRegistrars) {
    // 远程/自定义只读工具集（如沙箱内 read_file/list_files/grep/git_*）
    opts.readonlyRegistrars(registry);
  } else {
    // 默认：只读工具 read_file, list_files, grep, git_log, git_status, git_diff
    registerReadOnlyFileTools(registry, opts.workspace);
    registerSearchTool(registry, opts.workspace);
    registerGitTools(registry, opts.workspace);
  }

  // Plan 模式 (硬阻断所有写入)
  const permissions = new PermissionEngine({
    workspaceRoot: opts.workspace,
    mode: Mode.PLAN,
  });

  return new TurnEngine({
    provider: opts.provider,
    registry,
    permissions,
    model: opts.model,
    instructions: EXPLORER_INSTRUCTIONS,
    maxIterations: parseMaxIterations(process.env.EXPLORE_MAX_ITERATIONS, 30),
    hook: opts.hook,
  });
}

/**
 * 创建 explore 工具函数
 *
 * 每次调用都会新建一个独立的子引擎，运行研究任务并收集
 * 子代理的最终回复作为报告返回。
 */
export function makeExploreTool(opts: {
  workspace: string;
  provider: ProviderClient;
  model: string;
  readonlyRegistrars?: (registry: ToolRegistry) => void;
  /**
   * 子引擎钩子工厂（可选）：每次 explore 调用生成一个新实例。
   *
   * 用工厂而非共享实例，是因为低风险工具会被并发执行（同一条回复里的多个
   * explore 会同时运行），共享同一个渲染器会互相串状态、输出交错难辨。
   */
  hookFactory?: () => EngineHook;
}) {
  return async function explore(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = String(args.task ?? "");
    if (!task.trim()) return { error: "探索任务描述不能为空" };

    const engine = buildExplorerEngine({
      workspace: opts.workspace,
      provider: opts.provider,
      model: opts.model,
      readonlyRegistrars: opts.readonlyRegistrars,
      hook: opts.hookFactory?.(),
    });

    let report = "";
    let status = "unknown";

    try {
      // 驱动子引擎运行，捕获最终报告与结束状态
      for await (const event of engine.run(task)) {
        if (event.type === EventType.ASSISTANT_MESSAGE && event.data.text) {
          report = String(event.data.text);
        }
        if (event.type === EventType.TURN_END) {
          status = String(event.data.status ?? "unknown");
        }
        if (event.type === EventType.ERROR) {
          return { error: `explorer 错误: ${event.data.error}` };
        }
      }
    } catch (exc) {
      return { error: `explorer 异常: ${String(exc)}` };
    }

    if (!report) {
      return { error: `explorer 未产生报告 (状态: ${status})` };
    }

    const result: Record<string, unknown> = { report };
    // 子代理提前终止（如达到迭代上限）时提示报告可能不完整
    if (status !== "completed") {
      result.note = `explorer 提前停止 (${status})；报告可能不完整`;
    }
    return result;
  };
}

/** 注册 explore 工具（低风险，无需审批） */
export function registerExploreTool(
  registry: ToolRegistry,
  opts: {
    workspace: string;
    provider: ProviderClient;
    model: string;
    readonlyRegistrars?: (registry: ToolRegistry) => void;
    /** 子引擎钩子工厂（可选）：见 makeExploreTool */
    hookFactory?: () => EngineHook;
  },
): void {
  const exploreFunc = makeExploreTool(opts);

  registry.register(
    (args) => exploreFunc(args),
    {
      category: "search",
      riskLevel: "low",
      capabilities: ["search"],
      requiresApproval: false,
    },
    {
      type: "function",
      function: {
        name: "explore",
        description:
          "优先使用此工具执行跨文件代码探索任务——它在独立上下文中搜索，只返回最终报告，不消耗你的主上下文。子代理可读取文件、搜索内容、查看 git 历史。使用场景：追踪调用链/数据流、了解模块架构与组织方式、查找某个功能或错误处理的实现位置、理解项目中的代码模式。不要用此工具：读取单个已知文件、简单单文件搜索——这些场景直接自己读取即可。多个独立的 explore 调用可以并行执行。精确描述任务并说明报告应包含什么。",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "研究问题，包含约束条件和期望的报告格式",
            },
          },
          required: ["task"],
        },
      },
    },
  );
}
