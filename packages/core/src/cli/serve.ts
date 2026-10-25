/**
 * `zqagent serve` — 以 CLI 方式启动 zqagent server（headless 常驻）
 *
 * 与独立入口 `src/server/index.ts` 等价：复用 `runtime.startServer`，
 * 使只装了 CLI 的机器也能常驻为可被 Hub 管理的节点。
 *
 * 用法：
 *   zqagent serve [--data-dir <dir>] [--host <addr>] [--port <n>]
 *                 [--hub <url> --enroll-code <code> [--label <name>]]
 *                 [--hub <url> --username <邮箱/手机号> --password <密码> [--label <name>]]
 *
 * 首次带注册码或账号即接入；已有 `{DATA_DIR}/fleet.json` 时无需再带（fleet.json 优先）。
 * 都没有时，交互式终端会提示用 Hub 账号（密码或短信验证码）直接接入。
 */
import { startServer } from "../server/runtime.js";
import { cliErr, cliLog } from "../terminal.js";
import { maybeAccountEnroll, resolveDefaultHub } from "./account-enroll.js";
import {
  buildAccountAuth,
  isCompleteAccount,
  linkNode,
  type AccountFlags,
} from "./link.js";

interface ServeArgs extends AccountFlags {
  hubUrl?: string;
  code?: string;
  label?: string;
  dataDir?: string;
  host?: string;
  port?: number;
}

function parse(argv: string[]): ServeArgs {
  const out: ServeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--hub") { out.hubUrl = v; i++; }
    else if (a === "--enroll-code" || a === "--code") { out.code = v; i++; }
    else if (a === "--username" || a === "--user") { out.username = v; i++; }
    else if (a === "--email") { out.email = v; i++; }
    else if (a === "--phone") { out.phone = v; i++; }
    else if (a === "--password") { out.password = v; i++; }
    else if (a === "--sms-code") { out.smsCode = v; i++; }
    else if (a === "--label") { out.label = v; i++; }
    else if (a === "--data-dir") { out.dataDir = v; i++; }
    else if (a === "--host") { out.host = v; i++; }
    else if (a === "--port") { out.port = Number(v); i++; }
  }
  return out;
}

/** 子命令入口；返回后由 server 监听维持进程存活。 */
export async function runServeCommand(argv: string[]): Promise<void> {
  const args = parse(argv);
  const hubUrl = (args.hubUrl ?? process.env.HUB_URL ?? "").trim();
  const code = (args.code ?? process.env.HUB_ENROLL_CODE ?? "").trim();
  const account = buildAccountAuth(args);

  if (code && account) {
    cliErr("--enroll-code 与 Hub 账号参数（--username/--password 等）只能二选一。");
    return;
  }
  if (account && !isCompleteAccount(account) && !process.stdin.isTTY) {
    cliErr("账号参数缺少密码或短信验证码：非交互环境请补 --password 或 --sms-code。");
  }

  // 非交互场景（systemd / 容器）也能用账号参数接入：先落盘，startServer 随即读取。
  // 账号不完整（例如只给了 --username）时回退到交互向导补问密码。
  if (!code && isCompleteAccount(account)) {
    try {
      const r = await linkNode({
        hubUrl: resolveDefaultHub(args.hubUrl || undefined),
        account: account!,
        dataDir: args.dataDir,
        label: args.label,
        host: args.host,
        port: args.port,
      });
      cliLog(
        r.mode === "hot"
          ? `✅ 已通过 Hub 账号接入（节点 ${r.nodeId}）`
          : `✅ 已保存 Hub 接入凭据（节点 ${r.nodeId}）`,
      );
    } catch (e) {
      // 接入失败不阻断本地启动；用户可稍后执行 zqagent link 重试
      cliErr(`Hub 账号接入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 未带注册码的首次启动：交互式提示用 Hub 账号接入（已接入/非 TTY 时自动跳过）
  if (!(hubUrl && code) && !isCompleteAccount(account)) {
    await maybeAccountEnroll({ dataDir: args.dataDir, hubUrl: args.hubUrl, label: args.label });
  }

  const handle = startServer({
    dataDir: args.dataDir,
    host: args.host,
    port: args.port,
    // 仅当两者齐备时启用「启动即接入」；已有 fleet.json 时会被 runtime 忽略
    autoEnroll: hubUrl && code ? { hubUrl, code, label: args.label } : null,
    autoUpdate: true,
  });
  const info = await handle.ready;
  const fleet = handle.fleet.status();
  cliLog("");
  cliLog("✅ 节点已就绪（按 Ctrl+C 退出）");
  cliLog(`   · 地址    http://${info.host}:${info.port}`);
  cliLog(`   · 节点ID  ${fleet.nodeId}`);
  cliLog(`   · 数据目录 ${info.dataDir}`);
  if (fleet.gatewayUrl) {
    cliLog(`   · 云端   已接入（网关: ${fleet.gatewayUrl}）${fleet.online ? "" : "，连接中…"}`);
    if (!fleet.online) {
      // 8s 后复核一次：连不上时给出原因与补救步骤（服务本身不受影响）
      const t = setTimeout(() => {
        const st = handle.fleet.status();
        if (st.online) return;
        cliLog("");
        cliLog(`⚠️  网关仍未连接成功${st.lastError ? `：${st.lastError}` : ""}${
          st.reconnectCount ? `（已重试 ${st.reconnectCount} 次）` : ""
        }`);
        cliLog("    常见原因：接入码已失效、网络不可达（wss 走 443）、企业网关证书拦截");
        cliLog("    修复：控制台「节点管理」生成新接入码，然后");
        cliLog(`          zqagent link --hub <Hub地址> --code <接入码> --data-dir "${info.dataDir}" --port ${info.port}`);
      }, 8000);
      t.unref?.();
    }
  } else {
    cliLog("   · Hub     未接入");
    cliLog("     接入：用 Hub 账号执行 zqagent serve（交互式提示），或在控制台「节点管理」生成接入码后执行");
    cliLog(`       zqagent link --hub <Hub地址> --code <接入码> --data-dir "${info.dataDir}" --port ${info.port} [--label <名称>]`);
    cliLog("     本机已有该 server 时会热接入（免重启）。");
  }
}
