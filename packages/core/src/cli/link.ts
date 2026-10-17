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

export interface LinkOptions {
  hubUrl: string;
  code: string;
  dataDir?: string;
  label?: string;
  host?: string;
  port?: number;
}

export type LinkResult =
  | { mode: "hot"; nodeId: string; gatewayUrl?: string; online: boolean; label?: string }
  | { mode: "saved"; nodeId: string; gatewayUrl?: string; label?: string };

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
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
  const store = new Store(dataDir);
  const adminKey = process.env.ADMIN_API_KEY ?? store.loadAdminKey();
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.PORT ?? 8787);

  // 1) 本机已有 server（同 DATA_DIR）→ 热接入，立即生效
  if (adminKey && (await probeServer(host, port, adminKey))) {
    const status = await enrollViaServer(host, port, adminKey, opts);
    return { mode: "hot", ...status };
  }

  // 2) 本机无 server → 凭码接入并落盘 fleet.json，下次启动自动接入
  const nodeId = ensureNodeId(store);
  const cred = await hubEnrollByCode(opts.hubUrl, {
    code: opts.code,
    nodeId,
    label: opts.label,
  });
  store.saveFleetCredential({
    ...cred,
    label: opts.label ?? cred.label,
    enrolledAt: new Date().toISOString(),
  });
  return { mode: "saved", nodeId, gatewayUrl: cred.gatewayUrl, label: opts.label };
}

function printLinkHelp(): void {
  cliLog("用法: zqagent link --hub <url> --code <注册码> [--label 名称] [--data-dir 目录]");
  cliLog("  在 Hub 用户中心生成一次性注册码后，于节点机器执行本命令即可接入。");
  cliLog("  已有本机 server 时热接入（免重启）；否则写入 fleet.json，下次启动自动接入。");
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
    } else {
      cliLog("✅ 接入凭据已保存（本机暂无运行中的 server）");
      cliLog(`   节点: ${r.nodeId}`);
      cliLog(`   网关: ${r.gatewayUrl ?? "（未下发）"}`);
      cliLog("   下次启动 server 即自动接入；或运行 zqagent serve 常驻为节点。");
    }
    return true;
  } catch (e) {
    cliErr(`接入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
