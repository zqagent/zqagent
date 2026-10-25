/**
 * 工作区命令判定（无 OS 沙箱时的兜底策略）
 *
 * 用途：当系统沙箱不可用（典型是 Windows），仍希望「只操作工作区的命令」
 * 不必逐条审批。做法是把命令拆成简单片段，逐个检查其中出现的路径：
 * 只要所有路径都落在工作区内，就视为可放行。
 *
 * 这不是安全边界，务必据此使用：它只是静态文本分析，`pnpm install`
 * 的 postinstall 脚本、构建脚本里的任意代码都能绕过它。真正的隔离依赖
 * tools/sandbox.ts 的 OS 级沙箱。因此本模块只用于「沙箱未生效」的兜底，
 * 并且额外拒绝一批无法静态判定的写法（命令替换、内联代码、间接执行）。
 */
import * as os from "os";
import * as path from "path";
import { isWithinRoot } from "../tools/pathSafety.js";

export interface ConfinementResult {
  /** 命令行里所有路径是否都位于工作区内 */
  confined: boolean;
  /** 判定说明（放行原因 / 触发审批的原因） */
  reason: string;
}

export interface AssessOptions {
  workspaceRoot: string;
  /** 当前 shell 的 cwd；缺省按工作区根解析相对路径 */
  cwd?: string;
  platform?: NodeJS.Platform;
}

/** 直接作用于整机或系统配置的命令：一律不自动放行 */
const DENY_BINS = new Set([
  "sudo",
  "su",
  "doas",
  "runas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "fdisk",
  "diskutil",
  "format",
  "mount",
  "umount",
  "launchctl",
  "systemctl",
  "sc",
  "reg",
  "regedit",
  "schtasks",
  "crontab",
  "chown",
  "chgrp",
]);

/** 解释器的「内联代码」开关：无法静态判定其行为 */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  py: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  ash: ["-c"],
  ksh: ["-c"],
  fish: ["-c"],
  powershell: ["-command", "-c", "-encodedcommand", "-enc"],
  pwsh: ["-command", "-c", "-encodedcommand", "-enc"],
  cmd: ["/c", "/k"],
};

/** 间接执行：命令本身不体现要跑什么 */
const INDIRECT_BINS = new Set(["eval", "xargs", "source", "."]);

/**
 * 把命令行按顶层运算符拆成简单片段（引号内的运算符不拆）。
 * `piped` 标记该片段是否由管道喂入——`curl … | sh` 这类写法必须单独拦。
 */
