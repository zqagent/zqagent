/**
 * 会话命名元数据（CLI 层）
 *
 * 命名判定的纯逻辑（shouldAutoName / sanitizeSessionName）已下沉到
 * engine/sessionNaming.ts，与 Server 共用；本模块保留 CLI 专属的
 * state 文件读-改-写（命名请求在后台完成、用户已切换会话时，把名称
 * 写回正确的会话 state）与内存态 SessionMeta。
 *
 * 与 cli/index.ts 解耦，便于单独测试。
 */
import * as fs from "fs";
import * as path from "path";
import type { SavedState } from "../engine/FileLogHook.js";

// 命名纯逻辑已下沉到 engine/sessionNaming.ts（CLI 与 Server 共用），此处再导出保持兼容。
export {
  AUTO_NAME_TASK_COUNTS,
  shouldAutoName,
  sanitizeSessionName,
} from "../engine/sessionNaming.js";
export type { SessionNameSource } from "../engine/sessionNaming.js";

/** 当前会话的命名相关运行时状态（内存） */
export interface SessionMeta {
  sessionId: string;
  name?: string;
  nameSource?: "auto" | "user";
  taskCount: number;
}

/**
 * 读-改-写 `{sessionId}_state.json`：把 patch 中的命名元数据合并进
 * 已保存的 state（保留 messages 等其它字段）。文件不存在或损坏返回 false。
 */
export function updateSessionMetaFile(
  stateDir: string,
  sessionId: string,
  patch: Partial<Pick<SavedState, "name" | "nameSource" | "taskCount">>,
): boolean {
  const file = path.join(stateDir, `${sessionId}_state.json`);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const state = JSON.parse(raw) as SavedState;
    if (patch.name !== undefined) state.name = patch.name;
    if (patch.nameSource !== undefined) state.nameSource = patch.nameSource;
    if (patch.taskCount !== undefined) state.taskCount = patch.taskCount;
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
