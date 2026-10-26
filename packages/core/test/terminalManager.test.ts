/**
 * 终端管理器单测
 *
 * 覆盖四条容易回归的行为：
 *   1. 创建 → 执行命令 → 拿到输出（跨平台：用 `echo`，sh 与 cmd.exe 都支持）；
 *   2. 一行输入落一条 `cmd` 历史（「每个操作都要有记录」的底线）；
 *   3. 落盘限速：刷屏输出不能把历史文件写爆（只影响历史，不影响实时流）；
 *   4. 保留期清理：按 `lastActiveAt` 删除过期终端，且节点重启遗留的 running 变 exited。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/server/terminals/TerminalManager.js";
import { TerminalStore } from "../src/server/terminals/TerminalStore.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-terminal-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

/** 等到条件成立（Spawn 与 IO 是异步的，不能靠固定 sleep） */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待超时");
}

function makeManager(extra: Partial<Parameters<typeof TerminalManager>[0]> = {}) {
  return new TerminalManager({
    dir: tmpDir,
    resolveWorkspace: () => tmpDir,
    ...extra,
  });
}

describe("TerminalManager", () => {
  it("创建终端、执行命令并把输出送进回放缓冲", async () => {
    const mgr = makeManager();
    await mgr.init();
    const seen: string[] = [];
    const meta = await mgr.create({ projectId: "p1" });
    expect(meta.id.startsWith("t_")).toBe(true);
    expect(meta.status).toBe("running");

    mgr.attach(meta.id, (ev) => {
      if (ev.kind === "data" && ev.data) seen.push(Buffer.from(ev.data).toString("utf-8"));
    });
    expect(mgr.write(meta.id, "echo zq-terminal-ok\n")).toBe(true);

    await waitFor(() => seen.join("").includes("zq-terminal-ok"));
    expect(mgr.replayOutput(meta.id)).toContain("zq-terminal-ok");

    // 一行命令落一条历史
    await waitFor(() => true);
    const history = await mgr.history(meta.id);
    const cmds = history.filter((r) => r.t === "cmd").map((r) => r.cmd);
    expect(cmds).toContain("echo zq-terminal-ok");

    await mgr.close(meta.id);
    expect(mgr.isRunning(meta.id)).toBe(false);
    expect(mgr.get(meta.id)?.status).toBe("exited");
    mgr.dispose();
  }, 20_000);

  it("多个订阅者同时收到输出（多终端面板并行时不互相抢）", async () => {
    const mgr = makeManager();
    await mgr.init();
    const meta = await mgr.create({ projectId: "p1" });
    let a = "";
    let b = "";
    mgr.attach(meta.id, (ev) => {
      if (ev.data) a += Buffer.from(ev.data).toString("utf-8");
    });
    mgr.attach(meta.id, (ev) => {
      if (ev.data) b += Buffer.from(ev.data).toString("utf-8");
    });
    mgr.write(meta.id, "echo both-subscribers\n");
    await waitFor(() => a.includes("both-subscribers") && b.includes("both-subscribers"));
    await mgr.close(meta.id);
    mgr.dispose();
  }, 20_000);

  it("已退出的终端再写入返回 false（前端据此提示重开）", async () => {
    const mgr = makeManager();
    await mgr.init();
    const meta = await mgr.create({ projectId: "p1" });
    mgr.write(meta.id, "exit\n");
    await waitFor(() => !mgr.isRunning(meta.id));
    expect(mgr.write(meta.id, "echo late\n")).toBe(false);
    mgr.dispose();
  }, 20_000);

  it("init 把上次进程遗留的 running 标记为 exited", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({
        terminals: [
          {
            id: "t_old",
            label: "终端 1",
            projectId: "p1",
            cwd: tmpDir,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            status: "running",
          },
        ],
      }),
      "utf-8",
    );
    const mgr = makeManager();
    await mgr.init();
    expect(mgr.get("t_old")?.status).toBe("exited");
    mgr.dispose();
  });

  it("保留期清理：过期的终端被删，未过期的保留", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({
        terminals: [
          {
            id: "t_expired",
            label: "旧终端",
            projectId: "p1",
            cwd: tmpDir,
            createdAt: old,
            lastActiveAt: old,
            status: "exited",
          },
          {
            id: "t_fresh",
            label: "新终端",
            projectId: "p1",
            cwd: tmpDir,
            createdAt: fresh,
            lastActiveAt: fresh,
            status: "exited",
          },
        ],
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmpDir, "t_expired.jsonl"), '{"t":"cmd","ts":"x","cmd":"ls"}\n');
    fs.writeFileSync(path.join(tmpDir, "t_fresh.jsonl"), '{"t":"cmd","ts":"x","cmd":"ls"}\n');

    const mgr = makeManager();
    await mgr.init(); // 默认 30 天 → t_expired 被清理
    expect(mgr.get("t_expired")).toBeNull();
    expect(mgr.get("t_fresh")?.id).toBe("t_fresh");
    expect(fs.existsSync(path.join(tmpDir, "t_expired.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "t_fresh.jsonl"))).toBe(true);

    // 改保留天数（1–365 夹取）后可再触发清理
    expect((await mgr.updateSettings({ retentionDays: 9999 })).retentionDays).toBe(365);
    expect((await mgr.updateSettings({ retentionDays: 0 })).retentionDays).toBe(1);
    mgr.dispose();
  });
});

describe("TerminalStore 落盘限速", () => {
  it("输出超过每秒额度时丢弃并标记，历史文件保持很小", async () => {
    const store = new TerminalStore(tmpDir, { historyBytesPerSec: 1024, maxLogBytes: 1024 * 64 });
    await store.ensureDir();
    // 模拟 200 条 × 512 字节的刷屏输出（合计约 100KB，远超 1KB/s）
    const chunk = "x".repeat(512);
    for (let i = 0; i < 200; i += 1) {
      store.append("t_flood", { t: "out", ts: new Date().toISOString(), data: chunk });
    }
    // 命令不受限速影响（体积极小、审计价值高）
    store.append("t_flood", { t: "cmd", ts: new Date().toISOString(), cmd: "yes" });
    store.closeLog("t_flood");
    // 等写流 flush
    await new Promise((r) => setTimeout(r, 150));

    const size = fs.statSync(path.join(tmpDir, "t_flood.jsonl")).size;
    expect(size).toBeLessThan(20_000);
    // 单块超过配额时仍要留一段样本：历史不能一片空白
    expect(size).toBeGreaterThan(500);
    const records = await store.readHistory("t_flood");
    expect(records.some((r) => r.t === "cmd" && r.cmd === "yes")).toBe(true);
    // 输出停止后也要补「已截断」标记：否则用户翻历史会以为命令没有任何输出
    await new Promise((r) => setTimeout(r, 1400));
    const after = await store.readHistory("t_flood");
    expect(after.some((r) => (r.data ?? "").includes("输出过快"))).toBe(true);
    store.dispose();
  });

  it("读到被截断的最后一行不会整体失败", async () => {
    const store = new TerminalStore(tmpDir);
    await store.ensureDir();
    fs.writeFileSync(
      path.join(tmpDir, "t_broken.jsonl"),
      '{"t":"cmd","ts":"2024-01-01T00:00:00Z","cmd":"ls"}\n{"t":"cmd","ts":"2024-01-01T00:0',
      "utf-8",
    );
    const records = await store.readHistory("t_broken");
    expect(records).toHaveLength(1);
    expect(records[0]!.cmd).toBe("ls");
  });
});
