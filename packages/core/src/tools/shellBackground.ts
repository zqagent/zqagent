/**
 * 后台 shell 任务管理器
 *
 * 支撑 run_shell 的 `run_in_background` 能力（开发服务器 / watch 进程等长驻任务）：
 *   - start()：detached 启动，stdout/stderr 进环形缓冲，立即返回 task_id；
 *   - output()：读取某任务的累计输出与状态；
 *   - kill()：终止整棵进程树（Windows 用 taskkill /T /F，POSIX 用进程组信号）；
 *   - disposeAll()：进程退出时统一清理，避免残留子进程。
 *
 * 输出缓冲有上限（默认 64KB/流），超出丢弃最旧内容，防止长驻任务把内存吃满。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "./killTree.js";

/** 每个输出流的缓冲上限（字符） */
const DEFAULT_BUFFER_LIMIT = 64 * 1024;

/** 固定长度的环形字符缓冲：超出上限时从头部丢弃 */
class RingBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly limit = DEFAULT_BUFFER_LIMIT) {}

  add(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    // 单个 chunk 就可能超限：直接截取尾部
    if (this.size > this.limit) {
      const joined = this.chunks.join("");
      this.chunks = [joined.slice(-this.limit)];
      this.size = this.chunks[0]!.length;
    }
  }

  get(): string {
    const joined = this.chunks.join("");
    return joined.length > this.limit ? joined.slice(-this.limit) : joined;
  }
}

interface BackgroundTask {
  id: string;
  command: string;
  /** 归属标识（server 传租户 id），用于按项目过滤任务列表 */
  scope: string | null;
  child: ChildProcess;
  stdout: RingBuffer;
  stderr: RingBuffer;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
}

export interface BackgroundTaskSnapshot {
  task_id: string;
  command: string;
  status: "running" | "exited" | "killed";
  running: boolean;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface StartOptions {
  command: string;
  file: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 归属标识（如租户 id），用于按项目过滤任务列表 */
  scope?: string | null;
}

export class ShellTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private seq = 0;
  private cleanupInstalled = false;

  /** 启动一个后台任务，立即返回快照（不等退出） */
  start(opts: StartOptions): BackgroundTaskSnapshot {
    this.installCleanup();
    const id = `shell-${++this.seq}-${Date.now().toString(36)}`;
    const child = spawn(opts.file, opts.argv, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const task: BackgroundTask = {
      id,
      command: opts.command,
      scope: opts.scope ?? null,
      child,
      stdout: new RingBuffer(),
      stderr: new RingBuffer(),
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.tasks.set(id, task);

    child.stdout?.on("data", (d: Buffer) => task.stdout.add(d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => task.stderr.add(d.toString("utf-8")));
    child.on("error", (err) => task.stderr.add(`[spawn error] ${err.message}\n`));
    child.on("exit", (code, signal) => {
      task.exitCode = code;
      task.signal = signal;
      task.endedAt = Date.now();
      // 已被 kill() 标记为 killed 的保持 killed，否则记为正常退出
      if (task.status !== "killed") task.status = "exited";
    });
    // 允许父进程退出后子进程继续（配合 disposeAll 显式清理）
    child.unref();

    return this.snapshot(task);
  }

  /** 读取任务输出与状态 */
  output(taskId: string): BackgroundTaskSnapshot | { error: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `未知的后台任务: ${taskId}` };
    return this.snapshot(task);
  }

  /** 终止任务（进程树）并返回快照；传 scope 时只允许终止该归属下的任务 */
  kill(taskId: string, scope?: string | null): BackgroundTaskSnapshot | { error: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `未知的后台任务: ${taskId}` };
    if (scope !== undefined && task.scope !== scope) {
      return { error: `未知的后台任务: ${taskId}` };
    }
    if (task.status === "running") {
      task.status = "killed";
      task.endedAt = Date.now();
      killTree(task.child.pid);
    }
    return this.snapshot(task);
  }

  /** 列出任务快照（调试/展示用）；传 scope 时只返回该归属下的任务 */
  list(scope?: string | null): BackgroundTaskSnapshot[] {
    const all = [...this.tasks.values()];
    return (scope === undefined ? all : all.filter((t) => t.scope === scope)).map((t) =>
      this.snapshot(t),
    );
  }

  /** 终止全部任务（进程退出时调用） */
  disposeAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "killed";
        killTree(task.child.pid);
      }
    }
  }

  private snapshot(task: BackgroundTask): BackgroundTaskSnapshot {
    return {
      task_id: task.id,
      command: task.command,
      status: task.status,
      running: task.status === "running",
      exit_code: task.exitCode,
      signal: task.signal,
      stdout: task.stdout.get(),
      stderr: task.stderr.get(),
      duration_ms: (task.endedAt ?? Date.now()) - task.startedAt,
    };
  }

  private installCleanup(): void {
    if (this.cleanupInstalled) return;
    this.cleanupInstalled = true;
    process.once("exit", () => this.disposeAll());
  }
}
