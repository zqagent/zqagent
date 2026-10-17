/**
 * CLI 启动诊断（`--debug` / `ZQAGENT_DEBUG=1`）
 *
 * 背景：CLI 在某些环境下会「一闪而过、控制台没有任何输出」——进程在打印横幅
 * 之前抛出时，未捕获异常在部分终端（尤其 Windows 双击运行 / cmd）来不及显示。
 * 排查这类问题需要「不依赖终端也能拿到证据」，因此本模块的诊断输出**同步**落盘
 * （`appendFileSync`，不经事件循环与 stdout 缓冲，进程立刻 exit 也不丢），同时回显
 * 到 stderr。
 *
 * 日志路径规则（与 SEA 产物的启动引导保持一致，见 scripts/debug_bootstrap.mjs）：
 *   `ZQAGENT_DEBUG_LOG`（完整路径）→ `ZQAGENT_DEBUG_DIR/zqagent-debug.log`
 *   → `os.tmpdir()/zqagent-debug.log`
 *
 * 本模块只依赖 Node 内置模块，且所有写操作都吞掉异常——诊断本身不允许成为新的
 * 启动失败原因。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sanitizeEmoji } from "../terminal.js";

/** 日志文件名（与 scripts/debug_bootstrap.mjs 的规则一致） */
const LOG_NAME = "zqagent-debug.log";

/** 视为「开启」的环境变量取值 */
const TRUTHY = /^(1|true|yes|on)$/i;

/** SEA 产物启动引导留下的引用（见 scripts/debug_bootstrap.mjs） */
interface BootRef {
  /** 引导已建好的日志文件绝对路径 */
  file: string;
  /** 引导启动时刻的毫秒时间戳，作为统一计时基准 */
  t0: number;
  /** 引导提供的写入函数（行首已含耗时前缀） */
  write: (text: string) => void;
}

/** 取回启动引导的引用；非 SEA 产物（npm 安装的 bin）时返回 undefined */
function bootRef(): BootRef | undefined {
  return (globalThis as { __zqagentDebug?: BootRef }).__zqagentDebug;
}

let enabled = false;
let logFile: string | null = null;
let startedAt = Date.now();

/** 诊断是否已开启（供调用方决定是否附加额外信息） */
export function isDebugEnabled(): boolean {
  return enabled;
}

/** 当前诊断日志文件路径（未开启或落盘不可用时为 null） */
export function debugLogFile(): string | null {
  return logFile;
}

/** 解析日志路径：显式文件 → 显式目录 → 系统临时目录 */
function resolveLogFile(): string {
  const explicit = process.env.ZQAGENT_DEBUG_LOG;
  if (explicit) return path.resolve(explicit);
  const dir = process.env.ZQAGENT_DEBUG_DIR;
  return path.join(dir ? path.resolve(dir) : os.tmpdir(), LOG_NAME);
}

/**
 * 开启诊断并注册崩溃捕获，返回是否开启。
 *
 * 幂等：重复调用只生效一次；SEA 产物在 bundle 之前已由启动引导开启时，
 * 直接复用其日志文件与计时基准（避免同一进程写出两个日志）。
 */
export function enableDebug(argv: readonly string[] = process.argv): boolean {
  if (enabled) return true;
  const requested =
    argv.includes("--debug") || TRUTHY.test(process.env.ZQAGENT_DEBUG ?? "");
  if (!requested) return false;

  const boot = bootRef();
  if (boot) {
    enabled = true;
    logFile = boot.file;
    startedAt = boot.t0;
    return true;
  }

  enabled = true;
  logFile = resolveLogFile();
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, ""); // 每次启动截断，避免历史内容混淆本次排查
  } catch {
    logFile = null; // 落盘不可用 → 退化为仅回显 stderr
  }
  installCrashHandlers();
  return true;
}

/**
 * 写一条诊断。stage 是短标签（env / main / runTurn …），message 可含多行。
 * 同步落盘 + 回显 stderr，任何失败都静默忽略。
 */
