/**
 * 本机配置 / 状态目录的跨平台解析
 *
 * POSIX 沿用 XDG 约定；Windows 上 `HOME` 在 cmd / PowerShell 中通常不存在，
 * 若直接回退 `/tmp` 会把配置写到 `\tmp\...`（当前盘符根），且与
 * `%APPDATA%` 的常规位置不一致。统一顺序：显式 XDG 变量（用户显式指定，
 * 优先级最高）→ 平台原生目录 → XDG 默认位置（家目录）→ 临时目录。
 */
import * as os from "os";
import * as path from "path";

/** 应用目录名（`~/.config/zqagent` 的最后一段） */
const APP_DIR_NAME = "zqagent";

/**
 * 节点默认数据目录名（相对启动目录，即 `./.zqagent_data`）。
 * server / CLI 在既无 `--data-dir` 也无 `DATA_DIR` 时用它兜底，
 * 集中在此避免各处字面量走散。
 */
export const DEFAULT_DATA_DIR = ".zqagent_data";

/**
 * 官方 Hub 基址（不带结尾斜杠）：CLI 在既无 `--hub` 也无 `HUB_URL` 时用它兜底
 * （首个交互式接入提示的默认值）。自建 Hub 请用 `--hub` / `HUB_URL` 覆盖。
 */
export const DEFAULT_HUB_URL = "https://hub.cd-zq.com";

/** 是否为 Windows（仅此处需要区分平台；APPDATA 在别的系统上可能是无关变量） */
const IS_WINDOWS = process.platform === "win32";

/** 用户主目录：`HOME` → Windows `USERPROFILE` → `os.homedir()` → 临时目录 */
function homeDir(): string {
  return (
    process.env.HOME || process.env.USERPROFILE || os.homedir() || os.tmpdir()
  );
}

/** 配置目录：`$XDG_CONFIG_HOME/zqagent`、Windows `%APPDATA%\zqagent`、其余 `~/.config/zqagent` */
export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (IS_WINDOWS ? process.env.APPDATA : undefined) ||
    path.join(homeDir(), ".config");
  return path.join(base, APP_DIR_NAME);
}

/** 状态目录：`$XDG_STATE_HOME/zqagent`、Windows `%LOCALAPPDATA%\zqagent`、其余 `~/.local/state/zqagent` */
export function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME ||
    (IS_WINDOWS ? process.env.LOCALAPPDATA : undefined) ||
    path.join(homeDir(), ".local", "state");
  return path.join(base, APP_DIR_NAME);
}
