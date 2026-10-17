/**
 * 终端输出兼容层：终端能力探测 + emoji 降级
 *
 * 背景：Windows 传统控制台（conhost / cmd.exe / 旧 PowerShell 宿主）默认字体
 * 不含 astral 平面 emoji 字形，Node 通过 WriteConsoleW 写入时找不到字形，会显示
 * 成 `?`/豆腐块。这是字形覆盖问题，`chcp 65001` 之类改编码的手段解决不了。
 *
 * 处理：探测终端是否支持 emoji，不支持时把 CLI 自身与引擎钩子输出的 emoji
 * 降级为等义 ASCII 标记（✅→[OK]、❌→[x]、⚠️→[!] …），Markdown 表格也一并
 * 改用 ASCII 边框（见 MarkdownRenderer 的 `unicode` 选项）。
 *
 * 环境变量覆盖：
 *   ZQAGENT_EMOJI=1/0  强制开/关
 *   ZQAGENT_ASCII=1    强制降级
 *   NO_EMOJI=1         强制降级
 */

/** 探测入参（便于测试注入；默认取当前进程的 process / stdout） */
export interface TerminalDetectInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
}

/**
 * 探测当前终端是否能渲染 emoji。
 * 非 Windows 一律支持；Windows 下仅 Windows Terminal / VS Code 终端 / ConEmu
 * 等现代终端支持，传统 conhost 降级。重定向/管道（非 TTY）保持原样（UTF-8 文件安全）。
 */
export function detectEmojiSupport(input: TerminalDetectInput = {}): boolean {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);

  const flag = (env.ZQAGENT_EMOJI ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(flag)) return false;
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  if (env.ZQAGENT_ASCII && env.ZQAGENT_ASCII !== "0") return false;
  if (env.NO_EMOJI && env.NO_EMOJI !== "0") return false;

  if (platform !== "win32") return true;
  // 重定向到文件 / 管道：写的是 UTF-8 字节，交给下游自行渲染
  if (!isTTY) return true;
  // Windows Terminal 会设置 WT_SESSION
  if (env.WT_SESSION) return true;
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (termProgram === "vscode" || termProgram === "windows-terminal") return true;
  if ((env.ConEmuANSI ?? "").toUpperCase() === "ON") return true;
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("xterm") || term.includes("mintty")) return true;

  // 传统 conhost / cmd.exe / 旧 PowerShell 宿主
  return false;
}

/** 本进程终端是否支持 emoji（启动时求值一次） */
export const EMOJI_SUPPORTED: boolean = detectEmojiSupport();

/** 是否支持 Unicode 绘制（表格边框等）。与 emoji 同源：传统 cmd 下一并降级 */
export const UNICODE_SUPPORTED: boolean = EMOJI_SUPPORTED;

/** emoji → ASCII 等义标记（保持纯 ASCII，确保传统控制台可读） */
const EMOJI_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["✅", "[OK]"],
  ["❌", "[x]"],
  ["⚠️", "[!]"],
  ["⚠", "[!]"],
  ["ℹ️", "[i]"],
  ["ℹ", "[i]"],
  ["📋", "[i]"],
  ["📄", "[file]"],
  ["📁", "[dir]"],
  ["💾", "[saved]"],
  ["📡", "[net]"],
  ["🧰", "[tools]"],
  ["🔒", "[lock]"],
  ["🚫", "[denied]"],
  ["📦", "[files]"],
  ["🏷️", "[name]"],
  ["🏷", "[name]"],
  ["💡", "*"],
  ["⤴", "->"],
  ["⚙", "[run]"],
  ["⏹", "[stop]"],
  ["🔄", "[..]"],
  ["✗", "x"],
  ["🚀", "[run]"],
  ["🔍", "[search]"],
  ["🔧", "[tool]"],
  ["🎯", "[goal]"],
  ["📝", "[note]"],
  ["✨", "*"],
  ["🐛", "[bug]"],
  ["🎉", "*"],
  ["👀", "[look]"],
  ["🤖", "[bot]"],
  ["🔔", "[!]"],
  ["⬆", "^"],
  ["⬇", "v"],
];

const EMOJI_MAP = new Map<string, string>(EMOJI_PAIRS);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 长的键排在前面，避免 "⚠️" 被 "⚠" 先匹配掉
const EMOJI_RE = new RegExp(
  [...EMOJI_PAIRS]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k]) => escapeRegExp(k))
    .join("|"),
  "g",
);

/**
 * 把文本里的 emoji 降级为 ASCII 标记。`supported` 为 true 时原样返回。
 * 第二个参数便于测试注入；生产调用默认用本进程的 EMOJI_SUPPORTED。
 */
export function sanitizeEmoji(text: string, supported: boolean = EMOJI_SUPPORTED): string {
  if (supported || !text) return text;
  return text.replace(EMOJI_RE, (m) => EMOJI_MAP.get(m) ?? m);
}

/** emoji 或 ASCII 标记，按终端能力取值 */
export const sym = {
  get ok() {
    return EMOJI_SUPPORTED ? "✅" : "[OK]";
  },
  get fail() {
    return EMOJI_SUPPORTED ? "❌" : "[x]";
  },
  get warn() {
    return EMOJI_SUPPORTED ? "⚠️" : "[!]";
  },
  get info() {
    return EMOJI_SUPPORTED ? "ℹ️" : "[i]";
  },
  get list() {
    return EMOJI_SUPPORTED ? "📋" : "[i]";
  },
  get file() {
    return EMOJI_SUPPORTED ? "📄" : "[file]";
  },
  get dir() {
    return EMOJI_SUPPORTED ? "📁" : "[dir]";
  },
  get save() {
    return EMOJI_SUPPORTED ? "💾" : "[saved]";
  },
} as const;

// =====================================================================
// 输出包装：CLI 自身与引擎钩子的输出统一经过这里，按终端能力降级
// =====================================================================

function mapArgs(args: unknown[]): unknown[] {
  return args.map((a) => (typeof a === "string" ? sanitizeEmoji(a) : a));
}

/** console.log 的降级包装 */
export function cliLog(...args: unknown[]): void {
  console.log(...mapArgs(args));
}

/** console.error 的降级包装 */
export function cliErr(...args: unknown[]): void {
  console.error(...mapArgs(args));
}

/** console.warn 的降级包装 */
export function cliWarn(...args: unknown[]): void {
  console.warn(...mapArgs(args));
}

/** process.stdout.write 的降级包装（仅处理字符串块，保留二进制透传） */
export function cliWrite(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
  return (process.stdout.write as (...a: unknown[]) => boolean)(
    typeof chunk === "string" ? sanitizeEmoji(chunk) : chunk,
    ...rest,
  );
}
