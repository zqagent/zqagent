/**
 * `zqagent link` — 凭一次性注册码把本机节点接入 Hub
 *
 * 两种路径（自动选择）：
 *   1) 本机已有 server（同 DATA_DIR，含桌面 sidecar）→ 调其 admin 接口**热接入**（免重启）；
 *   2) 本机无 server → 凭码接入并写 `{DATA_DIR}/fleet.json`，供下次 server 启动自动接入。
 *
 * 不依赖交互；被 CLI 子命令 `link` 与交互命令 `/link` 复用。
 */
import * as path from "path";
import { Store, newId } from "../server/store.js";
import { hubEnrollByCode } from "@zqagent/shared/hub-api";
import { cliErr, cliLog } from "../terminal.js";
import { DEFAULT_DATA_DIR } from "../paths.js";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  buildHotCandidates,
  discoverRunningServeInstances,
  type ServeInstance,
} from "./serve-instances.js";

/**
 * 展开开头的 `~`。
 *
 * 不加引号时 shell 已经展开，但 `--data-dir "~/.zqagent"`（带引号）不会，
 * 原样传给 path.resolve 会得到 `<cwd>/~/.zqagent` 这种离谱路径。
 */
function expandHome(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/**
 * 安装脚本写入的服务数据目录（按平台）。
 *
 * `DEFAULT_DATA_DIR` 是相对当前目录的 `.zqagent_data`，只在「没有任何服务」时兜底；
 * 由安装脚本注册的服务用的是各平台固定目录，用户照抄指引时最容易在这里踩权限坑
 * （macOS 上抄了 Linux 的 /var/lib/zqagent 会 EACCES）。
 */
export function installDataDirHint(): string {
  if (process.platform === "darwin") return "$HOME/Library/Application Support/zqagent";
  if (process.platform === "win32") return "%LOCALAPPDATA%\\zqagent";
  return "/var/lib/zqagent（需 root；普通用户用 ~/.zqagent_data）";
}

export interface LinkOptions {
  hubUrl: string;
  code: string;
  dataDir?: string;
  label?: string;
  host?: string;
  port?: number;
}

export type LinkResult =
  | {
      mode: "hot";
      nodeId: string;
      gatewayUrl?: string;
      online: boolean;
      label?: string;
      dataDir: string;
    }
  | {
      mode: "saved";
      nodeId: string;
      gatewayUrl?: string;
      label?: string;
      dataDir: string;
      /** 是否由 `--data-dir` / `DATA_DIR` 显式指定（否则写进了当前目录） */
      explicitDataDir: boolean;
      /**
       * 本机正在运行、但数据目录与本次写入目录不同的 serve 实例目录。
       * 非空说明凭据写到了服务不会读的地方，调用方需要告警。
       */
      runningServiceDirs: string[];
    };

/** 解析 `--name value` 形式的参数 */
function parseLinkArgs(argv: string[]): Partial<LinkOptions> & { help?: boolean } {
  const out: Partial<LinkOptions> & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = argv[i + 1];
    if (a === "--hub") { out.hubUrl = val; i++; }
    else if (a === "--code") { out.code = val; i++; }
    else if (a === "--data-dir") { out.dataDir = val; i++; }
    else if (a === "--label") { out.label = val; i++; }
    else if (a === "--host") { out.host = val; i++; }
    else if (a === "--port") { out.port = Number(val); i++; }
    else if (a === "-h" || a === "--help") { out.help = true; }
  }
  return out;
}

/** 确保节点稳定 ID（与 server 的 `{DATA_DIR}/node.json` 同一份） */
function ensureNodeId(store: Store): string {
  let id = store.loadNodeId();
  if (!id) {
    id = newId();
    store.saveNodeId(id);
  }
  return id;
}

