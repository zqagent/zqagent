/**
 * 项目操作：终端命令执行 + Git 操作（面向控制台）
 *
 * - runProjectCommand：在工作区目录执行一条 shell 命令（超时/输出上限）。
 * - gitStatus / gitDiff / gitLog / gitShow / gitRefs：复用 tools/git.ts 的只读实现，定位工作区仓库。
 * - git 写操作（branches/fetch/stage/unstage/commit/checkout/pull/push）：同样复用
 *   tools/git.ts，由用户在控制台 Git 面板上手动触发（不注册为 Agent 工具）。
 *
 * 供 REST 与节点管理指令共用。终端的越权面由节点归属（管理员/项目）约束，
 * 命令在工作区内执行。
 */
import * as os from "os";
import * as path from "path";
import {
  resolveShellSpec,
  wrapCommand,
  type ShellSpec,
} from "../tools/shellRuntime.js";
import { decodeOutput } from "../tools/shell.js";
import { execAsync } from "../tools/execAsync.js";
import {
  makeGitStatus,
  makeGitDiff,
  makeGitBranches,
  makeGitLog,
  makeGitShow,
  makeGitRefs,
  makeGitFetch,
  makeGitStage,
  makeGitUnstage,
  makeGitCommit,
  makeGitCheckout,
  makeGitPull,
  makeGitPush,
  makeGitRepos,
} from "../tools/git.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  timedOut?: boolean;
}

const MAX_STDOUT = 20000;
const MAX_STDERR = 10000;
const MAX_BUFFER = 1024 * 1024 * 5;

/** 解析实际执行的 shell（与 tools/shell.ts 一致；default 时按平台兜底） */
function resolveInvocation(
  spec: ShellSpec,
  prepared: string,
): { file: string; argv: string[] } {
  if (spec.file !== null) return { file: spec.file, argv: spec.buildArgs(prepared) };
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    return { file: comspec, argv: ["/d", "/s", "/c", prepared] };
  }
  return { file: "/bin/sh", argv: ["-c", prepared] };
}

/** 工作区根：未配置时回退用户主目录（终端可用性优先） */
function workRoot(workspaceRoot: string | null | undefined): string {
  const r = (workspaceRoot ?? "").trim();
  return r ? path.resolve(r) : os.homedir();
}

/** 执行一条命令（前台，超时默认 60s / 上限 300s，输出截断） */
export async function runProjectCommand(
  workspaceRoot: string | null | undefined,
  command: string,
  timeoutSeconds?: number,
): Promise<ExecResult> {
  const cmd = String(command ?? "");
  if (!cmd.trim()) throw new Error("命令不能为空");
  const cwd = workRoot(workspaceRoot);

  const spec = resolveShellSpec();
  const prepared = wrapCommand(spec.kind, cmd);
  const { file, argv } = resolveInvocation(spec, prepared);

  const raw = Number(timeoutSeconds ?? 60);
  const sec = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 300) : 60;

  const res = await execAsync(file, argv, {
    cwd,
    timeoutMs: sec * 1000,
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });

  const stdout = decodeOutput(res.stdout).slice(-MAX_STDOUT);
  const stderr = decodeOutput(res.stderr).slice(-MAX_STDERR);

  if (res.error && !res.timedOut) {
    return { stdout, stderr: stderr || res.error.message, exitCode: 1, cwd };
  }
  return {
    stdout,
    stderr,
    exitCode: res.status ?? 1,
    cwd,
    ...(res.timedOut ? { timedOut: true } : {}),
  };
}

/** git status（只读） */
export async function projectGitStatus(
  workspaceRoot: string | null | undefined,
  relPath?: string,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitStatus(workRoot(workspaceRoot))({
    ...(relPath ? { path: relPath } : {}),
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git diff（只读） */
export async function projectGitDiff(
  workspaceRoot: string | null | undefined,
  relPath?: string,
  staged?: boolean,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitDiff(workRoot(workspaceRoot))({
    ...(relPath ? { path: relPath } : {}),
    staged: staged === true,
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git 分支列表 + 当前分支 */
export async function projectGitBranches(
  workspaceRoot: string | null | undefined,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitBranches(workRoot(workspaceRoot))({
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git 提交历史（只读） */
export async function projectGitLog(
  workspaceRoot: string | null | undefined,
  relPath?: string,
  maxCount?: number,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitLog(workRoot(workspaceRoot))({
    ...(relPath ? { path: relPath } : {}),
    ...(maxCount ? { max_count: maxCount } : {}),
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git 单次提交详情（meta + 变更文件 + diff；只读） */
export async function projectGitShow(
  workspaceRoot: string | null | undefined,
  hash: string,
  relPath?: string,
  context?: number,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitShow(workRoot(workspaceRoot))({
    hash,
    ...(relPath ? { path: relPath } : {}),
    ...(context ? { context } : {}),
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git 引用列表：本地分支 / 远程分支 / 标签（只读） */
export async function projectGitRefs(
  workspaceRoot: string | null | undefined,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitRefs(workRoot(workspaceRoot))({
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 列出工作区内的所有 git 仓库（含子目录；只读） */
export async function projectGitRepos(
  workspaceRoot: string | null | undefined,
  depth?: number,
): Promise<Record<string, unknown>> {
  return (await makeGitRepos(workRoot(workspaceRoot))({
    ...(depth !== undefined ? { depth } : {}),
  })) as unknown as Record<string, unknown>;
}

/** git fetch：刷新服务端分支与标签 */
export async function projectGitFetch(
  workspaceRoot: string | null | undefined,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitFetch(workRoot(workspaceRoot))({
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 暂存文件（paths 为空 = 全部改动） */
export async function projectGitStage(
  workspaceRoot: string | null | undefined,
  paths?: string[],
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitStage(workRoot(workspaceRoot))({
    paths,
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 取消暂存（paths 为空 = 全部） */
export async function projectGitUnstage(
  workspaceRoot: string | null | undefined,
  paths?: string[],
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitUnstage(workRoot(workspaceRoot))({
    paths,
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 提交已暂存内容 */
export async function projectGitCommit(
  workspaceRoot: string | null | undefined,
  message: string,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitCommit(workRoot(workspaceRoot))({
    message,
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 切换分支（create=true 时新建并切换） */
export async function projectGitCheckout(
  workspaceRoot: string | null | undefined,
  branch: string,
  create?: boolean,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitCheckout(workRoot(workspaceRoot))({
    branch,
    create: create === true,
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 拉取当前分支上游 */
export async function projectGitPull(
  workspaceRoot: string | null | undefined,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitPull(workRoot(workspaceRoot))({
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}

/** 推送当前分支 */
export async function projectGitPush(
  workspaceRoot: string | null | undefined,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  return (await makeGitPush(workRoot(workspaceRoot))({
    ...(repoPath ? { repo: repoPath } : {}),
  })) as unknown as Record<string, unknown>;
}
