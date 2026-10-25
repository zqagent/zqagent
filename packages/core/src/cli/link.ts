/**
 * `zqagent link` — 凭一次性注册码或 Hub 账号把本机节点接入 Hub
 *
 * 两种路径（自动选择）：
 *   1) 本机已有 server（同 DATA_DIR，含桌面 sidecar）→ 调其 admin 接口**热接入**（免重启）；
 *   2) 本机无 server → 凭码/账号接入并写 `{DATA_DIR}/fleet.json`，供下次 server 启动自动接入。
 *
 * 账号方式支持 `--username/--password`（邮箱或手机号）与 `--sms-code`；
 * 不带凭据参数且处于终端时会进入交互向导。被 CLI 子命令 `link` 与交互命令 `/link` 复用。
 */
import * as path from "path";
import * as readline from "node:readline";
import { Store, newId } from "../server/store.js";
import { hubEnrollByAccount, hubEnrollByCode } from "@zqagent/shared/hub-api";
import { cliErr, cliLog } from "../terminal.js";
import { DEFAULT_DATA_DIR, DEFAULT_HUB_URL } from "../paths.js";
import { defaultNodeLabel } from "../node-name.js";
import {
  promptLinkAccount,
  promptPassword,
  type PromptInterface,
} from "./account-enroll.js";
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
export function expandHome(p: string): string {
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
  if (process.platform === "win32") return "%APPDATA%\\zqagent";
  return "/var/lib/zqagent（需 root；普通用户用 ~/.zqagent_data）";
}

export interface LinkOptions {
  hubUrl: string;
  /** 一次性接入码；与 account 二选一 */
  code?: string;
  /** Hub 账号凭据；与 code 二选一 */
  account?: LinkAccount;
  dataDir?: string;
  label?: string;
  host?: string;
  port?: number;
}

/** Hub 账号凭据（邮箱/手机号 + 密码，或手机号 + 短信验证码） */
export interface LinkAccount {
  email?: string;
  phone?: string;
  password?: string;
  /** 短信验证码 */
  smsCode?: string;
}

/** 命令行里的账号相关参数（`zqagent link` 与 `zqagent serve` 共用） */
export interface AccountFlags {
  username?: string;
  email?: string;
  phone?: string;
  password?: string;
  smsCode?: string;
}

/**
 * 把 `--username`（Hub 注册的邮箱或手机号）与显式的 `--email/--phone` 归一化。
 *
 * 只给了账号、没给密码时仍返回对象（调用方在 TTY 下补问密码）；
 * 账号本身缺失时返回 null。
 */
export function buildAccountAuth(
  flags: AccountFlags,
  env: NodeJS.ProcessEnv = process.env,
): LinkAccount | null {
  const username = (flags.username ?? env.ZQAGENT_HUB_USERNAME ?? "").trim();
  let email = (flags.email ?? "").trim();
  let phone = (flags.phone ?? "").trim();
  if (username && !email && !phone) {
    if (username.includes("@")) email = username;
    else phone = username;
  }
  if (!email && !phone) return null;
  const password = flags.password ?? env.ZQAGENT_HUB_PASSWORD ?? "";
  const smsCode = (flags.smsCode ?? env.ZQAGENT_HUB_SMS_CODE ?? "").trim();
  return {
    email: email ? email.toLowerCase() : undefined,
    phone: phone || undefined,
    password: password || undefined,
    smsCode: smsCode || undefined,
  };
}

/** 账号凭据是否足够发起接入（密码或短信验证码至少有一个） */
export function isCompleteAccount(account: LinkAccount | null): boolean {
  return Boolean(account && (account.password || account.smsCode));
}

export type LinkResult =
  | {
      mode: "hot";
      nodeId: string;
      gatewayUrl?: string;
      online: boolean;
      label?: string;
      dataDir: string;
      /** 命中的实例是否由 systemd / launchd 托管（开机自启、重启后仍在） */
      managed?: boolean;
      /**
       * 需要明确提示用户的异常（例如命中了本机的临时实例，而托管服务仍在等凭据）。
       * 空数组表示一切正常。
       */
      warnings: string[];
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
      /**
       * 是否写入了本机托管服务（systemd / launchd / Windows 登录任务）的数据目录。
       * 为真时服务下次启动即自动接入，不需要用户再指定 --data-dir。
       */
      targetedService: boolean;
    };

