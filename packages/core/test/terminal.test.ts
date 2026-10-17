/**
 * 终端兼容层（src/terminal.ts）单元测试
 *
 * 覆盖：终端能力探测的各分支、emoji → ASCII 降级映射、降级结果必须是纯 ASCII，
 * 以及中英文与 emoji 混排时的处理。
 */
import { describe, it, expect } from "vitest";
import {
  detectEmojiSupport,
  sanitizeEmoji,
  EMOJI_SUPPORTED,
  sym,
} from "../src/terminal.js";

describe("detectEmojiSupport", () => {
  it("非 Windows 一律支持", () => {
    expect(detectEmojiSupport({ platform: "darwin", env: {}, isTTY: true })).toBe(true);
    expect(detectEmojiSupport({ platform: "linux", env: {}, isTTY: true })).toBe(true);
  });

  it("Windows 传统控制台（无 WT_SESSION）降级", () => {
    expect(detectEmojiSupport({ platform: "win32", env: {}, isTTY: true })).toBe(false);
  });

  it("Windows Terminal（WT_SESSION）支持", () => {
    expect(
      detectEmojiSupport({ platform: "win32", env: { WT_SESSION: "abc" }, isTTY: true }),
    ).toBe(true);
  });

  it("VS Code 终端（TERM_PROGRAM=vscode）支持", () => {
    expect(
      detectEmojiSupport({
        platform: "win32",
        env: { TERM_PROGRAM: "vscode" },
        isTTY: true,
      }),
    ).toBe(true);
  });

  it("ConEmu（ConEmuANSI=ON）支持", () => {
    expect(
      detectEmojiSupport({
        platform: "win32",
        env: { ConEmuANSI: "ON" },
        isTTY: true,
      }),
    ).toBe(true);
  });

  it("Windows 非 TTY（重定向/管道）保持原样", () => {
    expect(detectEmojiSupport({ platform: "win32", env: {}, isTTY: false })).toBe(true);
  });

  it("ZQAGENT_EMOJI=1 强制开启（覆盖传统控制台判定）", () => {
    expect(
      detectEmojiSupport({ platform: "win32", env: { ZQAGENT_EMOJI: "1" }, isTTY: true }),
    ).toBe(true);
  });

  it("ZQAGENT_EMOJI=0 / ZQAGENT_ASCII=1 强制降级", () => {
    expect(
      detectEmojiSupport({ platform: "darwin", env: { ZQAGENT_EMOJI: "0" }, isTTY: true }),
    ).toBe(false);
    expect(
      detectEmojiSupport({ platform: "darwin", env: { ZQAGENT_ASCII: "1" }, isTTY: true }),
    ).toBe(false);
    expect(
      detectEmojiSupport({ platform: "darwin", env: { NO_EMOJI: "1" }, isTTY: true }),
    ).toBe(false);
  });
});

describe("sanitizeEmoji", () => {
  it("支持时原样返回", () => {
    expect(sanitizeEmoji("✅ 完成", true)).toBe("✅ 完成");
  });

  it("降级时映射为 ASCII 标记", () => {
    expect(sanitizeEmoji("✅ 完成", false)).toBe("[OK] 完成");
    expect(sanitizeEmoji("❌ 失败", false)).toBe("[x] 失败");
    expect(sanitizeEmoji("⚠️  警告", false)).toBe("[!]  警告");
    expect(sanitizeEmoji("ℹ️  提示", false)).toBe("[i]  提示");
    expect(sanitizeEmoji("📋 列表", false)).toBe("[i] 列表");
    expect(sanitizeEmoji("📄 a.txt", false)).toBe("[file] a.txt");
    expect(sanitizeEmoji("⤴ 已记录", false)).toBe("-> 已记录");
  });

  it("兼容带/不带变体选择符的 ⚠", () => {
    expect(sanitizeEmoji("⚠ 裸警告", false)).toBe("[!] 裸警告");
    expect(sanitizeEmoji("⚠️ 变体警告", false)).toBe("[!] 变体警告");
  });

  it("中英文与 emoji 混排时只替换 emoji", () => {
    expect(sanitizeEmoji("正在处理 ✅ 中文 English ❌", false)).toBe(
      "正在处理 [OK] 中文 English [x]",
    );
  });

  it("降级结果不含任何非 ASCII 字符", () => {
    const sample = "✅❌⚠️ℹ️📋📄📁💾📡🧰🔒🚫📦💡⤴⚙⏹🔄✗";
    const out = sanitizeEmoji(sample, false);
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/^[\x00-\x7F]*$/);
    expect(out).not.toMatch(/[✅❌⚠ℹ📋📄📁💾📡🧰🔒🚫📦💡⤴⚙⏹🔄✗]/);
  });
});

describe("sym", () => {
  it("按终端能力返回 emoji 或 ASCII", () => {
    if (EMOJI_SUPPORTED) {
      expect(sym.ok).toBe("✅");
      expect(sym.fail).toBe("❌");
    } else {
      expect(sym.ok).toBe("[OK]");
      expect(sym.fail).toBe("[x]");
    }
  });
});
