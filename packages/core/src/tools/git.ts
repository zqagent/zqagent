/**
 * Git 工具
 *
 * - 只读工具（注册给 Agent）：git_log / git_status / git_diff；
 * - 控制台 Git 面板（**不**注册，经 REST / 舰队指令调用，见文件末尾）：
 *   只读 git_branches / git_refs / git_show，
 *   写操作 git_fetch / git_stage / git_unstage / git_commit / git_checkout / git_pull / git_push。
 *
 * 要点：
 * - 全部用异步 execAsync（参数数组），用户参数不经 shell 解释，杜绝命令注入；
 * - 统一带 `-c core.quotepath=false`，避免非 ASCII 文件名被输出成八进制转义；
 * - path 指向子目录里的另一个仓库时，用 `git -C <path> rev-parse --show-toplevel`
 *   自动定位到最近的仓库根，而不是永远以工作区根为准。
 * - 工作区可包含多个仓库（根 + 子目录），`repo` 参数（工作区相对路径）用于
 *   显式选定仓库；`scanGitRepos` 供控制台面板列出这些仓库。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "./ToolRegistry.js";
import { execAsync } from "./execAsync.js";
import { decodeOutput } from "./shell.js";
import { isInsideRelative } from "./pathSafety.js";

interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** 运行 git（带 core.quotepath=false，禁用交互式凭据提示） */
async function runGit(repoDir: string, args: string[], timeout = 15000): Promise<GitRunResult> {
  const res = await execAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repoDir,
    timeoutMs: timeout,
    maxBuffer: 1024 * 1024 * 5,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: res.status ?? 1,
    stdout: decodeOutput(res.stdout),
    stderr: decodeOutput(res.stderr) || (res.error?.message ?? ""),
  };
}

/**
 * 定位仓库根。
 *
 * pathArg 给出时，从它（文件取其所在目录）向上找最近的 git 仓库；
 * 找不到就回退到工作区根。这样 path 指向子目录里的另一个仓库也能工作。
 */
async function resolveRepoRoot(workspace: string, pathArg?: string): Promise<string> {
  let dir = workspace;
  if (pathArg) {
    const abs = path.resolve(workspace, pathArg);
    try {
      dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      dir = abs; // 不存在时交给 git 报错并回退
    }
  }
  const res = await runGit(dir, ["rev-parse", "--show-toplevel"], 10000);
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  return workspace;
}

/**
 * repo 参数（工作区相对路径，空 = 工作区根）→ 绝对路径。
 *
 * 只接受落在工作区内的路径（避免面板传 `../` 越界操作工作区外的仓库）；
 * 越界或类型不对时返回 undefined，回退到「按 path / 工作区根定位」的旧行为。
 */
function repoDirArg(workspace: string, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  const base = path.resolve(workspace);
  const abs = path.resolve(base, v);
  const rel = path.relative(base, abs);
  if (!isInsideRelative(rel)) return undefined;
  return abs;
}

/** 把 path 参数转成相对于仓库根 pathspec（供 `--` 使用） */
function toPathspec(repoRoot: string, workspace: string, pathArg?: string): string | null {
  if (!pathArg) return null;
  const abs = path.resolve(workspace, pathArg);
  let rel = path.relative(repoRoot, abs);
  if (rel === "") return ".";
  if (!isInsideRelative(rel)) {
    // repoRoot（git --show-toplevel 输出）与 abs 的路径形式可能不一致：
    // 符号链接（macOS /var→/private/var）、Windows 短路径/大小写/盘符形式等。
    // 用 realpath 归一后再算一次；仍无法表达就返回 null（退回整仓，而非报错）。
    try {
      const realRepo = fs.realpathSync(repoRoot);
      const realAbs = fs.realpathSync(abs);
      const rel2 = path.relative(realRepo, realAbs);
      if (rel2 === "") return ".";
      if (isInsideRelative(rel2)) return rel2;
    } catch {
      /* 路径不存在等：忽略 */
    }
    return null;
  }
  return rel;
}

