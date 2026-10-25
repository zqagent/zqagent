/**
 * 多会话并行的端到端验证
 *
 * 场景：两个会话共享同一工作区（server 配了 tenant.workspaceRoot 时的常态）。
 * 验证两件事一起生效时，行为符合预期：
 *   1. ConflictGuard —— 后写者不会静默覆盖先写者；
 *   2. SessionVcs   —— 每个会话各自留下快照，事后能查、能恢复。
 *
 * 这里刻意用「两个独立 registry + 两个独立 SessionVcs」模拟两个会话，
 * 与 server 的实际装配方式一致（每会话一套工具/guard/vcs）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ToolRegistry,
  ConflictGuard,
  registerFileTools,
  registerDiffTools,
  SessionVcs,
  resolveVcsPlan,
} from "../src/index.js";

/**
 * 这些用例每条要跑十来次 git 子进程；全量并发跑测试时会更慢，
 * 因此显式放宽超时（默认 15s 在 CI 上容易超）。
 */
const GIT_HEAVY = 60_000;

let workspace: string;

/** 一个「会话」：独立 guard + 独立 vcs，共享同一个工作区 */
function makeSession(id: string) {
  const guard = new ConflictGuard();
  const registry = new ToolRegistry();
  registerFileTools(registry, workspace, guard);
  registerDiffTools(registry, workspace, guard);
  const vcs = new SessionVcs(resolveVcsPlan(workspace, { mode: "shadow" }), id);
  return { registry, vcs, id };
}

type Session = ReturnType<typeof makeSession>;

async function call(
  s: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await s.registry.execute(name, args)) as Record<string, unknown>;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-multi-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("两会话并行改不同文件", () => {
  it("各自改动都保留，两份快照互不干扰", async () => {
    const a = makeSession("sess-a");
    const b = makeSession("sess-b");

    // hook 的真实时序：先落基线，再让工具改文件
    await a.vcs.beginTurn();
    await call(a, "write_file", { path: "a.txt", content: "from a\n" });
    await a.vcs.commitTurn("completed");

    await b.vcs.beginTurn();
    await call(b, "write_file", { path: "b.txt", content: "from b\n" });
    await b.vcs.commitTurn("completed");

    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("from a\n");
    expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf-8")).toBe("from b\n");

    const turnsA = await a.vcs.listTurns();
    const turnsB = await b.vcs.listTurns();
    expect(turnsA[0]!.files).toEqual(["a.txt"]);
    // 基线被跳过：B 的首个快照只有自己的 b.txt，不含 A 的 a.txt
    expect(turnsB[0]!.files).toEqual(["b.txt"]);
  }, GIT_HEAVY);
});

describe("两会话改同一文件", () => {
  it("后写者被拒绝，先写者的内容不被覆盖", async () => {
    const a = makeSession("sess-a");
    const b = makeSession("sess-b");

    // 两个会话都先读到初始内容
    await call(a, "write_file", { path: "shared.txt", content: "v1\n" });
    await call(a, "read_file", { path: "shared.txt" });
    await call(b, "read_file", { path: "shared.txt" });

    // A 先写
    const aWrite = await call(a, "write_file", { path: "shared.txt", content: "A version\n" });
    expect(aWrite.error).toBeUndefined();
    await a.vcs.commitTurn("completed");

    // B 基于旧内容写 → 被拦下
    const bWrite = await call(b, "write_file", { path: "shared.txt", content: "B version\n" });
    expect(String(bWrite.error)).toContain("已被其他会话");
    expect(fs.readFileSync(path.join(workspace, "shared.txt"), "utf-8")).toBe("A version\n");
  }, GIT_HEAVY);

  it("被拒绝的会话重新读取后可以继续写", async () => {
    const a = makeSession("sess-a");
    const b = makeSession("sess-b");

    await call(a, "write_file", { path: "shared.txt", content: "v1\n" });
    await call(a, "read_file", { path: "shared.txt" });
    await call(b, "read_file", { path: "shared.txt" });

    await call(a, "write_file", { path: "shared.txt", content: "A version\n" });
    expect((await call(b, "write_file", { path: "shared.txt", content: "B\n" })).error).toBeTruthy();

    await call(b, "read_file", { path: "shared.txt" });
    const retry = await call(b, "write_file", { path: "shared.txt", content: "B merged\n" });
    expect(retry.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "shared.txt"), "utf-8")).toBe("B merged\n");
  });
});

describe("从快照找回被覆盖的改动", () => {
  it("B 覆盖后，仍能从 A 的快照恢复 A 的版本", async () => {
    const a = makeSession("sess-a");
    const b = makeSession("sess-b");

    // A 写入并记录快照
    await call(a, "write_file", { path: "doc.txt", content: "A content\n" });
    await a.vcs.commitTurn("completed");

    // B 直接覆盖（B 没读过，所以不会被 ConflictGuard 拦）
    await call(b, "write_file", { path: "doc.txt", content: "B content\n" });
    expect(fs.readFileSync(path.join(workspace, "doc.txt"), "utf-8")).toBe("B content\n");

    // 从 A 的快照恢复
    const result = await a.vcs.restoreTurn(1, { paths: ["doc.txt"] });
    expect(result.restored).toEqual(["doc.txt"]);
    expect(result.overwritten).toEqual(["doc.txt"]);
    expect(fs.readFileSync(path.join(workspace, "doc.txt"), "utf-8")).toBe("A content\n");
  }, GIT_HEAVY);
});

describe("run_shell 的改动也进快照", () => {
  it("快照覆盖非工具写入（用 shell 重定向）", async () => {
    const a = makeSession("sess-a");
    // 直接落盘模拟 shell 改动（run_shell 在本测试中未注册）
    fs.writeFileSync(path.join(workspace, "shell-made.txt"), "by shell\n");
    const commit = await a.vcs.commitTurn("completed");
    expect(commit!.files).toContain("shell-made.txt");
  }, GIT_HEAVY);
});
