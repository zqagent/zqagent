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
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DATA_DIR } from "../paths.js";
import { serviceManagerFromCgroup } from "../update/platform.js";

export interface ServeInstance {
  /** 已解析为绝对路径 */
  dataDir: string;
  host: string;
  port: number;
  /**
   * 是否由 systemd / launchd 托管（开机自启、重启后仍在）。
   *
   * 托管实例才是这台机器长期服役的节点；命令行里手动跑起来的临时实例
   * 重启后就没了。`link` 必须优先命中前者。
   */
  managed?: boolean;
}

/** 默认监听参数（与 serve 子命令一致） */
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 8787;

/** 未指定 ZQAGENT_SERVICE_NAME 时的默认 systemd unit 名（与 install.sh / 桌面端一致） */
const DEFAULT_SERVICE_NAME = "zqagent";

/** 未指定 ZQAGENT_SERVICE_LABEL 时的默认 launchd 作业名（与 install.sh / 桌面端一致） */
const DEFAULT_SERVICE_LABEL = "com.zqagent.node";

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
 * 合并热接入候选，按「可信度」排序：
 *
 *   1. 显式 `--data-dir`（用户明确指定，永远第一）；
 *   2. 托管的实例（systemd / launchd 注册，开机自启、重启后仍在）；
 *   3. 其它运行中的实例（手动跑的临时进程）；
 *   4. `<cwd>/.zqagent_data` —— 纯猜测，只在没有显式目录时兜底。
 *
 * 顺序曾经是「默认目录在前、发现到的实例在后」，结果在 macOS 上出事：用户在家目录
 * 执行 `link`，而家目录残留着一个手动 `zqagent serve`（`~/.zqagent_data` + 8787），
 * 它抢在托管服务（`~/Library/Application Support/zqagent` + 8788）之前被探测到，
 * 凭据写进了那个临时实例。命令报「✅ 已接入」，托管服务却读不到，Hub 一直离线。
 *
 * 为什么显式目录之后还要追加发现到的实例：用户给的目录未必对（最典型的是在
 * macOS 上照抄 Linux 的 `/var/lib/zqagent`，或者猜了个 `~/.zqagent`）。此时该目录
 * 里没有 admin.json，热接入必然失败；若不追加真实运行中的实例，link 会退回
 * 「落盘」模式，把凭据写到一个服务根本不读的目录。追加之后，错配的目录只是探测
 * 失败一次，仍能命中真正的服务。
 *
 * `fallback` 是用户显式给的 `--host/--port`（或环境变量），只作用于「显式/默认目录」
 * 那一条；从进程反查到的实例自带真实监听参数，覆盖它——否则服务跑在非默认端口时
 * 会探测失败。
 */
