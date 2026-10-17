/**
 * Git 面板后端单测：分支列表 / 新建与切换 / 暂存 / 取消暂存 / 提交
 *
 * 覆盖 tools/git.ts 的写操作实现（经 projectOps 包装）：
 * status 的索引列与工作区列、分支名校验（选项注入）、非仓库报错。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  projectGitBranches,
  projectGitStatus,
  projectGitStage,
  projectGitUnstage,
  projectGitCommit,
  projectGitCheckout,
} from "../src/server/projectOps.js";

let repo: string;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitops-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

type Branches = {
  current?: string;
  detached?: boolean;
  branches?: { name: string; current?: boolean }[];
  error?: string;
};
type Status = {
  entries?: { file: string; index?: string; worktree?: string }[];
  error?: string;
};
type Op = { ok?: boolean; error?: string; stdout?: string };

describe("projectGitBranches", () => {
  it("返回当前分支并在列表中标记", async () => {
    const b = (await projectGitBranches(repo)) as Branches;
    expect(b.current).toBeTruthy();
    expect(b.detached).toBe(false);
    expect(b.branches?.some((x) => x.name === b.current && x.current)).toBe(true);
  });

  it("非 git 仓库返回 error（不抛异常）", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ow-plain-"));
    try {
      const b = (await projectGitBranches(plain)) as Branches;
      expect(b.error).toBeTruthy();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("projectGitStage / projectGitUnstage", () => {
  it("暂存后索引列有状态，取消后回到工作区状态", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

    const staged = (await projectGitStage(repo, ["a.txt"])) as Op;
    expect(staged.ok).toBe(true);
    let entry = ((await projectGitStatus(repo)) as Status).entries?.find(
      (e) => e.file === "a.txt",
    );
    expect(entry?.index).toBe("M");
    expect(entry?.worktree).toBe("");

    const un = (await projectGitUnstage(repo, ["a.txt"])) as Op;
    expect(un.ok).toBe(true);
    entry = ((await projectGitStatus(repo)) as Status).entries?.find((e) => e.file === "a.txt");
    expect(entry?.index).toBe("");
    expect(entry?.worktree).toBe("M");
  });

  it("paths 为空时暂存全部改动", async () => {
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    expect(((await projectGitStage(repo)) as Op).ok).toBe(true);
    const entry = ((await projectGitStatus(repo)) as Status).entries?.find(
      (e) => e.file === "b.txt",
    );
    expect(entry?.index).toBe("A");
  });
});

describe("projectGitCommit", () => {
  it("提交已暂存内容后工作区干净", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "three\n");
    await projectGitStage(repo, ["a.txt"]);
    expect(((await projectGitCommit(repo, "update a")) as Op).ok).toBe(true);
    expect(((await projectGitStatus(repo)) as Status).entries?.length ?? 0).toBe(0);
  });

  it("提交说明为空时报错", async () => {
    const r = (await projectGitCommit(repo, "   ")) as Op;
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("projectGitCheckout", () => {
  it("新建分支并切换", async () => {
    expect(((await projectGitCheckout(repo, "feature/x", true)) as Op).ok).toBe(true);
    const b = (await projectGitBranches(repo)) as Branches;
    expect(b.current).toBe("feature/x");
    expect(b.branches?.some((x) => x.name === "feature/x" && x.current)).toBe(true);
  });

  it("切换回原分支", async () => {
    const before = (await projectGitBranches(repo)) as Branches;
    await projectGitCheckout(repo, "tmp-b", true);
    expect(((await projectGitCheckout(repo, before.current!, false)) as Op).ok).toBe(true);
    expect(((await projectGitBranches(repo)) as Branches).current).toBe(before.current);
  });

  it("拒绝非法分支名（空 / 选项注入 / 空格）", async () => {
    for (const bad of ["", "-x", "a b", "a..b"]) {
      const r = (await projectGitCheckout(repo, bad, true)) as Op;
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });
});
