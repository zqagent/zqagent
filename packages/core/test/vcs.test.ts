/**
 * 变更追踪（VCS）单元测试
 *
 * 核心要验证的不是「git 能用」，而是三件容易出错的事：
 *   1. native 模式绝对不能碰用户的 HEAD / index / 分支；
 *   2. shadow 模式不能把影子仓库自己的对象库提交进去；
 *   3. 快照能按文件恢复，且默认不覆盖别人已经改过的内容。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  SessionVcs,
  resolveVcsPlan,
  isGitRepo,
  SHADOW_DIR,
} from "../src/vcs/index.js";

/** 每条用例要跑十几次 git 子进程，全量并发跑时放宽超时 */
const GIT_HEAVY = 60_000;

let workspace: string;

/** 直接跑 git（测试里用同步调用，语义清晰） */
function git(args: string[], cwd = workspace): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-vcs-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "v1\n");
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("resolveVcsPlan", () => {
  it("非 git 目录 → shadow", () => {
    const plan = resolveVcsPlan(workspace, { mode: "auto" });
    expect(plan.mode).toBe("shadow");
    expect(plan.gitDir).toBe(path.join(workspace, SHADOW_DIR));
    expect(isGitRepo(workspace)).toBe(false);
  });

  it("git 仓库 → native", () => {
    fs.mkdirSync(path.join(workspace, ".git"));
    expect(resolveVcsPlan(workspace).mode).toBe("native");
  });

  it("mode=off 直接关闭", () => {
    const plan = resolveVcsPlan(workspace, { mode: "off" });
    expect(plan.mode).toBe("off");
    expect(plan.gitDir).toBeNull();
  });

  it("无 git 可执行文件时降级为 off 并说明原因", () => {
    const plan = resolveVcsPlan(workspace, { gitAvailable: () => false });
    expect(plan.mode).toBe("off");
    expect(plan.reason).toContain("git");
  });
});

describe("shadow 模式", () => {
  it("建影子仓库但项目目录不出现 .git", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    const commit = await vcs.commitTurn("completed");
    expect(commit).not.toBeNull();
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, SHADOW_DIR, "HEAD"))).toBe(true);
  }, GIT_HEAVY);

  it("快照不包含影子仓库自身（info/exclude 生效）", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    fs.writeFileSync(path.join(workspace, "b.txt"), "hello\n");
    const commit = await vcs.commitTurn("completed");
    expect(commit!.files.sort()).toEqual(["a.txt", "b.txt"]);
    expect(commit!.files.some((f) => f.includes(".agent"))).toBe(false);
  }, GIT_HEAVY);

  it("无改动的一轮不产生空提交", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    expect(await vcs.commitTurn("completed")).not.toBeNull();
    expect(await vcs.commitTurn("completed")).toBeNull();
  }, GIT_HEAVY);

  it("两次改动产生两个快照，文件集各自正确", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    await vcs.commitTurn("completed");
    fs.writeFileSync(path.join(workspace, "c.txt"), "new\n");
    await vcs.commitTurn("completed");

    const turns = await vcs.listTurns();
    expect(turns).toHaveLength(2);
    expect(turns[0]!.files).toContain("a.txt");
    expect(turns[1]!.files).toEqual(["c.txt"]);
    expect(turns[1]!.status).toBe("completed");
  }, GIT_HEAVY);

  it("diffTurn 返回该轮的 patch", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    // 先落一个基线快照（v1），再改出 v2：这样第二轮才有 -v1/+v2 的 diff
    await vcs.commitTurn("completed");
    fs.writeFileSync(path.join(workspace, "a.txt"), "v2\n");
    await vcs.commitTurn("completed");
    const patch = await vcs.diffTurn(2);
    expect(patch).toContain("-v1");
    expect(patch).toContain("+v2");
  }, GIT_HEAVY);
});

