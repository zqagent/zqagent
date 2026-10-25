/**
 * `zqagent rename` — 修改本机节点在 Hub 显示的名称
 *
 * 两条路径（与 `link` 一致，自动选择）：
 *   1) 本机有 server 在跑 → 调它的 admin 接口：写本地配置、立即上报，
 *      并由 server 用节点自己的凭据同步 Hub 记录（免重启）；
 *   2) 本机无 server → 直接写数据目录的 `node.json` / `fleet.json`，下次启动生效。
 *
 * Hub 界面显示的是控制面里的 `node.label`，所以「接入过 Hub」时还要把它改掉，
 * 否则只是本机改名。Hub 界面同样可以改名（PATCH 节点），两个入口写同一份数据。
 */
import * as path from "path";
import { Store } from "../server/store.js";
import { hubUpdateNodeLabelSelf } from "@zqagent/shared/hub-api";
import { cliErr, cliLog } from "../terminal.js";
import { DEFAULT_DATA_DIR } from "../paths.js";
import { expandHome } from "./link.js";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  buildHotCandidates,
  discoverRunningServeInstances,
  type ServeInstance,
} from "./serve-instances.js";

interface RenameArgs {
  label?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  help?: boolean;
}

function parseArgs(argv: string[]): RenameArgs {
  const out: RenameArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") { out.dataDir = argv[++i]; }
    else if (a === "--host") { out.host = argv[++i]; }
    else if (a === "--port") { out.port = Number(argv[++i]); }
    else if (a === "-h" || a === "--help") { out.help = true; }
    else if (!a.startsWith("-") && out.label === undefined) { out.label = a; }
  }
  return out;
}

export function printRenameHelp(): void {
  cliLog("用法: zqagent rename <名称> [--data-dir <dir>]");
  cliLog("  修改本机节点在 Hub 显示的名称。本机有 server 在跑时热生效（免重启），");
  cliLog("  否则写入数据目录，下次启动生效；已接入 Hub 时同时更新 Hub 的节点记录。");
  cliLog("  接入时未指定名称的节点默认用主机名，也可在 Hub 界面直接改名。");
  cliLog("  示例: zqagent rename ten004-dev");
}

/** 探测本机 server（同 DATA_DIR 且 admin key 匹配） */
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

/** 经本机 server 改名（服务会同步 Hub 记录） */
async function renameViaServer(
  host: string,
  port: number,
  adminKey: string,
  label: string,
): Promise<{ hubSynced: boolean; hubError?: string }> {
  const res = await fetch(`http://${host}:${port}/api/v1/fleet/label`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ label }),
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
  const data = payload?.data as { hubSynced?: boolean; hubError?: string } | undefined;
  return { hubSynced: Boolean(data?.hubSynced), hubError: data?.hubError };
}

/** CLI 子命令入口：`zqagent rename <名称>`。返回是否成功。 */
export async function runRenameCommand(argv: string[]): Promise<boolean> {
  const args = parseArgs(argv);
  if (args.help) {
    printRenameHelp();
    return true;
  }
  const label = (args.label ?? "").trim();
  if (!label) {
    cliErr("缺少新的节点名称。");
    printRenameHelp();
    return false;
  }

  const host = args.host?.trim() || process.env.HOST?.trim() || DEFAULT_SERVE_HOST;
  const port = args.port ?? Number(process.env.PORT ?? DEFAULT_SERVE_PORT);
  const explicitDataDir = args.dataDir?.trim() ? expandHome(args.dataDir.trim()) : undefined;
  const running = discoverRunningServeInstances();
  // 显式 --data-dir 时只认那个目录：改名是「改这台节点的名字」，
  // 不能因为本机还有别的节点在跑就改到别人头上（link 的语义不同，那里要兜底写入）。
  const candidates: ServeInstance[] = explicitDataDir
    ? [
        running.find((r) => path.resolve(r.dataDir) === path.resolve(explicitDataDir)) ?? {
          dataDir: path.resolve(explicitDataDir),
          host,
          port,
        },
      ]
    : buildHotCandidates(undefined, running, { host, port });

  for (const inst of candidates) {
    const store = new Store(inst.dataDir);
    const adminKey = process.env.ADMIN_API_KEY ?? store.loadAdminKey();
    if (!adminKey) continue;
    if (!(await probeServer(inst.host, inst.port, adminKey))) continue;
    try {
      const r = await renameViaServer(inst.host, inst.port, adminKey, label);
      cliLog(`✅ 节点名称已更新为「${label}」（已热生效，无需重启）`);
      cliLog(`   数据目录: ${inst.dataDir}`);
      if (r.hubSynced) {
        cliLog("   Hub 记录已同步，刷新控制台即可看到新名称。");
      } else if (r.hubError) {
        cliLog(`⚠️  本地已更新，但同步 Hub 失败：${r.hubError}`);
        cliLog("   可稍后重试同一命令，或直接在 Hub 界面改名。");
      } else {
        cliLog("   本机未接入 Hub，Hub 界面不会显示该名称。");
      }
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 运行中的服务版本较旧、没有该接口：退化为直接写文件（重启/下次上报生效），
      // 不要在这里硬失败——安装脚本与节点二进制本就独立升级。
      if (/未知路由|HTTP 404/.test(msg)) {
        cliLog("⚠️  运行中的节点服务版本较旧，改名改为直接写入数据目录，重启后生效。");
        break;
      }
      cliErr(`改名失败: ${msg}`);
      return false;
    }
  }

  // 本机没有运行中的 server：直接落盘，下次启动时上报
  const dataDir = path.resolve(
    explicitDataDir ?? running.find((r) => r.managed)?.dataDir ?? DEFAULT_DATA_DIR,
  );
  const store = new Store(dataDir);
  try {
    store.saveNodeLabel(label);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    cliErr(
      `无法写入数据目录 ${dataDir}（${err.code ?? "EACCES"}）。` +
        "若节点由系统服务托管，请用 sudo 执行，或用 --data-dir 指定目录。",
    );
    return false;
  }

  const cred = store.loadFleetCredential();
  if (!cred) {
    cliLog(`✅ 节点名称已保存为「${label}」（${dataDir}）`);
    cliLog("   本机未接入 Hub，下次启动 serve 后生效。");
    return true;
  }
  store.saveFleetCredential({ ...cred, label });

  // 服务没在跑，用 fleet.json 里的节点凭据直接同步 Hub 记录
  let hubSynced = false;
  let hubError: string | undefined;
  if (cred.hubUrl && cred.fleetToken) {
    try {
      await hubUpdateNodeLabelSelf(cred.hubUrl, cred.fleetToken, {
        nodeId: cred.nodeId,
        label,
      });
      hubSynced = true;
    } catch (e) {
      hubError = e instanceof Error ? e.message : String(e);
    }
  }

  cliLog(`✅ 节点名称已保存为「${label}」（${dataDir}，下次启动 serve 生效）`);
  if (hubSynced) {
    cliLog("   Hub 记录已同步，刷新控制台即可看到新名称。");
  } else if (hubError) {
    cliLog(`⚠️  本地已保存，但同步 Hub 失败：${hubError}`);
    cliLog("   可稍后重试同一命令，或直接在 Hub 界面改名。");
  } else {
    cliLog("   节点凭据不完整（缺少 Hub 地址或令牌），Hub 记录未更新。");
  }
  return true;
}