/** git_log — 提交历史 */
export function makeGitLog(workspace: string) {
  return async function git_log(args: Record<string, unknown>) {
    const filePath = args.path ? String(args.path) : undefined;
    const maxCount = Math.min(Number(args.max_count ?? 20), 200);

    if (maxCount < 1) return { error: "max_count 必须 >= 1" };

    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo) ?? filePath);
    const cmd = [
      "log",
      `-n${maxCount}`,
      "--pretty=format:%h%x1f%an%x1f%ad%x1f%s",
      "--date=short",
    ];
    const pathspec = toPathspec(repo, workspace, filePath);
    if (pathspec) cmd.push("--", pathspec);

    const res = await runGit(repo, cmd);
    if (res.status !== 0) {
      return { error: (res.stderr || "git log failed").trim().slice(0, 300) };
    }
    const commits = res.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0)
      .map((line) => {
        const parts = line.split("\x1f");
        if (parts.length === 4) {
          return { hash: parts[0], author: parts[1], date: parts[2], subject: parts[3] };
        }
        return { raw: line };
      });
    return { repo, count: commits.length, commits };
  };
}

/** git_status — 工作区状态 */
export function makeGitStatus(workspace: string) {
  return async function git_status(args: Record<string, unknown>) {
    const filePath = args.path ? String(args.path) : undefined;
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo) ?? filePath);
    const res = await runGit(repo, ["status", "--porcelain"], 10000);

    if (res.status !== 0) {
      const msg = res.stderr;
      if (msg.toLowerCase().includes("not a git repository")) {
        return { error: "不是 git 仓库" };
      }
      return { error: (msg || "git status failed").trim().slice(0, 300) };
    }

    // 注意：不能整体 trim —— porcelain 第一行常以空格开头（" M path"），
    // trim 会吃掉它，随后按固定宽度切列就会多切掉路径首字符。
    const lines = res.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0);
    const entries = lines.map((line) => {
      const status = line.slice(0, 2).trim();
      // 两列分别保留：索引（暂存区）与工作区状态，供控制台 Git 面板区分
      // 「已暂存」与「未暂存」（trim 后的 status 无法表达这一点）
      const index = line.slice(0, 1).trim();
      const worktree = line.slice(1, 2).trim();
      let file = line.slice(3);
      // 重命名形如 "R  old -> new"，取新路径
      const renameArrow = file.indexOf(" -> ");
      if (renameArrow >= 0) file = file.slice(renameArrow + 4);
      return { status, file, index, worktree };
    });
    return { repo, clean: entries.length === 0, entries, count: entries.length };
  };
}

/** git_diff — 差异对比 */
export function makeGitDiff(workspace: string) {
  return async function git_diff(args: Record<string, unknown>) {
    const staged = args.staged === true;
    const filePath = args.path ? String(args.path) : undefined;
    const contextLines = Math.min(Number(args.context ?? 3), 10);

    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo) ?? filePath);
    const cmd = ["diff"];
    if (staged) cmd.push("--staged");
    cmd.push(`-U${contextLines}`);
    const pathspec = toPathspec(repo, workspace, filePath);
    if (pathspec) cmd.push("--", pathspec);

    const res = await runGit(repo, cmd);
    if (res.status !== 0) {
      return { error: (res.stderr || "git diff failed").trim().slice(0, 300) };
    }
    return {
      repo,
      staged,
      path: filePath ?? null,
      diff: res.stdout.slice(0, 50000),
      truncated: res.stdout.length > 50000,
    };
  };
}

/** 注册 Git 工具 */
export function registerGitTools(registry: ToolRegistry, workspace: string): void {
  const gitLog = makeGitLog(workspace);
  registry.register(
    (args) => gitLog(args),
    { category: "git", riskLevel: "low", capabilities: ["git"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "git_log",
        description: "查看最近的 git 提交历史 (hash, 作者, 日期, 主题)。可选地限定到某个路径（该路径所在仓库会被自动定位）。用于在编辑前了解代码的演进过程。只读。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "可选：限定到某个文件或目录（并按其所在仓库查询）" },
            max_count: { type: "integer", description: "返回多少条提交 (默认 20，最大 200)" },
          },
        },
      },
    },
  );

  const gitStatus = makeGitStatus(workspace);
  registry.register(
    (args) => gitStatus(args),
    { category: "git", riskLevel: "low", capabilities: ["git"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "查看工作区 git 状态 (已修改、已暂存、未跟踪的文件)。只读。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "可选：优先查询该路径所在的仓库（默认工作区根）" },
          },
        },
      },
    },
  );

  const gitDiff = makeGitDiff(workspace);
  registry.register(
    (args) => gitDiff(args),
    { category: "git", riskLevel: "low", capabilities: ["git"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "查看工作区与暂存区或最近提交之间的差异。可选地查看已暂存的更改。只读。",
        parameters: {
          type: "object",
          properties: {
            staged: { type: "boolean", description: "是否查看已暂存的更改 (默认 false)" },
            path: { type: "string", description: "可选：限定到某个文件（并按其在仓库中的路径）" },
            context: { type: "integer", description: "上下文行数 (默认 3)" },
          },
        },
      },
    },
  );
}

