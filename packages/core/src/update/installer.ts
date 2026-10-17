/**
 * 原子替换与回滚。
 *
 * 替换策略：
 * - Unix：先尝试 rename（同一文件系统内是原子的）；跨分区（EXDEV）时复制到 exe 同目录
 *   的 `.new` 再 rename，避免把半个文件暴露成可执行入口。
 * - Windows：运行中的 exe 不能覆盖，但允许改名——先把旧文件改成 `.old`，再落新文件。
 *
 * 备份统一放在 `<dataDir>/updates/backup/`（该目录一定可写），供 `update --rollback` 使用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { currentVersion } from "./platform.js";
import { patchState, updatesDir, type UpdateState } from "./state.js";

export interface InstallOptions {
  dataDir: string;
  /** 当前正在运行的可执行文件（SEA 的 process.execPath） */
  execPath: string;
  /** 已下载并通过自检的新文件 */
  stagedPath: string;
  version: string;
  log?: (msg: string) => void;
}

function backupDir(dataDir: string): string {
  return path.join(updatesDir(dataDir), "backup");
}

/** 备份当前可执行文件，返回备份路径 */
export function backupCurrent(dataDir: string, execPath: string, version: string): string {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `zqagent-${version}${process.platform === "win32" ? ".exe" : ""}`);
  fs.copyFileSync(execPath, target);
  fs.chmodSync(target, 0o755);
  return target;
}

/**
 * 用 `stagedPath` 替换 `execPath`。
 * 调用方负责在这之后退出进程，让服务管理器拉起新版本。
 */
export function replaceExecutable(execPath: string, stagedPath: string): void {
  if (process.platform === "win32") {
    const oldPath = `${execPath}.old`;
    fs.rmSync(oldPath, { force: true });
    fs.renameSync(execPath, oldPath);
    fs.copyFileSync(stagedPath, execPath);
    fs.chmodSync(execPath, 0o755);
    return;
  }

  try {
    fs.renameSync(stagedPath, execPath);
    fs.chmodSync(execPath, 0o755);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // 跨文件系统：先复制到同目录，再原子 rename 覆盖
    const tmp = `${execPath}.new`;
    fs.rmSync(tmp, { force: true });
    fs.copyFileSync(stagedPath, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, execPath);
    fs.rmSync(stagedPath, { force: true });
  }
}

/**
 * 执行安装（备份 → 替换 → 记录状态）。不负责退出进程。
 * 失败时抛错，调用方保留 staged 文件以便下次重试。
 */
export function installStaged(opts: InstallOptions): UpdateState {
  const log = opts.log ?? (() => {});
  const from = currentVersion();

  log(`正在安装 v${opts.version}（当前 v${from}）`);
  const backupPath = backupCurrent(opts.dataDir, opts.execPath, from);
  log(`已备份当前版本到 ${path.basename(backupPath)}`);

  replaceExecutable(opts.execPath, opts.stagedPath);

  return patchState(opts.dataDir, {
    stagedVersion: undefined,
    stagedPath: undefined,
    pendingVersion: opts.version,
    previousVersion: from,
    backupVersion: from,
    backupPath,
    installedExecPath: opts.execPath,
    lastError: undefined,
    failureCount: 0,
    failedVersion: undefined,
  });
}

/** 用备份覆盖当前可执行文件并返回被恢复的版本；无备份时返回 null */
export function rollback(dataDir: string, execPath: string, log: (msg: string) => void = () => {}): string | null {
  const state = readRollbackTarget(dataDir);
  if (!state?.backupPath || !state.backupVersion) return null;
  if (!fs.existsSync(state.backupPath)) return null;

  log(`正在回滚到 v${state.backupVersion}`);
  if (process.platform === "win32") {
    fs.rmSync(`${execPath}.old`, { force: true });
    fs.renameSync(execPath, `${execPath}.old`);
    fs.copyFileSync(state.backupPath, execPath);
    fs.chmodSync(execPath, 0o755);
  } else {
    const tmp = `${execPath}.rollback`;
    fs.copyFileSync(state.backupPath, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, execPath);
  }

  patchState(dataDir, {
    pendingVersion: state.backupVersion,
    previousVersion: currentVersion(),
    // 不让自动更新立刻把刚回滚掉的版本再装回来
    skippedVersion: currentVersion(),
    backupPath: undefined,
    backupVersion: undefined,
  });
  return state.backupVersion;
}

function readRollbackTarget(dataDir: string): Pick<UpdateState, "backupPath" | "backupVersion"> | null {
  try {
    const raw = fs.readFileSync(path.join(updatesDir(dataDir), "state.json"), "utf-8");
    const s = JSON.parse(raw) as UpdateState;
    if (s.backupPath && s.backupVersion) return s;
  } catch {
    // 无状态
  }
  return null;
}
