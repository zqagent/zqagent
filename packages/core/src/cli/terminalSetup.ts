/**
 * Windows 终端环境引导：传统控制台下的自助升级路径
 *
 * 背景见 terminal.ts：conhost / cmd.exe 的默认字体不含 astral 平面 emoji 与
 * Nerd Font 图标字形，也没有真彩色，CLI 只能把 emoji 与表格边框降级成 ASCII。
 * 本模块在启动时探测到这种情况后给出两条出路：
 *   1. 让 agent 用 winget 装好 Windows Terminal + Nerd Font（首选，见
 *      buildTerminalInstallPrompt）；
 *   2. agent 用不了（未配置 LLM 连接）或装不动时，回退到内置手动教程
 *      （见 renderTerminalTutorial）。
 *
 * 环境变量覆盖：
 *   ZQAGENT_TERM_SETUP=0  关闭启动引导
 *   ZQAGENT_TERM_SETUP=1  强制触发（便于在 macOS / Linux 上预览教程）
 */
import { existsSync } from "fs";
import * as path from "path";
import { UNICODE_SUPPORTED } from "../terminal.js";

/** 探测入参（便于测试注入；默认取当前进程的 process / stdout） */
export interface TerminalSetupInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  /** 终端是否支持 Unicode 字形，默认取本进程的 UNICODE_SUPPORTED */
  unicodeSupported?: boolean;
  /** 文件存在性检查，默认 fs.existsSync（测试注入用） */
  fileExists?: (filePath: string) => boolean;
}

/** 终端环境探测结果 */
export interface TerminalSetupAdvice {
  /** 是否需要引导用户升级终端环境 */
  needed: boolean;
  /** 是否已在 PATH（或 WindowsApps）上找到 Windows Terminal（wt.exe） */
  windowsTerminalInstalled: boolean;
}

/** 关闭 / 强制开启引导的环境变量名 */
export const TERM_SETUP_ENV = "ZQAGENT_TERM_SETUP";

/** 视为「关闭」的取值 */
const FALSE_FLAGS = ["0", "false", "no", "off"];
/** 视为「强制开启」的取值 */
const TRUE_FLAGS = ["1", "true", "yes", "on"];

/**
 * PATH 上是否存在 Windows Terminal（`wt.exe`）。
 *
 * winget / Microsoft Store 安装后落在 `%LOCALAPPDATA%\Microsoft\WindowsApps`
 * （默认在 PATH 上），因此安装完成后重新扫描即可判断是否装好。
 */
export function hasWindowsTerminal(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (filePath: string) => boolean = existsSync,
): boolean {
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = raw.split(path.delimiter).filter(Boolean);
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
  }
  return dirs.some((dir) => fileExists(path.join(dir, "wt.exe")));
}

/**
 * 探测是否需要引导用户升级终端环境。
 *
 * 默认只在「Windows + TTY + 终端不支持 Unicode 字形」时触发；重定向 / 管道
 * 保持安静（写的是 UTF-8 字节，交给下游渲染，见 terminal.ts）。
 */
export function detectTerminalSetup(
  input: TerminalSetupInput = {},
): TerminalSetupAdvice {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);
  const unicodeSupported = input.unicodeSupported ?? UNICODE_SUPPORTED;

  const windowsTerminalInstalled = hasWindowsTerminal(env, input.fileExists);

  const flag = (env[TERM_SETUP_ENV] ?? "").trim().toLowerCase();
  if (FALSE_FLAGS.includes(flag)) {
    return { needed: false, windowsTerminalInstalled };
  }
  if (TRUE_FLAGS.includes(flag)) {
    return { needed: true, windowsTerminalInstalled };
  }

  const needed = platform === "win32" && isTTY && !unicodeSupported;
  return { needed, windowsTerminalInstalled };
}

/** agent 与教程共用的安装命令（Windows 包管理器 winget） */
export const TERMINAL_INSTALL_COMMANDS: readonly string[] = [
  "winget install --id Microsoft.WindowsTerminal -e --accept-source-agreements --accept-package-agreements",
  "winget install --id DEVCOM.JetBrainsMonoNerdFont -e --accept-source-agreements --accept-package-agreements",
];

