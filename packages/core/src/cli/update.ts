/**
 * `zqagent update` — 查看与手动触发节点更新。
 *
 *   zqagent update --status     当前版本、通道、上次检查、暂存与失败原因
 *   zqagent update --check      只检查是否有新版本（不下载）
 *   zqagent update --now        立即下载并安装（跳过空闲等待，装完需重启服务）
 *   zqagent update --rollback   用上次安装前的备份回滚
 *
 * 选项：--data-dir <dir>
 *
 * 自动更新本身由 `zqagent serve` 内置的调度器完成（静默下载 + 空闲时重启），
 * 本命令只做诊断与人工干预。
 */
import { UpdateController, updaterChannel, updaterUrl } from "../update/controller.js";
import { currentVersion, isSeaRuntime, serviceManager } from "../update/platform.js";
import { DEFAULT_DATA_DIR } from "../paths.js";
import { cliLog, cliErr } from "../terminal.js";
import * as path from "node:path";

interface UpdateArgs {
  status: boolean;
  check: boolean;
  now: boolean;
  rollback: boolean;
  dataDir?: string;
}

function parse(argv: string[]): UpdateArgs {
  const out: UpdateArgs = { status: false, check: false, now: false, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") out.status = true;
    else if (a === "--check") out.check = true;
    else if (a === "--now") out.now = true;
    else if (a === "--rollback") out.rollback = true;
    else if (a === "--data-dir") {
      out.dataDir = argv[i + 1];
      i++;
    }
  }
  return out;
}

/** 回滚/立即安装后必须重启服务才会加载新文件 */
function restartHint(): string {
  // install.sh rollback 自己在改完后重启服务，不需要再提示
  if (process.env.ZQAGENT_NO_RESTART_HINT === "1") return "";
  const mgr = serviceManager();
  const name = process.env.ZQAGENT_SERVICE_NAME?.trim() || "zqagent";
  if (mgr === "systemd") return `请重启服务使改动生效：systemctl restart ${name}`;
  if (mgr === "launchd") {
    const label = process.env.ZQAGENT_SERVICE_LABEL?.trim() || "com.zqagent.node";
    return `请重启服务使改动生效：launchctl kickstart -k gui/$(id -u)/${label}`;
  }
  return "请手动重启节点进程使改动生效";
}

export async function runUpdateCommand(argv: string[]): Promise<number> {
  const args = parse(argv);
  const dataDir = path.resolve(args.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR);

  const controller = new UpdateController({ dataDir, isIdle: () => true });

  if (args.rollback) {
    const restored = controller.rollbackNow();
    if (!restored) {
      cliErr("没有可用的回滚备份（可能尚未通过自动更新安装过新版本）。");
      return 1;
    }
    cliLog(`✅ 已回滚到 v${restored}`);
    const hint = restartHint();
    if (hint) cliLog(hint);
    return 0;
  }

  if (args.status) {
    const s = controller.status();
    cliLog(`当前版本  v${s.currentVersion}`);
    cliLog(`运行形态  ${isSeaRuntime() ? "单文件（SEA）" : "Node（npm/source）"}`);
    cliLog(`服务托管  ${s.serviceManager ?? "未托管（前台/nohup）"}`);
    cliLog(`更新通道  ${s.channel}`);
    cliLog(`清单地址  ${s.manifestUrl}`);
    cliLog(`自动更新  ${s.enabled ? "已启用" : `未启用${s.reason ? `（${s.reason}）` : ""}`}`);
    if (s.lastCheckAt) cliLog(`上次检查  ${s.lastCheckAt}`);
    if (s.stagedVersion) cliLog(`待安装    v${s.stagedVersion}`);
    if (s.pendingVersion) cliLog(`安装中    v${s.pendingVersion}`);
    if (s.previousVersion) cliLog(`更新前    v${s.previousVersion}`);
    if (s.backupVersion) cliLog(`可回滚到  v${s.backupVersion}`);
    if (s.lastError) cliLog(`最近错误  ${s.lastError}`);
    return 0;
  }

  if (args.check) {
    // 只检查：不下载，避免为了看一眼版本号拉 100MB
    const msg = await controller.check(false, true);
    cliLog(msg);
    return 0;
  }

  if (args.now) {
    // 先打印提示：安装成功后进程会退出（由服务管理器拉起新版本）
    const hint = restartHint();
    if (hint) cliLog(hint);
    const msg = await controller.check(true, false, true);
    cliLog(msg);
    return 0;
  }

  cliLog("用法：zqagent update --status | --check | --now | --rollback [--data-dir <dir>]");
  cliLog(`  当前版本 v${currentVersion()}，通道 ${updaterChannel()}，清单 ${updaterUrl()}`);
  return 0;
}