export function buildHotCandidates(
  explicitDataDir: string | undefined,
  discovered: ServeInstance[],
  fallback: { host: string; port: number },
): ServeInstance[] {
  const out: ServeInstance[] = [];
  const push = (inst: ServeInstance): void => {
    if (!out.some((o) => o.dataDir === inst.dataDir)) out.push(inst);
  };

  if (explicitDataDir) push({ dataDir: path.resolve(explicitDataDir), ...fallback });

  // 托管服务优先：它是重启后唯一还会自己连回来的那个。
  for (const inst of discovered) if (inst.managed) push(inst);
  // 其次是其它运行中的实例（手动 serve、桌面 sidecar 等）。
  for (const inst of discovered) if (!inst.managed) push(inst);

  // 默认目录只是兜底猜测，放最后，避免 cwd 里的残留实例把凭据截走。
  if (!explicitDataDir) push({ dataDir: path.resolve(DEFAULT_DATA_DIR), ...fallback });

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

/**
 * 判断该 pid 是否由 systemd 托管。
 *
 * 优先看安装脚本注入的 `ZQAGENT_SERVICE_MANAGER`；旧版 unit 没注入时按 cgroup
 * 归属兜底（与 `update` 自检同一套判据）。
 */
function isManagedBySystemd(pid: number, env: Record<string, string>): boolean {
  if (env.ZQAGENT_SERVICE_MANAGER?.trim()) return true;
  try {
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf-8");
    const serviceName = env.ZQAGENT_SERVICE_NAME?.trim() || "zqagent";
    return serviceManagerFromCgroup(cgroup, serviceName) !== null;
  } catch {
    return false;
  }
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
    let env: Record<string, string>;
    try {
      // cmdline 以 NUL 分隔；末尾通常还有一个空串
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
      env = processEnv(pid);
    } catch {
      continue;
    }
    const parsed = parseServeArgs(argv);
    if (!parsed) continue;
    const dataDir = resolveDataDir(parsed.dataDir, processCwd(pid), env);
    if (!dataDir) continue;
    out.push({
      dataDir,
      host: parsed.host,
      port: parsed.port,
      managed: isManagedBySystemd(pid, env),
    });
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

/**
 * 解析 launchd plist 中 `ProgramArguments` 数组。
 *
 * 只处理 install.sh 写出的 `<key>ProgramArguments</key><array><string>…</string></array>`
 * 形式；其它形状返回空数组。
 */
/** 解码 plist 字符串里的 XML 实体（桌面端写入前会 xml_escape，路径可能含 & < >） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseLaunchdProgramArguments(xml: string): string[] {
  const marker = xml.indexOf("<key>ProgramArguments</key>");
  if (marker < 0) return [];
  const open = xml.indexOf("<array>", marker);
  if (open < 0) return [];
  const close = xml.indexOf("</array>", open);
  if (close < 0) return [];
  return [...xml.slice(open + "<array>".length, close).matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => decodeXmlEntities(m[1]),
  );
}

/**
 * 读取本机 launchd 作业登记的 serve 实例。
 *
 * macOS 的 `ps` 拿不到进程环境变量，无法像 Linux 那样按 `ZQAGENT_SERVICE_MANAGER`
 * 判断托管；但安装脚本写的 plist 里保存着完整的 `ProgramArguments`，据此既能标记
 * 托管，也能在 `ps` 解析不到时补出实例（例如以后 unit 不再显式传 `--data-dir`）。
 */
function launchdServiceInstances(): ServeInstance[] {
  if (process.platform !== "darwin") return [];
  const label = process.env.ZQAGENT_SERVICE_LABEL?.trim() || DEFAULT_SERVICE_LABEL;
  // 与桌面端 discover() 同序：root 装的 LaunchDaemon 优先于用户级 LaunchAgent，
  // 否则同一个 label 的两个定义会各起一个节点抢端口。
  const plists = [
    `/Library/LaunchDaemons/${label}.plist`,
    path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`),
  ];

  const out: ServeInstance[] = [];
  for (const plist of plists) {
    let xml: string;
    try {
      xml = fs.readFileSync(plist, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseServeArgs(parseLaunchdProgramArguments(xml));
    if (!parsed?.dataDir || !isAbsolutePath(parsed.dataDir)) continue;
    out.push({
      dataDir: normalizePath(parsed.dataDir),
      host: parsed.host,
      port: parsed.port,
      managed: true,
    });
  }
  return out;
}

/**
 * 解析 systemd unit 里的 serve 实例。
 *
 * install.sh 与桌面端写出的 unit 都同时带 `WorkingDirectory=` 和
 * `ExecStart=<bin> serve --host … --port … --data-dir …`，任一处都能给出数据目录；
 * 优先取 ExecStart 的 `--data-dir`（与运行参数一致），缺失时退回 WorkingDirectory。
 */
export function parseSystemdUnit(text: string): ServeInstance | null {
  let dataDir: string | null = null;
  let host = DEFAULT_SERVE_HOST;
  let port = DEFAULT_SERVE_PORT;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WorkingDirectory=")) {
      const v = trimmed.slice("WorkingDirectory=".length).trim();
      if (v && isAbsolutePath(v)) dataDir = v;
    } else if (trimmed.startsWith("ExecStart=")) {
      const tokens = trimmed
        .slice("ExecStart=".length)
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^["']|["']$/g, ""));
      const parsed = parseServeArgs(tokens);
      if (!parsed) continue;
      if (parsed.dataDir && isAbsolutePath(parsed.dataDir)) dataDir = parsed.dataDir;
      host = parsed.host;
      port = parsed.port;
    }
  }

  if (!dataDir) return null;
  return { dataDir: normalizePath(dataDir), host, port, managed: true };
}

/**
 * 读取本机 systemd 登记的服务定义（system 优先，其次 user）。
 *
 * 服务没在运行时进程扫描找不到它，但 unit 文件仍在——`link` 需要靠它把凭据
 * 写到服务真正会读的数据目录，而不是当前目录。
 */
function systemdServiceInstances(): ServeInstance[] {
  if (process.platform !== "linux") return [];
  const unit = process.env.ZQAGENT_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const units = [
    `/etc/systemd/system/${unit}.service`,
    path.join(configHome, "systemd", "user", `${unit}.service`),
  ];

  const out: ServeInstance[] = [];
  for (const file of units) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const inst = parseSystemdUnit(text);
    if (inst) out.push(inst);
  }
  return out;
}

/**
 * Windows 桌面端把服务元数据写在 `<数据目录>/runtime/service.json`
 * （见 packages/desktop/src-tauri/src/service.rs）。登录任务没启动时也能靠它定位。
 */
function windowsServiceInstances(): ServeInstance[] {
  if (process.platform !== "win32") return [];
  const appdata = process.env.APPDATA?.trim();
  if (!appdata) return [];
  const base = path.join(appdata, "zqagent");
  try {
    const raw = fs.readFileSync(path.join(base, "runtime", "service.json"), "utf-8");
    const v = JSON.parse(raw) as { port?: number; dataDir?: string };
    const dataDir = v.dataDir && isAbsolutePath(v.dataDir) ? v.dataDir : base;
    const port = Number(v.port);
    return [
      {
        dataDir: normalizePath(dataDir),
        host: DEFAULT_SERVE_HOST,
        port: Number.isFinite(port) && port > 0 ? port : DEFAULT_SERVE_PORT,
        managed: true,
      },
    ];
  } catch {
    return [];
  }
}

/**
 * 合并进程侧发现到的实例与服务定义里登记的实例：
 * 同一目录保留进程侧的真实监听参数，并打上托管标记。
 */
export function mergeServeInstances(
  discovered: ServeInstance[],
  managed: ServeInstance[],
): ServeInstance[] {
  const out: ServeInstance[] = [];
  const push = (inst: ServeInstance): void => {
    if (!out.some((o) => o.dataDir === inst.dataDir)) out.push(inst);
  };
  for (const inst of discovered) {
    const hit = managed.find((m) => m.dataDir === inst.dataDir);
    push(hit ? { ...inst, managed: true } : inst);
  }
  for (const inst of managed) push(inst);
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

  // 进程侧只反映「正在跑什么」，服务定义才是「这台机器长期装了什么」。
  // 两者合并后，服务没启动时也能定位到它将来会读的数据目录。
  const declared =
    process.platform === "linux"
      ? systemdServiceInstances()
      : process.platform === "win32"
        ? windowsServiceInstances()
        : launchdServiceInstances();

  // 同一数据目录可能既有服务主进程又有子进程，merge 会按目录去重
  return mergeServeInstances(found, declared);
}
