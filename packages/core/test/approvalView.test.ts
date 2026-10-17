/**
 * 审批表格统一格式单测
 *
 * 覆盖：字段行序（工具 → 原因 → 参数）、换行折叠、竖线转义、超长截断、
 * 以及各通道共用的 Markdown / HTML 渲染结果。
 */
import { describe, it, expect } from "vitest";
import {
  approvalFields,
  approvalInputFromData,
  approvalToHtmlTable,
  approvalToMarkdownTable,
  APPROVAL_VALUE_MAX,
} from "../src/engine/approvalView.js";

describe("approvalFields", () => {
  it("行序固定为 工具 → 原因 → 每个参数", () => {
    const fields = approvalFields({
      toolName: "run_shell",
      reason: "命令可能修改工作区",
      arguments: { command: "npm test", timeout: 60000 },
    });
    expect(fields.map((f) => f.label)).toEqual([
      "🔧 工具",
      "💬 原因",
      "command",
      "timeout",
    ]);
    expect(fields[3].value).toBe("60000");
  });

  it("对象参数 JSON 化、换行折叠为 ↵", () => {
    const fields = approvalFields({
      toolName: "write_file",
      reason: "写入文件",
      arguments: { path: "a.txt", content: "line1\nline2" },
    });
    expect(fields.find((f) => f.label === "content")?.value).toBe("line1↵line2");
    const nested = approvalFields({
      toolName: "t",
      reason: "r",
      arguments: { opts: { a: 1 } },
    });
    expect(nested.find((f) => f.label === "opts")?.value).toBe('{"a":1}');
  });

  it("超长值截断加 …", () => {
    const long = "x".repeat(APPROVAL_VALUE_MAX + 50);
    const fields = approvalFields({ toolName: "t", reason: long });
    const reason = fields.find((f) => f.label === "💬 原因")!.value;
    expect(reason.length).toBe(APPROVAL_VALUE_MAX + 1);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("approvalToMarkdownTable", () => {
  it("输出两列表格并转义竖线", () => {
    const table = approvalToMarkdownTable({
      toolName: "run_shell",
      reason: "a|b",
      arguments: { command: "echo 1" },
    });
    const lines = table.split("\n");
    expect(lines[0]).toBe("| 项目 | 详情 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| 🔧 工具 | run_shell |");
    expect(lines[3]).toBe("| 💬 原因 | a\\|b |");
    expect(lines).toHaveLength(5);
  });

  it("支持标题并可从事件负载构造", () => {
    const input = approvalInputFromData({
      toolName: "write_file",
      reason: "写入",
      arguments: { path: "x" },
    });
    expect(approvalToMarkdownTable(input, { title: "🔒 需要审批" })).toContain(
      "🔒 需要审批\n\n| 项目 | 详情 |",
    );
    expect(input.arguments).toEqual({ path: "x" });
  });

  it("arguments 缺失或非对象时只输出工具 / 原因", () => {
    for (const args of [undefined, null, "not-an-object"]) {
      const input = approvalInputFromData({ toolName: "t", reason: "r", arguments: args });
      expect(approvalToMarkdownTable(input).split("\n")).toHaveLength(4);
    }
  });
});

describe("approvalToHtmlTable", () => {
  it("渲染为 HTML 表格并转义尖括号", () => {
    const html = approvalToHtmlTable({
      toolName: "run_shell",
      reason: "<b>粗体</b>",
      arguments: { command: "echo <1>" },
    });
    expect(html.startsWith("<table")).toBe(true);
    expect(html).toContain("🔧 工具");
    expect(html).toContain("&lt;b&gt;粗体&lt;/b&gt;");
    expect(html).toContain("echo &lt;1&gt;");
  });
});
