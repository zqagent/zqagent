/**
 * 顶栏科技纹样（`.topbar` / `.appbar` 的 ::before）
 *
 * 需求：顶栏装饰不限定波浪线，只要显得有科技感即可。
 * 实现：点阵网格 + 电路走线（45° 折角）+ 节点方块，并让它缓慢横向流动。
 *
 * 这里锁住三条容易回归的约束：
 *   1. 竖线不能贴 tile 边界——贴边会被裁成半截，接缝处线宽比内部细一半；
 *   2. tile 内首尾留白相等（12 / 240-228），平铺后间距才均匀；
 *   3. 动画位移必须正好一个 tile 宽 + 降低动态效果偏好下要停掉。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const CSS = path.join(ROOT, "packages/portal/src/styles.css");
const APPBAR_CSS = path.join(ROOT, "packages/portal/src/styles-appbar.css");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** 取出某个主题里 --topbar-tech 的 SVG 源码（解码后） */
function techSvg(theme: "light" | "dark"): string {
  const css = read(CSS);
  // 变量出现两次：先亮色后深色；深色块从 `.dark {` 开始
  const darkAt = css.indexOf(".dark {");
  const scope = theme === "light" ? css.slice(0, darkAt) : css.slice(darkAt);
  const m = scope.match(/--topbar-tech:\s*url\("data:image\/svg\+xml,([^"]+)"\)/);
  expect(m, `${theme} 主题缺少 --topbar-tech`).not.toBeNull();
  return decodeURIComponent(m![1]);
}

/** 取某个主题里某个 CSS 变量的值（主题块以 `.dark {` 分界） */
function themeVar(theme: "light" | "dark", name: string): string {
  const css = read(CSS);
  const darkAt = css.indexOf(".dark {");
  const scope = theme === "light" ? css.slice(0, darkAt) : css.slice(darkAt);
  const m = scope.match(new RegExp(`--${name}:\\s*([\\s\\S]*?);`));
  expect(m, `${theme} 主题缺少 --${name}`).not.toBeNull();
  return m![1]!.trim();
}

/**
 * 解析 linear-gradient 里各色标的 alpha（rgb(...) 视为不透明）。
 * 位置可能是百分比，也可能是无单位长度（如顶部高光的 `rgba(...) 0`）。
 */
function stopAlphas(gradient: string): number[] {
  return [...gradient.matchAll(/(rgba?\([^)]*\))\s*[\d.]+%?/g)].map((m) => {
    const rgba = m[1]!.match(/rgba\(([^)]*)\)/);
    if (!rgba) return 1;
    const parts = rgba[1]!.split(",").map((s) => s.trim());
    return parts.length === 4 ? Number(parts[3]) : 1;
  });
}

