/**
 * 启动横幅（banner.ts）单元测试
 *
 * 覆盖：块状字标拼装、渐变 ANSI 着色（真彩/256 色）、无颜色与 ASCII 回退。
 * 测试环境为管道（非 TTY），因此显式传入 level/unicode 控制行为。
 */
import { describe, it, expect } from "vitest";
import {
  BRAND_TEXT,
  renderBanner,
  renderBrandArt,
  colorizeBrandArt,
} from "../src/cli/banner.js";

describe("renderBrandArt", () => {
  it("按字形拼出 6 行块状字标", () => {
    const art = renderBrandArt(BRAND_TEXT);
    expect(art.split("\n")).toHaveLength(6);
    expect(art).toContain("███████╗");
    expect(art).toContain("╚═╝");
  });

  it("宽度适配 80 列终端", () => {
    const width = Math.max(
      ...renderBrandArt(BRAND_TEXT).split("\n").map((l) => l.length),
    );
    expect(width).toBeLessThanOrEqual(79);
  });
});

describe("colorizeBrandArt", () => {
  const art = renderBrandArt(BRAND_TEXT);

  it("level=0 不输出 ANSI 转义", () => {
    expect(colorizeBrandArt(art, 0)).toBe(art);
    expect(colorizeBrandArt(art, 0)).not.toContain("\x1b[");
  });

  it("level=3 使用真彩色码", () => {
    const out = colorizeBrandArt(art, 3);
    expect(out).toContain("\x1b[38;2;");
    expect(out).toContain("\x1b[39m");
    // 空白不着色，避免多余转义
    expect(out.split("\n")).toHaveLength(6);
  });

  it("level=2 使用 256 色码", () => {
    expect(colorizeBrandArt(art, 2)).toContain("\x1b[38;5;");
  });

  it("剥离颜色后与原始字标一致", () => {
    const stripped = colorizeBrandArt(art, 3).replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe(art);
  });
});

describe("renderBanner", () => {
  it("无颜色时输出块状字标且无 ANSI", () => {
    const out = renderBanner({ level: 0 });
    expect(out).toContain("███████╗");
    expect(out).not.toContain("\x1b[");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("保留品牌名原始大小写（冒烟测试依赖输出含 ZQAgent）", () => {
    // scripts/smoke_cli_binary.mjs 以输出是否包含 "ZQAgent" 判定启动成功
    expect(renderBanner({ level: 0 })).toContain("ZQAgent");
    expect(renderBanner({ level: 3 })).toContain("ZQAgent");
    expect(renderBanner({ unicode: false, level: 0 })).toContain("ZQAgent");
  });

  it("Unicode 不可用时退回 ASCII 方框", () => {
    const out = renderBanner({ unicode: false, level: 0 });
    expect(out).toContain("+---");
    expect(out).toContain("ZQAGENT");
    expect(out).not.toContain("█");
  });
});
