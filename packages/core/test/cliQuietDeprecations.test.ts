/**
 * 静音 Node 内置 punycode 的 DEP0040 警告（core `cli/quietDeprecations`）
 *
 * 背景：依赖链 node-fetch → whatwg-url → tr46 用的是内置 punycode，
 * Node 21+ 每次启动都往 stderr 打两行 DeprecationWarning，混进安装输出、
 * `zqagent --version` 与服务日志。
 *
 * 这里锁住判定本身：只吞 DEP0040，别的一概放行（不能顺手关掉所有弃用警告，
 * 那会把我们自己的代码问题也一起藏起来）。
 */
import { describe, it, expect } from "vitest";
import {
  IGNORED_WARNING_CODES,
  shouldSilenceWarning,
} from "../../core/src/cli/quietDeprecations.js";

describe("shouldSilenceWarning（只静音 punycode 的 DEP0040）", () => {
  it("DEP0040 → 丢弃（本次修复的目标）", () => {
    expect(shouldSilenceWarning({ code: "DEP0040" })).toBe(true);
  });

  it("其它弃用警告 → 照常输出", () => {
    expect(shouldSilenceWarning({ code: "DEP0060" })).toBe(false);
    expect(shouldSilenceWarning({ code: "DEP0005" })).toBe(false);
    // ExperimentalWarning 等非弃用类别同样不受影响
    expect(shouldSilenceWarning({ code: "ExperimentalWarning" })).toBe(false);
  });

  it("没有 code 的警告 → 照常输出", () => {
    expect(shouldSilenceWarning({})).toBe(false);
    expect(shouldSilenceWarning(undefined)).toBe(false);
    expect(shouldSilenceWarning(null)).toBe(false);
  });

  it("噪音清单里只有 punycode 这一条", () => {
    expect([...IGNORED_WARNING_CODES]).toEqual(["DEP0040"]);
  });
});