describe("顶栏背景：左侧高透明 → 右侧不透明", () => {
  it("亮色与深色都是水平渐变，alpha 从左到右单调递增到 1", () => {
    for (const theme of ["light", "dark"] as const) {
      const bg = themeVar(theme, "topbar-bg");
      expect(bg, theme).toMatch(/^linear-gradient\(\s*90deg/);
      const alphas = stopAlphas(bg);
      expect(alphas.length, `${theme} 色标不足`).toBeGreaterThanOrEqual(3);
      // 单调不减
      for (let i = 1; i < alphas.length; i++) {
        expect(alphas[i]!, `${theme} 第 ${i} 个色标透明度不应下降`).toBeGreaterThanOrEqual(
          alphas[i - 1]!,
        );
      }
      // 左端很透、右端完全不透明，中间有明显跨度
      expect(alphas[0]!, theme).toBeLessThan(0.15);
      expect(alphas[alphas.length - 1]!, theme).toBe(1);
      expect(alphas[alphas.length - 1]! - alphas[0]!, theme).toBeGreaterThan(0.8);
    }
  });

  it("右侧比左侧更深（不只是更不透明）", () => {
    for (const theme of ["light", "dark"] as const) {
      const bg = themeVar(theme, "topbar-bg");
      const rgb = [...bg.matchAll(/rgba?\(([^)]*)\)/g)].map((m) =>
        m[1]!.split(",").slice(0, 3).map((s) => Number(s.trim())),
      );
      const first = rgb[0]!;
      const last = rgb[rgb.length - 1]!;
      const sum = (c: number[]) => c[0]! + c[1]! + c[2]!;
      // 亮色：右侧更深 = 三通道和更小；深色主题同理（数值更暗）
      expect(sum(last), `${theme} 右端应比左端深`).toBeLessThan(sum(first));
    }
  });

  it("顶部加了一层高光，且顶栏/移动顶栏都用「高光 + 渐变」两层背景", () => {
    for (const theme of ["light", "dark"] as const) {
      const glow = themeVar(theme, "topbar-top-glow");
      // 从上到下淡出
      expect(glow, theme).toMatch(/^linear-gradient\(\s*180deg/);
      const alphas = stopAlphas(glow);
      expect(alphas[0], `${theme} 顶部高光起点应有可见亮度`).toBeGreaterThan(0);
      expect(alphas[alphas.length - 1], `${theme} 高光应淡出到 0`).toBe(0);
    }

    for (const [name, css, selector] of [
      [".topbar", read(CSS), ".topbar {\n"],
      [".appbar", read(APPBAR_CSS), ".appbar {\n"],
    ] as const) {
      const at = css.indexOf(selector);
      expect(at, `${name} 规则缺失`).toBeGreaterThan(-1);
      const block = css.slice(at, css.indexOf("}", at));
      expect(block, `${name} 应同时使用顶部高光与方向渐变`).toContain(
        "var(--topbar-top-glow), var(--topbar-bg)",
      );
    }
  });
});

describe("顶栏按钮 hover 更明显", () => {
  it("定义了 hover 的底色 / 描边 / 投影三个变量", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const v of ["topbar-hover-bg", "topbar-hover-ring", "topbar-hover-shadow"]) {
        expect(themeVar(theme, v), `${theme} 缺少 --${v}`).toBeTruthy();
      }
    }
  });

  it("覆盖了桌面导航、账户、设置、返回、图标按钮与移动顶栏按钮", () => {
    const css = read(CSS);
    // 规则分两组（无上浮 / 有上浮），这里取整段一起校验覆盖范围
    const start = css.indexOf("顶栏内可点元素 hover");
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf("translateY(-1px);", start);
    expect(end).toBeGreaterThan(start);
    const block = css.slice(start, end);
    for (const sel of [
      ".topbar .nav a:hover",
      ".topbar .cq-topbar-context button.cq-node-name:hover",
      ".topbar .cq-topbar-context .cq-select2-trigger:hover",
      ".topbar .cq-topbar-context .cq-icon-btn:hover",
      ".topbar .cq-topbar-context .cq-project-current:hover",
      ".topbar .topbar-back:hover",
      ".topbar .account-trigger:hover",
      ".topbar .pref-btn:hover",
      ".appbar .appbar-btn:hover",
    ]) {
      expect(block, `缺少 ${sel}`).toContain(sel);
    }
    expect(block).toContain("var(--topbar-hover-bg)");
    expect(block).toContain("var(--topbar-hover-ring)");
  });

  it("节点按钮与相邻的项目按钮在同一组规则里（效果必然一致）", () => {
    const css = read(CSS);
    // 定位第一条 hover 规则的选择器列表（到 `{` 为止）
    const at = css.indexOf(".topbar .nav a:hover,");
    expect(at).toBeGreaterThan(-1);
    const selectorList = css.slice(at, css.indexOf("{", at));
    // 同组 → 声明完全相同，不会一紫一灰
    expect(selectorList).toContain(".topbar .cq-topbar-context button.cq-node-name:hover");
    expect(selectorList).toContain(".topbar .cq-topbar-context .cq-project-current:hover");
    // 也不该被 console-ui 的 .cq-node-name:hover 旧样式（面板色 + 强调色文字）带偏
    expect(css).not.toMatch(/\.cq-node-name:hover\s*\{[^}]*cq-accent/);
  });

  it("带 fixed 弹层的触发器不加 transform（否则下拉会错位）", () => {
    const css = read(CSS);
    // 第二组（带上浮）的规则块
    const start = css.indexOf(".topbar .topbar-back:hover,");
    expect(start).toBeGreaterThan(-1);
    const withLift = css.slice(start, css.indexOf("}", start));
    expect(withLift).toContain("translateY(-1px)");
    // 这些元素只在第一组（无 transform）里出现
    for (const sel of ["cq-select2-trigger:hover", "cq-icon-btn:hover", "cq-project-current:hover"]) {
      expect(withLift, `${sel} 不应有上浮`).not.toContain(sel);
    }
  });
});