export function dlog(stage: string, message = ""): void {
  if (!enabled) return;
  const boot = bootRef();
  if (boot) {
    boot.write(`[${stage}] ${message}`);
    return;
  }
  const line = `[+${String(Date.now() - startedAt).padStart(6)}ms] [${stage}] ${message}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      /* 诊断失败不能影响主流程 */
    }
  }
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* stderr 可能已关闭 */
  }
}

/** 把任意抛出物格式化为 message + 堆栈（诊断用，自身绝不抛） */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return `${err.name}${code ? ` (code=${code})` : ""}: ${err.message}\n${err.stack ?? "(无堆栈)"}`;
  }
  try {
    return `非 Error 抛出物: ${JSON.stringify(err)}`;
  } catch {
    return `非 Error 抛出物: ${String(err)}`;
  }
}

/** 记录一个阶段失败（含完整堆栈） */
export function dlogError(stage: string, err: unknown): void {
  dlog(stage, sanitizeEmoji(`✗ 失败\n${describeError(err)}`));
}

/** 同步阶段包装：记录进入 / 退出 / 失败，异常原样抛出 */
export function debugStage<T>(stage: string, fn: () => T): T {
  if (!enabled) return fn();
  dlog(stage, "开始");
  try {
    const out = fn();
    dlog(stage, "完成");
    return out;
  } catch (err) {
    dlogError(stage, err);
    throw err;
  }
}

/** 异步阶段包装：语义同 debugStage */
export async function debugStageAsync<T>(
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  dlog(stage, "开始");
  try {
    const out = await fn();
    dlog(stage, "完成");
    return out;
  } catch (err) {
    dlogError(stage, err);
    throw err;
  }
}

/**
 * 注册崩溃捕获：未捕获异常 / 未处理拒绝 / 进程退出全部落盘。
 *
 * 这是「无输出退出」的关键——默认情况下 Node 不会报告这些内容，而落盘是同步的，
 * 进程随后的退出不影响写入结果。仅诊断模式生效。
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    dlog("crash", `uncaughtException\n${describeError(err)}`);
    process.exit(1); // 同步落盘已完成，立刻退出而不是带着半死状态继续跑
  });
  process.on("unhandledRejection", (reason) => {
    dlog("crash", `unhandledRejection\n${describeError(reason)}`);
  });
  process.on("warning", (w) => {
    dlog("warning", `${w.name}: ${w.message}`);
  });
  process.on("exit", (code) => {
    dlog("exit", `进程退出 code=${code}`);
  });
}

/** 执行并返回字符串化结果，抛错时返回错误描述（用于环境快照） */
function safe(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    return `<取值失败: ${describeError(err)}>`;
  }
}

/** 是否 SEA 单文件产物（`node:sea` 在旧版本不存在，取不到即视作未知） */
function seaFlag(): string {
  try {
    const getBuiltin = (
      process as unknown as {
        getBuiltinModule?: (id: string) => unknown;
      }
    ).getBuiltinModule;
    const sea = getBuiltin?.("node:sea") as
      | { isSea?: () => boolean }
      | undefined;
    return sea?.isSea ? String(sea.isSea()) : "未知（无 node:sea）";
  } catch {
    return "未知";
  }
}

/** 关键环境变量快照——排查「换台机器/换终端就起不来」时最有用的一组事实 */
function envDump(): string {
  const keys = [
    "WORKSPACE",
    "OPENAI_MODEL",
    "OPENAI_BASE_URL",
    "MAX_ITERATIONS",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
    "SHELL",
    "ZQAGENT_SHELL",
    "ZQAGENT_BUSYBOX",
    "TERM",
    "COLORTERM",
    "LANG",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];
  const lines = keys.map((k) => {
    const v = process.env[k];
    if (v === undefined) return `  ${k} = (未设置)`;
    if (k === "PATH") return `  PATH = ${shorten(v)}`;
    return `  ${k} = ${v}`;
  });
  lines.push(`  PATH = ${process.env.PATH ? shorten(process.env.PATH) : "(未设置)"}`);
  // 凭据只报告「是否存在 + 长度」，绝不打印明文
  for (const k of ["OPENAI_API_KEY", "ZQAGENT_API_KEY"]) {
    const v = process.env[k];
    lines.push(`  ${k} = ${v ? `(已设置, 长度 ${v.length})` : "(未设置)"}`);
  }
  return lines.join("\n");
}

/** 过长内容截断显示，避免 PATH 之类刷屏 */
function shorten(v: string, max = 500): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max)}… (共 ${v.length} 字符)`;
}

/**
 * 打印启动环境快照。刻意「只报事实」：版本、路径、TTY、内存、关键环境变量，
 * 不推测原因——每条都可能解释「为什么这台机器上不一样」。
 */
export function logEnvironment(): void {
  if (!enabled) return;
  const tty = (name: string, s: { isTTY?: boolean } | undefined): string =>
    s ? `${name}.isTTY = ${String(s.isTTY)}` : `${name} 不存在`;

  dlog("env", `诊断已开启，日志文件: ${logFile ?? "(不可写，仅 stderr)"}`);
  dlog("env", `时间: ${new Date().toISOString()}`);
  dlog("env", `node: ${process.version} (${process.platform}/${process.arch})`);
  dlog("env", `execPath: ${process.execPath}`);
  dlog("env", `argv: ${JSON.stringify(process.argv)}`);
  dlog("env", `cwd: ${safe(() => process.cwd())}`);
  dlog("env", `pid: ${process.pid}  ppid: ${process.ppid}`);
  dlog("env", `sea: ${seaFlag()}`);
  dlog(
    "env",
    `${tty("stdin", process.stdin)} / ${tty("stdout", process.stdout)} / ${tty("stderr", process.stderr)}`,
  );
  dlog(
    "env",
    `stdout 终端: ${safe(() => `columns=${String(process.stdout.columns)} rows=${String(process.stdout.rows)} colorDepth=${String(process.stdout.getColorDepth?.())}`)}`,
  );
  dlog(
    "env",
    `内存: rss=${Math.round(process.memoryUsage().rss / 1048576)}MB heapTotal=${Math.round(process.memoryUsage().heapTotal / 1048576)}MB`,
  );
  dlog("env", `关键环境变量:\n${envDump()}`);
}
