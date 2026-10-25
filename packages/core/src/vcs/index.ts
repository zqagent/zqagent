/**
 * 变更追踪（VCS）入口
 *
 * 导出探测、快照与恢复能力。设计说明见 docs/multi-session.md。
 */
export {
  resolveVcsPlan,
  isGitRepo,
  agentRef,
  sessionIndexPath,
  SHADOW_DIR,
  SHADOW_EXCLUDES,
} from "./plan.js";
export type { VcsMode, VcsConfigMode, VcsPlan, TurnCommit, ResolveVcsOptions } from "./plan.js";
export { SessionVcs } from "./session.js";
export type { RestoreResult } from "./session.js";
export { VcsHook } from "./hook.js";
export { runGit, gitOk, gitMessage } from "./runner.js";
export type { GitResult, GitRunOptions } from "./runner.js";
