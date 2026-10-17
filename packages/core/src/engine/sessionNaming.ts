/**
 * 会话命名纯逻辑（CLI 与 Server 共用）
 *
 * 触发时机：任务成功完成第 1/3/5 次时自动生成会话名。
 * 用户手动改名（nameSource=user）后永不再自动生成。
 */

/** 触发自动生成会话名的任务完成次数 */
export const AUTO_NAME_TASK_COUNTS = [1, 3, 5];

export type SessionNameSource = "auto" | "user";

/**
 * 是否应在第 taskCount 次任务完成后自动生成会话名。
 * 用户手动改名（nameSource === "user"）后永不再自动生成。
 */
export function shouldAutoName(
  taskCount: number,
  nameSource?: SessionNameSource,
): boolean {
  return nameSource !== "user" && AUTO_NAME_TASK_COUNTS.includes(taskCount);
}

/**
 * 清洗 AI 生成的会话名：
 * - 取首行（去掉换行与多余解释）；
 * - 剥离首尾引号/书名号等包裹符；
 * - 去掉「会话名称：」之类前缀；
 * - 超长截断到 30 字；
 * - 结果为空返回 null。
 */
export function sanitizeSessionName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  let name = raw.trim().split(/\r?\n/)[0]!.trim();
  name = name.replace(/^["'“”「『《〈]+|["'”」』》〉]+$/g, "").trim();
  name = name.replace(/^(会话名称|名称|标题|session name|title)\s*[:：]\s*/i, "").trim();
  if (!name) return null;
  if (name.length > 30) name = name.slice(0, 30);
  return name;
}
