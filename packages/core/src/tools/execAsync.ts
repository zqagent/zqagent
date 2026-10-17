/**
 * 异步子进程执行（spawnSync 的异步替身）
 *
 * 为什么需要：spawnSync 期间 Node 事件循环被整体阻塞，单进程节点上多个会话
 * 并发跑命令时会互相拖死——一条长命令（run_shell / ffmpeg 可达数百秒）就让
 * server 停止响应，SSE 心跳、HTTP 请求、其他会话的工具调用全部排队。
 * 换成异步 spawn 后，等待子进程的时间可以正常处理事件循环。
 *
 * 与 spawnSync 的差异（异步 spawn 不自带的语义在这里补齐）：
 * - 超时：自行计时 + SIGKILL，结果里给出 `timedOut` 布尔
 *   （spawnSync 是 ETIMEDOUT 错误码）；
 * - 中断：监听 opts.signal，abort 时终止整棵进程树，结果里给出 `aborted` 布尔；
 * - 结算兜底：kill 后若仍有后代持有管道（`close` 不触发），宽限期到点强制结算，
 *   保证 Promise 一定有界，绝不永久挂起；
 * - 输出上限：自行累积 + 截断，结果里给出 `truncated` 布尔
 *   （spawnSync 是 ENOBUFS 错误）；
 * - stdout/stderr 保留原始 Buffer，交调用方的 decodeOutput 做编码回退。
 *
 * 参数一律用数组传递，不经 shell 解释，保持与原先一致的注入防护。
 */
import { spawn } from "node:child_process";
import { killTree } from "./killTree.js";

export interface ExecAsyncOptions {
  cwd?: string;
  /** 超时毫秒数；到点 SIGKILL 子进程并置 timedOut。不传则不限时 */
  timeoutMs?: number;
  /** stdout / stderr 各自的累积上限（字节）；超出部分丢弃并置 truncated */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** 需要向 stdin 写入的内容（如 git apply 的补丁）；不传则 stdin 关闭 */
  input?: string;
  /**
   * 中断信号：abort 时终止整棵进程树并置 aborted。
   * 用于把 TurnEngine 的用户中断传导到正在执行的命令。
   */
  signal?: AbortSignal;
}

export interface ExecAsyncResult {
  /** 退出码；被信号杀死或启动失败时为 null */
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** 仅启动失败（命令不存在 ENOENT、无执行权限等）时存在 */
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
  truncated: boolean;
  /** 是否因 signal abort 被终止 */
  aborted?: boolean;
}

/**
 * 存活的子进程（pid）。子进程以 detached 启动（自成进程组，便于整组终止），
 * 因此终端 Ctrl+C 不再波及它们；进程退出时统一收掉，避免遗留孤儿。
 */
const liveChildren = new Set<number>();
let exitCleanupInstalled = false;

function trackChild(pid: number | undefined): void {
  if (!pid) return;
  liveChildren.add(pid);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const p of liveChildren) killTree(p);
  });
}

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 5;

/**
 * 终止进程树后等待 stdio 关闭的宽限期（毫秒）。
 *
 * 结算挂在 `close` 上，而 `close` 要求子进程的 stdout/stderr 全部关闭。子进程虽以
 * detached 启动（自成进程组，killTree 的 `-pid` 覆盖整组），但仍有后代存活的可能：
 * detached 未生效、`process.kill(-pid)` 抛错走了只杀直接 pid 的兜底分支、或后代
 * 自行 setsid / 被 reparent 脱离进程组。此时管道写端不关，`close` 永不触发，
 * Promise 永久挂起（会话卡在 running，interrupt 也因等不到安全点而无效）。
 */
const KILL_GRACE_MS = 1000;

/** 累积器：到上限后丢弃后续数据，但仍消费流避免子进程写阻塞 */
function makeSink(maxBuffer: number): {
  push: (chunk: Buffer) => void;
  done: () => Buffer;
  over: () => boolean;
} {
  const chunks: Buffer[] = [];
  let len = 0;
  let over = false;
  return {
    push(chunk: Buffer) {
      if (len >= maxBuffer) {
        over = true;
        return;
      }
      const room = maxBuffer - len;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        len = maxBuffer;
        over = true;
        return;
      }
      chunks.push(chunk);
      len += chunk.length;
    },
    done: () => Buffer.concat(chunks),
    over: () => over,
  };
}

export function execAsync(
  file: string,
  argv: string[],
  opts: ExecAsyncOptions = {},
): Promise<ExecAsyncResult> {
  return new Promise<ExecAsyncResult>((resolve) => {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const out = makeSink(maxBuffer);
    const err = makeSink(maxBuffer);

    // 调用前已被中断：不必启动进程
    if (opts.signal?.aborted) {
      resolve({
        status: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        aborted: true,
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        // 自成进程组（POSIX）：超时/中断时用 killTree 一次收掉整棵进程树
        detached: process.platform !== "win32",
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        status: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: e as NodeJS.ErrnoException,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    trackChild(child.pid);

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = (): void => {
      aborted = true;
      killAndSettle();
    };

    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (child.pid !== undefined) liveChildren.delete(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      const result: ExecAsyncResult = {
        status,
        stdout: out.done(),
        stderr: err.done(),
        timedOut,
        truncated: out.over() || err.over(),
      };
      if (aborted) result.aborted = true;
      if (spawnError) result.error = spawnError;
      resolve(result);
    };

    /**
     * 终止子进程树，并在宽限期内仍未结算时强制结算。
     *
     * 只调 killTree 是不够的：结算依赖 `close`，而后代存活会让它永不触发
     * （原因见 KILL_GRACE_MS 注释）——本次会话卡死的直接成因。
     */
    const killAndSettle = (): void => {
      killTree(child.pid);
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => {
        // 输出已随 kill 前的 data 事件收完；这里放下可能仍被后代持有的管道，
        // 结算语义已由 timedOut / aborted 确定，不再继续等待
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    };

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killAndSettle();
      }, opts.timeoutMs);
    }

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));

    child.on("error", (e) => {
      spawnError = e as NodeJS.ErrnoException;
      // 进程根本没起来时不会有 close 事件，立即结算避免调用方永久挂起
      if (child.pid === undefined) finish(null);
    });

    if (opts.input !== undefined && child.stdin) {
      // 子进程可能已退出（EPIPE），忽略写入错误
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }

    child.on("close", (code) => finish(code));
  });
}
