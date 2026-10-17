/**
 * QQ 命令解析单测
 */
import { describe, it, expect } from "vitest";
import { ApprovalOutcome } from "../src/engine/events.js";
import { parseCommand, parseDecision } from "../src/server/qq/commands.js";

describe("parseDecision", () => {
  it("识别中英文决策值", () => {
    expect(parseDecision("once")).toBe(ApprovalOutcome.ONCE);
    expect(parseDecision("同意")).toBe(ApprovalOutcome.ONCE);
    expect(parseDecision("允许")).toBe(ApprovalOutcome.ONCE);
    expect(parseDecision("y")).toBe(ApprovalOutcome.ONCE);
    expect(parseDecision("always_tool")).toBe(ApprovalOutcome.ALWAYS_TOOL);
    expect(parseDecision("总是允许")).toBe(ApprovalOutcome.ALWAYS_TOOL);
    expect(parseDecision("全部同意")).toBe(ApprovalOutcome.ALWAYS_TOOL);
    expect(parseDecision("全部允许")).toBe(ApprovalOutcome.ALWAYS_TOOL);
    expect(parseDecision("always_command")).toBe(ApprovalOutcome.ALWAYS_COMMAND);
    expect(parseDecision("deny")).toBe(ApprovalOutcome.DENY);
    expect(parseDecision("拒绝")).toBe(ApprovalOutcome.DENY);
    expect(parseDecision("no")).toBe(ApprovalOutcome.DENY);
  });

  it("无法识别返回 null", () => {
    expect(parseDecision("随便")).toBeNull();
    expect(parseDecision("")).toBeNull();
  });
});

describe("parseCommand", () => {
  it("普通文本视为任务", () => {
    expect(parseCommand("写一个 hello world")).toEqual({
      kind: "task",
      text: "写一个 hello world",
    });
  });

  it("命令不区分大小写", () => {
    expect(parseCommand("/HELP")).toEqual({ kind: "help" });
    expect(parseCommand("/stop")).toEqual({ kind: "stop" });
  });

  it("bind 提取配对码", () => {
    expect(parseCommand("/bind ABC12345")).toEqual({ kind: "bind", code: "ABC12345" });
    expect(parseCommand("/bind")).toEqual({ kind: "bind", code: "" });
  });

  it("approve 解析决策；非法值回 unknown", () => {
    expect(parseCommand("/approve once")).toEqual({
      kind: "approve",
      decision: ApprovalOutcome.ONCE,
    });
    expect(parseCommand("/approve 随便")).toEqual({
      kind: "unknown",
      raw: "/approve 随便",
    });
  });

  it("answer 提取内容", () => {
    expect(parseCommand("/answer 用 /usr/local/bin")).toEqual({
      kind: "answer",
      text: "用 /usr/local/bin",
    });
  });

  it("未知命令回 unknown", () => {
    expect(parseCommand("/foo bar")).toEqual({ kind: "unknown", raw: "/foo bar" });
  });

  it("中文别名", () => {
    expect(parseCommand("/新会话")).toEqual({ kind: "new" });
    expect(parseCommand("/状态")).toEqual({ kind: "status" });
    expect(parseCommand("/停止")).toEqual({ kind: "stop" });
    expect(parseCommand("/解绑")).toEqual({ kind: "unbind" });
  });
});