/* ===================== Git 写操作（控制台 Git 面板） =====================
 *
 * 与只读工具分开：以下函数**不**注册进 ToolRegistry（Agent 不能调用），
 * 只由 REST / 舰队指令转发控制台面板上的手动操作。参数全部经 runGit 的
 * 参数数组执行，分支名/提交说明/路径都不经 shell 解释。
 */

/** 写操作结果：ok=false 时 error 为可直接展示给用户的原因 */
export interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** 回传输出上限（面板只展示 git 的一两行提示） */
const OP_OUTPUT_LIMIT = 8000;

function opResult(res: GitRunResult): GitOpResult {
  const stdout = res.stdout.trim().slice(-OP_OUTPUT_LIMIT);
  const stderr = res.stderr.trim().slice(-OP_OUTPUT_LIMIT);
  if (res.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      error: (stderr || stdout || "git 命令失败").slice(0, 500),
    };
  }
  return { ok: true, stdout, stderr };
}

function failed(error: string): GitOpResult {
  return { ok: false, stdout: "", stderr: "", error };
}

/** 分支名校验（拒绝空、选项注入与 git 非法字符）；返回 null 表示可用 */
export function gitRefProblem(name: string): string | null {
  const v = name.trim();
  if (!v) return "分支名不能为空";
  if (v.startsWith("-")) return "分支名不能以 - 开头";
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(v)) return "分支名包含空白或非法字符";
  if (v.includes("..") || v.includes("//") || v.endsWith("/") || v.endsWith(".lock")) {
    return "分支名不合法";
  }
  return null;
}

/** payload 里的 paths（字符串或数组）→ 去空白后的非空数组 */
function normalizePaths(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((p) => String(p).trim()).filter((p) => p.length > 0);
}

/** 工作区相对路径 → 仓库内 pathspec（无法表达时丢弃） */
function toPathspecs(repoRoot: string, workspace: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const spec = toPathspec(repoRoot, workspace, p);
    if (spec) out.push(spec);
  }
  return out;
}

/** git_branches — 本地分支列表 + 当前分支（detached 时 current 为短 hash） */
export function makeGitBranches(workspace: string) {
  return async function git_branches(args: Record<string, unknown>) {
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const list = await runGit(
      repo,
      [
        "for-each-ref",
        "--sort=-committerdate",
        // 制表符作字段分隔（git 的 --format 不支持 %x1f 之类的十六进制转义）
        "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)",
        "refs/heads",
      ],
      10000,
    );
    if (list.status !== 0) {
      const msg = list.stderr;
      if (msg.toLowerCase().includes("not a git repository")) return { error: "不是 git 仓库" };
      return { error: (msg || "git branch failed").trim().slice(0, 300) };
    }

    // 空仓库（尚无提交）时 refs/heads 为空，但 symbolic-ref 仍能给出分支名
    const head = await runGit(repo, ["symbolic-ref", "--short", "HEAD"], 10000);
    const detached = head.status !== 0;
    let current = detached ? "" : head.stdout.trim();
    if (detached) {
      const rev = await runGit(repo, ["rev-parse", "--short", "HEAD"], 10000);
      current = rev.status === 0 ? rev.stdout.trim() : "";
    }

    const branches = list.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0)
      .map((line) => {
        const [name, headMark, upstream] = line.split("\t");
        return {
          name,
          current: headMark?.trim() === "*" || (!!current && name === current),
          ...(upstream ? { upstream } : {}),
        };
      });
    return { repo, current, detached, branches };
  };
}

/** 提交标识（hash / ref 名）校验：拒绝空、选项注入与 git 非法字符；返回 null 表示可用 */
export function gitObjectProblem(name: string): string | null {
  const v = name.trim();
  if (!v) return "提交标识不能为空";
  if (v.startsWith("-")) return "提交标识不能以 - 开头";
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(v)) return "提交标识包含空白或非法字符";
  if (v.includes("..") || v.includes("//") || v.endsWith("/") || v.endsWith(".lock")) {
    return "提交标识不合法";
  }
  return null;
}

