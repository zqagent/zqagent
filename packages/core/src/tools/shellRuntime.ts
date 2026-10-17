/**
 * shell 运行时探测
 *
 * 决定 run_shell 用哪个 shell 执行命令，解决三件事：
 * - POSIX：沿用 Node 默认 /bin/sh，不改变既有语义；
 * - Windows：cmd.exe 没有 ls/grep/rm/cat，优先挑一个 POSIX 风格的 shell
 *   （BusyBox-w32 / Git Bash / PowerShell），都没有时才回退到 %ComSpec%；
 * - 允许用 ZQAGENT_SHELL / ZQAGENT_BUSYBOX 显式覆盖，便于在装了非常规
 *   shell（如内网自带的 busybox）的机器上接入。
 *
 * 本模块只做解析，不执行命令；platform / env / 文件探测均可注入，
 * 便于在 CI（Linux）上覆盖 Windows 分支。
 */
import * as fs from "fs";
import * as path from "path";

/** shell 家族，决定命令行参数怎么拼 */
export type ShellKind = "sh" | "busybox" | "powershell" | "cmd" | "default";

export interface ShellSpec {
  kind: ShellKind;
  /** 人类可读标签，用于工具描述 */
  label: string;
  /** 可执行文件路径；null 表示交给 Node 默认（POSIX /bin/sh 或 %ComSpec%） */
  file: string | null;
  /** 拼出实际 argv（含命令本身） */
  buildArgs: (command: string) => string[];
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 判断文件是否存在，便于测试注入 */
  fileExists?: (p: string) => boolean;
  /** 用于定位「产物同目录」的 busybox，默认 process.execPath */
  execPath?: string;
}

export interface ProbeContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
}

/** Windows 可执行文件后缀（按优先级） */
const WINDOWS_SUFFIXES = [".exe", ".cmd", ".bat", ".com", ""];

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultFileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 按目标平台（而非宿主）拼路径 */
function joinPath(platform: NodeJS.Platform, ...parts: string[]): string {
  return pathApi(platform).join(...parts);
}

/**
 * 在 PATH 上查找可执行文件（同步，不 spawn 进程）。
 * name 含路径分隔符时按路径直接判定。Windows 会按 WINDOWS_SUFFIXES 补后缀。
 */
