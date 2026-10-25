/** 审批视图：统一字段行、Markdown 表格与 HTML 表格。 */
import { describe, it, expect } from "vitest";
import {
  APPROVAL_COLUMNS,
  APPROVAL_VALUE_MAX,
  approvalFields,
  approvalInputFromData,
  approvalToHtmlTable,
  approvalToMarkdownTable,
} from "../src/approval-view.js";

const input = {
  toolName: "shell",
  reason: "需要执行命令",
  arguments: { cmd: "echo hi", path: "/tmp" },
};

describe("approvalInputFromData", () => {
  it("提取工具/原因/参数", () => {
    expect(
      approvalInputFromData({ toolName: "a", reason: "b", arguments: { x: 1 } }),
    ).toEqual({ toolName: "a", reason: "b", arguments: { x: 1 } });
  });

  it("缺失字段退化为空串，非对象参数忽略", () => {
    expect(approvalInputFromData({})).toEqual({
      toolName: "",
      reason: "",
      arguments: undefined,
    });
    expect(approvalInputFromData({ arguments: "x" }).arguments).toBeUndefined();
    expect(approvalInputFromData({ arguments: [1] }).arguments).toEqual([1]);
  });
});

describe("approvalFields", () => {
  it("固定行序：工具 → 原因 → 参数", () => {
    expect(approvalFields(input)).toEqual([
      { label: "🔧 工具", value: "shell" },
      { label: "💬 原因", value: "需要执行命令" },
      { label: "cmd", value: "echo hi" },
      { label: "path", value: "/tmp" },
    ]);
  });

  it("换行折叠为 ↵，非字符串值 JSON 化", () => {
    const f = approvalFields({
      toolName: "a\nb",
      reason: "",
      arguments: { n: 2, obj: { k: true }, nil: null },
    });
    expect(f[0]!.value).toBe("a↵b");
    expect(f[2]!.value).toBe("2");
    expect(f[3]!.value).toBe('{"k":true}');
    expect(f[4]!.value).toBe("");
  });

  it("按 maxLen 截断并追加省略号", () => {
    const f = approvalFields({ toolName: "12345", reason: "" }, 3);
    expect(f[0]!.value).toBe("123…");
    expect(APPROVAL_VALUE_MAX).toBe(120);
    expect(approvalFields(input)[0]!.value).toBe("shell");
  });
});

describe("approvalToMarkdownTable", () => {
  it("包含表头且每字段一行", () => {
    const md = approvalToMarkdownTable(input);
    const lines = md.split("\n");
    expect(lines[0]).toBe(`| ${APPROVAL_COLUMNS[0]} | ${APPROVAL_COLUMNS[1]} |`);
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines).toHaveLength(2 + 4);
  });

  it("可选标题置于表格前", () => {
    const md = approvalToMarkdownTable(input, { title: "🔒 需要审批" });
    expect(md.startsWith("🔒 需要审批\n\n| 项目 |")).toBe(true);
  });

  it("转义竖线，避免破坏列结构", () => {
    const md = approvalToMarkdownTable({
      toolName: "a|b",
      reason: "",
      arguments: {},
    });
    expect(md).toContain("a\\|b");
  });

  it("支持自定义 maxLen", () => {
    const md = approvalToMarkdownTable({ toolName: "abcdef", reason: "" }, { maxLen: 4 });
    expect(md).toContain("| abcd… |");
  });
});

describe("approvalToHtmlTable", () => {
  it("生成转义后的表格结构", () => {
    const html = approvalToHtmlTable({
      toolName: "<tag>",
      reason: "a&b",
      arguments: { k: '"' },
    });
    expect(html.startsWith("<table ")).toBe(true);
    expect(html).toContain("&lt;tag&gt;");
    expect(html).toContain("a&amp;b");
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });

  it("按 maxLen 截断", () => {
    expect(approvalToHtmlTable({ toolName: "abcdef", reason: "" }, 4)).toContain("abcd…");
  });
});
