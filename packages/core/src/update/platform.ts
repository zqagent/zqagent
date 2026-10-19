/**
 * 运行形态与自更新能力判定。
 *
 * 只有「SEA 单文件 + 由 systemd/launchd 托管 + 配置了公钥」三者同时满足，
 * 才允许自动替换可执行文件并重启——否则退出后没人把它拉起来。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * 当前版本：构建期注入（SEA/tsup define）优先，其次读包内 package.json，
 * 最后回退 "dev"。后两条让源码运行（tsx）也能显示真实版本。
 */
export function currentVersion(): string {
  const injected = process.env.ZQAGENT_VERSION?.trim();
  if (injected) return injected;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    if (pkg?.version) return pkg.version;
  } catch {
    // SEA 内取不到包信息，忽略
  }
  return "dev";
}

/**
 * 是否为 SEA 单文件运行。
 *
 * 判据优先取 execPath 的文件名：SEA 产物是 `zqagent`，经 node 运行的则是 `node`。
 * 构建期还会注入 `ZQAGENT_SEA=1`（见 tsup.sea.config.ts）作为权威标记。
 */
export function isSeaRuntime(): boolean {
  if (process.env.ZQAGENT_SEA === "1") return true;
  const base = path.basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  return base !== "node" && base !== "nodejs";
}

export type ServiceManager = "systemd" | "launchd";

/** 未指定 ZQAGENT_SERVICE_NAME 时的默认 systemd unit 名（与 install.sh 一致） */
const DEFAULT_SERVICE_NAME = "zqagent";

/** 未指定 ZQAGENT_SERVICE_LABEL 时的默认 launchd 作业名（与 install.sh 一致） */
const DEFAULT_SERVICE_LABEL = "com.zqagent.node";

/**
 * 从 `/proc/self/cgroup` 的内容判定进程是否属于某个 systemd unit。
 *
 * 抽取为纯函数以便测试。兼容 cgroup v1（`1:name=systemd:/system.slice/x.service`）
 * 与 v2（`0::/system.slice/x.service`）两种行格式。
 *
 * 只认路径中**独立成段**的 `<serviceName>.service`：`my-zqagent.service`、
 * `zqagent.service.bak` 这类名字相近的 unit 不会被误判成 `zqagent.service`。
 */
export function serviceManagerFromCgroup(
  cgroup: string,
  serviceName: string = DEFAULT_SERVICE_NAME,
): ServiceManager | null {
  const unitName = `${serviceName}.service`;
  for (const line of cgroup.split("\n")) {
    // 路径在最后一个冒号之后；v1 的 `name=systemd` 不会干扰
    const idx = line.lastIndexOf(":");
    if (idx < 0) continue;
    const unitPath = line.slice(idx + 1).trim();
    if (unitPath.split("/").includes(unitName)) return "systemd";
  }
  return null;
}

/** launchd 作业所在域：root 装的是 LaunchDaemon（system），普通用户是 LaunchAgent（gui/<uid>） */
function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid === 0 ? "system" : `gui/${uid}`;
}

function launchdLabel(): string {
  return process.env.ZQAGENT_SERVICE_LABEL?.trim() || DEFAULT_SERVICE_LABEL;
}

/** 与 install.sh 写入的位置保持一致 */
function launchdPlistPath(): string {
  const label = launchdLabel();
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid === 0) return `/Library/LaunchDaemons/${label}.plist`;
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * 从 `launchctl print <domain>/<label>` 的输出判定是否为 launchd 托管。
 *
 * macOS 没有 cgroup 可用，改用作业描述里的两处信息：
 * - `pid = N` 与当前进程一致 → 本进程就是该作业拉起的；
 * - `program = /path` 与 execPath 相同 → 服务运行的正是这个可执行文件，
 *   在交互 shell 里执行 `zqagent update` 时靠这条判定（Linux 靠 cgroup 归属）。
 *
 * `sea` 为 false（npm/source 形态）时作业存在即算托管：这种形态本来就不允许
 * 自替换二进制（见 selfUpdateCapability），这里只影响 `update --status` 的显示。
 */
export function serviceManagerFromLaunchctl(
  output: string,
  pid: number,
  execPath: string,
  sea = true,
): ServiceManager | null {
  const pidMatch = /^\s*pid = (\d+)\s*$/m.exec(output);
  if (pidMatch && Number(pidMatch[1]) === pid) return "launchd";

  const program = /^\s*program = (.+?)\s*$/m.exec(output);
  if (program) {
    const shown = program[1].replace(/^"|"$/g, "");
    if (path.resolve(shown) === path.resolve(execPath)) return "launchd";
  }

  if (!sea && /^\s*state = /m.test(output)) return "launchd";
  return null;
}

/**
 * 解析 launchd plist 中 `EnvironmentVariables` 字典的键值。
 *
 * 只处理本脚本会写出的 `<key>K</key><string>V</string>` 形式；`<true/>` 之类的
 * 非字符串值忽略（更新配置用不到）。
 */
