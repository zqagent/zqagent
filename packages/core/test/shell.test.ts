/**
 * run_shell 工具单元测试
 *
 * 覆盖：正常命令执行、空命令、失败命令（非零退出）、
 * cd 命令的持久化 cwd 语义。全部使用安全只读命令。
 * 注意 macOS 下 /var 是 /private/var 的符号链接，比较路径时
 * 用 fs.realpathSync 归一化。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerShellTool } from "../src/index.js";
import { decodeOutput, listShellTasks, killShellTask } from "../src/tools/shell.js";

let workspace: string;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-shell-"));
  registry = new ToolRegistry();
  registerShellTool(registry, workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function run(
  command: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await registry.execute("run_shell", { command, ...args })) as Record<string, unknown>;
}

describe("run_shell 基本执行", () => {
  it("正常命令返回 stdout 与 exit_code 0", async () => {
    const result = await run("echo hello");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.error).toBeUndefined();
  });

  it("空命令报错", async () => {
    const result = await run("   ");
    expect(result.error).toContain("不能为空");
  });

  it("失败命令返回非零 exit_code 与错误信息", async () => {
    const result = await run("ls /nonexistent-dir-xyz");
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});

describe("run_shell cwd 持久化", () => {
  it("cd 到已存在目录后 cwd 更新", async () => {
    const sub = path.join(workspace, "sub");
    fs.mkdirSync(sub);
    const result = await run(`cd ${sub}`);
    expect(result.exit_code).toBe(0);
    expect(result.cwd).toBe(sub);
  });

  it("cd 后后续命令在新目录执行", async () => {
    const sub = path.join(workspace, "sub");
    fs.mkdirSync(sub);
    await run(`cd ${sub}`);
    const result = await run("pwd");
    // realpath 归一化，兼容 macOS /var → /private/var
    expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(sub));
  });

  it("cd 到不存在的目录不更新 cwd", async () => {
    const before = (await run("pwd")).cwd;
    const result = await run("cd /no/such/dir");
    expect(result.cwd).toBe(before);
  });

  it("cd <dir> && <cmd> 时后续命令在新目录执行且 cwd 更新", async () => {
    const sub = path.join(workspace, "sub-and");
    fs.mkdirSync(sub);
    const result = await run(`cd ${sub} && pwd`);
    expect(result.exit_code).toBe(0);
    expect(fs.realpathSync(String(result.stdout).trim())).toBe(fs.realpathSync(sub));
    expect(result.cwd).toBe(sub);
  });
});

describe("run_shell 显式 shell（ZQAGENT_SHELL）", () => {
  const hasBash = fs.existsSync("/bin/bash") || fs.existsSync("/usr/bin/bash");

  // 本机（Linux）用 bash 走通「非默认 spec → execFileSync」分支；
  // Windows 上该分支才是默认路径，这里只保证参数拼装与执行链路正确。
  it.skipIf(!hasBash)("ZQAGENT_SHELL=bash 时经 execFileSync 正常执行", async () => {
    const prev = process.env.ZQAGENT_SHELL;
    process.env.ZQAGENT_SHELL = "bash";
    try {
      const reg = new ToolRegistry();
      registerShellTool(reg, workspace);
      const result = (await reg.execute("run_shell", { command: "echo via-bash" })) as Record<
        string,
        unknown
      >;
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("via-bash");
      expect(result.cwd).toBe(workspace);
    } finally {
      if (prev === undefined) delete process.env.ZQAGENT_SHELL;
      else process.env.ZQAGENT_SHELL = prev;
    }
  });

  // busybox-w32 的约定是 `busybox.exe sh -c "..."`（argv[1] 为 applet 名）。
  // 用一个 shim 模拟该约定，使这条分支在 Linux 上也能验证，而不是只能靠 Windows。
  it.skipIf(process.platform === "win32")("ZQAGENT_BUSYBOX 时按 `busybox sh -c` 调用", async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-bb-"));
    const shim = path.join(shimDir, "busybox");
    fs.writeFileSync(shim, '#!/bin/sh\napplet="$1"; shift\nexec /bin/sh "$@"\n', { mode: 0o755 });

    const prevShell = process.env.ZQAGENT_SHELL;
    const prevBusybox = process.env.ZQAGENT_BUSYBOX;
    process.env.ZQAGENT_SHELL = "busybox";
    process.env.ZQAGENT_BUSYBOX = shim;
    try {
      const reg = new ToolRegistry();
      registerShellTool(reg, workspace);
      const result = (await reg.execute("run_shell", {
        command: "echo bb-$((6 * 7))",
      })) as Record<string, unknown>;
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("bb-42");
    } finally {
      if (prevShell === undefined) delete process.env.ZQAGENT_SHELL;
      else process.env.ZQAGENT_SHELL = prevShell;
      if (prevBusybox === undefined) delete process.env.ZQAGENT_BUSYBOX;
      else process.env.ZQAGENT_BUSYBOX = prevBusybox;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe("run_shell 工具描述", () => {
  it("注入当前平台与 shell 提示，引导模型使用匹配的命令风格", () => {
    const schema = registry.schemas().find((s) => s.function.name === "run_shell");
    const description = String(schema?.function.description ?? "");
    expect(description).toContain("运行环境");
    expect(description).toContain(process.platform);
    // POSIX 下应提示使用 POSIX 风格命令
    if (process.platform !== "win32") {
      expect(description).toContain("POSIX 风格命令");
    }
  });
});

describe("run_shell stderr 捕获", () => {
  it("成功命令的 stderr 也会返回（不再被丢弃）", async () => {
    const result = await run("echo to-stderr 1>&2");
    expect(result.exit_code).toBe(0);
    expect(String(result.stderr)).toContain("to-stderr");
  });

  it("失败命令同时返回 stdout / stderr / 非零退出码", async () => {
    const result = await run("echo out-here; echo err-here 1>&2; exit 7");
    expect(result.exit_code).toBe(7);
    expect(String(result.stdout)).toContain("out-here");
    expect(String(result.stderr)).toContain("err-here");
  });
});

describe("decodeOutput 自适应解码", () => {
  it("UTF-8 字节正常解码", () => {
    expect(decodeOutput(Buffer.from("中文 ok", "utf-8"))).toBe("中文 ok");
  });

  it("非 UTF-8（GBK）字节回退到 GBK 解码", () => {
    // "贵州茅台" 的 GBK 字节；按 UTF-8 解会失败
    const gbk = Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]);
    expect(decodeOutput(gbk)).toBe("贵州茅台");
  });

  it("空输入返回空串", () => {
    expect(decodeOutput(null)).toBe("");
    expect(decodeOutput(Buffer.alloc(0))).toBe("");
  });
});

describe("run_shell 后台任务", () => {
  it("后台启动 → 轮询输出 → 自然结束", async () => {
    const start = (await registry.execute("run_shell", {
      command: "echo bg-hello",
      run_in_background: true,
    })) as Record<string, unknown>;
    expect(start.task_id).toBeTruthy();

    let out = registry.execute("shell_task_output", {
      task_id: start.task_id,
    }) as Record<string, unknown>;
    for (let i = 0; i < 40 && out.running; i++) {
      await new Promise((r) => setTimeout(r, 50));
      out = registry.execute("shell_task_output", {
        task_id: start.task_id,
      }) as Record<string, unknown>;
    }
    expect(out.status).toBe("exited");
    expect(String(out.stdout)).toContain("bg-hello");
  });

  it("shell_task_kill 终止长驻进程", async () => {
    const start = (await registry.execute("run_shell", {
      command: "sleep 30",
      run_in_background: true,
    })) as Record<string, unknown>;
    const killed = registry.execute("shell_task_kill", {
      task_id: start.task_id,
    }) as Record<string, unknown>;
    expect(killed.status).toBe("killed");
  });

  it("未知 task_id 返回错误", () => {
    const out = registry.execute("shell_task_output", {
      task_id: "nope",
    }) as Record<string, unknown>;
    expect(String(out.error)).toContain("未知");
  });
});

const posix = process.platform !== "win32";

describe("run_shell 中断", () => {
  it.skipIf(!posix)("signal abort 立即终止前台命令（不等它自然结束）", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const running = registry.execute(
      "run_shell",
      { command: "sleep 30" },
      { signal: ctrl.signal },
    ) as Promise<Record<string, unknown>>;
    setTimeout(() => ctrl.abort(), 150);

    const result = await running;
    expect(result.interrupted).toBe(true);
    expect(String(result.error)).toContain("中断");
    // 若中断传导不到子进程，这里会等到 120s 默认超时
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.skipIf(!posix)("未中断时不受 signal 影响，正常返回结果", async () => {
    const ctrl = new AbortController();
    const result = (await registry.execute(
      "run_shell",
      { command: "echo still-fine" },
      { signal: ctrl.signal },
    )) as Record<string, unknown>;
    expect(result.exit_code).toBe(0);
    expect(String(result.stdout)).toContain("still-fine");
    expect(result.interrupted).toBeUndefined();
  });
});

describe("后台任务的归属（scope）", () => {
  it.skipIf(!posix)("按 scope 过滤，跨 scope 不可终止", async () => {
    const scoped = new ToolRegistry();
    registerShellTool(scoped, workspace, "tenant-a");
    const start = (await scoped.execute("run_shell", {
      command: "sleep 30",
      run_in_background: true,
    })) as Record<string, unknown>;
    const taskId = String(start.task_id);
    try {
      expect(listShellTasks("tenant-a").some((t) => t.task_id === taskId)).toBe(true);
      expect(listShellTasks("tenant-b").some((t) => t.task_id === taskId)).toBe(false);

      // 跨项目终止被拒绝（task_id 可猜，隔离不能只靠 URL 不泄露）
      const denied = killShellTask(taskId, "tenant-b") as { error?: string };
      expect(String(denied.error)).toContain("未知");

      const killed = killShellTask(taskId, "tenant-a") as Record<string, unknown>;
      expect(killed.status).toBe("killed");
    } finally {
      killShellTask(taskId, "tenant-a");
    }
  });
});