/**
 * git_refs — 引用列表（控制台 Git 面板）
 *
 * 一次返回本地分支 / 远程分支 / 标签三组，供面板分组展示与切换。
 * 远程分支与标签只有在 `git fetch` 之后才是服务端的最新状态（见 makeGitFetch）。
 */
export function makeGitRefs(workspace: string) {
  return async function git_refs(args: Record<string, unknown>) {
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const list = await runGit(
      repo,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(objectname:short)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      15000,
    );
    if (list.status !== 0) {
      const msg = list.stderr;
      if (msg.toLowerCase().includes("not a git repository")) return { error: "不是 git 仓库" };
      return { error: (msg || "git for-each-ref failed").trim().slice(0, 300) };
    }

    const head = await runGit(repo, ["symbolic-ref", "--short", "HEAD"], 10000);
    const detached = head.status !== 0;
    let current = detached ? "" : head.stdout.trim();
    if (detached) {
      const rev = await runGit(repo, ["rev-parse", "--short", "HEAD"], 10000);
      current = rev.status === 0 ? rev.stdout.trim() : "";
    }

    const local: Array<{ name: string; current?: boolean; upstream?: string }> = [];
    const remote: Array<{ name: string }> = [];
    const tags: Array<{ name: string; target?: string }> = [];

    for (const raw of list.stdout.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line) continue;
      const [refname, short, headMark, upstream, target] = line.split("\t");
      if (!refname || !short) continue;
      if (refname.startsWith("refs/heads/")) {
        local.push({
          name: short,
          current: headMark?.trim() === "*" || (!!current && short === current),
          ...(upstream ? { upstream } : {}),
        });
        continue;
      }
      if (refname.startsWith("refs/remotes/")) {
        // origin/HEAD 之类的符号引用不是真实分支
        // （refname 是完整名 refs/remotes/origin/HEAD，short 只有 "origin"）
        if (refname.endsWith("/HEAD")) continue;
        remote.push({ name: short });
        continue;
      }
      if (refname.startsWith("refs/tags/")) {
        tags.push({ name: short, ...(target ? { target } : {}) });
      }
    }

    return { repo, current, detached, local, remote, tags };
  };
}

/**
 * git_show — 单次提交详情（meta + 变更文件 + diff）
 *
 * path 省略时返回整个提交的 diff（截断 50000 字符）；给出 path 时只返回该文件
 * 在此提交中的 diff（相对第一父提交，merge commit 也能给出可读结果）。
 */
export function makeGitShow(workspace: string) {
  return async function git_show(args: Record<string, unknown>) {
    const hash = String(args.hash ?? "").trim();
    const problem = gitObjectProblem(hash);
    if (problem) return { error: problem };
    const filePath = args.path ? String(args.path) : undefined;
    const contextLines = Math.min(Number(args.context ?? 3), 10);

    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo) ?? filePath);

    const metaRes = await runGit(
      repo,
      [
        "show",
        "-s",
        "--first-parent",
        "--date=iso-strict",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b",
        hash,
      ],
      15000,
    );
    if (metaRes.status !== 0) {
      return { error: (metaRes.stderr || "git show failed").trim().slice(0, 300) };
    }
    const parts = metaRes.stdout.split("\x1f");
    const commit = {
      hash: (parts[0] ?? "").trim(),
      short: (parts[1] ?? "").trim(),
      author: (parts[2] ?? "").trim(),
      authorEmail: (parts[3] ?? "").trim(),
      date: (parts[4] ?? "").trim(),
      subject: (parts[5] ?? "").trim(),
      body: (parts.slice(6).join("\x1f") ?? "").trim(),
    };
    if (!commit.hash) return { error: "未找到该提交" };

    const filesRes = await runGit(
      repo,
      ["show", "--name-status", "--format=", "--first-parent", commit.hash],
      15000,
    );
    const files = filesRes.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const cols = line.split("\t");
        // 重命名 / 复制形如 "R100\told\tnew"，取新路径
        const status = (cols[0] ?? "").trim();
        const file = (cols[cols.length - 1] ?? "").trim();
        return { status, file };
      })
      .filter((f) => f.file.length > 0);

    const cmd = ["show", "--format=", "--first-parent", `-U${contextLines}`, commit.hash];
    const pathspec = toPathspec(repo, workspace, filePath);
    if (pathspec) cmd.push("--", pathspec);
    const diffRes = await runGit(repo, cmd, 20000);
    if (diffRes.status !== 0) {
      return { error: (diffRes.stderr || "git show diff failed").trim().slice(0, 300) };
    }

    return {
      repo,
      commit,
      files,
      path: filePath ?? null,
      diff: diffRes.stdout.slice(0, 50000),
      truncated: diffRes.stdout.length > 50000,
    };
  };
}