describe("顶栏科技纹样", () => {
  it("亮色与深色各有一套，且色调不同", () => {
    const light = techSvg("light");
    const dark = techSvg("dark");
    expect(light).toContain("<svg");
    expect(dark).toContain("<svg");
    // 亮色用靛蓝，深色用更亮的淡紫，夜里不至于一条条发黑
    expect(light.toLowerCase()).toContain("#6366f1");
    expect(dark.toLowerCase()).toContain("#a5b4fc");
    expect(light).not.toBe(dark);
  });

  it("tile 尺寸固定 240×48（决定动画周期与平铺接缝）", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = techSvg(theme);
      expect(svg, theme).toContain(`width='240'`);
      expect(svg, theme).toContain(`height='48'`);
    }
  });

  it("竖线不贴边界，且 tile 内首尾留白相等", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = techSvg(theme);
      const vertical = svg.match(/d='(M\d+,0V48(?:M\d+,0V48)*)'/);
      expect(vertical, theme).not.toBeNull();
      const xs = [...vertical![1].matchAll(/M(\d+),0V48/g)].map((m) => Number(m[1]));
      expect(xs.length).toBeGreaterThan(1);

      // 不贴边：否则平铺时被裁半，接缝处线比内部细
      expect(xs, theme).not.toContain(0);
      expect(xs, theme).not.toContain(240);

      // 等距
      const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
      expect(new Set(gaps).size, `${theme} 竖线间距应一致: ${gaps}`).toBe(1);

      // 首尾留白相等 → 跨 tile 的间距与内部一致
      const gap = gaps[0]!;
      expect(xs[0], theme).toBe(gap / 2);
      expect(240 - xs[xs.length - 1]!, theme).toBe(gap / 2);
    }
  });

  it("含有科技感元素：电路折线（45°）与节点方块", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = techSvg(theme);
      // 45° 折角：水平段后接等量的 l<x>,<x>
      expect(svg, theme).toMatch(/h\d+l(\d+),\1/);
      expect(svg, theme).toContain("<rect");
    }
  });

  it("两套顶栏都用同一变量，且铺满宽度固定 240px", () => {
    const topbarCss = read(CSS);
    const appbarCss = read(APPBAR_CSS);
    for (const [name, css] of [
      [".topbar", topbarCss],
      [".appbar", appbarCss],
    ] as const) {
      const block = css.match(
        new RegExp(`\\${name}::before \\{[^}]*\\}`),
      )?.[0];
      expect(block, `${name}::before 缺失`).toBeTruthy();
      expect(block!).toContain("var(--topbar-tech)");
      // 宽度必须固定，否则纵向拉伸会让 tile 实际宽度 ≠ 240，动画循环处会跳
      expect(block!).toMatch(/background-size:\s*240px 100%/);
      expect(block!).toContain("topbar-tech-drift");
    }
  });

  it("动画位移正好一个 tile，并在降低动态效果偏好下停用", () => {
    const css = read(CSS);
    const keyframes = css.match(/@keyframes topbar-tech-drift \{[^}]*\}[^}]*\}[^}]*\}/)?.[0];
    expect(keyframes).toBeTruthy();
    expect(keyframes!).toMatch(/to\s*\{[^}]*background-position:\s*240px/);
    // 减少动态偏好：保留静态纹样，只停流动
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none/);
  });
});
