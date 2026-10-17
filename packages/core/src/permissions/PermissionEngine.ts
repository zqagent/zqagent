/**
 * 权限引擎
 *
 * 对齐 Python 版 PermissionEngine。核心职责是对每个工具调用做安全评估，
 * 输出「允许 / 拒绝 / 需要审批」的决策。评估维度包括：
 *   - 运行模式（只读模式硬阻断写入与 shell）
 *   - 工具风险分类（读 / 写 / 执行 / 外部）
 *   - 写入路径是否在可写根目录内
 *   - 命令是否命中白名单（且不含 shell 运算符）
 *   - 会话级白名单（用户选择「总是允许」后生效）
 */
import { RiskClass, type ToolMetadata } from "../tools/ToolRegistry.js";
import { isWithinRoot } from "../tools/pathSafety.js";

/** 权限模式 (对齐 Python 版 Mode) */
export enum Mode {
  /** 讨论模式：只读，禁止一切写入与执行 */
  DISCUSS = "discuss",
  /** 计划模式：只读，禁止一切写入与执行 */
  PLAN = "plan",
  /** 交互模式：有副作用的操作需用户逐次审批 */
  INTERACTIVE = "interactive",
  /** 自动模式：有副作用的操作全部放行（高风险，需自行承担） */
  AUTO = "auto",
}

/** 权限决策 */
export interface Decision {
  /** 是否允许执行 */
  allowed: boolean;
  /** 决策原因（用于展示给用户） */
  reason: string;
  /** 是否需要用户审批 */
  needsUser: boolean;
}

/** 只读模式集合：此模式下所有有副作用的操作都会被拒绝 */
const READ_ONLY_MODES = new Set([Mode.DISCUSS, Mode.PLAN]);

/** Python 版 risk.py 中的风险分类：写文件类工具 */
const WRITE_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "apply_unified_diff",
]);
/** shell 工具名 */
const SHELL_TOOL = "run_shell";

/** 工具名 → 基础风险等级 的默认映射（其余工具按元数据动态归类） */
const BASE_RISK: Record<string, RiskClass> = {
  ...Object.fromEntries(
    [...WRITE_TOOLS].map((n) => [n, RiskClass.WRITE_LOCAL]),
  ),
  [SHELL_TOOL]: RiskClass.EXEC,
};

/**
 * 风险分类
 *
 * 优先查默认映射表；未命中时：MCP 注入的工具（metadata.category === "mcp"）
 * 与标记 requiresApproval 的工具归为 EXTERNAL（外部/高风险），其余一律视为只读。
 */
function classify(toolName: string, metadata?: ToolMetadata): RiskClass {
  const base = BASE_RISK[toolName];
  if (base) return base;
  if (metadata?.category === "mcp" || metadata?.requiresApproval) {
    return RiskClass.EXTERNAL;
  }
  return RiskClass.READ;
}

/** 是否有副作用（非只读即视为有副作用） */
function isConsequential(risk: RiskClass): boolean {
  return risk !== RiskClass.READ;
}

/** Shell 运算符：命令含其中任意一个就认为有复合逻辑，不能自动放行 */
const SHELL_OPERATORS = [";", "&", "|", ">", "<", "`", "$(", "(", "\n", "\r"];

/** 判断命令字符串中是否包含 shell 运算符 */
function hasShellOperators(command: string): boolean {
  return SHELL_OPERATORS.some((op) => command.includes(op));
}