/** git_stage — 暂存文件（paths 为空 = 全部改动） */
export function makeGitStage(workspace: string) {
  return async function git_stage(args: Record<string, unknown>) {
    const paths = normalizePaths(args.paths);
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const specs = paths.length > 0 ? toPathspecs(repo, workspace, paths) : [];
    if (paths.length > 0 && specs.length === 0) return failed("路径不在仓库内");
    const cmd = specs.length > 0 ? ["add", "--", ...specs] : ["add", "-A"];
    return opResult(await runGit(repo, cmd, 30000));
  };
}

/** git_unstage — 取消暂存（paths 为空 = 全部） */
export function makeGitUnstage(workspace: string) {
  return async function git_unstage(args: Record<string, unknown>) {
    const paths = normalizePaths(args.paths);
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const specs = paths.length > 0 ? toPathspecs(repo, workspace, paths) : [];
    if (paths.length > 0 && specs.length === 0) return failed("路径不在仓库内");
    const cmd = specs.length > 0 ? ["restore", "--staged", "--", ...specs] : ["reset", "-q"];
    return opResult(await runGit(repo, cmd, 30000));
  };
}

/** git_commit — 提交已暂存内容 */
export function makeGitCommit(workspace: string) {
  return async function git_commit(args: Record<string, unknown>) {
    const message = String(args.message ?? "").trim();
    if (!message) return failed("提交说明不能为空");
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    return opResult(await runGit(repo, ["commit", "-m", message], 60000));
  };
}

/** git_checkout — 切换分支（create=true 时新建并切换） */
export function makeGitCheckout(workspace: string) {
  return async function git_checkout(args: Record<string, unknown>) {
    const branch = String(args.branch ?? "").trim();
    const problem = gitRefProblem(branch);
    if (problem) return failed(problem);
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const cmd = args.create === true ? ["checkout", "-b", branch] : ["checkout", branch];
    return opResult(await runGit(repo, cmd, 30000));
  };
}

/** git_pull — 拉取当前分支的上游 */
export function makeGitPull(workspace: string) {
  return async function git_pull(args: Record<string, unknown>) {
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    return opResult(await runGit(repo, ["pull"], 60000));
  };
}

/** git_push — 推送当前分支（无 upstream 且存在 origin 时按首次推送补 -u） */
export function makeGitPush(workspace: string) {
  return async function git_push(args: Record<string, unknown>) {
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const upstream = await runGit(
      repo,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      10000,
    );
    if (upstream.status !== 0) {
      const head = await runGit(repo, ["symbolic-ref", "--short", "HEAD"], 10000);
      const remotes = await runGit(repo, ["remote"], 10000);
      const hasOrigin =
        remotes.status === 0 && remotes.stdout.split("\n").some((r) => r.trim() === "origin");
      if (head.status === 0 && hasOrigin) {
        return opResult(await runGit(repo, ["push", "-u", "origin", head.stdout.trim()], 60000));
      }
    }
    return opResult(await runGit(repo, ["push"], 60000));
  };
}

/** git_fetch — 刷新服务端分支与标签（--all --prune --tags） */
export function makeGitFetch(workspace: string) {
  return async function git_fetch(args: Record<string, unknown>) {
    const repo = await resolveRepoRoot(workspace, repoDirArg(workspace, args.repo));
    const remotes = await runGit(repo, ["remote"], 10000);
    if (remotes.status !== 0) {
      const msg = remotes.stderr;
      if (msg.toLowerCase().includes("not a git repository")) return failed("不是 git 仓库");
      return failed((msg || "git remote failed").trim().slice(0, 300));
    }
    if (!remotes.stdout.trim()) return failed("未配置远端仓库");
    return opResult(await runGit(repo, ["fetch", "--all", "--prune", "--tags"], 60000));
  };
}