/** 解析 `--name value` 形式的参数 */
function parseLinkArgs(
  argv: string[],
): Partial<LinkOptions> & AccountFlags & { help?: boolean } {
  const out: Partial<LinkOptions> & AccountFlags & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = argv[i + 1];
    if (a === "--hub") { out.hubUrl = val; i++; }
    else if (a === "--code") { out.code = val; i++; }
    else if (a === "--username" || a === "--user") { out.username = val; i++; }
    else if (a === "--email") { out.email = val; i++; }
    else if (a === "--phone") { out.phone = val; i++; }
    else if (a === "--password") { out.password = val; i++; }
    else if (a === "--sms-code") { out.smsCode = val; i++; }
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
    body: JSON.stringify({
      hubUrl: opts.hubUrl,
      code: opts.code,
      email: opts.account?.email,
      phone: opts.account?.phone,
      password: opts.account?.password,
      smsCode: opts.account?.smsCode,
      label: opts.label,
    }),
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

/**
 * 热接入命中后检查是否「打偏」。
 *
 * 候选顺序已把托管服务排在前面，但托管服务的 admin key 缺失/探测失败时，仍可能
 * 落到同机的临时实例上。此时命令会报成功，而托管服务重启后依旧离线，所以必须
 * 显式告警，别让用户以为已经接好了。
 */
function hotWarnings(inst: ServeInstance, running: ServeInstance[]): string[] {
  const warnings: string[] = [];
  const managed = running.filter((r) => r.managed && r.dataDir !== inst.dataDir);
  if (!inst.managed && managed.length > 0) {
    warnings.push(
      `凭据写入了非托管实例 ${inst.dataDir}，但本机托管服务使用的是 ${managed.map((m) => m.dataDir).join("、")}。`,
    );
    warnings.push(
      "托管服务读不到这份凭据（重启后也不会自动上线），请用 --data-dir 指向它的数据目录重新接入。",
    );
  }
  const others = [...new Set(running.map((r) => r.dataDir).filter((d) => d !== inst.dataDir))];
  if (others.length > 0) {
    warnings.push(`本机还有其它运行中的节点实例（未写入凭据）：${others.join("、")}。`);
  }
  return warnings;
}

/** 执行接入（自动选择热接入 / 落盘）。失败抛出。 */
export async function linkNode(opts: LinkOptions): Promise<LinkResult> {
  if (!opts.code && !isCompleteAccount(opts.account ?? null)) {
    throw new Error("缺少接入码，或 Hub 账号密码/短信验证码");
  }
  const hubUrl = opts.hubUrl.trim().replace(/\/$/, "");
  if (!hubUrl) throw new Error("缺少 Hub 地址");
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
    const status = await enrollViaServer(inst.host, inst.port, adminKey, { ...opts, hubUrl });
    return {
      mode: "hot",
      ...status,
      dataDir: inst.dataDir,
      managed: inst.managed,
      warnings: hotWarnings(inst, running),
    };
  }

  // 2) 本机无 server → 凭码接入并落盘 fleet.json，下次启动自动接入。
  //    没有显式 --data-dir 时优先写到本机托管服务（systemd / launchd / Windows 登录任务）
  //    的数据目录：即使服务当前没在跑，它启动时也会读这份凭据；写到 cwd 只是白写。
  const managedDir = running.find((r) => r.managed)?.dataDir;
  const dataDir = path.resolve(explicitDataDir ?? managedDir ?? DEFAULT_DATA_DIR);
  const targetedService = !explicitDataDir && Boolean(managedDir) && dataDir === managedDir;
  const store = new Store(dataDir);
  const nodeId = ensureNodeId(store);
  // 未指定名称时用主机名，Hub 界面直接显示机器名而不是 nodeId
  const label = opts.label?.trim() || defaultNodeLabel();
  const account = opts.account;
  const cred = account && isCompleteAccount(account)
    ? await hubEnrollByAccount(hubUrl, {
        email: account.email,
        phone: account.phone,
        password: account.password,
        code: account.smsCode,
        nodeId,
        label,
      })
    : await hubEnrollByCode(hubUrl, {
        code: opts.code!,
        nodeId,
        label,
      });
  try {
    store.saveFleetCredential({
      ...cred,
      label,
      enrolledAt: new Date().toISOString(),
    });
    // 节点上报的 label 取自 node.json，与 Hub 记录保持一致
    store.saveNodeLabel(label);
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
          `  （接入码一次性，需要重新生成；账号方式可重复使用）`,
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
    targetedService,
  };
}

