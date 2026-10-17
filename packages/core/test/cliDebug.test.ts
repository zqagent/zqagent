/**
 * CLI 启动诊断单元测试
 *
 * 覆盖两条链路：
 * 1. `src/cli/debug.ts`：开关语义、日志同步落盘、环境快照（含「绝不打印密钥明文」）；
 * 2. `scripts/debug_bootstrap.mjs`：SEA 产物「bundle 之前的启动引导」——在独立子进程里
 *    先执行引导再抛异常，验证**模块初始化期崩溃**也能留下堆栈并以非零码退出。
 *    这正是 Windows 上「一闪而过、cmd 无输出」的取证路径，在 Linux 上同样可验证。
 *
 * 注意：diagnostics 会注册进程级处理器，因此每个用例结束后都要把「本模块新增的」
 * 监听器摘掉，既避免污染 vitest 自身，也避免 MaxListeners 警告。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEBUG_BOOTSTRAP_JS } from "../scripts/debug_bootstrap.mjs";

type DebugModule = typeof import("../src/cli/debug.js");

/** debug 模块会挂接的事件 */
const DEBUG_EVENTS = ["uncaughtException", "unhandledRejection", "warning", "exit"] as const;

const tmpDirs: string[] = [];

/** 建临时目录，afterEach 统一清理 */
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-debug-test-"));
  tmpDirs.push(dir);
  return dir;
}

function snapshotListeners(): Map<string, unknown[]> {
  return new Map(DEBUG_EVENTS.map((e) => [e, process.listeners(e)]));
}