export function findExecutable(name: string, ctx: ProbeContext): string | null {
  if (name.includes("/") || name.includes("\\")) {
    return ctx.fileExists(name) ? name : null;
  }
  const suffixes = ctx.platform === "win32" ? WINDOWS_SUFFIXES : [""];
  const delimiter = ctx.platform === "win32" ? ";" : ":";
  const dirs = (ctx.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = joinPath(ctx.platform, dir, name + suffix);
      if (ctx.fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** 按文件名推断 shell 家族 */
function kindFromBasename(base: string): ShellKind {
  const b = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  if (b === "busybox") return "busybox";
  if (b === "powershell" || b === "pwsh") return "powershell";
  if (b === "cmd") return "cmd";
  // sh/bash/dash/zsh/ash 以及不认识的名字（如 busybox 的 sh.exe 符号链接）都按 sh 处理
  return "sh";
}

/**
 * busybox 按 argv[0] 决定 applet：`busybox.exe` 需要显式给 applet 名
 * （`busybox.exe sh -c "..."`），而重命名/硬链接出来的 `sh.exe` 本身就是 ash，
 * 多传一个 "sh" 会被当成脚本文件名。
 */
function busyboxArgs(file: string | null, command: string): string[] {
  const base = (file ? path.win32.basename(file) : "busybox")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "");
  return base === "busybox" ? ["sh", "-c", command] : ["-c", command];
}

function argsFor(kind: ShellKind, command: string): string[] {
  switch (kind) {
    case "busybox":
      return ["sh", "-c", command];
    case "powershell":
      return ["-NoProfile", "-NonInteractive", "-Command", command];
    case "cmd":
      return ["/d", "/s", "/c", command];
    default:
      return ["-c", command];
  }
}

function makeSpec(kind: ShellKind, file: string | null, label: string): ShellSpec {
  return {
    kind,
    file,
    label,
    buildArgs: (command) =>
      kind === "busybox" ? busyboxArgs(file, command) : argsFor(kind, command),
  };
}

function defaultLabelFor(kind: ShellKind): string {
  switch (kind) {
    case "busybox":
      return "busybox ash";
    case "powershell":
      return "PowerShell";
    case "cmd":
      return "cmd.exe";
    case "default":
      return "系统默认 shell";
    default:
      return "sh";
  }
}

/**
 * 查找 BusyBox-w32。
 * 显式 ZQAGENT_BUSYBOX 优先；否则看 CLI 产物同目录及其 bin/ 子目录
 * （兼容 SEA 单文件、npm 安装与桌面 sidecar 三种布局，其中 sh.exe 是
 * busybox.exe 的重命名副本 —— busybox 按 argv[0] 决定 applet）。
 */
function findBusybox(
  ctx: ProbeContext,
  execPath: string,
): string | null {
  const explicit = (ctx.env.ZQAGENT_BUSYBOX ?? "").trim();
  if (explicit) return ctx.fileExists(explicit) ? explicit : null;

  const exeDir = pathApi(ctx.platform).dirname(execPath);
  const candidates = [
    joinPath(ctx.platform, exeDir, "busybox.exe"),
    joinPath(ctx.platform, exeDir, "sh.exe"),
    joinPath(ctx.platform, exeDir, "bin", "busybox.exe"),
    joinPath(ctx.platform, exeDir, "bin", "sh.exe"),
  ];
  for (const candidate of candidates) {
    if (ctx.fileExists(candidate)) return candidate;
  }
  return null;
}

/** 解析 ZQAGENT_SHELL 的显式取值（关键字或路径） */
function resolveRequested(requested: string, ctx: ProbeContext, execPath: string): ShellSpec {
  const lower = requested.toLowerCase();

  if (lower === "cmd") {
    const file =
      findExecutable("cmd", ctx) ?? ctx.env.ComSpec ?? ctx.env.COMSPEC ?? "cmd.exe";
    return makeSpec("cmd", file, "cmd.exe");
  }
  if (lower === "powershell" || lower === "pwsh") {
    const file =
      findExecutable(lower, ctx) ?? findExecutable("powershell", ctx) ?? `${lower}.exe`;
    return makeSpec("powershell", file, "PowerShell");
  }
  if (lower === "busybox") {
    const found = findBusybox(ctx, execPath) ?? findExecutable("busybox", ctx);
    return makeSpec("busybox", found ?? requested, "busybox ash");
  }
  if (["sh", "bash", "dash", "zsh", "ash"].includes(lower)) {
    return makeSpec("sh", findExecutable(lower, ctx) ?? lower, lower);
  }

  // 视为路径（可能含空格，如 C:\Program Files\Git\bin\bash.exe）
  const base = pathApi(ctx.platform).basename(requested);
  const kind = kindFromBasename(base);
  return makeSpec(kind, requested, base || defaultLabelFor(kind));
}

/**
 * 解析当前应使用的 shell。
 * 返回值 file === null 时表示「不显式指定」，由 Node 走平台默认 shell
 * （POSIX /bin/sh / Windows %ComSpec%），即改造前的行为。
 */
export function resolveShellSpec(opts: ResolveShellOptions = {}): ShellSpec {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const ctx: ProbeContext = {
    platform,
    env,
    fileExists: opts.fileExists ?? defaultFileExists,
  };

  const requested = (env.ZQAGENT_SHELL ?? "").trim();
  if (requested && requested.toLowerCase() !== "auto") {
    return resolveRequested(requested, ctx, execPath);
  }

  // 非 Windows：保持 Node 默认（不改变既有行为）
  if (platform !== "win32") {
    return makeSpec("default", null, "/bin/sh");
  }

  // Windows：优先 POSIX 风格 shell —— cmd.exe 缺 ls/grep/rm/cat，模型产出的
  // POSIX 命令在它下面几乎全废。
  const busybox = findBusybox(ctx, execPath);
  if (busybox) return makeSpec("busybox", busybox, "busybox ash (POSIX)");

  const bash = findExecutable("bash", ctx);
  if (bash) return makeSpec("sh", bash, "bash (Git for Windows)");

  // PowerShell 排在 cmd 之前：它有 ls/cat/rm/cp/mv/pwd 别名，更接近模型习惯
  const shell = findExecutable("pwsh", ctx) ?? findExecutable("powershell", ctx);
  if (shell) return makeSpec("powershell", shell, "PowerShell");

  return makeSpec("default", null, env.ComSpec ?? env.COMSPEC ?? "cmd.exe");
}

/**
 * 为命令套上「编码设置 + 退出码传播」外壳，按 shell 家族区分。
 *
 * - PowerShell：先设置控制台输出编码为 UTF-8（同一次调用内即对后续命令生效，
 *   规避 `chcp 65001` 要等下一次调用才生效的问题），命令结束后若存在
 *   `$LASTEXITCODE` 就以它作为进程退出码 —— 否则 PowerShell 对 `cmd /c ...`
 *   这类原生命令一律返回 0，工具拿到的 exit_code 不可信。
 * - cmd.exe（含 Windows 下未探测到其它 shell 时的 default）：`chcp 65001` 切换
 *   代码页，避免中文被压成 `?`。
 * - POSIX sh / busybox：现代环境默认 UTF-8，不改动。
 */
export function wrapCommand(
  kind: ShellKind,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (kind === "powershell") {
    return (
      "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      command +
      "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"
    );
  }
  if (kind === "cmd" || (kind === "default" && platform === "win32")) {
    return `chcp 65001>nul & ${command}`;
  }
  return command;
}

/** 生成给模型的运行环境提示，追加到 run_shell 描述里 */
export function describeShell(spec: ShellSpec, platform: NodeJS.Platform): string {
  if (spec.kind === "sh" || spec.kind === "busybox") {
    return `当前平台 ${platform}，shell=${spec.label}：请使用 POSIX 风格命令。`;
  }
  if (spec.kind === "powershell") {
    return (
      `当前平台 ${platform}，shell=PowerShell：ls/cat/rm/cp/mv/pwd 等别名可用，` +
      `也可用 cmdlet；路径分隔符为 "\\"。`
    );
  }
  if (spec.kind === "default" && platform !== "win32") {
    return `当前平台 ${platform}，shell=${spec.label}：请使用 POSIX 风格命令。`;
  }
  return (
    `当前平台 ${platform}，shell=${spec.label}：请使用 Windows 命令` +
    `（dir/type/del/copy/move/findstr），多条命令用 & 或 && 连接；` +
    `不要使用 ls/cat/rm/grep 等 POSIX 命令。`
  );
}

/**
 * 解析命令里的「切目录」意图，返回目录与剩余命令。
 *
 * 识别 POSIX 的 `cd dir`、PowerShell 的 `Set-Location`/`sl`、cmd 的 `cd /d dir`，
 * 以及 `pushd`/`Push-Location`（只跟踪目标目录；popd 的栈语义不在此处理）。
 * 带 `&&` 时（如 `cd /d D:\x && dir`）只把切目录部分交给 cwd 跟踪，剩余命令
 * 在新目录下执行 —— 否则目录变更只影响那一个子 shell，无法跨调用保持。
 *
 * target 为 null 时调用方应原样执行命令（未识别到切目录意图）。
 */
export function parseCdChain(
  command: string,
  opts: { platform?: NodeJS.Platform } = {},
): { target: string | null; rest: string | null } {
  const platform = opts.platform ?? process.platform;
  const trimmed = command.trim();

  const chain = /^([\s\S]*?)\s*&&\s*([\s\S]+)$/.exec(trimmed);
  const head = (chain ? chain[1] : trimmed).trim();
  const rest = chain ? chain[2].trim() : null;

  const m = /^(?:cd|set-location|sl|pushd|push-location)\b\s*([\s\S]*)$/i.exec(head);
  if (!m) return { target: null, rest: null };

  let target = m[1].trim();
  // PowerShell 显式参数与 cmd 的盘符切换
  target = target.replace(/^-(?:path|literalpath)\s+/i, "");
  if (platform === "win32") target = target.replace(/^\/d\s+/i, "");
  // 去引号
  target = target.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();

  // 裸 `cd` / `cd -` 不跟踪（无法确定目标目录）
  if (!target || target === "-") return { target: null, rest: null };
  return { target, rest };
}
