/**
 * Git 引用 / 提交历史 / 提交详情后端单测
 *
 * 覆盖 tools/git.ts 的 git_refs / git_log / git_show / git_fetch（经 projectOps 包装）：
 * 本地与远程分支、标签分组、fetch 刷新服务端引用、提交 meta 与变更文件、单文件 diff、
 * 以及提交标识（hash）的选项注入拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  projectGitFetch,
  projectGitLog,
  projectGitRefs,
  projectGitShow,
} from "../src/server/projectOps.js";

let repo: string;
let origin: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

type Refs = {
  current?: string;
  detached?: boolean;
  local?: { name: string; current?: boolean }[];
  remote?: { name: string }[];
  tags?: { name: string; target?: string }[];
  error?: string;
};
type Log = {
  count?: number;
  commits?: { hash: string; author?: string; date?: string; subject?: string }[];
  error?: string;
};
type Show = {
  commit?: { hash: string; short: string; author: string; subject: string };
  files?: { status: string; file: string }[];
  path?: string | null;
  diff?: string;
  error?: string;
};
type Op = { ok?: boolean; error?: string };

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitrefs-"));
  origin = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gitorigin-"));
  git(origin, ["init", "--bare", "-q"]);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  git(repo, ["branch", "-M", "main"]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
});

describe("projectGitRefs", () => {
  it("返回当前分支、本地分支与标签", async () => {
    git(repo, ["tag", "v1.0"]);
    const r = (await projectGitRefs(repo)) as Refs;
    expect(r.error).toBeUndefined();
    expect(r.current).toBe("main");
    expect(r.local?.some((b) => b.name === "main" && b.current === true)).toBe(true);
    expect(r.tags?.map((t) => t.name)).toContain("v1.0");
    expect(r.remote).toEqual([]);
  });

  it("非仓库时报错清晰", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ow-nogit-"));
    try {
      const r = (await projectGitRefs(plain)) as Refs;
      expect(r.error).toContain("不是 git 仓库");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("projectGitLog / projectGitShow", () => {
  it("log 返回提交历史，show 返回 meta 与变更文件", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "add two"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const log = (await projectGitLog(repo, undefined, 10)) as Log;
    expect(log.error).toBeUndefined();
    expect(log.count).toBe(2);
    expect(log.commits?.[0]?.subject).toBe("add two");

    const show = (await projectGitShow(repo, head)) as Show;
    expect(show.error).toBeUndefined();
    expect(show.commit?.hash).toBe(head);
    expect(show.commit?.subject).toBe("add two");
    expect(show.commit?.author).toBe("tester");
    expect(show.files?.some((f) => f.file === "a.txt" && f.status[0] === "M")).toBe(true);
    expect(show.diff).toContain("+two");
  });

  it("show 带 path 时只返回该文件在此提交中的 diff", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "touch both"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const show = (await projectGitShow(repo, head, "a.txt")) as Show;
    expect(show.path).toBe("a.txt");
    expect(show.diff).toContain("a.txt");
    expect(show.diff).not.toContain("b.txt");
  });

  it("拒绝以 - 开头的提交标识（选项注入）", async () => {
    const show = (await projectGitShow(repo, "--help")) as Show;
    expect(show.error).toContain("不能以 - 开头");
  });
});

describe("projectGitFetch", () => {
  it("没有远端时给出可读错误", async () => {
    const r = (await projectGitFetch(repo)) as Op;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未配置远端仓库");
  });

  it("刷新服务端分支与标签（含本地尚未跟踪的远程分支）", async () => {
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["tag", "v1.0"]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["branch", "side"]);
    git(repo, ["push", "-q", "origin", "side"]);
    // 模拟本地还没有该远程分支引用（未 fetch 前）
    git(repo, ["branch", "-D", "side"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/side"]);

    const before = (await projectGitRefs(repo)) as Refs;
    expect(before.remote?.some((b) => b.name === "origin/side")).toBe(false);

    const r = (await projectGitFetch(repo)) as Op;
    expect(r.ok).toBe(true);

    const refs = (await projectGitRefs(repo)) as Refs;
    const names = (refs.remote ?? []).map((b) => b.name);
    expect(names).toContain("origin/main");
    expect(names).toContain("origin/side");
    // refs/remotes/origin/HEAD 是符号引用，short 名为 "origin"，不能当作分支
    expect(names).not.toContain("origin");
    expect(names.some((n) => n.endsWith("/HEAD"))).toBe(false);
    expect(refs.tags?.map((t) => t.name)).toContain("v1.0");
  });
});
