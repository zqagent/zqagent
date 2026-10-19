/**
 * 发现正在运行的 `zqagent serve` 实例（供 `zqagent link` 热接入用）
 *
 * 背景：`link` 默认按 `<cwd>/.zqagent_data` 找本机 server，而安装脚本把节点服务
 * 跑在 `--data-dir /var/lib/zqagent` 下、且不设 `DATA_DIR` 环境变量。两者对不上时
 * link 会误判「本机无 server」，把凭据写进当前目录的 `.zqagent_data/fleet.json`；
 * 正在运行的服务读不到这份凭据，Hub 上就一直显示未在线。
 *
 * 这里从进程命令行反查 serve 的 `--data-dir / --host / --port`，让 link 能命中
 * 那个已经在跑的实例。只做发现，不改变任何进程状态。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DATA_DIR } from "../paths.js";

export interface ServeInstance {
  /** 已解析为绝对路径 */
  dataDir: string;
  host: string;
  port: number;
}

/** 默认监听参数（与 serve 子命令一致） */
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 8787;

/**
 * 找到 serve 子命令的位置（argv[0] 是可执行文件，其后第一个非选项 token 才是子命令）。
 *
 * 不用 `argv.includes("serve")`：`--label serve` 这类取值也会命中，把交互式 CLI
 * 误当成常驻服务。找不到返回 -1。
 */
function serveSubcommandIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("-")) continue;
    return argv[i] === "serve" ? i : -1;
  }
  return -1;
}

/** 解析 serve 的参数；不是 serve 进程返回 null */
export function parseServeArgs(argv: string[]): Omit<ServeInstance, "dataDir"> & {
  dataDir: string | null;
} | null {
  const at = serveSubcommandIndex(argv);
  if (at < 0) return null;
  let dataDir: string | null = null;
  let host = DEFAULT_SERVE_HOST;
  let port = DEFAULT_SERVE_PORT;

  for (let i = at + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }

  if (!Number.isFinite(port) || port <= 0) port = DEFAULT_SERVE_PORT;
  // 监听 0.0.0.0 / :: 时本机探测要走回环地址
  if (host === "0.0.0.0" || host === "::" || host === "") host = DEFAULT_SERVE_HOST;
  return { dataDir, host, port };
}

/**
 * 合并热接入候选：显式目录最优先，运行中的实例追加在后（去重）；未显式指定时
 * 默认目录在前，再追加发现的实例。
 *
 * 为什么显式目录之后还要追加发现到的实例：用户给的目录未必对（最典型的是在
 * macOS 上照抄 Linux 的 `/var/lib/zqagent`，或者猜了个 `~/.zqagent`）。此时该目录
 * 里没有 admin.json，热接入必然失败；若不追加真实运行中的实例，link 会退回
 * 「落盘」模式，把凭据写到一个服务根本不读的目录，命令还报「✅ 接入凭据已保存」，
 * Hub 上却始终未接入。追加之后，错配的目录只是探测失败一次，仍能命中真正的服务。
 *
 * `fallback` 是用户显式给的 `--host/--port`（或环境变量），只作用于「默认目录」那一条；
 * 从进程反查到的实例自带真实监听参数，覆盖它——否则服务跑在非默认端口时会探测失败。
 */
export function buildHotCandidates(
  explicitDataDir: string | undefined,
  discovered: ServeInstance[],
  fallback: { host: string; port: number },
): ServeInstance[] {
  const out: ServeInstance[] = explicitDataDir
    ? [{ dataDir: path.resolve(explicitDataDir), ...fallback }]
    : [{ dataDir: path.resolve(DEFAULT_DATA_DIR), ...fallback }];
  for (const inst of discovered) {
    if (!out.some((o) => o.dataDir === inst.dataDir)) out.push(inst);
  }
  return out;
}

/** 盘符（`C:\`）或 UNC（`\\server\share`）形式的 Windows 绝对路径 */
function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/** 绝对路径判定：同时接受 POSIX 与 Windows 形式（单测在 Linux 上跑 Windows 分支） */
function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || isWindowsAbsolute(p);
}

function normalizePath(p: string): string {
  return isWindowsAbsolute(p) ? path.win32.normalize(p) : path.normalize(p);
}

/**
 * 从一整行进程命令行里解析 serve 实例（macOS `ps` 与 Windows PowerShell 共用）。
 *
 * 只认显式 `--data-dir`：这两个平台都拿不到目标进程的 cwd / 环境变量，
 * 缺省目录无法可靠回推。值允许带引号（Windows 路径常含空格），也支持
 * `--data-dir=<路径>`。路径必须是绝对路径，否则忽略。
 */
