/**
 * 静音 Node 内置 `punycode` 的弃用警告（DEP0040）。
 *
 * 为什么需要：依赖链 `node-fetch` → `whatwg-url` → `tr46` 用的是**内置**
 * `punycode` 模块，我们无法替换成用户态实现；Node 21+ 因此每次启动都会往
 * stderr 打两行：
 *
 *   (node:12345) [DEP0040] DeprecationWarning: The `punycode` module is
 *   deprecated. Please use a userland alternative instead.
 *   (Use `node --trace-deprecation ...` to show where the warning was created)
 *
 * 这段噪音会混进安装脚本的输出、`zqagent --version` 的结果、以及服务日志，
 * 对用户没有任何行动价值（我们能做的只有等上游换掉 punycode）。
 *
 * 实现上只能拦截 `warning` 事件：该警告由 Node 内部的 emitDeprecationWarning
 * 直接派发，**不经过** `process.emitWarning`，替换那个方法无效。
 * 这里只过滤 DEP0040，其余弃用警告仍交给 Node 默认处理器，不牺牲可观测性。
 *
 * 注意：本模块必须最先被求值（见 `cli/index.ts` 的第一条 import）。ESM 按
 * import 顺序求值，因此它早于任何可能 require punycode 的依赖。
 */

/** 要静音的弃用警告码：内置 punycode（Node 21+ 才存在） */
export const IGNORED_WARNING_CODES: ReadonlySet<string> = new Set(["DEP0040"]);

/** 该警告是否应被丢弃（true = 不打到 stderr） */
export function shouldSilenceWarning(warning: { code?: string } | undefined | null): boolean {
  const code = warning?.code;
  return typeof code === "string" && IGNORED_WARNING_CODES.has(code);
}

const listeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (shouldSilenceWarning(warning as { code?: string })) return;
  // 交回 Node 原来的处理器，保持「其它警告」的既有格式与行为
  for (const listener of listeners) listener(warning);
});
