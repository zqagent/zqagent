/**
 * 终止整棵进程树
 *
 * 前台命令（execAsync 的超时/中断）与后台任务（ShellTaskManager.kill）共用：
 * 只有以 detached 启动的子进程才是进程组组长，负 pid 才能覆盖其派生的孙进程。
 */
import { spawnSync } from "node:child_process";

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* 尽力而为 */
    }
    return;
  }
  // POSIX：detached 启动使子进程成为进程组组长，负 pid 即整组
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}