/** 取命令的可执行程序名（首词，去掉路径），用于「总是允许该命令」的同类匹配 */
function commandBin(command: string): string {
  const first =
    String(command ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? first;
}

/** 命令首词是否为裸命令名（不含路径）；带路径的调用不按同类命令放行 */
function isBareCommand(command: string): boolean {
  const first =
    String(command ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return first.length > 0 && !first.includes("/");
}

import * as path from "path";

/** 权限引擎 (对齐 Python 版 PermissionEngine) */
export class PermissionEngine {
  /** 工作区根目录（写入路径必须位于其下） */
  workspaceRoot: string;
  /** 当前运行模式 */
  mode: Mode;
  /** 命令白名单（前缀匹配） */
  allowedCommands: string[];
  /** 会话级「总是允许此工具」集合 */
  sessionAllowTools: Set<string>;
  /** 会话级「总是允许此命令」集合 */
  sessionAllowCommands: Set<string>;

  constructor(opts: {
    workspaceRoot: string;
    mode: Mode;
    allowedCommands?: string[];
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.mode = opts.mode;
    this.allowedCommands = Array.isArray(opts.allowedCommands)
      ? opts.allowedCommands
      : [];
    this.sessionAllowTools = new Set();
    this.sessionAllowCommands = new Set();
  }

  /**
   * 评估工具调用是否允许
   *
   * 按优先级依次检查：只读模式 → 路径范围 → 低风险放行 → AUTO 放行 →
   * 命令白名单 → 会话白名单 → 最后兜底为「需要审批」。
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    metadata?: ToolMetadata,
  ): Decision {
    const risk = classify(toolName, metadata);
    const isWrite = risk === RiskClass.WRITE_LOCAL;
    const isShell = risk === RiskClass.EXEC;
    const consequential = isConsequential(risk);

    // 1. 只读模式 → 拒绝任何有副作用的操作
    if (READ_ONLY_MODES.has(this.mode) && consequential) {
      return {
        allowed: false,
        reason: `${this.mode} 模式为只读`,
        needsUser: false,
      };
    }

    // 2. 路径范围检查：写文件必须落在可写根目录内
    if (isWrite) {
      const filePath = args["path"] as string | undefined;
      if (filePath && !this._underWritableRoot(filePath)) {
        return {
          allowed: false,
          reason: `路径不在可写目录下: ${filePath}`,
          needsUser: false,
        };
      }
    }

    // 3. 非 consequential → 始终允许
    if (!consequential) {
      return { allowed: true, reason: "低风险", needsUser: false };
    }

    // 4. AUTO 模式 → 全部放行
    if (this.mode === Mode.AUTO) {
      return { allowed: true, reason: "全自动模式", needsUser: false };
    }

    // 5. 命令白名单检查（仅 shell）：命中白名单前缀或会话已允许的命令直接放行
    if (isShell) {
      const command = String(args["command"] ?? "");
      if (this._commandAllowed(command)) {
        return { allowed: true, reason: "命令在白名单中", needsUser: false };
      }
      // 会话白名单按可执行程序名（首词）记忆；仅放行简单命令：
      // 含 shell 运算符、或首词带路径（/usr/bin/x、./x）时不做匹配，
      // 避免复合命令与别处的同名二进制被顺带放行
      if (!hasShellOperators(command) && isBareCommand(command)) {
        const bin = commandBin(command);
        if (bin && this.sessionAllowCommands.has(bin)) {
          return {
            allowed: true,
            reason: "会话已允许此命令",
            needsUser: false,
          };
        }
      }
    }

    // 6. Session 白名单：用户选择「总是允许此工具」后无需再审批
    if (this.sessionAllowTools.has(toolName)) {
      return { allowed: true, reason: "会话已允许此工具", needsUser: false };
    }

    // 7. 兜底：需要审批（由 approver 回调决定）
    return { allowed: false, reason: "需要审批", needsUser: true };
  }

  /** 将工具加入会话白名单 */
  allowToolForSession(toolName: string): void {
    this.sessionAllowTools.add(toolName);
  }

  /** 将命令加入会话白名单（按可执行程序名记录，同类命令后续直接放行） */
  allowCommandForSession(command: string): void {
    const bin = commandBin(command);
    if (bin) this.sessionAllowCommands.add(bin);
  }

  /**
   * 检查路径是否在可写根目录下
   *
   * 基于 fs.realpathSync 解析符号链接后比较（pathSafety.isWithinRoot），
   * 同时防御 ../ 逃逸与 symlink 逃逸。
   */
  private _underWritableRoot(filePath: string): boolean {
    return isWithinRoot(this.workspaceRoot, filePath);
  }

  /**
   * 检查命令是否在白名单中
   *
   * 含 shell 运算符的命令一律不放行（避免绕过白名单做复合操作）；
   * 白名单采用前缀匹配（如 "git status" 匹配 "git status -s"）。
   */
  private _commandAllowed(command: string): boolean {
    if (hasShellOperators(command)) return false;
    return this.allowedCommands.some((prefix) => command.startsWith(prefix));
  }
}
