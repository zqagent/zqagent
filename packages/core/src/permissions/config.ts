/**
 * 权限配置（项目级 `.agent/permissions.json`）
 *
 * 与 `.agent/agents.json` / `.agent/mcp.json` 同一约定：配置随项目走，可提交 git。
 * 文件缺省或损坏时静默回退默认值——权限配置不该成为启动失败的来源。
 *
 * 优先级：环境变量 `ZQAGENT_SHELL_POLICY` > 配置文件 > 内置默认。
 */
import * as fs from "fs";
import * as path from "path";
import { Mode, type ShellPolicy } from "./PermissionEngine.js";
import type { SandboxMode } from "../tools/sandbox.js";

/** 未配置白名单时的兜底命令前缀（只读类，命中免审） */
export const DEFAULT_ALLOWED_COMMANDS = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "git status",
  "git diff",
  "git log",
];

/** 项目级权限配置 */
export interface PermissionConfig {
  /** 启动时的运行模式（默认 interactive） */
  mode: Mode;
  /** shell 免审策略（默认 workspace：沙箱生效则免审，否则用工作区路径判定） */
  shellPolicy: ShellPolicy;
  /** 命令白名单（前缀匹配，词边界生效） */
  allowedCommands: string[];
  sandbox: {
    /** auto：探测到就用；off：关闭；required：要求必须可用 */
    mode: SandboxMode;
    /** 额外可写路径（沙箱允许写工作区之外的这些目录） */
    extraWritable: string[];
  };
  /**
   * 变更追踪：记录每个会话每轮改了什么，便于事后审计与回滚。
   * auto 时优先用项目已有的 git，否则在 .agent/vcs 建影子仓库。
   */
  vcs: {
    mode: "auto" | "native" | "shadow" | "off";
  };
}

/** 配置文件名（相对工作区） */
export const PERMISSION_CONFIG_FILE = path.join(".agent", "permissions.json");

const MODES = new Set<string>([Mode.DISCUSS, Mode.PLAN, Mode.INTERACTIVE, Mode.AUTO]);
const SHELL_POLICIES = new Set<string>(["approve", "sandbox", "workspace", "all"]);
const SANDBOX_MODES = new Set<string>(["auto", "off", "required"]);
const VCS_MODES = new Set<string>(["auto", "native", "shadow", "off"]);

/** 默认配置（不读文件时的取值） */
export function defaultPermissionConfig(): PermissionConfig {
  return {
    mode: Mode.INTERACTIVE,
    shellPolicy: "workspace",
    allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
    sandbox: { mode: "auto", extraWritable: [] },
    vcs: { mode: "auto" },
  };
}

/**
 * 读取并归一化配置。
 *
 * 所有字段独立回退：某一项非法不影响其余项，便于用户只写关心的部分。
 */
export function loadPermissionConfig(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): PermissionConfig {
  const cfg = defaultPermissionConfig();
  const file = path.join(workspace, PERMISSION_CONFIG_FILE);

  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    /* 文件不存在或损坏：用默认值 */
  }

  if (raw) {
    const mode = String(raw.mode ?? "").toLowerCase();
    if (MODES.has(mode)) cfg.mode = mode as Mode;

    const policy = String(raw.shellPolicy ?? "").toLowerCase();
    if (SHELL_POLICIES.has(policy)) cfg.shellPolicy = policy as ShellPolicy;

    if (Array.isArray(raw.allowedCommands)) {
      cfg.allowedCommands = raw.allowedCommands
        .map((c) => String(c ?? "").trim())
        .filter((c) => c.length > 0);
    }

    const sandbox = raw.sandbox;
    if (typeof sandbox === "string") {
      const m = sandbox.toLowerCase();
      if (SANDBOX_MODES.has(m)) cfg.sandbox.mode = m as SandboxMode;
    } else if (sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)) {
      const s = sandbox as Record<string, unknown>;
      const m = String(s.mode ?? "").toLowerCase();
      if (SANDBOX_MODES.has(m)) cfg.sandbox.mode = m as SandboxMode;
      if (Array.isArray(s.extraWritable)) {
        cfg.sandbox.extraWritable = s.extraWritable
          .map((p) => String(p ?? "").trim())
          .filter((p) => p.length > 0);
      }
    }

    const vcs = raw.vcs;
    if (typeof vcs === "string") {
      const m = vcs.toLowerCase();
      if (VCS_MODES.has(m)) cfg.vcs.mode = m as PermissionConfig["vcs"]["mode"];
    } else if (vcs && typeof vcs === "object" && !Array.isArray(vcs)) {
      const m = String((vcs as Record<string, unknown>).mode ?? "").toLowerCase();
      if (VCS_MODES.has(m)) cfg.vcs.mode = m as PermissionConfig["vcs"]["mode"];
    }
  }

  // 环境变量覆盖：便于临时切换，不必改文件
  const envPolicy = String(env.ZQAGENT_SHELL_POLICY ?? "").trim().toLowerCase();
  if (SHELL_POLICIES.has(envPolicy)) cfg.shellPolicy = envPolicy as ShellPolicy;

  return cfg;
}