function printLinkHelp(): void {
  cliLog("用法: zqagent link [--hub <url>] [--username <邮箱/手机号> --password <密码>] [--label 名称]");
  cliLog("      zqagent link [--hub <url>] --code <一次性接入码> [--label 名称]");
  cliLog("  方式一（推荐）：用 Hub 已注册的账号直接接入：");
  cliLog("    zqagent link --hub https://hub.cd-zq.com --username you@example.com --password '<密码>'");
  cliLog("    zqagent link --hub https://hub.cd-zq.com --username 13800000000 --password '<密码>'");
  cliLog("    zqagent link --hub https://hub.cd-zq.com --username 13800000000 --sms-code <验证码>");
  cliLog("  方式二：在 Hub「节点管理」生成一次性接入码（15 分钟有效）：");
  cliLog("    zqagent link --hub https://hub.cd-zq.com --code <接入码>");
  cliLog("  不带凭据参数时进入交互向导（需终端）；密码也可用 ZQAGENT_HUB_PASSWORD 提供。");
  cliLog("  本机已装节点服务（install.sh / 桌面端）时会自动发现它的数据目录并热接入，");
  cliLog("  不需要手动指定 --data-dir；服务没在运行时会写入它的目录，下次启动即接入。");
  cliLog("  仅当本机完全没有服务时才需要 --data-dir 指定目录（下次启动 serve 时生效）。");
}

export interface LinkCommandContext {
  /** 复用已有 readline（交互式 CLI 内的 /link）；不传则交互模式下自行创建 */
  rl?: readline.Interface;
  /** 是否允许交互；默认看 stdin / stdout 是否为 TTY */
  interactive?: boolean;
}