export function parseLaunchdEnvironment(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const marker = xml.indexOf("<key>EnvironmentVariables</key>");
  if (marker < 0) return out;
  const open = xml.indexOf("<dict>", marker);
  if (open < 0) return out;
  const close = xml.indexOf("</dict>", open);
  if (close < 0) return out;
  const body = xml.slice(open + "<dict>".length, close);
  for (const m of body.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * 未注入 ZQAGENT_SERVICE_MANAGER 时的兜底检测。
 *
 * 服务进程的环境变量由 unit 注入，但运维在交互 shell 里手动执行
 * `zqagent update --status/--check/--now` 时没有这些变量——此前会被判成
 * 「未托管」，导致诊断结论错误、`--now` 直接拒绝执行。这里用 cgroup 归属
 * 兜底：Linux 上进程落在 `/<service>.service` 里，说明 systemd 确实会拉起它。
 *
 * 刻意不使用「/run/systemd/system 存在即视为托管」这类判据：那样任何在
 * systemd 机器上裸跑的进程都会通过自检，替换二进制后 `exit(70)` 却没人拉起，
 * 节点会直接下线。
 */
function detectServiceManager(): ServiceManager | null {
  if (process.platform === "darwin") return detectLaunchd();
  if (process.platform !== "linux") return null;
  const serviceName =
    process.env.ZQAGENT_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
  try {
    return serviceManagerFromCgroup(
      fs.readFileSync("/proc/self/cgroup", "utf8"),
      serviceName,
    );
  } catch {
    return null;
  }
}

/**
 * macOS 兜底：读取 launchd 作业描述，按 pid / program 判定（见
 * `serviceManagerFromLaunchctl`）。作业不存在、launchctl 不可用时返回 null。
 */
function detectLaunchd(): ServiceManager | null {
  try {
    const res = spawnSync(
      "launchctl",
      ["print", `${launchdDomain()}/${launchdLabel()}`],
      { encoding: "utf8", timeout: 3000 },
    );
    if (res.status !== 0 || !res.stdout) return null;
    return serviceManagerFromLaunchctl(
      res.stdout,
      process.pid,
      process.execPath,
      isSeaRuntime(),
    );
  } catch {
    return null;
  }
}

/**
 * 进程由哪个服务管理器托管；无托管返回 null。
 *
 * 优先采信 `deploy/service/install.sh` 注入的环境变量，缺失时在 Linux 上
 * 按 cgroup 归属兜底检测（见 `detectServiceManager`）。
 */
export function serviceManager(): ServiceManager | null {
  const v = process.env.ZQAGENT_SERVICE_MANAGER?.trim().toLowerCase();
  if (v === "systemd" || v === "launchd") return v;
  return detectServiceManager();
}

export function autoUpdateDisabled(): boolean {
  return process.env.ZQAGENT_AUTO_UPDATE?.trim() === "0";
}

/**
 * 解析 `systemctl show -p Environment --value` 的输出为键值表。
 *
 * 输出形如 `NODE_ENV=production PATH=/usr/local/bin:/usr/bin KEY=abc`。
 * 值里若含空格会被拆开——本函数只用于取公钥/通道/清单地址这类不含空格的
 * 变量，够用且无需处理 systemd 的引号规则。
 */
export function parseServiceEnvironment(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/)) {
    const idx = token.indexOf("=");
    if (idx > 0) out[token.slice(0, idx)] = token.slice(idx + 1);
  }
  return out;
}

let cachedServiceEnv: Record<string, string> | null = null;

function readServiceEnvironment(): Record<string, string> {
  const serviceName =
    process.env.ZQAGENT_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
  try {
    const res = spawnSync(
      "systemctl",
      ["show", serviceName, "--property=Environment", "--value", "--no-pager"],
      { encoding: "utf8", timeout: 3000 },
    );
    if (res.status !== 0 || !res.stdout) return {};
    return parseServiceEnvironment(res.stdout);
  } catch {
    return {};
  }
}

/**
 * 读取 systemd unit 注入的环境变量。
 *
 * 服务进程拿得到这些变量，但运维在交互 shell 里手动执行 `zqagent update`
 * 时拿不到——公钥缺失会让自更新被判为不可用。这里按需从 unit 补齐，
 * 取不到（非 systemd、无 systemctl、超时）时返回 undefined。
 */
export function serviceEnvValue(key: string): string | undefined {
  if (process.platform === "darwin") {
    if (serviceManager() !== "launchd") return undefined;
    cachedLaunchdEnv ??= readLaunchdEnvironment();
    return cachedLaunchdEnv[key];
  }
  if (process.platform !== "linux") return undefined;
  if (serviceManager() !== "systemd") return undefined;
  cachedServiceEnv ??= readServiceEnvironment();
  return cachedServiceEnv[key];
}

let cachedLaunchdEnv: Record<string, string> | null = null;

/**
 * 读取 launchd plist 注入的环境变量。
 *
 * 与 systemd 的 `systemctl show -p Environment` 对应：干净 shell 里执行
 * `zqagent update --status` 时，公钥/通道/清单地址只能从服务定义里取回。
 */
function readLaunchdEnvironment(): Record<string, string> {
  try {
    return parseLaunchdEnvironment(fs.readFileSync(launchdPlistPath(), "utf8"));
  } catch {
    return {};
  }
}

export interface Capability {
  ok: boolean;
  /** 不满足时的可读原因（用于日志/`update --status`） */
  reason?: string;
}

/**
 * 自更新能力判定。`hasPublicKey` 由调用方传入（公钥只在验签时解析一次）。
 */
export function selfUpdateCapability(hasPublicKey: boolean): Capability {
  if (!isSeaRuntime()) {
    return {
      ok: false,
      reason: "当前不是单文件（SEA）形态：请用 npm 升级（npm i -g @zqagent/core@latest）",
    };
  }
  if (!serviceManager()) {
    return {
      ok: false,
      reason: "未被 systemd/launchd 托管：请用 deploy/service/install.sh 安装，或手动升级",
    };
  }
  if (!hasPublicKey) {
    return { ok: false, reason: "未配置 ZQAGENT_UPDATE_PUBKEY，无法验签，已禁用自动更新" };
  }
  return { ok: true };
}
