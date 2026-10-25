/** 共享通用工具：随机 token、时间戳窗口、nonce 防重放。 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLOCK_SKEW_MS,
  NonceTracker,
  generateToken,
  isFreshTimestamp,
} from "../src/common.js";

describe("generateToken", () => {
  it("默认生成 32 字节的 base64url 串（无填充与 +/）", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
  });

  it("支持自定义字节数且每次不同", () => {
    const a = generateToken(8);
    const b = generateToken(8);
    expect(Buffer.from(a, "base64url")).toHaveLength(8);
    expect(a).not.toBe(b);
  });
});

describe("isFreshTimestamp", () => {
  const now = 1_700_000_000_000;

  it("窗口内通过，边界含等号", () => {
    expect(isFreshTimestamp(now, now)).toBe(true);
    expect(isFreshTimestamp(now - DEFAULT_CLOCK_SKEW_MS, now)).toBe(true);
    expect(isFreshTimestamp(now + DEFAULT_CLOCK_SKEW_MS, now)).toBe(true);
  });

  it("窗口外拒绝", () => {
    expect(isFreshTimestamp(now - DEFAULT_CLOCK_SKEW_MS - 1, now)).toBe(false);
    expect(isFreshTimestamp(now + DEFAULT_CLOCK_SKEW_MS + 1, now)).toBe(false);
  });

  it("拒绝非数值/非有限值", () => {
    expect(isFreshTimestamp(Number.NaN, now)).toBe(false);
    expect(isFreshTimestamp(Number.POSITIVE_INFINITY, now)).toBe(false);
    expect(isFreshTimestamp("1" as unknown as number, now)).toBe(false);
  });

  it("支持自定义窗口", () => {
    expect(isFreshTimestamp(now - 10, now, 5)).toBe(false);
    expect(isFreshTimestamp(now - 10, now, 10)).toBe(true);
  });
});

describe("NonceTracker", () => {
  it("首次通过，重复拒绝", () => {
    const t = new NonceTracker();
    expect(t.checkAndRecord("a", 1000)).toBe(true);
    expect(t.checkAndRecord("a", 1001)).toBe(false);
    expect(t.checkAndRecord("b", 1001)).toBe(true);
  });

  it("过期后可再次使用", () => {
    const t = new NonceTracker(1000);
    expect(t.checkAndRecord("a", 1000)).toBe(true);
    expect(t.checkAndRecord("a", 1999)).toBe(false);
    expect(t.checkAndRecord("a", 2001)).toBe(true);
  });

  it("不同实例互不影响", () => {
    expect(new NonceTracker().checkAndRecord("x", 1)).toBe(true);
    expect(new NonceTracker().checkAndRecord("x", 1)).toBe(true);
  });
});