function splitSegments(command: string): { text: string; piped: boolean }[] {
  const out: { text: string; piped: boolean }[] = [];
  let cur = "";
  let piped = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&") {
      out.push({ text: cur, piped });
      cur = "";
      piped = ch === "|";
      // 跳过成对的 && / || / >>
      const next = command[i + 1];
      if ((ch === "&" || ch === "|") && next === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push({ text: cur, piped });
  return out
    .map((s) => ({ text: s.text.trim(), piped: s.piped }))
    .filter((s) => s.text.length > 0);
}

/** 按空白拆分参数，保留引号内内容（去掉引号本身） */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let touched = false;
  const flush = (): void => {
    if (touched || cur) out.push(cur);
    cur = "";
    touched = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      touched = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/** 是否像路径参数（而不是开关 / URL / 正则片段） */
function looksLikePath(token: string, platform: NodeJS.Platform): boolean {
  if (!token || token === "-") return false;
  // 形如 2>&1 / >&2 的重定向描述符
  if (/^\d*>&\d+$/.test(token) || /^&\d+$/.test(token)) return false;
  // 去重定向前缀：`2>/tmp/x`、`>>out.log`、`&>err.log`
  const stripped = token.replace(/^(?:&|\d)*>>?/, "");
  if (stripped !== token) return looksLikePath(stripped, platform);
  if (token.includes("://")) return false;
  if (platform === "win32" && /^[A-Za-z]:[\\/]/.test(token)) return true;
  if (token.startsWith("~")) return true;
  if (/^\.\.?([\\/]|$)/.test(token)) return true;
  if (token.startsWith("/") && !token.startsWith("//")) return true;
  // --out=/tmp/x 这类带值的开关：只检查等号后的值
  if (/^--?[^=]+=/.test(token)) {
    const value = token.slice(token.indexOf("=") + 1);
    return looksLikePath(value, platform);
  }
  if (/^-/.test(token)) return false;
  if (token.includes("/")) return true;
  if (platform === "win32" && token.includes("\\")) return true;
  return false;
}

/** 允许访问的字符设备 / 黑洞文件：出现在任何命令里都不算越界 */
const SAFE_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** 是否为环境变量赋值前缀（FOO=bar cmd） */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * 判定一条命令是否只在工作区内操作。
 *
 * 阻断条件（任一命中即不自动放行）：
 * - 含命令替换 `$(...)` / 反引号；
 * - 解释器内联代码（node -e、python -c、bash -c…）；
 * - 间接执行（eval / xargs / source / find -exec）；
 * - 系统级命令（sudo、systemctl、reg…）；
 * - 任一参数解析到工作区之外。
 */
export function assessCommand(
  command: string,
  opts: AssessOptions,
): ConfinementResult {
  const platform = opts.platform ?? process.platform;
  const root = path.resolve(opts.workspaceRoot);
  const raw = String(command ?? "");
  if (!raw.trim()) return { confined: false, reason: "空命令" };

  if (raw.includes("`") || raw.includes("$(")) {
    return { confined: false, reason: "含命令替换，无法静态判定" };
  }

  const base = opts.cwd && isWithinRoot(root, opts.cwd) ? path.resolve(opts.cwd) : root;
  if (opts.cwd && base !== path.resolve(opts.cwd)) {
    return { confined: false, reason: "当前目录不在工作区内" };
  }

  for (const segment of splitSegments(raw)) {
    const tokens = tokenize(segment.text);
    if (tokens.length === 0) continue;

    // 跳过 FOO=bar 前缀，取真正的命令名
    let i = 0;
    while (i < tokens.length && isEnvAssignment(tokens[i]!)) i++;
    const binToken = tokens[i];
    if (!binToken) continue;

    const bin = path.basename(binToken.replace(/\\/g, "/")).toLowerCase();
    // Windows 的 .exe/.cmd 后缀同样按裸命令名比较
    const binName = bin.replace(/\.(exe|cmd|bat|com)$/, "");

    if (DENY_BINS.has(binName)) {
      return { confined: false, reason: `系统级命令不允许自动放行: ${binName}` };
    }
    if (INDIRECT_BINS.has(binName)) {
      return { confined: false, reason: `间接执行不允许自动放行: ${binName}` };
    }

    const inlineFlags = INLINE_CODE_FLAGS[binName] ?? [];
    // `curl … | sh`：管道内容无法静态判定，一律不自动放行
    if (segment.piped && inlineFlags.length > 0) {
      return {
        confined: false,
        reason: `管道输入到解释器不允许自动放行: ${binName}`,
      };
    }
    if (inlineFlags.length > 0) {
      const bad = tokens
        .slice(i + 1)
        .find((t) => inlineFlags.includes(t.toLowerCase()));
      if (bad) {
        return {
          confined: false,
          reason: `内联代码不允许自动放行: ${binName} ${bad}`,
        };
      }
    }
    if (binName === "find" && tokens.some((t) => /^-(exec|execdir|ok|okdir)$/i.test(t))) {
      return { confined: false, reason: "find -exec 不允许自动放行" };
    }

    for (let j = i; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (!looksLikePath(token, platform)) continue;

      // ~ 是 HOME，不是工作区里的一个目录
      const expanded =
        token === "~"
          ? os.homedir()
          : token.startsWith("~/") || token.startsWith("~\\")
            ? path.join(os.homedir(), token.slice(2))
            : token;
      const target = path.resolve(base, expanded);
      if (SAFE_DEVICES.has(target) || SAFE_DEVICES.has(token)) continue;
      if (!isWithinRoot(root, target)) {
        return { confined: false, reason: `路径越界: ${token}` };
      }
    }
  }

  return { confined: true, reason: "所有路径均在工作区内" };
}