/* ===================== 多仓库扫描（控制台 Git 面板） =====================
 *
 * 工作区根可能不是仓库，或只是若干独立仓库的父目录（子模块 / 多仓库工程）。
 * 面板需要先列出这些仓库，再让用户选定一个进行操作。
 * 扫描只读 `.git` 元数据（不启动 git 进程），并限制深度与目录数，
 * 避免在超大工作区上遍历过久、拖住节点事件循环。
 */

/** 扫描时跳过的目录（依赖 / 其他 VCS 元数据；.git 不进入，避免遍历对象库） */
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** 默认扫描深度（工作区根记为 0）与目录数上限 */
const SCAN_DEFAULT_DEPTH = 3;
const SCAN_MAX_DIRS = 2000;

export interface GitRepoInfo {
  /** 相对工作区的路径；根仓库为 "" */
  path: string;
  /** 目录名（根仓库为工作区目录名） */
  name: string;
  /** 当前分支；detached 时为短 hash */
  branch?: string;
  detached?: boolean;
}

/** 读取仓库 HEAD 的当前分支（.git 为文件时表示子模块 / worktree） */
function readRepoHead(repoDir: string): { branch?: string; detached?: boolean } {
  const dotGit = path.join(repoDir, ".git");
  try {
    let headFile: string;
    if (fs.statSync(dotGit).isDirectory()) {
      headFile = path.join(dotGit, "HEAD");
    } else {
      const raw = fs.readFileSync(dotGit, "utf-8");
      const m = /^gitdir:\s*(.+)$/m.exec(raw);
      if (!m) return {};
      headFile = path.join(path.resolve(repoDir, m[1].trim()), "HEAD");
    }
    const head = fs.readFileSync(headFile, "utf-8").trim();
    const prefix = "ref: refs/heads/";
    if (head.startsWith(prefix)) return { branch: head.slice(prefix.length), detached: false };
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: head.slice(0, 7), detached: true };
  } catch {
    /* 空仓库（无 HEAD）/ 权限不足：忽略分支信息 */
  }
  return {};
}

/**
 * 扫描工作区及其子目录中的 git 仓库。
 *
 * 遇到仓库后仍继续向下扫描：子模块与「仓库里嵌套独立仓库」的工程都能被发现。
 * 根仓库排在第一位，其余按相对路径排序。
 */
export function scanGitRepos(
  workspace: string,
  depth = SCAN_DEFAULT_DEPTH,
): { repos: GitRepoInfo[]; truncated?: boolean } {
  const root = path.resolve(workspace);
  const maxDepth = Number.isFinite(depth)
    ? Math.min(Math.max(Math.floor(depth), 0), 6)
    : SCAN_DEFAULT_DEPTH;
  const repos: GitRepoInfo[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    const { dir, depth: d } = stack.pop()!;
    visited += 1;
    if (visited > SCAN_MAX_DIRS) {
      truncated = true;
      break;
    }
    const rel = path.relative(root, dir).split(path.sep).join("/");
    if (fs.existsSync(path.join(dir, ".git"))) {
      repos.push({
        path: rel,
        name: rel ? path.basename(dir) : path.basename(root),
        ...readRepoHead(dir),
      });
    }
    if (d >= maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 权限不足等：跳过该目录
    }
    for (const e of entries) {
      // isDirectory() 对符号链接目录为 false，天然避免环路
      if (!e.isDirectory() || SCAN_SKIP_DIRS.has(e.name)) continue;
      stack.push({ dir: path.join(dir, e.name), depth: d + 1 });
    }
  }

  repos.sort((a, b) =>
    a.path === "" ? -1 : b.path === "" ? 1 : a.path.localeCompare(b.path),
  );
  return { repos, ...(truncated ? { truncated: true } : {}) };
}

/** git_repos — 列出工作区内的所有 git 仓库（控制台 Git 面板的仓库选择器） */
export function makeGitRepos(workspace: string) {
  return async function git_repos(args: Record<string, unknown>) {
    const root = path.resolve(workspace);
    try {
      if (!fs.statSync(root).isDirectory()) return { root, repos: [], error: "工作区不是目录" };
    } catch {
      return { root, repos: [], error: "工作区目录不存在" };
    }
    const rawDepth = Number(args.depth);
    const depth = Number.isFinite(rawDepth) ? rawDepth : SCAN_DEFAULT_DEPTH;
    return { root, ...scanGitRepos(root, depth) };
  };
}
