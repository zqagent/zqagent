/**
 * Shell 工具
 *
 * 提供 run_shell 工具（对齐 Python 版 LocalExecutor）：
 * 在持久化 shell 会话中执行命令。cwd 在多次调用之间保持
 * （支持 cd / pushd 命令切换目录，状态按工作区存放，引擎重建也不丢），
 * 输出截断到末尾部分，超时与缓冲区大小均有上限。
 *
 * 用哪个 shell 由 shellRuntime 决定：POSIX 下沿用 Node 默认 /bin/sh
 * （行为不变），Windows 下优先 POSIX 风格 shell（busybox / Git Bash /
 * PowerShell），都没有才回退 cmd.exe。
 *
 * 执行统一走异步 execAsync：成功与失败都能拿到真实的 stdout / stderr / exit_code
 * （旧实现用 execSync，成功分支把 stderr 丢弃、exit_code 恒为 0）；异步而非
 * spawnSync，避免命令执行期间阻塞事件循环、拖住其他会话与心跳。
 * 另外支持 run_in_background，配合 shell_task_output / shell_task_kill
 * 管理开发服务器等长驻进程。
 */
import * as fs from "fs";
import * as path from "path";
import { ToolRegistry } from "./ToolRegistry.js";
import { execAsync } from "./execAsync.js";
import {
  describeShell,
  parseCdChain,
  resolveShellSpec,
  wrapCommand,
  type ShellSpec,
} from "./shellRuntime.js";
import { ShellTaskManager } from "./shellBackground.js";
import type { BackgroundTaskSnapshot } from "./shellBackground.js";
import type { ToolExecContext } from "./ToolRegistry.js";

/** 输出截断上限（字符） */
const MAX_STDOUT = 10000;
const MAX_STDERR = 5000;
/** 单次命令输出缓冲上限（字节） */
const MAX_BUFFER = 1024 * 1024 * 5;

/**
 * 持久 shell 会话状态：按工作区根目录存放 cwd。
 *
 * 之所以放在模块级而不是 makeRunShell 的闭包里：CLI 在 /mode、/agent、/model、
 * reset 时会重建引擎（重新调用 registerShellTool），闭包里的 cwd 会随之丢失。
 * 以工作区为键既可跨引擎重建保持，又不会在多租户之间串目录。
 */
const shellSessions = new Map<string, { cwd: string }>();

function sessionFor(workspace: string): { cwd: string } {
  // 用规范化后的绝对路径作键：避免尾斜杠 / 相对路径在不同注册点产生两个会话
  const key = path.resolve(workspace);
  let s = shellSessions.get(key);
  if (!s) {
    s = { cwd: key };
    shellSessions.set(key, s);
  }
  return s;
}

/** 测试用：重置某个工作区的 shell 会话状态 */
export function resetShellSession(workspace: string): void {
  shellSessions.delete(path.resolve(workspace));
}

/** 解析实际执行的 shell 可执行文件与 argv 构造器（default 时按平台兜底） */
function resolveInvocation(
  spec: ShellSpec,
  prepared: string,
): { file: string; argv: string[] } {
  if (spec.file !== null) {
    return { file: spec.file, argv: spec.buildArgs(prepared) };
  }
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    return { file: comspec, argv: ["/d", "/s", "/c", prepared] };
  }
  return { file: "/bin/sh", argv: ["-c", prepared] };
}

/** 供 run_shell 与后台任务共用的环境变量 */
function shellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/**
 * 解码子进程输出。
 *
 * 正常情况下命令前已注入 UTF-8 编码设置，输出就是 UTF-8。但 PowerShell 的
 * **语法错误（ParserError）** 会在脚本执行前就抛出，此时编码设置那行还没跑，
 * stderr 用的是控制台 OEM 代码页（中文 Windows 为 936/GBK）——直接按 UTF-8
 * 读会得到乱码。这里先严格按 UTF-8 解，失败再回退到 GBK 等常见编码。
 */
export function decodeOutput(buf: Buffer | null | undefined): string {
  if (!buf || buf.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    for (const enc of ["gbk", "big5", "shift_jis", "latin1"]) {
      try {
        return new TextDecoder(enc).decode(buf);
      } catch {
        /* 当前 Node 构建不支持该编码，继续尝试 */
      }
    }
    return buf.toString("latin1");
  }
}

/**
 * run_shell — 持久化 shell (对齐 Python 版 LocalExecutor)
 *
 * 内部维护 cwd 状态：识别 cd / pushd 命令并更新，使后续命令在新目录下执行。
 * 注意：不要用 require()（ESM 下未定义），必须用 import 的 fs/path。
 */
