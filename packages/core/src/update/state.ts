/**
 * 更新状态持久化：`<dataDir>/updates/state.json`
 *
 * 记录最近一次检查、已暂存待安装的版本、失败计数与回滚用的备份路径。
 * 文件损坏或不可读时按「无状态」处理，不阻塞节点启动。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface UpdateState {
  lastCheckAt?: string;
  /** 最近一次失败原因（成功检查后清空） */
  lastError?: string;
  /** 同一版本的连续失败次数；达到阈值后放弃该版本 */
  failureCount?: number;
  failedVersion?: string;
  /** 已下载并通过校验、等待空闲安装的版本 */
  stagedVersion?: string;
  stagedPath?: string;
  /** 已替换文件、等待新进程启动确认的版本 */
  pendingVersion?: string;
  /** 回滚备份 */
  backupVersion?: string;
  backupPath?: string;
  /** 上次成功启动的版本（用于判断更新是否生效） */
  runningVersion?: string;
  /** 上次更新前运行的版本 */
  previousVersion?: string;
  /** 被替换的可执行文件路径（回滚时用，避免从 node 进程误推断成 node 自身） */
  installedExecPath?: string;
  /** 被回滚掉的版本：自动更新会跳过它，直到发布更新的版本（手动 --now 不受限） */
  skippedVersion?: string;
}

export function updatesDir(dataDir: string): string {
  return path.join(dataDir, "updates");
}

function statePath(dataDir: string): string {
  return path.join(updatesDir(dataDir), "state.json");
}

export function loadState(dataDir: string): UpdateState {
  try {
    const raw = fs.readFileSync(statePath(dataDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as UpdateState;
  } catch {
    // 不存在或损坏：按空状态处理
  }
  return {};
}

export function saveState(dataDir: string, state: UpdateState): void {
  const dir = updatesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = statePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** 合并写入（读 → 改 → 写），避免并发覆盖 */
export function patchState(dataDir: string, patch: Partial<UpdateState>): UpdateState {
  const next = { ...loadState(dataDir), ...patch };
  saveState(dataDir, next);
  return next;
}
