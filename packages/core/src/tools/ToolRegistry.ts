/**
 * 工具注册表
 *
 * 对齐 Python 版 ToolRegistry。负责集中管理所有可用的 Agent 工具：
 * 注册（含内置 schema 推导）、按名查询、批量导出 OpenAI Schema
 * （供 LLM 调用）、按名执行。是 TurnEngine 与具体工具实现之间的桥梁。
 */
import type { ToolSchema } from "../engine/types.js";

/** 工具风险等级 (对齐 Python 版 RiskClass) */
export enum RiskClass {
  /** 只读，无副作用（如 read_file、grep） */
  READ = "read",
  /** 写入本地文件 */
  WRITE_LOCAL = "write_local",
  /** 执行 shell 命令 */
  EXEC = "exec",
  /** 访问外部网络资源 */
  EXTERNAL = "external",
}

/** 工具元数据 */
export interface ToolMetadata {
  /** 工具分类（filesystem / shell / search / web / planning 等） */
  category: string;
  /** 风险级别（low / medium / high） */
  riskLevel: "low" | "medium" | "high";
  /** 能力标签（用于生成默认描述） */
  capabilities: string[];
  /** 是否强制需要人工审批 */
  requiresApproval: boolean;
}

/** 工具执行上下文（由引擎注入） */
export interface ToolExecContext {
  /**
   * 中断信号。可中断的工具（如 run_shell）应把它传给子进程，
   * 使用户中断能立即终止正在执行的命令，而不是等命令自然结束。
   */
  signal?: AbortSignal;
}

/** 单个工具规格 */
export interface ToolSpec {
  /** 工具名 */
  name: string;
  /** OpenAI 工具 Schema（供 LLM 识别调用方式） */
  schema: ToolSchema;
  /** 实际执行函数 */
  func: (args: Record<string, unknown>, ctx?: ToolExecContext) => unknown;
  /** 工具元数据（供权限引擎评估风险） */
  metadata: ToolMetadata;
  /**
   * 工具来源标识（展示用，可选）：
   * "internal" 内置、`mcp:<server>` MCP 工具、"cli:command" 命令工具等
   */
  source?: string;
}

/** 工具注册表 (对齐 Python 版 ToolRegistry) */
export class ToolRegistry {
  /** 工具名 → 工具规格 的映射表 */
  private tools: Map<string, ToolSpec> = new Map();
  /** 已禁用的工具名集合（禁用的工具不出现在 schemas 中，模型不可调用） */
  private disabled: Set<string> = new Set();

  /**
   * 注册一个工具 (内置 schema 自动推导；同名注册即替换，可实现"替换工具")
   *
   * @param func     工具执行函数（工具名优先取 schema.function.name，
   *                 否则回退到 func.name；可返回 Promise，引擎会自动 await）
   * @param metadata 工具元数据（风险等级、分类等）
   * @param schema   OpenAI 工具 Schema；缺省时根据 metadata 自动构建
   * @param source   工具来源标识（展示用，如 "mcp:<server>"）
   * @returns 注册完成后的 ToolSpec
   */
  register(
    func: (args: Record<string, unknown>, ctx?: ToolExecContext) => unknown,
    metadata: ToolMetadata,
    schema?: ToolSchema,
    source?: string,
  ): ToolSpec {
    // 工具名优先从 schema.function.name 取，其次从 func.name
    const name = schema?.function?.name ?? func.name;
    if (!name) throw new Error("Tool function must have a name (provide it via schema).");

    // 确保函数有名字（便于调试栈信息）
    Object.defineProperty(func, "name", { value: name, configurable: true });

    const spec: ToolSpec = {
      name,
      schema: schema ?? this._defaultSchema(name, metadata),
      func,
      metadata,
      source,
    };
    this.tools.set(name, spec);
    // 重新注册（替换）时自动恢复启用
    this.disabled.delete(name);
    return spec;
  }

  /** 移除工具。@returns 是否移除成功 */
  remove(name: string): boolean {
    const had = this.tools.delete(name);
    this.disabled.delete(name);
    return had;
  }

  /** 是否存在指定工具 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 禁用工具（从 schemas 移除，模型不可再调用；已排队的调用仍会执行）。@returns 是否成功 */
  disable(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.disabled.add(name);
    return true;
  }

  /** 重新启用工具。@returns 是否成功（原本处于禁用状态） */
  enable(name: string): boolean {
    return this.disabled.delete(name);
  }

  /** 工具当前是否被禁用 */
  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /** 获取所有启用中的工具的 OpenAI Schema（供 LLM 工具调用使用） */
  schemas(): ToolSchema[] {
    return Array.from(this.tools.values())
      .filter((t) => !this.disabled.has(t.name))
      .map((t) => t.schema);
  }

  /** 获取全部工具名列表（含禁用的） */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 获取全部工具规格（含禁用的，返回副本） */
  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({ ...t }));
  }

  /** 获取单个工具 */
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /**
   * 执行工具
   *
   * @param ctx 执行上下文（引擎注入的中断信号等）
   * @throws 工具未注册时抛出错误
   */
  execute(name: string, args: Record<string, unknown>, ctx?: ToolExecContext): unknown {
    const spec = this.tools.get(name);
    if (!spec) throw new Error(`Tool not registered: ${name}`);
    return spec.func(args, ctx);
  }

  /**
   * 构建默认 Schema
   *
   * 未显式提供 schema 时使用：描述取 capabilities 的逗号拼接，
   * parameters 为空对象（此时模型可能不知道参数结构，因此
   * 正式工具都应显式提供完整 schema）。
   */
  private _defaultSchema(name: string, metadata: ToolMetadata): ToolSchema {
    return {
      type: "function",
      function: {
        name,
        description: metadata.capabilities.join(", "),
        parameters: { type: "object", properties: {} },
      },
    };
  }
}
