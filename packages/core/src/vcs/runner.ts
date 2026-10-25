/**
 * git 调用封装
 *
 * 所有调用都显式给出 `--git-dir` / `--work-tree` / `GIT_INDEX_FILE`：
 * - 不依赖当前进程的 cwd，避免多会话互相影响；
 * - 不碰用户的 `.git/index`，两个会话同时 write-tree 也不会破坏暂存区；
 * - 用参数数组传入（execAsync 不经 shell），会话 id / 路径里的特殊字符不会被解释。
 */
import { execAsync } from "../tools/execAsync.js";
import type { VcsPlan } from "./plan.js";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 启动失败（git 不存在等） */
  error?: string;
}

export interface GitRunOptions {
  /** 独立 index 文件路径；不传则用 git 默认 index */
  index?: string;
  /** 覆盖工作目录（默认 workTree） */
  cwd?: string;
  /** 写入 stdin（如 commit 消息） */
  input?: string;
  timeoutMs?: number;
  /**
   * 不注入 GIT_DIR / GIT_WORK_TREE。
   *
   * `git init --bare <dir>` 会因为已存在的 GIT_WORK_TREE 直接报
   * `fatal: GIT_WORK_TREE not allowed without specifying GIT_DIR`，
   * 所以初始化必须走这个模式。
   */
  isolated?: boolean;
}

/** 统一注入的作者信息：避免用户 machine 未配置 user.name/email 时提交失败 */
const IDENTITY = [
  "-c",
  "user.name=zqagent",
  "-c",
  "user.email=zqagent@local",
  "-c",
  "commit.gpgsign=false",
];

/**
 * 执行一条 git 命令。
 *
 * 失败不抛异常——调用方需要区分「没有提交」「有冲突」「git 不可用」，
 * 统一按 status/stderr 判断比 try/catch 更好组合。
 */
export async function runGit(
  plan: VcsPlan,
  args: string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  if (!plan.gitDir) {
    return { status: null, stdout: "", stderr: "", error: "变更追踪未启用" };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 固定输出编码，避免非 ASCII 路径被转义成八进制
    GIT_PAGER: "cat",
  };
  if (!opts.isolated) {
    env.GIT_DIR = plan.gitDir;
    env.GIT_WORK_TREE = plan.workTree;
  } else {
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
  }
  if (opts.index) env.GIT_INDEX_FILE = opts.index;
  // 不允许 git 去交互式要密码（fetch/push 等场景在 agent 侧不应发生）
  env.GIT_TERMINAL_PROMPT = "0";

  const result = await execAsync("git", [...IDENTITY, ...args], {
    cwd: opts.cwd ?? plan.workTree,
    env,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    timeoutMs: opts.timeoutMs ?? 30000,
  });

  return {
    status: result.status,
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
    ...(result.error ? { error: String(result.error.message ?? result.error) } : {}),
  };
}

/** 成功判断：status === 0 */
export function gitOk(r: GitResult): boolean {
  return r.status === 0;
}

/** 取 stderr/stdout 的首行，用于错误提示 */
export function gitMessage(r: GitResult): string {
  const text = (r.stderr || r.stdout || r.error || "").trim();
  return text.split("\n").filter((l) => l.trim())[0] ?? "未知错误";
}