export function parseServeCommandLine(line: string): ServeInstance | null {
  // 只把独立的 `serve` token 当作子命令，避免 `--label serve` 之类误判
  if (!/(?:^|\s)["']?serve["']?(?=\s|$)/.test(line)) return null;

  const m = /--data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--\w|\s*$)/.exec(line);
  const rawDataDir = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  if (!rawDataDir || !isAbsolutePath(rawDataDir)) return null;

  const host = /--host(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line);
  const rawHost = (host?.[1] ?? host?.[2] ?? host?.[3] ?? DEFAULT_SERVE_HOST).trim();
  const portMatch = /--port(?:=|\s+)(\d+)/.exec(line);
  const port = Number(portMatch?.[1] ?? DEFAULT_SERVE_PORT);

  return {
    dataDir: normalizePath(rawDataDir),
    host: rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "" ? DEFAULT_SERVE_HOST : rawHost,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_SERVE_PORT,
  };
}

/** 读取进程工作目录（仅 Linux /proc；其他平台返回 null） */
function processCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** 读取进程环境变量（仅 Linux /proc；其他平台返回空对象） */
function processEnv(pid: number): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    // 权限不足或平台不支持：当作没有
  }
  return out;
}

/** `--data-dir` 缺省时按 serve 的规则回推：DATA_DIR 环境变量 → 进程 cwd 下的默认目录 */
function resolveDataDir(
  rawDataDir: string | null,
  cwd: string | null,
  env: Record<string, string>,
): string | null {
  const pick = rawDataDir ?? env.DATA_DIR ?? null;
  if (pick) return path.isAbsolute(pick) ? path.normalize(pick) : cwd ? path.resolve(cwd, pick) : null;
  return cwd ? path.resolve(cwd, DEFAULT_DATA_DIR) : null;
}

/** Linux：遍历 /proc 取所有 serve 进程 */
function discoverFromProc(): ServeInstance[] {
  const out: ServeInstance[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let argv: string[];
    try {
      // cmdline 以 NUL 分隔；末尾通常还有一个空串
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const parsed = parseServeArgs(argv);
    if (!parsed) continue;
    const dataDir = resolveDataDir(parsed.dataDir, processCwd(pid), processEnv(pid));
    if (!dataDir) continue;
    out.push({ dataDir, host: parsed.host, port: parsed.port });
  }
  return out;
}

/** macOS 等无 /proc 的平台：用 `ps` 尽力而为。解析不到返回空，link 退回旧行为。 */
function discoverFromPs(): ServeInstance[] {
  const out: ServeInstance[] = [];
  const res = spawnSync("ps", ["-axo", "command="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  if (res.status !== 0 || !res.stdout) return out;
  for (const line of res.stdout.split("\n")) {
    const inst = parseServeCommandLine(line);
    if (inst) out.push(inst);
  }
  return out;
}

/**
 * Windows：Windows 没有 `ps`，用 PowerShell 的 Win32_Process 取命令行。
 *
 * `zqagent serve` 既可能是 SEA 单文件 `zqagent.exe`，也可能是 `node.exe ... serve`；
 * 只解析含独立 `serve` 且带绝对 `--data-dir` 的命令行（见 parseServeCommandLine）。
 * PowerShell 不可用、被策略拦截或超时时返回空，不影响 link 的落盘路径。
 */
function discoverFromWindows(): ServeInstance[] {
  const out: ServeInstance[] = [];
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "Get-CimInstance Win32_Process -Filter \"Name='zqagent.exe' OR Name='node.exe'\" " +
    "| ForEach-Object { $_.CommandLine }";
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf-8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (res.status !== 0 || !res.stdout) return out;
  for (const line of res.stdout.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const inst = parseServeCommandLine(line);
    if (inst) out.push(inst);
  }
  return out;
}

/** 列出本机正在运行的 serve 实例（可能为空） */
export function discoverRunningServeInstances(): ServeInstance[] {
  const found =
    process.platform === "linux"
      ? discoverFromProc()
      : process.platform === "win32"
        ? discoverFromWindows()
        : discoverFromPs();
  // 同一数据目录可能既有 systemd 主进程又有子进程，按目录去重
  const seen = new Set<string>();
  return found.filter((inst) => {
    if (seen.has(inst.dataDir)) return false;
    seen.add(inst.dataDir);
    return true;
  });
}
