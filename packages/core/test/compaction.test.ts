/**
 * 上下文压缩工具单元测试
 *
 * 覆盖：模型上下文窗口查找（lookupContextWindow 的精确/前缀/回退策略）、
 * 触发阈值计算（triggerTokens 的 cap 上限与自定义阈值）与压缩判定（shouldCompact）。
 */
import { describe, it, expect } from "vitest";
import {
  lookupContextWindow,
  triggerTokens,
  softTriggerTokens,
  shouldCompact,
  formatTokens,
  applyToolResultElision,
  elisionKeepChars,
  applyReadFileDedup,
  parseReadFileSpan,
  normalizeToolPath,
  applyOneShotElision,
  DEFAULT_CONTEXT_WINDOW,
} from "../src/engine/compaction.js";
import type { Message } from "../src/engine/types.js";

describe("lookupContextWindow 模型上下文窗口查找", () => {
  it("已知模型精确匹配返回对应窗口", () => {
    expect(lookupContextWindow("gpt-4o")).toBe(128_000);
    expect(lookupContextWindow("gpt-4")).toBe(8_192);
    expect(lookupContextWindow("claude-3.5-sonnet")).toBe(200_000);
    expect(lookupContextWindow("o1")).toBe(200_000);
  });

  it("匹配对大小写不敏感", () => {
    expect(lookupContextWindow("GPT-4O")).toBe(128_000);
    expect(lookupContextWindow("Claude-3.5-Sonnet")).toBe(200_000);
  });

  it("带日期快照的模型 ID 前缀匹配到基础模型", () => {
    expect(lookupContextWindow("gpt-4o-2024-08-06")).toBe(128_000);
    expect(lookupContextWindow("claude-3.5-sonnet-20241022")).toBe(200_000);
  });

  it("精确匹配优先于前缀匹配（o1-preview 不落入 o1 的 200K）", () => {
    expect(lookupContextWindow("o1-preview")).toBe(128_000);
    expect(lookupContextWindow("o1-mini")).toBe(128_000);
    expect(lookupContextWindow("o3-mini")).toBe(200_000);
  });

  it("未知模型回退到默认上下文窗口", () => {
    expect(lookupContextWindow("totally-unknown-model-9")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(lookupContextWindow("")).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("triggerTokens 触发阈值", () => {
  it("未指定窗口时按默认窗口 80% 计算", () => {
    expect(triggerTokens(undefined)).toBe(0.8 * DEFAULT_CONTEXT_WINDOW);
    expect(triggerTokens(null)).toBe(0.8 * DEFAULT_CONTEXT_WINDOW);
  });

  it("按窗口 80% 计算，缺省不设 cap 上限", () => {
    expect(triggerTokens(200_000)).toBe(160_000);
    // 大窗口模型按比例用满窗口，不再被固定 cap 截断
    expect(triggerTokens(1_000_000)).toBe(800_000);
    expect(triggerTokens(2_000_000)).toBe(1_600_000);
  });

  it("显式传入 cap 时才截断", () => {
    expect(triggerTokens(2_000_000, 0.8, 250_000)).toBe(250_000);
    expect(triggerTokens(200_000, 0.8, 300_000)).toBe(160_000);
  });

  it("支持自定义阈值比例", () => {
    expect(triggerTokens(100_000, 0.5)).toBe(50_000);
  });
});

describe("shouldCompact 压缩判定", () => {
  it("信号低于阈值时不压缩，达到或超过阈值时压缩", () => {
    const threshold = triggerTokens(128_000); // 102_400
    expect(shouldCompact(threshold - 1, 128_000)).toBe(false);
    expect(shouldCompact(threshold, 128_000)).toBe(true);
    expect(shouldCompact(threshold + 10_000, 128_000)).toBe(true);
  });
});

describe("formatTokens token 数格式化", () => {
  it("小于 1000 原样输出", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("千位用 K，整数不带小数，否则保留一位", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(102_400)).toBe("102.4K");
    expect(formatTokens(115_200)).toBe("115.2K");
  });

  it("百万位用 M", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("softTriggerTokens 软阈值", () => {
  it("默认取硬阈值的 75%（0.8 × 0.75 = 60% 窗口）", () => {
    expect(softTriggerTokens(128_000)).toBe(76_800);
    expect(softTriggerTokens(200_000)).toBe(120_000);
  });

  it("显式比例优先，且必须低于硬阈值", () => {
    expect(softTriggerTokens(100_000, 0.8, null, 0.5)).toBe(50_000);
    // 显式值高于硬阈值时被压到 hard × 0.95，避免分层失效
    expect(softTriggerTokens(100_000, 0.8, null, 0.95)).toBe(76_000);
  });

  it("capTokens 同时约束硬阈值与软阈值", () => {
    // hard = min(0.8 × 2M, 100K) = 100K → soft = 75K
    expect(softTriggerTokens(2_000_000, 0.8, 100_000)).toBe(75_000);
  });
});

describe("elisionKeepChars 淘汰保留预算", () => {
  it("按硬阈值 15% token、4 字符/token 计算", () => {
    expect(elisionKeepChars(10_000)).toBe(6_000);
  });

  it("小窗口下保留一个最小可用量", () => {
    expect(elisionKeepChars(1_000)).toBe(4_000);
  });
});

describe("applyToolResultElision 旧工具结果淘汰", () => {
  const tool = (name: string, content: string): Message => ({
    role: "tool",
    tool_call_id: `call_${name}`,
    tool_call_name: name,
    content,
  });

  it("总字符数未超预算时原样返回", () => {
    const messages = [tool("read_file", "short")];
    const res = applyToolResultElision(messages, 100);
    expect(res.messages).toBe(messages);
    expect(res.elided).toBe(0);
  });

  it("从最旧开始淘汰，最近的结果完整保留", () => {
    const messages = [
      tool("read_file", "a".repeat(100)),
      tool("read_file", "b".repeat(100)),
      tool("read_file", "c".repeat(100)),
    ];
    // 保留预算 150：最近一条 100 保留；再加第二条就 200 > 150 → 前两条淘汰
    const res = applyToolResultElision(messages, 150);

    expect(res.elided).toBe(2);
    expect(res.messages[0]!.content).toContain("old tool result elided");
    expect(res.messages[1]!.content).toContain("old tool result elided");
    expect(res.messages[2]!.content).toBe("c".repeat(100));
    // 协议字段保持完整
    expect(res.messages[0]!.tool_call_id).toBe("call_read_file");
  });

  it("explore 等豁免工具的结果永不淘汰", () => {
    const messages = [
      tool("explore", "e".repeat(500)),
      tool("read_file", "r".repeat(100) + "0"),
      tool("read_file", "r".repeat(100) + "1"),
    ];
    const res = applyToolResultElision(messages, 100);

    // 豁免项原样保留；旧的可淘汰项被替换，最新的按预算部分保留
    expect(res.messages[0]!.content).toBe("e".repeat(500));
    expect(res.messages[1]!.content).toContain("old tool result elided");
    expect(res.messages[2]!.content).toContain("truncated");
  });

  it("占位文本保留落盘路径，便于按需取回完整内容", () => {
    const content =
      "[tool output truncated: 9999 chars, full output saved to /tmp/tool-results/a.txt]\n\n" +
      "x".repeat(500);
    const res = applyToolResultElision(
      [tool("run_shell", content), tool("read_file", "y".repeat(100))],
      100,
    );

    expect(res.messages[0]!.content).toContain("/tmp/tool-results/a.txt");
  });

  it("唯一一条结果就超预算时部分保留，不整条丢弃", () => {
    const res = applyToolResultElision([tool("read_file", "z".repeat(1000))], 100);
    expect(res.messages[0]!.content.startsWith("z".repeat(100))).toBe(true);
    expect(res.messages[0]!.content).toContain("truncated");
    expect(res.elided).toBe(0);
  });
});

describe("parseReadFileSpan 读取区间解析", () => {
  it("解析正常 JSON 结果", () => {
    const content = JSON.stringify({
      path: "src/a.ts",
      start_line: 10,
      end_line: 60,
      total_lines: 500,
      content: "…",
    });
    expect(parseReadFileSpan(content)).toEqual({
      path: "src/a.ts",
      start: 10,
      end: 60,
    });
  });

  it("剥离工具结果预算添加的截断前缀", () => {
    const content =
      "[tool output truncated: 9999 chars, full output saved to /tmp/x.txt]\n\n" +
      JSON.stringify({ path: "a.ts", start_line: 1, end_line: 20, content: "" });
    expect(parseReadFileSpan(content)?.path).toBe("a.ts");
  });

  it("JSON 被头尾截断时用正则取元数据", () => {
    const content =
      '{\n  "path": "src/b.ts",\n  "start_line": 5,\n  "end_line": 99,\n' +
      '  "total_lines": 120,\n  "content": "line1\n… [5000 characters omitted] …';
    expect(parseReadFileSpan(content)).toEqual({
      path: "src/b.ts",
      start: 5,
      end: 99,
    });
  });

  it("错误结果（无路径/区间）返回 null", () => {
    expect(parseReadFileSpan(JSON.stringify({ error: "不是文件: a.ts" }))).toBeNull();
    expect(parseReadFileSpan("not json")).toBeNull();
  });
});

describe("normalizeToolPath 路径归一", () => {
  it("去掉 ./ 前缀与重复斜杠，统一分隔符", () => {
    expect(normalizeToolPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeToolPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeToolPath("src//a.ts")).toBe("src/a.ts");
    expect(normalizeToolPath("  src/a.ts  ")).toBe("src/a.ts");
  });
});

describe("applyReadFileDedup 同一路径重复读取去重", () => {
  const read = (id: string, path: string, start: number, end: number): Message => ({
    role: "tool",
    tool_call_id: id,
    tool_call_name: "read_file",
    content: JSON.stringify({
      path,
      start_line: start,
      end_line: end,
      total_lines: 500,
      content: "x",
    }),
  });
  const call = (names: string[]): Message => ({
    role: "assistant",
    content: "",
    tool_calls: names.map((name, i) => ({
      id: `call_${i}`,
      type: "function" as const,
      function: { name, arguments: "{}" },
    })),
  });

  it("同一路径的旧结果被新读取覆盖时淘汰", () => {
    const messages = [read("a", "src/a.ts", 1, 100), read("b", "src/a.ts", 1, 100)];
    const res = applyReadFileDedup(messages);

    expect(res.elided).toBe(1);
    expect(res.messages[0]!.content).toContain("superseded by a later read_file");
    expect(res.messages[1]!.content).toContain('"start_line":1');
  });

  it("不同路径互不影响", () => {
    const messages = [read("a", "src/a.ts", 1, 100), read("b", "src/b.ts", 1, 100)];
    const res = applyReadFileDedup(messages);
    expect(res.elided).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("分段读取（区间不同）不淘汰", () => {
    const messages = [read("a", "src/a.ts", 1, 100), read("b", "src/a.ts", 101, 200)];
    expect(applyReadFileDedup(messages).elided).toBe(0);
  });

  it("多次读取合并后覆盖旧区间时淘汰", () => {
    const messages = [
      read("a", "src/a.ts", 1, 200),
      read("b", "src/a.ts", 1, 100),
      read("c", "src/a.ts", 101, 200),
    ];
    const res = applyReadFileDedup(messages);
    expect(res.elided).toBe(1);
    expect(res.messages[0]!.content).toContain("superseded");
  });

  it("两次读取之间有写操作时不淘汰（改动前后是不同版本）", () => {
    const messages = [
      read("a", "src/a.ts", 1, 100),
      call(["replace_in_file"]),
      read("b", "src/a.ts", 1, 100),
    ];
    const res = applyReadFileDedup(messages);
    expect(res.elided).toBe(0);
  });

  it("run_shell 也视为潜在写操作（保守）", () => {
    const messages = [
      read("a", "src/a.ts", 1, 100),
      call(["run_shell"]),
      read("b", "src/a.ts", 1, 100),
    ];
    expect(applyReadFileDedup(messages).elided).toBe(0);
  });

  it("路径写法不同但指向同一文件时仍能识别", () => {
    const messages = [read("a", "./src/a.ts", 1, 50), read("b", "src\\a.ts", 1, 50)];
    expect(applyReadFileDedup(messages).elided).toBe(1);
  });
});

describe("applyOneShotElision 旧 git_diff 优先淘汰", () => {
  const tool = (name: string, content: string, id = name): Message => ({
    role: "tool",
    tool_call_id: id,
    tool_call_name: name,
    content,
  });

  it("只保留最近一条 git_diff，更早的直接淘汰", () => {
    const messages = [
      tool("git_diff", "d1".repeat(500), "d1"),
      tool("git_diff", "d2".repeat(500), "d2"),
      tool("git_diff", "d3".repeat(500), "d3"),
    ];
    const res = applyOneShotElision(messages);

    expect(res.elided).toBe(2);
    expect(res.messages[0]!.content).toContain("old tool result elided: git_diff");
    expect(res.messages[1]!.content).toContain("old tool result elided: git_diff");
    expect(res.messages[2]!.content).toBe("d3".repeat(500));
  });

  it("只有一条 git_diff 时不淘汰", () => {
    const messages = [tool("git_diff", "only")];
    expect(applyOneShotElision(messages).elided).toBe(0);
  });

  it("其他工具结果不受影响", () => {
    const messages = [
      tool("read_file", "内容".repeat(100)),
      tool("git_diff", "d1".repeat(100), "d1"),
      tool("git_diff", "d2".repeat(100), "d2"),
    ];
    const res = applyOneShotElision(messages);
    expect(res.elided).toBe(1);
    expect(res.messages[0]!.content).toContain("内容");
  });

  it("已是占位符的结果不重复计数", () => {
    const messages = [
      tool("git_diff", "[old tool result elided: git_diff, 100 chars]", "d1"),
      tool("git_diff", "d2".repeat(100), "d2"),
    ];
    expect(applyOneShotElision(messages).elided).toBe(0);
  });

  it("占位符保留落盘路径，便于取回原文", () => {
    const messages = [
      tool(
        "git_diff",
        "[tool output truncated: 999 chars, full output saved to /tmp/d1.txt]\n\n" +
          "x".repeat(200),
        "d1",
      ),
      tool("git_diff", "d2", "d2"),
    ];
    const res = applyOneShotElision(messages);
    expect(res.messages[0]!.content).toContain("/tmp/d1.txt");
  });
});
