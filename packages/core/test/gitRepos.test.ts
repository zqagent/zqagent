/**
 * 多仓库工作区单测：扫描工作区内的 git 仓库（根 + 子目录），
 * 以及按 repo 参数把只读查询 / 写操作定位到指定仓库。
 *
 * 覆盖 tools/git.ts 的 scanGitRepos 与 projectOps 包装。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  projectGitCommit,
  projectGitLog,
  projectGitRepos,
  projectGitStage,
  projectGitStatus,
} from "../src/server/projectOps.js";

let workspace: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "tester"]);
}

type Repos = {
  root?: string;
  repos?: Array<{ path: string; name: string; branch?: string; detached?: boolean }>;
  truncated?: boolean;
  error?: string;
};
type Status = {
  repo?: string;
  entries?: Array<{ file: string; index?: string; worktree?: string }>;
  error?: string;
};
type Op = { ok?: boolean; error?: string };
type Log = { repo?: string; commits?: Array<{ subject?: string }>; error?: string };

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitrepos-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("projectGitRepos", () => {
  it("发现根仓库与各级子目录仓库（根排在第一位）", async () => {
    initRepo(workspace);
    initRepo(path.join(workspace, "nested-a"));
    initRepo(path.join(workspace, "deep", "nested-b"));
    // node_modules 等依赖目录不扫描
    initRepo(path.join(workspace, "node_modules", "hidden"));

    const r = (await projectGitRepos(workspace)) as Repos;
    expect(r.error).toBeUndefined();
    expect(r.repos?.map((x) => x.path)).toEqual(["", "deep/nested-b", "nested-a"]);
    const root = r.repos?.[0];
    expect(root?.name).toBe(path.basename(workspace));
    expect(root?.branch).toBe(git(workspace, ["symbolic-ref", "--short", "HEAD"]).trim());
  }, 20000);

  it("工作区根不是仓库时只返回子目录仓库", async () => {
    initRepo(path.join(workspace, "repo-a"));

    const r = (await projectGitRepos(workspace)) as Repos;
    expect(r.repos?.map((x) => x.path)).toEqual(["repo-a"]);
    expect(r.repos?.[0]?.branch).toBe(git(path.join(workspace, "repo-a"), ["symbolic-ref", "--short", "HEAD"]).trim());
  });

  it("没有仓库时返回空列表（不报错）", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "x\n");
    const r = (await projectGitRepos(workspace)) as Repos;
    expect(r.repos).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});

describe("按 repo 定位仓库", () => {
  it("status / stage / commit / log 作用于指定子仓库", async () => {
    initRepo(workspace);
    const nested = path.join(workspace, "nested");
    initRepo(nested);
    fs.writeFileSync(path.join(nested, "n.txt"), "x\n");

    const before = (await projectGitStatus(workspace, undefined, "nested")) as Status;
    expect(before.repo && fs.realpathSync(before.repo)).toBe(fs.realpathSync(nested));
    expect(before.entries?.some((e) => e.file === "n.txt")).toBe(true);

    // paths 是工作区相对路径；repo 指定执行目录
    const staged = (await projectGitStage(workspace, ["nested/n.txt"], "nested")) as Op;
    expect(staged.ok).toBe(true);
    const afterStage = (await projectGitStatus(workspace, undefined, "nested")) as Status;
    expect(afterStage.entries?.find((e) => e.file === "n.txt")?.index).toBe("A");

    const committed = (await projectGitCommit(workspace, "nested commit", "nested")) as Op;
    expect(committed.ok).toBe(true);

    const log = (await projectGitLog(workspace, undefined, 10, "nested")) as Log;
    expect(log.repo && fs.realpathSync(log.repo)).toBe(fs.realpathSync(nested));
    expect(log.commits?.[0]?.subject).toBe("nested commit");

    // 根仓库没有新提交
    const rootLog = (await projectGitLog(workspace, undefined, 10)) as Log;
    expect(rootLog.commits ?? []).toHaveLength(0);
  }, 20000);

  it("repo 越界（../）时忽略，退回工作区根", async () => {
    initRepo(workspace);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitoutside-"));
    try {
      initRepo(outside);
      const r = (await projectGitStatus(workspace, undefined, `../${path.basename(outside)}`)) as Status;
      expect(r.repo && fs.realpathSync(r.repo)).toBe(fs.realpathSync(workspace));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 20000);
});
