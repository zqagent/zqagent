/**
 * ask_user 选项序号解析测试
 */
import { describe, it, expect } from "vitest";
import { parsePicks } from "../src/tools/ask.js";

describe("parsePicks 选项序号解析", () => {
  it("单选数字", () => {
    expect(parsePicks("1", 5)).toEqual([1]);
    expect(parsePicks("3", 5)).toEqual([3]);
    expect(parsePicks("5", 5)).toEqual([5]);
  });

  it("多选（中英文逗号/顿号/分号/空格分隔）", () => {
    expect(parsePicks("1,2,4", 5)).toEqual([1, 2, 4]);
    expect(parsePicks("1，2，4", 5)).toEqual([1, 2, 4]);
    expect(parsePicks("1、2、4", 5)).toEqual([1, 2, 4]);
    expect(parsePicks("1 2 4", 5)).toEqual([1, 2, 4]);
    expect(parsePicks("1;2;4", 5)).toEqual([1, 2, 4]);
  });

  it("越界 / 非数字 / 空输入 → null", () => {
    expect(parsePicks("0", 5)).toBeNull();
    expect(parsePicks("6", 5)).toBeNull();
    expect(parsePicks("-1", 5)).toBeNull();
    expect(parsePicks("abc", 5)).toBeNull();
    expect(parsePicks("1a", 5)).toBeNull();
    expect(parsePicks("1.5", 5)).toBeNull();
    expect(parsePicks("", 5)).toBeNull();
    expect(parsePicks("   ", 5)).toBeNull();
  });
});
