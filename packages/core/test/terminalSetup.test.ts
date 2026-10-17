/**
 * Windows 终端环境引导单测
 *
 * 覆盖：探测判定（平台 / TTY / 字形能力 / 环境变量覆盖）、wt.exe 查找，
 * 以及 agent 安装指令与手动教程的关键内容 —— 教程必须经过 emoji 降级后
 * 原样可见，因为它正是要打印给「缺字形」的那个终端看的。
 */
import { describe, it, expect } from "vitest";
import { sanitizeEmoji } from "../src/terminal.js";
import {
  TERMINAL_INSTALL_COMMANDS,
  buildTerminalInstallPrompt,
  detectTerminalSetup,
  hasWindowsTerminal,
  renderTerminalTutorial,
} from "../src/cli/terminalSetup.js";

describe("detectTerminalSetup", () => {
  it("Windows 传统控制台（TTY 且缺字形）需要引导", () => {
    const advice = detectTerminalSetup({
      env: {},
      platform: "win32",
      isTTY: true,
      unicodeSupported: false,
      fileExists: () => false,
    });
    expect(advice.needed).toBe(true);
    expect(advice.windowsTerminalInstalled).toBe(false);
  });

  it("已装 Windows Terminal（支持字形）时不引导", () => {
    const advice = detectTerminalSetup({
      env: { WT_SESSION: "abc" },
      platform: "win32",
      isTTY: true,
      unicodeSupported: true,
      fileExists: () => false,
    });
    expect(advice.needed).toBe(false);
  });

  it("非 Windows / 重定向（非 TTY）都不引导", () => {
    for (const input of [
      { platform: "darwin" as NodeJS.Platform, isTTY: true },
      { platform: "linux" as NodeJS.Platform, isTTY: true },
      { platform: "win32" as NodeJS.Platform, isTTY: false },
    ]) {
      const advice = detectTerminalSetup({
        env: {},
        unicodeSupported: false,
        fileExists: () => false,
        ...input,
      });
      expect(advice.needed).toBe(false);
    }
  });

  it("ZQAGENT_TERM_SETUP 可关闭，也可强制开启（便于预览）", () => {
    expect(
      detectTerminalSetup({
        env: { ZQAGENT_TERM_SETUP: "0" },
        platform: "win32",
        isTTY: true,
        unicodeSupported: false,
        fileExists: () => false,
      }).needed,
    ).toBe(false);

    expect(
      detectTerminalSetup({
        env: { ZQAGENT_TERM_SETUP: "1" },
        platform: "darwin",
        isTTY: false,
        unicodeSupported: true,
        fileExists: () => false,
      }).needed,
    ).toBe(true);
  });
});

describe("hasWindowsTerminal", () => {
  it("按 PATH 查找 wt.exe", () => {
    const env = { PATH: ["/a", "/b"].join(":") };
    expect(hasWindowsTerminal(env, (p) => p === "/b/wt.exe")).toBe(true);
    expect(hasWindowsTerminal(env, () => false)).toBe(false);
  });

  it("额外回退到 %LOCALAPPDATA%\\Microsoft\\WindowsApps", () => {
    const wt = "/home/u/AppData/Local/Microsoft/WindowsApps/wt.exe";
    expect(
      hasWindowsTerminal(
        { PATH: "/a", LOCALAPPDATA: "/home/u/AppData/Local" },
        (p) => p === wt,
      ),
    ).toBe(true);
  });
});

describe("安装指引", () => {
  it("agent 指令与手动教程都带上 winget 安装命令", () => {
    const prompt = buildTerminalInstallPrompt();
    const tutorial = renderTerminalTutorial();
    for (const cmd of TERMINAL_INSTALL_COMMANDS) {
      expect(prompt).toContain(cmd);
      expect(tutorial).toContain(cmd);
    }
  });

  it("agent 指令限定范围：只装终端与字体、不改仓库文件", () => {
    const prompt = buildTerminalInstallPrompt();
    expect(prompt).toContain("不要改动当前仓库的任何文件");
    expect(prompt).toContain("winget --version");
  });

  it("教程经 emoji 降级后原样可见（不含 emoji / astral 字形）", () => {
    const tutorial = renderTerminalTutorial();
    expect(sanitizeEmoji(tutorial, false)).toBe(tutorial);
    expect(/[\u{10000}-\u{10FFFF}]/u.test(tutorial)).toBe(false);
  });
});