/** 只摘掉 debug 模块新增的监听器，保留其余（vitest / 运行器自己的） */
function removeAddedListeners(before: Map<string, unknown[]>): void {
  for (const event of DEBUG_EVENTS) {
    const prev = before.get(event) ?? [];
    for (const listener of process.listeners(event)) {
      if (!prev.includes(listener)) {
        process.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
  }
}

/** 以「未被污染」的模块状态运行用例，结束后清理监听器 */
async function withDebug<T>(fn: (debug: DebugModule) => T): Promise<T> {
  const before = snapshotListeners();
  try {
    vi.resetModules();
    const debug = (await import("../src/cli/debug.js")) as DebugModule;
    return await fn(debug);
  } finally {
    removeAddedListeners(before);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("enableDebug — 开关语义", () => {
  it("没有 --debug 且没有环境变量时不开启，dlog 静默且不建文件", async () => {
    await withDebug((debug) => {
      const file = path.join(tmpDir(), "never.log");
      vi.stubEnv("ZQAGENT_DEBUG", "");
      vi.stubEnv("ZQAGENT_DEBUG_LOG", file);

      expect(debug.enableDebug(["zqagent"])).toBe(false);
      expect(debug.isDebugEnabled()).toBe(false);
      expect(debug.debugLogFile()).toBeNull();
      expect(() => debug.dlog("stage", "不应出现")).not.toThrow();
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("--debug 时开启并同步落盘，日志路径可查询", async () => {
    await withDebug((debug) => {
      const file = path.join(tmpDir(), "nested", "debug.log");
      vi.stubEnv("ZQAGENT_DEBUG_LOG", file);
      vi.stubEnv("ZQAGENT_DEBUG", "");

      expect(debug.enableDebug(["zqagent", "--debug"])).toBe(true);
      expect(debug.isDebugEnabled()).toBe(true);
      expect(debug.debugLogFile()).toBe(file);

      debug.dlog("stage-a", "hello");
      debug.dlog("stage-b", "多行\n第二行");
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("[stage-a] hello");
      expect(text).toContain("[stage-b] 多行\n第二行");
    });
  });

  it("ZQAGENT_DEBUG=1 也能开启（大小写不敏感）", async () => {
    await withDebug((debug) => {
      const file = path.join(tmpDir(), "env.log");
      vi.stubEnv("ZQAGENT_DEBUG_LOG", file);
      vi.stubEnv("ZQAGENT_DEBUG", "TRUE");

      expect(debug.enableDebug(["zqagent"])).toBe(true);
      expect(debug.debugLogFile()).toBe(file);
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it("ZQAGENT_DEBUG_LOG 缺失时落到 ZQAGENT_DEBUG_DIR，再退回临时目录", async () => {
    await withDebug((debug) => {
      const dir = tmpDir();
      vi.stubEnv("ZQAGENT_DEBUG_LOG", "");
      vi.stubEnv("ZQAGENT_DEBUG_DIR", dir);
      vi.stubEnv("ZQAGENT_DEBUG", "1");

      debug.enableDebug(["zqagent"]);
      expect(debug.debugLogFile()).toBe(path.join(dir, "zqagent-debug.log"));
    });
  });

  it("重复调用是幂等的，且每次启动截断旧日志", async () => {
    await withDebug((debug) => {
      const file = path.join(tmpDir(), "truncate.log");
      fs.writeFileSync(file, "上一次运行的残留内容");
      vi.stubEnv("ZQAGENT_DEBUG_LOG", file);

      expect(debug.enableDebug(["--debug"])).toBe(true);
      const first = debug.debugLogFile();
      expect(fs.readFileSync(file, "utf8")).toBe("");

      expect(debug.enableDebug(["--debug"])).toBe(true);
      expect(debug.debugLogFile()).toBe(first);
    });
  });
});

describe("describeError — 错误格式化", () => {
  it("包含错误码与堆栈", async () => {
    await withDebug((debug) => {
      const err = Object.assign(new Error("boom"), { code: "EACCES" });
      const text = debug.describeError(err);
      expect(text).toContain("Error (code=EACCES): boom");
      expect(text).toContain("cliDebug.test");
    });
  });

  it("非 Error 抛出物（含 undefined）也能安全格式化", async () => {
    await withDebug((debug) => {
      expect(debug.describeError({ a: 1 })).toContain("非 Error 抛出物");
      expect(debug.describeError(undefined)).toContain("非 Error 抛出物");
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => debug.describeError(circular)).not.toThrow();
    });
  });
});

describe("logEnvironment — 环境快照", () => {
  it("记录关键事实，但绝不打印密钥明文", async () => {
    await withDebug((debug) => {
      const file = path.join(tmpDir(), "env-snapshot.log");
      const secret = "sk-secret-value-should-never-appear";
      vi.stubEnv("ZQAGENT_DEBUG_LOG", file);
      vi.stubEnv("OPENAI_API_KEY", secret);

      debug.enableDebug(["--debug"]);
      debug.logEnvironment();

      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain(process.version);
      expect(text).toContain(process.execPath);
      expect(text).toContain("[env]");
      expect(text).toContain("cwd:");
      expect(text).toContain(`OPENAI_API_KEY = (已设置, 长度 ${secret.length})`);
      expect(text).not.toContain(secret);
    });
  });
});

describe("启动引导（SEA banner）", () => {
  /** 造一个「引导 → 模块初始化期抛错」的最小复现，返回子进程结果与日志内容 */
  function runBootstrapCrash(env: NodeJS.ProcessEnv): {
    status: number | null;
    log: string;
    logPath: string;
    stderr: string;
  } {
    const dir = tmpDir();
    const boot = path.join(dir, "boot.js");
    fs.writeFileSync(boot, DEBUG_BOOTSTRAP_JS);
    const runner = path.join(dir, "runner.cjs");
    fs.writeFileSync(
      runner,
      `require(${JSON.stringify(boot)});\n` +
        `// 模拟 bundle 模块初始化阶段就抛错（banner 已先行执行）\n` +
        `throw new Error("boom-during-module-init");\n`,
    );
    const logPath = path.join(dir, "debug.log");

    const res = spawnSync(process.execPath, [runner], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, ZQAGENT_DEBUG_LOG: logPath },
    });

    return {
      status: res.status,
      log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
      logPath,
      stderr: res.stderr ?? "",
    };
  }

  it("开启诊断时捕获模块初始化期崩溃：留下堆栈并以非零码退出", () => {
    const { status, log, stderr } = runBootstrapCrash({ ZQAGENT_DEBUG: "1" });

    expect(status).toBe(1);
    expect(log).toContain("[boot] bundle 加载开始");
    expect(log).toContain("[crash] uncaughtException");
    expect(log).toContain("boom-during-module-init");
    // 同步落盘的同时也回显 stderr，双击运行看不到时至少文件里有
    expect(stderr).toContain("boom-during-module-init");
  });

  it("--debug 参数同样能开启引导", () => {
    const dir = tmpDir();
    const boot = path.join(dir, "boot.js");
    fs.writeFileSync(boot, DEBUG_BOOTSTRAP_JS);
    const runner = path.join(dir, "runner.cjs");
    fs.writeFileSync(
      runner,
      `require(${JSON.stringify(boot)});\n` +
        `process.exitCode = 0;\n`,
    );
    const logPath = path.join(dir, "debug.log");

    const res = spawnSync(process.execPath, [runner, "--debug"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ZQAGENT_DEBUG: "", ZQAGENT_DEBUG_LOG: logPath },
    });

    expect(res.status).toBe(0);
    expect(fs.readFileSync(logPath, "utf8")).toContain("[boot]");
  });

  it("未开启诊断时引导完全不写入（对正常启动零影响）", () => {
    const { status, log, logPath } = runBootstrapCrash({});

    expect(status).toBe(1); // node 自身的未捕获异常行为未改变
    expect(log).toBe("");
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
