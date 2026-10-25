/**
 * 变更追踪（VCS）—— 类型与探测
 *
 * 目标：记录「每个会话每一轮改了什么」，让多个会话并行操作同一工作区时
 * 事后能审计、能回滚，而不是一团无法追溯的最终状态。
 *
 * 不自己实现版本控制：git 完全可以在没有 `.git` 的目录上工作
 * （`--git-dir` 与 `--work-tree` 分离），所以：
 *   - 项目本身是 git 仓库 → 复用（native），但用独立 index 和独立 ref，
 *     绝不碰用户的 HEAD / 暂存区；
 *   - 项目不是 git 仓库 → 在 `.agent/vcs` 建影子仓库（shadow），
 *     项目目录里不出现 `.git`，用户完全无感。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 追踪模式 */
export type VcsMode = "native" | "shadow" | "off";

/** 配置取值：auto 表示自动探测 */
export type VcsConfigMode = "auto" | "native" | "shadow" | "off";

/** 解析后的方案 */
export interface VcsPlan {
  mode: VcsMode;
  /** 工作区绝对路径 */
  workTree: string;
  /** git 目录绝对路径；mode=off 时为 null */
  gitDir: string | null;
  /** 状态说明（供日志 / 命令输出） */
  reason: string;
}

/** 一轮的提交记录 */
export interface TurnCommit {
  /**
   * 快照序号（从 1 开始，按本会话提交顺序）。
   * `commitTurn()` 的返回值里为 0——序号由 `listTurns()` 统一给出，
   * 提交时再算一次只会多花一次 git 调用。
   */
  turn: number;
  /** commit sha */
  commit: string;
  /** 提交时间（ISO） */
  ts: string;
  /** 本轮改动涉及的文件（工作区相对路径） */
  files: string[];
  /** 本轮结束状态（completed / interrupted / error …） */
  status: string;
}

/** 影子仓库目录（相对工作区） */
export const SHADOW_DIR = path.join(".agent", "vcs");

/**
 * 影子仓库默认排除项。
 *
 * 必须排除 `.agent` 自身：影子仓库的对象库就在里面，不排除的话
 * `git add -A` 会把它自己提交进去（每轮体积翻倍，且 diff 全是对象文件）。
 * 其余是常见产物目录，避免追踪体积大、无意义的文件。
 */
export const SHADOW_EXCLUDES = [
  ".agent/",
  ".git/",
  "node_modules/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".cache/",
  "coverage/",
  "*.log",
  ".DS_Store",
];

export interface ResolveVcsOptions {
  /** auto（默认）/ native / shadow / off */
  mode?: VcsConfigMode;
  platform?: NodeJS.Platform;
  /** 是否探测到 git 可执行文件（测试注入） */
  gitAvailable?: () => boolean;
}

/** 探测一个目录是否是 git 仓库根（`.git` 为目录或文件均可） */
export function isGitRepo(dir: string): boolean {
  try {
    const p = path.join(dir, ".git");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 解析当前工作区该用哪种追踪方式。
 *
 * - `off`：显式关闭
 * - `native`：项目本身是 git 仓库
 * - `shadow`：项目不是 git 仓库（或用户显式要求）
 * - 自动模式：优先 native，其次 shadow
 */
export function resolveVcsPlan(
  workspace: string,
  opts: ResolveVcsOptions = {},
): VcsPlan {
  const workTree = path.resolve(workspace);
  const requested = opts.mode ?? "auto";

  if (requested === "off") {
    return { mode: "off", workTree, gitDir: null, reason: "变更追踪已关闭" };
  }

  const gitOk = opts.gitAvailable ? opts.gitAvailable() : true;
  if (!gitOk) {
    return {
      mode: "off",
      workTree,
      gitDir: null,
      reason: "未找到 git 可执行文件（写入冲突检测仍可用）",
    };
  }

  const native = isGitRepo(workTree);
  if (requested === "native" || requested === "auto") {
    if (native) {
      return {
        mode: "native",
        workTree,
        gitDir: path.join(workTree, ".git"),
        reason: "项目已是 git 仓库：使用独立 index 与 refs/agent/*，不影响你的分支与暂存区",
      };
    }
    if (requested === "native") {
      return {
        mode: "off",
        workTree,
        gitDir: null,
        reason: "要求 native 模式，但工作区不是 git 仓库",
      };
    }
  }

  // shadow（含 auto 且不是 git 仓库）
  return {
    mode: "shadow",
    workTree,
    gitDir: path.join(workTree, SHADOW_DIR),
    reason: "工作区不是 git 仓库：在 .agent/vcs 建立影子仓库（不影响项目目录）",
  };
}

/** 会话的 git ref 名 */
export function agentRef(sessionId: string): string {
  // 会话 id 里可能有 / 之类的字符，统一替换掉，避免非法 ref
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "-") || "default";
  return `refs/agent/${safe}`;
}

/** 会话的独立 index 路径（避免与用户暂存区互相破坏） */
export function sessionIndexPath(plan: VcsPlan, sessionId: string): string {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "-") || "default";
  if (plan.mode === "native" && plan.gitDir) {
    // 放进 .git 内：连 untracked 列表都不会出现
    return path.join(plan.gitDir, "zqagent", `${safe}.index`);
  }
  const gitDir = plan.gitDir ?? path.join(plan.workTree, SHADOW_DIR);
  return path.join(gitDir, `${safe}.index`);
}