/** CLI 子命令入口：`zqagent link ...`。返回是否成功。 */
export async function runLinkCommand(
  argv: string[],
  ctx: LinkCommandContext = {},
): Promise<boolean> {
  const args = parseLinkArgs(argv);
  if (args.help) {
    printLinkHelp();
    return true;
  }

  const explicitHub = Boolean((args.hubUrl ?? process.env.HUB_URL ?? "").trim());
  let hubUrl = (args.hubUrl ?? process.env.HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/$/, "");
  const code = (args.code ?? "").trim();
  let account = buildAccountAuth(args);
  const interactive = ctx.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (code && account) {
    cliErr("--code 与 Hub 账号（--username/--email/--phone/--password）只能二选一。");
    return false;
  }
  if (!account && (args.password || args.smsCode)) {
    cliErr("提供了密码/短信验证码，但缺少账号：请加 --username、--email 或 --phone。");
    return false;
  }

  // `readline` 的 question 是回调式，向导用的是 Promise 式；这里做一层轻量适配，
  // 保证交互 CLI 内复用同一个 readline（否则输入会重复回显）。
  const asPrompter = (rl: readline.Interface): PromptInterface => ({
    question: (q) => new Promise((resolve) => rl.question(q, resolve)),
    pause: () => rl.pause(),
    resume: () => rl.resume(),
  });

  let ownedRl: readline.Interface | null = null;
  const getRl = (): PromptInterface | null => {
    if (ctx.rl) return asPrompter(ctx.rl);
    if (!interactive) return null;
    ownedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return asPrompter(ownedRl);
  };
  // 闭包里的赋值不参与控制流收窄，单独封装避免 finally 处被推断成 never
  const closeOwnedRl = (): void => {
    if (ownedRl) ownedRl.close();
  };

  try {
    // 没有可用凭据：TTY 下进入向导；非交互环境明确报错。
    if (!code && !isCompleteAccount(account)) {
      const rl = getRl();
      if (!rl) {
        cliErr("缺少接入凭据：请用 --username/--password，或 --code <接入码>。");
        printLinkHelp();
        return false;
      }
      if (account) {
        // 只给了账号（如 --username a@b.com）：补问密码；短信登录请用 --sms-code。
        const password = await promptPassword(rl);
        if (!password) {
          cliErr("密码不能为空，已取消接入。");
          return false;
        }
        account = { ...account, password };
      } else {
        const prompted = await promptLinkAccount(rl, hubUrl, { askHub: !explicitHub });
        if (!prompted) return true; // 用户主动跳过，不算失败
        hubUrl = prompted.hubUrl;
        account = {
          email: prompted.auth.email,
          phone: prompted.auth.phone,
          password: prompted.auth.password,
          smsCode: prompted.auth.code,
        };
      }
    }

    const r = await linkNode({
      hubUrl,
      code: code || undefined,
      account: account ?? undefined,
      dataDir: args.dataDir,
      label: args.label,
      host: args.host,
      port: args.port,
    });
    if (r.mode === "hot") {
      cliLog("✅ 已接入 Hub（热接入，免重启）");
      cliLog(`   节点: ${r.nodeId}${r.label ? ` (${r.label})` : ""}`);
      cliLog(`   网关: ${r.gatewayUrl ?? "（未下发）"}    在线: ${r.online ? "是" : "连接中…"}`);
      cliLog(`   数据目录: ${r.dataDir}${r.managed ? "（托管服务，开机自启）" : ""}`);
      if (r.warnings.length > 0) {
        cliLog("");
        for (const w of r.warnings) cliLog(`⚠️  ${w}`);
      }
    } else {
      cliLog("✅ 接入凭据已保存（本机暂无运行中的 server）");
      cliLog(`   节点: ${r.nodeId}`);
      cliLog(`   网关: ${r.gatewayUrl ?? "（未下发）"}`);
      cliLog(`   数据目录: ${r.dataDir}`);
      cliLog("   下次启动 server 即自动接入；或运行 zqagent serve 常驻为节点。");
      if (r.targetedService) {
        // 已写到托管服务的目录：服务下次启动（含重启机器）就会自动接入。
        cliLog("");
        cliLog("✅ 凭据已写入本机托管服务的数据目录，服务启动时自动接入，无需 --data-dir。");
        cliLog("   立即生效：重启该服务（Linux: systemctl restart zqagent；");
        cliLog("   macOS: launchctl kickstart -k gui/$(id -u)/com.zqagent.node）。");
      } else if (r.runningServiceDirs.length > 0) {
        // 本机明明有 serve 在跑，却没能热接入 —— 凭据写到这里它也读不到。
        // 这是最容易「命令报成功、Hub 上却一直未接入」的情形，必须说清楚。
        cliLog("");
        cliLog("⚠️  本机有正在运行的节点，但数据目录与本次写入的不一致：");
        cliLog(`    本次写入: ${r.dataDir}`);
        for (const d of r.runningServiceDirs) cliLog(`    服务使用: ${d}`);
        cliLog("    正在运行的服务读不到这份凭据，Hub 会一直显示未接入。");
        cliLog("    请确认服务的数据目录后重新执行（接入码一次性；账号方式可重复使用）：");
        cliLog(`      zqagent link --hub <Hub地址> --username <邮箱/手机号> --password '<密码>' --data-dir "${r.runningServiceDirs[0]}"`);
      } else if (!r.explicitDataDir) {
        // 既没有显式目录，也没发现任何服务定义：只能落到当前目录。
        cliLog("");
        cliLog("⚠️  未发现本机节点服务，凭据写入了当前目录下的 .zqagent_data。");
        cliLog("    如果这台机器打算长期运行节点，请先安装开机服务，之后 link 会自动写入它的目录：");
        cliLog("      curl -fsSL https://agent.cd-zq.com/install.sh | sh");
        cliLog(`      （服务默认数据目录：${installDataDirHint()}）`);
      }
    }
    return true;
  } catch (e) {
    cliErr(`接入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    closeOwnedRl();
  }
}
