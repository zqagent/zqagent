/**
 * 【临时调试】节点侧慢操作打点。
 *
 * 目的：定位「控制台刷新时节点事件循环被阻塞 40~97s」的具体环节
 * （已有证据：卡住期间 80 个 ping 中 65 个无响应；CPU 时间未同步增长）。
 *
 * 用法：
 *   const t0 = dbgNow();  ...业务...  dbgMs("标签", t0, "附加信息");
 *
 * 开关：默认关闭；ZQAGENT_DEBUG_FLEET=1 开启；ZQAGENT_DEBUG_FLEET_MIN_MS 调整输出阈值（默认 200ms）。
 * 删除：删本文件，并搜索各文件中的 "dbgNow"/"dbgMs"/"[dbg]" 调用点一并移除。
 */
export const DBG_FLEET = (() => {
  return process.env.ZQAGENT_DEBUG_FLEET === "1"; // 仅显式开启时输出
})();

/** 低于该耗时不打点（避免刷屏；97s 级阻塞必然超过） */
const MIN_MS = (() => {
  const n = Number(process.env.ZQAGENT_DEBUG_FLEET_MIN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 200;
})();

export function dbgNow(): number {
  return Date.now();
}

/** 耗时才打点（>= MIN_MS） */
export function dbgMs(label: string, t0: number, extra?: string): void {
  if (!DBG_FLEET) return;
  const ms = Date.now() - t0;
  if (ms < MIN_MS) return;
  console.log(`[dbg] ${label} ${ms}ms${extra ? ` | ${extra}` : ""}`);
}

/** 无条件打点（关键节点：进入/离开，用于判断耗时归属与是否发生进程挂起） */
export function dbgMark(label: string, extra?: string): void {
  if (!DBG_FLEET) return;
  console.log(`[dbg] ${label} @${new Date().toISOString()}${extra ? ` | ${extra}` : ""}`);
}
