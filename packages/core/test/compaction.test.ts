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
  shouldCompact,
  formatTokens,
  DEFAULT_CONTEXT_WINDOW,
} from "../src/engine/compaction.js";

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
