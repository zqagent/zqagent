/**
 * execAsync 单元测试
 *
 * 覆盖：正常执行 / 非零退出码 / 超时（timedOut）/ 输出截断（truncated）/
 * 启动失败（ENOENT，不会挂起）/ env 与 cwd 传递 / stdin 写入 /
 * 参数数组不被 shell 解释 / 原始字节交调用方解码。
 * POSIX 命令在 Windows 下跳过。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execAsync } from "../src/tools/execAsync.js";

const posix = process.platform !== "win32";
const echo = posix ? "/bin/echo" : "cmd.exe";

describe("execAsync 基本执行", () => {
  it.skipIf(!posix)("正常命令返回 status 0 与 stdout", async () => {
    const r = await execAsync(echo, ["hello-async"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString("utf-8")).toContain("hello-async");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it.skipIf(!posix)("非零退出码原样返回", async () => {
    const r = await execAsync("/bin/sh", ["-c", "exit 7"]);
    expect(r.status).toBe(7);
    expect(r.timedOut).toBe(false);
  });

  it.skipIf(!posix)("参数数组不经 shell 解释（注入防护）", async () => {
    const r = await execAsync(echo, ["a; rm -rf /", "$(whoami)"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString("utf-8")).toContain("a; rm -rf /");
    expect(r.stdout.toString("utf-8")).toContain("$(whoami)");
  });
});

describe("execAsync 超时", () => {
  it.skipIf(!posix)("到点杀死子进程并置 timedOut", async () => {
    const r = await execAsync("/bin/sleep", ["5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
  });
});

describe("execAsync 输出上限", () => {
  it.skipIf(!posix)("超出 maxBuffer 时截断并置 truncated", async () => {
    const r = await execAsync(echo, ["abcdefghij"], { maxBuffer: 4 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(4);
    expect(r.stdout.toString("utf-8")).toBe("abcd");
  });
});

describe("execAsync 启动失败", () => {
  it("命令不存在时立即返回 ENOENT（不挂起）", async () => {
    const r = await execAsync("/no/such/binary-xyz", []);
    expect(r.error?.code).toBe("ENOENT");
    expect(r.status).toBeNull();
    expect(r.timedOut).toBe(false);
  });
});

describe("execAsync 选项", () => {
  it.skipIf(!posix)("env 覆盖生效", async () => {
    const r = await execAsync("/bin/sh", ["-c", "echo $OW_ASYNC_ENV"], {
      env: { ...process.env, OW_ASYNC_ENV: "env-ok" },
    });
    expect(r.stdout.toString("utf-8")).toContain("env-ok");
  });

  it("cwd 生效", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-execasync-"));
    try {
      const script = posix ? "pwd" : "cd";
      const r = posix
        ? await execAsync("/bin/sh", ["-c", script], { cwd: dir })
        : await execAsync("cmd.exe", ["/d", "/s", "/c", script], { cwd: dir });
      expect(fs.realpathSync(r.stdout.toString("utf-8").trim())).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)("input 写入 stdin", async () => {
    const r = await execAsync("/bin/cat", [], { input: "stdin-payload" });
    expect(r.status).toBe(0);
    expect(r.stdout.toString("utf-8")).toBe("stdin-payload");
  });

  it.skipIf(!posix)("非 UTF-8 字节原样保留，交调用方解码", async () => {
    // "贵州茅台" 的 GBK 字节；execAsync 不做解码
    const gbk = Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]);
    const r = await execAsync("/bin/sh", ["-c", `printf '\\271\\363\\326\\335\\303\\251\\314\\250'`]);
    expect(r.stdout.equals(gbk)).toBe(true);
  });
});

/** 等待文件出现（子进程写盘有延迟） */
async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待文件超时: ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 进程是否仍存在（信号 0 只做存在性探测） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待进程消失（刚被杀死的进程可能短暂处于僵尸态） */
async function waitGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

describe("execAsync 中断", () => {
  it.skipIf(!posix)("signal abort 终止子进程并置 aborted", async () => {
    const ctrl = new AbortController();
    const running = execAsync("/bin/sleep", ["30"], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);

    const r = await running;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBeNull();
  });

  it.skipIf(!posix)("调用前已 abort 时不启动进程", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await execAsync("/bin/sleep", ["30"], { signal: ctrl.signal });
    expect(r.aborted).toBe(true);
    expect(r.status).toBeNull();
  });

  it.skipIf(!posix)("abort 连同孙进程一起终止（整组 SIGKILL）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-execasync-abort-"));
    const pidFile = path.join(dir, "grandchild.pid");
    try {
      const ctrl = new AbortController();
      // sh 派生的 sleep 是孙进程：把 pid 落盘后再等（不下 detached 就杀不到它）
      const running = execAsync("/bin/sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
        signal: ctrl.signal,
      });
      await waitForFile(pidFile);
      const grandchild = Number(fs.readFileSync(pidFile, "utf-8").trim());
      expect(grandchild).toBeGreaterThan(0);
      expect(isAlive(grandchild)).toBe(true);

      ctrl.abort();
      await running;
      expect(await waitGone(grandchild)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("execAsync 结算兜底", () => {
  it.skipIf(!posix)(
    "后代脱离进程组仍持有管道时，超时也在宽限期内结算（不永久挂起）",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-execasync-grace-"));
      const pidFile = path.join(dir, "orphan.pid");
      const helper = path.join(dir, "spawn-orphan.mjs");
      // 直接子进程派生一个 detached（自成进程组）的后代，并让它继承 stdout/stderr：
      // killTree 的 `-pid` 覆盖不到它，管道写端一直存活 → `close` 永不触发，
      // 只有宽限兜底能结算（这正是会话卡在 running、interrupt 也无效的成因）。
      fs.writeFileSync(
        helper,
        [
          'import { spawn } from "node:child_process";',
          'import * as fs from "node:fs";',
          'const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "inherit" });',
          "fs.writeFileSync(process.argv[2], String(child.pid));",
          "setTimeout(() => {}, 60000);",
        ].join("\n"),
      );

      let orphan = 0;
      try {
        const started = Date.now();
        const running = execAsync(
          "/bin/sh",
          ["-c", `"${process.execPath}" "${helper}" "${pidFile}"`],
          // 超时只需早于「后代写 pid 文件」之后触发；并行跑全量时进程启动慢，
          // 过短的超时会在 helper 起来前就杀掉进程组，留足启动余量
          // （结算 = 超时 + 1s 宽限，仍在下方的 5s 断言内）
          { timeoutMs: 3000 },
        );
        // 并行跑全量时进程启动会被拖慢，等待放宽（不影响 elapsed 断言）
        await waitForFile(pidFile, 10_000);
        const r = await running;
        const elapsed = Date.now() - started;

        expect(r.timedOut).toBe(true);
        expect(r.status).toBeNull();
        // 关键断言：管道仍被后代持有，也必须在宽限期内结算而非永久挂起
        expect(elapsed).toBeLessThan(5000);

        orphan = Number(fs.readFileSync(pidFile, "utf-8").trim());
        expect(orphan).toBeGreaterThan(0);
        // 前提校验：它确实脱离了原进程组、killTree 杀不到，兜底才是结算原因
        expect(isAlive(orphan)).toBe(true);
      } finally {
        if (orphan > 0) {
          try {
            process.kill(orphan, "SIGKILL");
          } catch {
            /* 已退出 */
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    // 并行跑全量时进程启动慢，等待文件 + 宽限期结算可能超过默认 5s
    20_000,
  );
});