function makeRunShell(workspace: string, spec: ShellSpec, tasks: ShellTaskManager, scope: string | null) {
  const session = sessionFor(workspace);

  return async function run_shell(args: Record<string, unknown>, ctx?: ToolExecContext) {
    const command = String(args.command ?? "");
    const description = String(args.description ?? "").slice(0, 100);
    const background = args.run_in_background === true;
    // 超时上限 600s，换算为毫秒；非法值回退默认 120s
    const rawTimeout = Number(args.timeout_seconds ?? 120);
    const timeoutSec = Number.isFinite(rawTimeout) ? rawTimeout : 120;
    const timeout = Math.min(Math.max(timeoutSec, 1), 600) * 1000;

    if (!command.trim()) {
      return { error: "命令不能为空" };
    }

    // 切目录：在执行前解析，这样 `cd dir && 其他命令` 的剩余部分能在新目录下跑
    // （否则目录变更只作用于那个子 shell，无法跨调用保持）。
    const { target, rest } = parseCdChain(command);
    let toRun = command;
    if (target) {
      try {
        const resolved = path.resolve(session.cwd, target);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          session.cwd = resolved;
        }
      } catch {
        /* ignore */
      }
      if (rest) toRun = rest;
    }

    const prepared = wrapCommand(spec.kind, toRun);
    const { file, argv } = resolveInvocation(spec, prepared);
    const env = shellEnv();

    // ---- 后台执行 ----
    if (background) {
      const snap = tasks.start({ command, file, argv, cwd: session.cwd, env, scope });
      return {
        task_id: snap.task_id,
        status: snap.status,
        cwd: session.cwd,
        note: "已在后台启动。用 shell_task_output 查看输出，shell_task_kill 终止。",
      };
    }

    // ---- 前台执行 ----
    // 不用 encoding: "utf-8"，先拿原始字节再自适应解码（见 decodeOutput）。
    const result = await execAsync(file, argv, {
      cwd: session.cwd,
      timeoutMs: timeout,
      maxBuffer: MAX_BUFFER,
      env,
      signal: ctx?.signal,
    });

    const stdout = decodeOutput(result.stdout).slice(-MAX_STDOUT);
    const stderr = decodeOutput(result.stderr).slice(-MAX_STDERR);

    // 被用户中断：报告为中断而非普通失败，引擎随即按中断收尾
    if (result.aborted) {
      return {
        stdout,
        stderr,
        exit_code: result.status ?? 1,
        cwd: session.cwd,
        interrupted: true,
        error: "命令已被用户中断",
      };
    }

    // 非超时的启动错误（如 shell 不存在）单独报告
    if (result.error && !result.timedOut) {
      const message = result.error.message;
      return {
        stdout,
        stderr: stderr || message,
        exit_code: 1,
        cwd: session.cwd,
        error: message.slice(0, 200),
      };
    }

    return {
      stdout,
      stderr,
      exit_code: result.status ?? 1,
      cwd: session.cwd,
      ...(result.timedOut
        ? { timed_out: true, error: `命令超时（${timeoutSec}s）后已终止` }
        : {}),
    };
  };
}

/**
 * 后台任务表：与 shellSessions 同理，放模块级单例。
 * 若每次注册都新建，引擎重建后旧 task_id 会查不到、后台进程也失去跟踪。
 */
const shellTasks = new ShellTaskManager();

/** 列出后台任务快照；scope 为 undefined 时返回全部（控制台按项目过滤用） */
export function listShellTasks(scope?: string | null): BackgroundTaskSnapshot[] {
  return shellTasks.list(scope);
}

/** 终止后台任务（连同进程树）；scope 用于限定归属，防止跨项目误杀 */
export function killShellTask(
  taskId: string,
  scope?: string | null,
): BackgroundTaskSnapshot | { error: string } {
  return shellTasks.kill(taskId, scope);
}

/**
 * 注册 Shell 工具（高风险：requiresApproval=true，由权限引擎门控）
 *
 * @param scope 后台任务归属（server 传租户 id）；用于按项目过滤任务列表与终止
 */
export function registerShellTool(
  registry: ToolRegistry,
  workspace: string,
  scope?: string | null,
): void {
  const spec = resolveShellSpec();
  const tasks = shellTasks;
  const shell = makeRunShell(workspace, spec, tasks, scope ?? null);

  registry.register(
    (args, ctx) => shell(args, ctx),
    { category: "shell", riskLevel: "high", capabilities: ["run_shell"], requiresApproval: true },
    {
      type: "function",
      function: {
        name: "run_shell",
        description:
          "在持久化 shell 会话中运行命令 (cwd 和环境变量在多次调用之间保持)。" +
          "输出截断到最后部分，stdout 与 stderr 都会返回。" +
          "传递 description 说明命令用途 (显示在审批提示中)，" +
          "传递 timeout_seconds 控制超时。" +
          "对于开发服务器 / watch 等长驻进程，设置 run_in_background=true，" +
          "随后用 shell_task_output 轮询输出、shell_task_kill 终止。" +
          `运行环境：${describeShell(spec, process.platform)}`,
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的 shell 命令" },
            description: { type: "string", description: "命令用途的简短描述 (显示在审批中)" },
            timeout_seconds: { type: "integer", description: "超时秒数 (默认 120，最大 600)" },
            run_in_background: {
              type: "boolean",
              description: "是否后台运行 (默认 false)。适合开发服务器等长驻进程。",
            },
          },
          required: ["command"],
        },
      },
    },
  );

  // ---- shell_task_output ----
  registry.register(
    (args) => tasks.output(String(args.task_id ?? "")),
    { category: "shell", riskLevel: "low", capabilities: ["run_shell"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "shell_task_output",
        description:
          "查看 run_shell(run_in_background=true) 启动的后台任务的累计输出与状态。" +
          "返回 status (running/exited/killed)、exit_code、stdout、stderr。",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "run_shell 返回的 task_id" },
          },
          required: ["task_id"],
        },
      },
    },
  );

  // ---- shell_task_kill ----
  registry.register(
    (args) => tasks.kill(String(args.task_id ?? ""), scope ?? null),
    { category: "shell", riskLevel: "medium", capabilities: ["run_shell"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "shell_task_kill",
        description: "终止后台任务（连同其子进程树）。返回任务的最终状态。",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "run_shell 返回的 task_id" },
          },
          required: ["task_id"],
        },
      },
    },
  );
}