/** 探测本机 server 是否在运行（同 DATA_DIR 且 admin key 匹配） */
async function probeServer(host: string, port: number, adminKey: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/fleet/status`, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 经本机 server 的 admin 接口热接入 */
async function enrollViaServer(
  host: string,
  port: number,
  adminKey: string,
  opts: LinkOptions,
): Promise<{ nodeId: string; brokerUrl?: string; online: boolean; label?: string }> {
  const res = await fetch(`http://${host}:${port}/api/v1/fleet/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ hubUrl: opts.hubUrl, code: opts.code, label: opts.label }),
  });
  const text = await res.text();
  let payload: { data?: unknown; error?: { message?: string } } | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应按状态码处理
  }
  if (!res.ok) {
    throw new Error(payload?.error?.message ?? `HTTP ${res.status}`);
  }
  return payload?.data as { nodeId: string; brokerUrl?: string; online: boolean; label?: string };
}

/** 执行接入（自动选择热接入 / 落盘）。失败抛出。 */
export async function linkNode(opts: LinkOptions): Promise<LinkResult> {
  // 空字符串（`DATA_DIR=`）按未设置处理，否则会解析成当前目录
  const rawDataDir = opts.dataDir?.trim() || process.env.DATA_DIR?.trim() || undefined;
  const explicitDataDir = rawDataDir ? expandHome(rawDataDir) : undefined;
  const host = opts.host?.trim() || process.env.HOST?.trim() || DEFAULT_SERVE_HOST;
  const port = opts.port ?? Number(process.env.PORT ?? DEFAULT_SERVE_PORT);

  // 1) 本机已有 server → 热接入，立即生效。
  //    无论是否显式给目录都要反查运行中的 serve：安装脚本把服务跑在各平台固定目录
  //    （Linux /var/lib/zqagent、macOS ~/Library/Application Support/zqagent）且不设
  //    DATA_DIR。显式目录可能是错的（例如在 macOS 上照抄 Linux 路径、或猜成
  //    ~/.zqagent），此时若只探测该目录，就会误判「本机无 server」并把凭据写丢。
  const running = discoverRunningServeInstances();
  const candidates: ServeInstance[] = buildHotCandidates(explicitDataDir, running, { host, port });

  for (const inst of candidates) {
    const store = new Store(inst.dataDir);
    const adminKey = process.env.ADMIN_API_KEY ?? store.loadAdminKey();
    if (!adminKey) continue;
    if (!(await probeServer(inst.host, inst.port, adminKey))) continue;
    const status = await enrollViaServer(inst.host, inst.port, adminKey, opts);
    return { mode: "hot", ...status, dataDir: inst.dataDir };
  }

  // 2) 本机无 server → 凭码接入并落盘 fleet.json，下次启动自动接入
  const dataDir = path.resolve(explicitDataDir ?? DEFAULT_DATA_DIR);
  const store = new Store(dataDir);
  const nodeId = ensureNodeId(store);
  const cred = await hubEnrollByCode(opts.hubUrl, {
    code: opts.code,
    nodeId,
    label: opts.label,
  });
  try {
    store.saveFleetCredential({
      ...cred,
      label: opts.label ?? cred.label,
      enrolledAt: new Date().toISOString(),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // 最常见的坑：把 Linux 安装脚本的 /var/lib/zqagent 抄到了 macOS / 普通用户环境，
    // 裸 EACCES 无法定位。给出平台默认目录与「不带 --data-dir」两条出路。
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw new Error(
        `无法写入数据目录 ${dataDir}（${err.code}: ${err.message}）\n` +
          `  该目录当前用户没有写权限。两种改法：\n` +
          `    1) 去掉 --data-dir，让 link 自动发现本机运行的节点（推荐）；\n` +
          `    2) 用当前用户可写的目录，本平台安装脚本默认：${installDataDirHint()}\n` +
          `  （接入码一次性，需要重新生成）`,
      );
    }
    throw e;
  }
  // 本机有 serve 在跑，却没能热接入（通常是凭据/管理密钥对不上）：
  // 此时落盘到另一个目录，服务读不到，Hub 会一直显示未接入。
  // 把这些目录回传给调用方去告警，别让用户以为已经成功。
  const otherRunningDirs = [
    ...new Set(running.map((r) => r.dataDir).filter((d) => d !== dataDir)),
  ];
  return {
    mode: "saved",
    nodeId,
    gatewayUrl: cred.gatewayUrl,
    label: opts.label,
    dataDir,
    explicitDataDir: Boolean(explicitDataDir),
    runningServiceDirs: otherRunningDirs,
  };
}

function printLinkHelp(): void {
  cliLog("用法: zqagent link --hub <url> --code <注册码> [--label 名称] [--data-dir 目录]");
  cliLog("  在 Hub 用户中心生成一次性注册码后，于节点机器执行本命令即可接入。");
  cliLog("  已有本机 server 时热接入（免重启，会自动发现运行中服务的 --data-dir）；");
  cliLog("  否则写入 <数据目录>/fleet.json，下次启动自动接入。");
}

/** CLI 子命令入口：`zqagent link ...`。返回是否成功。 */
export async function runLinkCommand(argv: string[]): Promise<boolean> {
  const args = parseLinkArgs(argv);
  if (args.help) {
    printLinkHelp();
    return true;
  }
  const hubUrl = (args.hubUrl ?? process.env.HUB_URL ?? "").trim().replace(/\/$/, "");
  const code = (args.code ?? "").trim();
  if (!hubUrl || !code) {
    cliErr("缺少 --hub 或 --code。");
    printLinkHelp();
    return false;
  }
  try {
    const r = await linkNode({
      hubUrl,
      code,
      dataDir: args.dataDir,
      label: args.label,
      host: args.host,
      port: args.port,
    });
    if (r.mode === "hot") {
      cliLog("✅ 已接入 Hub（热接入，免重启）");
      cliLog(`   节点: ${r.nodeId}${r.label ? ` (${r.label})` : ""}`);
      cliLog(`   网关: ${r.gatewayUrl ?? "（未下发）"}    在线: ${r.online ? "是" : "连接中…"}`);
      cliLog(`   数据目录: ${r.dataDir}`);
    } else {
      cliLog("✅ 接入凭据已保存（本机暂无运行中的 server）");
      cliLog(`   节点: ${r.nodeId}`);
      cliLog(`   网关: ${r.gatewayUrl ?? "（未下发）"}`);
      cliLog(`   数据目录: ${r.dataDir}`);
      cliLog("   下次启动 server 即自动接入；或运行 zqagent serve 常驻为节点。");
      if (r.runningServiceDirs.length > 0) {
        // 本机明明有 serve 在跑，却没能热接入 —— 凭据写到这里它也读不到。
        // 这是最容易「命令报成功、Hub 上却一直未接入」的情形，必须说清楚。
        cliLog("");
        cliLog("⚠️  本机有正在运行的节点，但数据目录与本次写入的不一致：");
        cliLog(`    本次写入: ${r.dataDir}`);
        for (const d of r.runningServiceDirs) cliLog(`    服务使用: ${d}`);
        cliLog("    正在运行的服务读不到这份凭据，Hub 会一直显示未接入。");
        cliLog("    请确认服务的数据目录后重新执行（接入码一次性，需要重新生成）：");
        cliLog(`      zqagent link --hub <Hub地址> --code <新接入码> --data-dir "${r.runningServiceDirs[0]}"`);
      } else if (!r.explicitDataDir) {
        // 安装脚本起的服务用平台固定目录且不设 DATA_DIR，这里写进当前目录等于白写
        cliLog("");
        cliLog("⚠️  未指定 --data-dir，凭据写入了当前目录下的 .zqagent_data。");
        cliLog("    若本机服务是由安装脚本（systemd / launchd）启动的，它读不到这份凭据，");
        cliLog("    Hub 会一直显示未在线。请用服务的数据目录重新执行：");
        cliLog("      zqagent link --hub <Hub地址> --code <新接入码> --data-dir <服务数据目录>");
        cliLog(`      （本平台安装脚本默认：${installDataDirHint()}；接入码一次性，需要重新生成）`);
      }
    }
    return true;
  } catch (e) {
    cliErr(`接入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