describe("native 模式不干扰用户 git", () => {
  function initRepo(): void {
    git(["init", "-q", "."]);
    git(["config", "user.email", "user@example.com"]);
    git(["config", "user.name", "user"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
  }

  it("用户的 status / 暂存区 / HEAD / 分支都不变", async () => {
    initRepo();
    fs.writeFileSync(path.join(workspace, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    fs.writeFileSync(path.join(workspace, "untracked.txt"), "u\n");
    // 先让 agent 改一个文件，再取基线：否则 status 的差异是测试自己造成的
    fs.writeFileSync(path.join(workspace, "a.txt"), "agent change\n");

    const statusBefore = git(["status", "--porcelain"]);
    const headBefore = git(["rev-parse", "HEAD"]);
    const branchesBefore = git(["branch", "--format=%(refname)"]);

    const vcs = new SessionVcs(resolveVcsPlan(workspace), "sess-native");
    const commit = await vcs.commitTurn("completed");
    expect(commit).not.toBeNull();

    expect(git(["status", "--porcelain"])).toBe(statusBefore);
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(["branch", "--format=%(refname)"])).toBe(branchesBefore);
    // 用户的暂存区仍在
    expect(git(["diff", "--cached", "--name-only"])).toBe("staged.txt");
  }, GIT_HEAVY);

  it("快照里不出现 .agent 与用户的未跟踪产物之外的噪音", async () => {
    initRepo();
    const vcs = new SessionVcs(resolveVcsPlan(workspace), "sess-native");
    const commit = await vcs.commitTurn("completed");
    // 首轮会包含初始文件；关键是不能包含 .agent
    expect(commit!.files.some((f) => f.startsWith(".agent/"))).toBe(false);
  }, GIT_HEAVY);

  it("agent 快照存在 refs/agent/<session> 下", async () => {
    initRepo();
    const vcs = new SessionVcs(resolveVcsPlan(workspace), "sess-native");
    await vcs.commitTurn("completed");
    const refs = git(["for-each-ref", "refs/agent", "--format=%(refname:short)"]);
    expect(refs).toBe("agent/sess-native");
  }, GIT_HEAVY);
});

describe("restoreTurn", () => {
  it("从快照恢复文件内容", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    fs.writeFileSync(path.join(workspace, "a.txt"), "agent version\n");
    await vcs.commitTurn("completed");

    fs.writeFileSync(path.join(workspace, "a.txt"), "later edit\n");
    const result = await vcs.restoreTurn(1);
    expect(result.restored).toContain("a.txt");
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("agent version\n");
  }, GIT_HEAVY);

  it("默认覆盖，并把真正被覆盖的文件记入 overwritten", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    fs.writeFileSync(path.join(workspace, "a.txt"), "agent version\n");
    await vcs.commitTurn("completed");

    fs.writeFileSync(path.join(workspace, "a.txt"), "someone else\n");
    const result = await vcs.restoreTurn(1);
    expect(result.overwritten).toEqual(["a.txt"]);
    expect(result.restored).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("agent version\n");
  }, GIT_HEAVY);

  it("dryRun 只报告不落盘", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    fs.writeFileSync(path.join(workspace, "a.txt"), "agent version\n");
    await vcs.commitTurn("completed");
    fs.writeFileSync(path.join(workspace, "a.txt"), "someone else\n");

    const result = await vcs.restoreTurn(1, { dryRun: true });
    expect(result.restored).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("someone else\n");
  }, GIT_HEAVY);

  it("可只恢复指定文件", async () => {
    const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), "sess1");
    fs.writeFileSync(path.join(workspace, "b.txt"), "b1\n");
    await vcs.commitTurn("completed");
    fs.writeFileSync(path.join(workspace, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(workspace, "b.txt"), "b2\n");

    const result = await vcs.restoreTurn(1, { paths: ["a.txt"] });
    expect(result.restored).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf-8")).toBe("b2\n");
  }, GIT_HEAVY);
});

describe("会话隔离", () => {
  it("两个会话各有一条 ref，互不覆盖", async () => {
    const plan = resolveVcsPlan(workspace, { mode: "shadow" });
    const a = new SessionVcs(plan, "sess-a");
    const b = new SessionVcs(plan, "sess-b");

    fs.writeFileSync(path.join(workspace, "a-only.txt"), "a\n");
    await a.commitTurn("completed");
    fs.writeFileSync(path.join(workspace, "b-only.txt"), "b\n");
    await b.commitTurn("completed");

    const turnsA = await a.listTurns();
    const turnsB = await b.listTurns();
    expect(turnsA).toHaveLength(1);
    expect(turnsB).toHaveLength(1);
    expect(turnsA[0]!.files).not.toEqual(turnsB[0]!.files);
  }, GIT_HEAVY);
});
