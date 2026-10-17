/**
 * 引擎运行限制的健壮解析
 *
 * 统一解析「单轮最大迭代次数」等运行限制的环境变量，避免
 * `Number(x) || fallback` 在 0 / 负数 / 非法值下静默回退的坑。
 */

/**
 * 解析最大迭代次数：非法 / 非正数 / 空值 → fallback；否则向下取整。
 * @param value 环境变量原始字符串（可能 undefined）
 * @param fallback 缺省值
 */
export function parseMaxIterations(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * 解析可选的「正数」环境变量（如 CONTEXT_WINDOW / COMPACTION_CAP_TOKENS）。
 * 空值 / 非法 / 非正数 → undefined（表示「未设置，用默认」）。
 */
export function parseOptionalPositiveNumber(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === null || value.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * 解析可选的「比例」环境变量（如 COMPACTION_THRESHOLD_PCT）。
 * 接受 0~1 之间的小数（如 0.8）；空值 / 非法 / 越界 → undefined。
 */
export function parseRatio(value: string | undefined): number | undefined {
  if (value === undefined || value === null || value.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
}
