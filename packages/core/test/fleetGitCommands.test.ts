/**
 * 舰队指令：Git 引用 / 历史 / 提交详情 / 刷新远端
 *
 * 走完整的节点侧分派路径（cmd → _dispatchEnvelope → 调度 → dispatchFleetCommand），
 * 确保 git_refs / git_log / git_show / git_fetch 都真正被识别并执行——
 * 而不是落到 default 分支回「未知指令」。这正是控制台 Git 面板在远端节点上
 * 依赖的四个新指令。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import {
  generateToken,
  type FleetAckPayload,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";
import type { TenantConfig } from "../src/server/types.js";

const NODE = "n-git";

interface Internals {
  _dispatchEnvelope: (env: FleetCmdEnvelope) => void;
  _publishAck: (env: FleetCmdEnvelope, ack: FleetAckPayload) => void;
}

let repo: string;
let origin: string;
let root: string;
let acks: FleetAckPayload[];
let internals: Internals;
let seq: number;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// 并行跑全量时 git init/push 会被拖慢（hook 默认 10s 不够）
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-fleetgit-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ow-fleetgit-repo-"));
  origin = fs.mkdtempSync(path.join(os.tmpdir(), "ow-fleetgit-origin-"));

  git(origin, ["init", "--bare", "-q"]);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["tag", "v1.0"]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["push", "-q", "origin", "v1.0"]);

  const store = new Store(root);
  store.saveTenant({
    id: "p1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
    workspaceRoot: repo,
  } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  // 不建链：直接驱动 _dispatchEnvelope，走真实调度与指令分发
  const node = new FleetNodeBridge({
    fleetToken: "ft-git",
    fleetSecret: "git-secret-0123456789abcdef",
    nodeId: NODE,
    deps: { store, manager },
  });
  internals = node as unknown as Internals;
  acks = [];
  internals._publishAck = (_env, ack) => acks.push(ack);
  seq = 0;
}, 30_000);

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
});

/** 发一条指令并等它的回执 */
async function send(
  type: FleetCmdType,
  payload: Record<string, unknown> = {},
): Promise<FleetAckPayload> {
  seq += 1;
  const reqId = `r${seq}`;
  const base: Omit<FleetCmdEnvelope, "sig"> = {
    t: Date.now(),
    nonce: generateToken(16),
    reqId,
    type,
    clientId: "c1",
    nodeId: NODE,
    projectId: "p1",
    payload,
  };
  internals._dispatchEnvelope({ ...base, sig: "test" });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const hit = acks.find((a) => a.reqId === reqId);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`等待回执超时: ${type}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("舰队指令：Git 面板新增指令", () => {
  // 并行跑全量时 git 进程会被拖慢，放宽超时（单独跑约 2s）
  it("git_repos 列出工作区内的仓库（含子目录），repo 参数可定位子仓库", async () => {
    const nested = path.join(repo, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.email", "t@t.t"]);
    git(nested, ["config", "user.name", "tester"]);
    fs.writeFileSync(path.join(nested, "n.txt"), "x\n");

    const ack = await send("git_repos");
    expect(ack.ok).toBe(true);
    const data = ack.data as { repos?: { path: string; branch?: string }[] };
    expect(data.repos?.map((r) => r.path)).toEqual(["", "nested"]);

    const st = (await send("git_status", { repo: "nested" })).data as { repo?: string };
    expect(st.repo && fs.realpathSync(st.repo)).toBe(fs.realpathSync(nested));
  }, 20_000);

  it("git_refs 返回本地分支 / 远程分支 / 标签（不被当成未知指令）", async () => {
    const ack = await send("git_refs");
    expect(ack.ok).toBe(true);
    expect(ack.error).toBeUndefined();
    const data = ack.data as {
      current?: string;
      local?: { name: string; current?: boolean }[];
      remote?: { name: string }[];
      tags?: { name: string }[];
    };
    expect(data.current).toBe("main");
    expect(data.local?.some((b) => b.name === "main" && b.current === true)).toBe(true);
    expect(data.remote?.map((b) => b.name)).toContain("origin/main");
    expect(data.tags?.map((t) => t.name)).toContain("v1.0");
  });

  it("git_log 返回提交历史", async () => {
    const ack = await send("git_log", { max: 5 });
    expect(ack.ok).toBe(true);
    const data = ack.data as { count?: number; commits?: { subject?: string }[] };
    expect(data.count).toBe(1);
    expect(data.commits?.[0]?.subject).toBe("init");
  });

  it("git_show 返回提交详情与该提交的 diff", async () => {
    const hash = git(repo, ["rev-parse", "HEAD"]).trim();
    const ack = await send("git_show", { hash });
    expect(ack.ok).toBe(true);
    const data = ack.data as {
      commit?: { hash: string; subject: string };
      files?: { file: string }[];
      diff?: string;
    };
    expect(data.commit?.hash).toBe(hash);
    expect(data.commit?.subject).toBe("init");
    expect(data.files?.some((f) => f.file === "a.txt")).toBe(true);
    expect(data.diff).toContain("+one");
  });

  it("git_fetch 刷新服务端引用", async () => {
    // 远端多一个分支，本地尚未 fetch
    git(repo, ["branch", "side"]);
    git(repo, ["push", "-q", "origin", "side"]);
    git(repo, ["branch", "-D", "side"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/side"]);

    const ack = await send("git_fetch");
    expect(ack.ok).toBe(true);
    expect(ack.error).toBeUndefined();

    const refs = (await send("git_refs")).data as { remote?: { name: string }[] };
    expect(refs.remote?.map((b) => b.name)).toContain("origin/side");
  });
});
