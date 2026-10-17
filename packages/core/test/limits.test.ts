/**
 * 引擎运行限制解析测试
 */
import { describe, it, expect } from "vitest";
import {
  parseMaxIterations,
  parseOptionalPositiveNumber,
  parseRatio,
} from "../src/engine/limits.js";

describe("parseMaxIterations", () => {
  it("缺省值 / 空串 → fallback", () => {
    expect(parseMaxIterations(undefined, 150)).toBe(150);
    expect(parseMaxIterations("", 150)).toBe(150);
    expect(parseMaxIterations("   ", 150)).toBe(150);
  });

  it("合法正整数 → 取整", () => {
    expect(parseMaxIterations("200", 150)).toBe(200);
    expect(parseMaxIterations("30.7", 150)).toBe(30);
  });

  it("非法 / 非正数 → fallback（不再静默回退成 fallback 之外的行为）", () => {
    expect(parseMaxIterations("abc", 150)).toBe(150);
    expect(parseMaxIterations("0", 150)).toBe(150);
    expect(parseMaxIterations("-5", 150)).toBe(150);
    expect(parseMaxIterations("Infinity", 150)).toBe(150);
    expect(parseMaxIterations("NaN", 150)).toBe(150);
  });
});

describe("parseOptionalPositiveNumber", () => {
  it("空值 / 非法 / 非正数 → undefined", () => {
    expect(parseOptionalPositiveNumber(undefined)).toBeUndefined();
    expect(parseOptionalPositiveNumber("")).toBeUndefined();
    expect(parseOptionalPositiveNumber("  ")).toBeUndefined();
    expect(parseOptionalPositiveNumber("abc")).toBeUndefined();
    expect(parseOptionalPositiveNumber("0")).toBeUndefined();
    expect(parseOptionalPositiveNumber("-1")).toBeUndefined();
  });

  it("合法正数 → 取整", () => {
    expect(parseOptionalPositiveNumber("1000000")).toBe(1_000_000);
    expect(parseOptionalPositiveNumber("250000.9")).toBe(250_000);
  });
});

describe("parseRatio", () => {
  it("空值 / 非法 / 越界 → undefined", () => {
    expect(parseRatio(undefined)).toBeUndefined();
    expect(parseRatio("")).toBeUndefined();
    expect(parseRatio("abc")).toBeUndefined();
    expect(parseRatio("0")).toBeUndefined();
    expect(parseRatio("1.5")).toBeUndefined();
    expect(parseRatio("-0.5")).toBeUndefined();
  });

  it("0~1 之间的小数 → 原值", () => {
    expect(parseRatio("0.8")).toBe(0.8);
    expect(parseRatio("0.9")).toBe(0.9);
    expect(parseRatio("1")).toBe(1);
  });
});
