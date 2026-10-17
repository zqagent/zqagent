/**
 * MarkdownRenderer 单元测试
 *
 * 覆盖：回退模式（无颜色/无 Unicode 时保留结构）、正常模式（ANSI 彩色）、
 * 灰阶模式（保留排版、颜色统一灰色）、块级流式（代码块/表格跨 chunk 缓冲）、emoji 转换。
 *
 * 测试环境为管道（非 TTY），因此显式传入 opts 控制 color/unicode。
 */
import { describe, it, expect } from "vitest";
import { MarkdownRenderer } from "../src/engine/MarkdownRenderer.js";

/** 把多个流式 chunk 喂给渲染器并返回完整输出 */
function render(
  chunks: string[],
  opts?: { color?: boolean; unicode?: boolean; gray?: boolean },
): string {
  const r = new MarkdownRenderer(opts);
  let out = "";
  for (const c of chunks) out += r.push(c);
  out += r.flush();
  return out;
}

const PLAIN = { color: false, unicode: false };

describe("MarkdownRenderer 回退模式（无颜色，保留结构）", () => {
  it("加粗/斜体/行内代码/删除线保留符号", () => {
    const out = render(["这是 **加粗** *斜体* `代码` ~~删除~~\n"], PLAIN);
    expect(out).toContain("**加粗**");
    expect(out).toContain("*斜体*");
    expect(out).toContain("`代码`");
    expect(out).toContain("~~删除~~");
  });

  it("链接显示为 文字 (url)", () => {
    const out = render(["[官网](https://x.com)\n"], PLAIN);
    expect(out).toContain("官网 (https://x.com)");
  });

  it("标题保留 # 前缀", () => {
    const out = render(["# 标题\n", "## 二级\n"], PLAIN);
    expect(out).toContain("# 标题");
    expect(out).toContain("## 二级");
  });

  it("列表保留符号与嵌套缩进", () => {
    const out = render(["- A\n- B\n  - C\n", "1. 一\n2. 二\n"], PLAIN);
    expect(out).toContain("- A");
    expect(out).toContain("  - C");
    expect(out).toContain("1. 一");
    expect(out).toContain("2. 二");
  });

  it("引用保留 > 前缀", () => {
    const out = render(["> 引用\n"], PLAIN);
    expect(out).toContain("> 引用");
  });

  it("表格用 ASCII 边框并对齐", () => {
    const out = render(["| 名称 | 数量 |\n", "|---|---|\n", "| 苹果 | 3 |\n"], PLAIN);
    expect(out).toContain("+"); // ASCII 边框
    expect(out).toContain("名称");
    expect(out).toContain("苹果");
    expect(out).not.toContain("┌"); // 不用 Unicode 边框
  });

  it("代码块保留围栏", () => {
    const out = render(["```python\ndef f():\n    pass\n```\n"], PLAIN);
    expect(out).toContain("```python");
    expect(out).toContain("def f():");
  });

  it("emoji 保留短代码", () => {
    const out = render(["hello :smile:\n"], PLAIN);
    expect(out).toContain(":smile:");
  });
});

describe("MarkdownRenderer 正常模式（ANSI 彩色）", () => {
  const COLOR = { color: true, unicode: true };

  it("加粗输出 ANSI bold 码", () => {
    const out = render(["**加粗**\n"], COLOR);
    expect(out).toContain("\x1b[1m加粗\x1b[22m");
  });

  it("行内代码输出 cyan 码", () => {
    const out = render(["`代码`\n"], COLOR);
    expect(out).toContain("\x1b[36m代码\x1b[39m");
  });

  it("链接输出蓝色下划线 + url", () => {
    const out = render(["[官网](https://x.com)\n"], COLOR);
    expect(out).toContain("\x1b[4m\x1b[34m官网");
    expect(out).toContain("(https://x.com)");
  });

  it("emoji 转换为 Unicode", () => {
    const out = render([":smile:\n"], COLOR);
    expect(out).toContain("😄");
  });

  it("表格用 Unicode 边框", () => {
    const out = render(["| a | b |\n|---|---|\n| 1 | 2 |\n"], COLOR);
    expect(out).toContain("┌");
  });
});

describe("MarkdownRenderer 块级流式", () => {
  it("代码块跨 chunk 缓冲后完整渲染", () => {
    const out = render(
      ["```py\n", "def f():\n", "    pass\n", "```\n"],
      PLAIN,
    );
    expect(out).toContain("```py");
    expect(out).toContain("def f():");
    expect(out).toContain("```");
  });

  it("表格跨 chunk 缓冲后完整渲染", () => {
    const out = render(
      ["| a | b |\n", "|---|---|\n", "| 1 | 2 |\n"],
      PLAIN,
    );
    expect(out).toContain("+");
    expect(out).toContain("1");
  });

  it("普通段落需空行结束（否则由 flush 兜底）", () => {
    const r = new MarkdownRenderer(PLAIN);
    // 无空行：push 不立即输出
    expect(r.push("这是一段话\n")).toBe("");
    // 空行结束段落
    const out = r.push("\n") + r.flush();
    expect(out).toContain("这是一段话");
  });

  it("reset 后状态干净可复用", () => {
    const r = new MarkdownRenderer(PLAIN);
    r.push("```py\n");
    r.flush();
    const out = r.push("普通\n") + r.flush();
    expect(out).toContain("普通");
    expect(out).not.toContain("```");
  });
});

describe("MarkdownRenderer 灰阶模式（保留排版，颜色统一灰色）", () => {
  const GRAY = { color: true, unicode: true, gray: true };

  it("列表保留符号，但项目符号为灰色而非青色", () => {
    const out = render(["- A\n- B\n\n"], GRAY);
    expect(out).toContain("- A");
    expect(out).toContain("- B");
    expect(out).toContain("\x1b[90m"); // 灰色包裹
    expect(out).not.toContain("\x1b[36m"); // 无青色
  });

  it("表格渲染边框且除灰色外无其他颜色", () => {
    const out = render(["| 名称 | 数量 |\n|---|---|\n| 苹果 | 3 |\n\n"], GRAY);
    expect(out).toContain("┌"); // Unicode 边框仍在
    expect(out).toContain("名称");
    expect(out).toContain("苹果");
    expect(out.startsWith("\x1b[90m")).toBe(true);
    expect(out.endsWith("\x1b[39m")).toBe(true);
    // 剥掉灰色包裹后不应残留任何 ANSI 码
    const inner = out.slice("\x1b[90m".length, -"\x1b[39m".length);
    expect(inner).not.toContain("\x1b[");
  });

  it("行内代码与链接不加彩色", () => {
    const out = render(["`代码` 和 [官网](https://x.com)\n\n"], GRAY);
    // 去掉 ANSI 后仍是完整可读文本（仅保留下划线等样式，无颜色）
    const plain = out.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("代码");
    expect(plain).toContain("官网 (https://x.com)");
    expect(out).not.toContain("\x1b[36m"); // 无青色
    expect(out).not.toContain("\x1b[34m"); // 无蓝色
  });

  it("代码块不做语法高亮（无彩色）", () => {
    const out = render(["```python\ndef f():\n    pass\n```\n"], GRAY);
    expect(out).toContain("```python");
    expect(out).toContain("def f():");
    expect(out).not.toContain("\x1b[36m");
  });
});