/**
 * 交给 agent 的安装指令。
 *
 * 刻意收窄范围（只装终端 + 字体、不改仓库文件、winget 不可用就如实失败），
 * 避免一次启动引导演变成 agent 自由发挥的软件安装。
 */
export function buildTerminalInstallPrompt(): string {
  return [
    "请改善这台 Windows 机器的命令行终端环境。当前 CLI 跑在传统控制台（conhost / cmd.exe）里，其字体不含 emoji 与 Unicode 表格边框字形，也没有真彩色，所以界面被降级成了 ASCII 标记。",
    "",
    "请用 run_shell 依次执行：",
    ...TERMINAL_INSTALL_COMMANDS.map((cmd) => `- ${cmd}`),
    "",
    "约束：",
    "1. 只做这一件事：安装 Windows Terminal 与一款 Nerd Font。不要改动当前仓库的任何文件，不要安装其他软件。",
    "2. 若 `winget --version` 不可用（系统过旧或被策略禁用）或命令报错，不要自行改用其他下载渠道，直接说明失败原因即可。",
    "3. 若上面的包在源里不存在，可用 `winget search` 找等价的 Windows Terminal / Nerd Font 包名再装，但不要装非字体类软件。",
    "4. 结束后用两三句话报告：每条命令是否成功、失败原因、以及用户接下来要做什么（关掉当前窗口，改用 Windows Terminal 重新打开）。",
  ].join("\n");
}

/**
 * 手动安装教程（纯 ASCII，因为要打印给「正好缺字形」的那个终端看）。
 */
export function renderTerminalTutorial(): string {
  return [
    "Windows 终端环境安装教程（手动）",
    "================================",
    "",
    "为什么需要：当前控制台是传统 conhost / cmd.exe，默认字体不含 emoji 与",
    "Nerd Font 图标字形，也不支持真彩色，所以 CLI 只能把 emoji 和表格边框降级",
    "成 ASCII 标记。换成 Windows Terminal + Nerd Font 即可与 Linux / macOS 一致。",
    "",
    "第 1 步：安装 Windows Terminal",
    "  方式 A（推荐，Win10 1809+ 自带 winget）：",
    `      ${TERMINAL_INSTALL_COMMANDS[0]}`,
    '  方式 B：打开「Microsoft Store」，搜索 "Windows Terminal" 安装。',
    "",
    "第 2 步：安装 Nerd Font（等宽 + 图标字形）",
    `      ${TERMINAL_INSTALL_COMMANDS[1]}`,
    "  等价字体任选其一（包名可用 winget search nerd 查）：",
    "      CaskaydiaCove Nerd Font / FiraCode Nerd Font / Hack Nerd Font",
    "  也可以到 https://www.nerdfonts.com/ 手动下载，解压后右键字体文件",
    "  -> 「为所有用户安装」。",
    "",
    "第 3 步：把 Windows Terminal 设为默认终端",
    "  打开 Windows Terminal -> 设置 -> 启动 -> 「默认终端应用程序」",
    '  -> 选择 "Windows Terminal"。此后从 cmd.exe / PowerShell 启动也会进入它。',
    "",
    "第 4 步：在 Windows Terminal 里用上 Nerd Font",
    "  设置 -> 配置文件 -> 默认值 -> 外观 -> 字体 -> 选择",
    '  "JetBrainsMono Nerd Font"（或你实际安装的那一款）。',
    "",
    "第 5 步：确认 CLI 恢复正常显示",
    "  关闭当前窗口，改用 Windows Terminal 打开后重新运行 zqagent，",
    "  emoji 与表格边框应当正常显示。",
    "",
    "常见问题",
    "  - winget 不存在：去「Microsoft Store」搜索「应用安装程序」(App Installer)",
    "    安装，或直接用上面的方式 B 从商店安装 Windows Terminal。",
    "  - 装了 Nerd Font 仍是方块：确认 Windows Terminal 里选的是 *Nerd Font*",
    "    那一款，而不是裸的 JetBrains Mono。",
    "  - 想维持现状：降级只是显示层面，功能不受影响。设 ZQAGENT_EMOJI=1 可强制",
    "    开启 emoji，设 ZQAGENT_TERM_SETUP=0 可关闭本启动提示。",
  ].join("\n");
}
