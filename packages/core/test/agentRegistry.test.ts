/**
 * AgentRegistry 单元测试
 *
 * 覆盖：内置默认 agent、增删改查、切换（含 model 同步）、
 * buildSystemPrompt 组装、upsert(set) 覆盖内置、删除当前 agent 的回退。
 */
import { describe, it, expect } from "vitest";
import {
  AgentRegistry,
  BUILTIN_AGENTS,
  CODE_INSTRUCTIONS,
  buildInstructions,
} from "../src/index.js";

describe("AgentRegistry", () => {
  it("默认注册内置 code / cowork，当前为 code", () => {
    const r = new AgentRegistry();
    expect(r.list().map((a) => a.name)).toEqual(["code", "cowork"]);
    expect(r.current).toBe("code");
    expect(r.currentDef.name).toBe("code");
  });

  it("list 返回的是副本，外部修改不影响内部", () => {
    const r = new AgentRegistry();
    const list = r.list();
    list[0]!.prompt = "hacked";
    expect(r.get("code")!.prompt).toBe(CODE_INSTRUCTIONS);
  });

  it("add 新增 agent；同名重复抛错", () => {
    const r = new AgentRegistry();
    r.add({ name: "reviewer", prompt: "你是严格的代码审查者" });
    expect(r.has("reviewer")).toBe(true);
    expect(r.get("reviewer")!.prompt).toBe("你是严格的代码审查者");
    expect(() => r.add({ name: "reviewer", prompt: "重复" })).toThrow(/已存在/);
  });

  it("update 局部修改 prompt / model；不存在的名称返回 false", () => {
    const r = new AgentRegistry();
    expect(
      r.update("code", { prompt: "新的编程提示词", model: "deepseek-flash" }),
    ).toBe(true);
    expect(r.get("code")!.prompt).toBe("新的编程提示词");
    expect(r.get("code")!.model).toBe("deepseek-flash");
    expect(r.update("nope", { prompt: "x" })).toBe(false);
  });

  it("set 为 upsert 语义：可覆盖内置 agent", () => {
    const r = new AgentRegistry();
    r.set({ name: "code", prompt: "自定义 code prompt", model: "gpt-4o" });
    expect(r.list()).toHaveLength(2); // 不新增
    expect(r.get("code")!.prompt).toBe("自定义 code prompt");
    r.set({ name: "writer", prompt: "写作助手" });
    expect(r.list()).toHaveLength(3);
  });

  it("switch 切换当前 agent 并返回定义；不存在返回 undefined", () => {
    const r = new AgentRegistry();
    const def = r.switch("cowork");
    expect(def?.name).toBe("cowork");
    expect(r.current).toBe("cowork");
    expect(r.switch("ghost")).toBeUndefined();
    expect(r.current).toBe("cowork");
  });

  it("remove 删除当前 agent 时回退到 code", () => {
    const r = new AgentRegistry();
    r.switch("cowork");
    expect(r.remove("cowork")).toBe(true);
    expect(r.current).toBe("code");
    expect(r.remove("cowork")).toBe(false); // 已删除
  });

  it("remove 删除自定义当前 agent 时回退到剩余第一个", () => {
    const r = new AgentRegistry([{ name: "alpha", prompt: "A" }]);
    r.switch("alpha");
    r.add({ name: "beta", prompt: "B" });
    r.switch("beta");
    expect(r.remove("beta")).toBe(true);
    expect(r.current).toBe("alpha");
  });

  it("buildSystemPrompt 包含 agent prompt、叙述规则与环境信息", () => {
    const r = new AgentRegistry();
    const prompt = r.buildSystemPrompt("code", "/ws", "2026-08-27");
    expect(prompt).toContain(CODE_INSTRUCTIONS);
    expect(prompt).toContain("进度叙述");
    expect(prompt).toContain("工作区：/ws");
    expect(prompt).toContain("当前日期：2026-08-27");
    // 与既有 buildInstructions 结构一致（兼容性）
    expect(prompt).toBe(buildInstructions("code", "/ws", "2026-08-27"));
  });

  it("buildSystemPrompt 对不存在的名称回退到当前 agent", () => {
    const r = new AgentRegistry();
    const prompt = r.buildSystemPrompt("ghost", "/ws", "2026-08-27");
    expect(prompt).toContain(CODE_INSTRUCTIONS);
  });

  it("自定义 agent 的 model 随 switch 返回，供调用方同步模型", () => {
    const r = new AgentRegistry();
    r.add({ name: "coder", prompt: "P", model: "deepseek-flash" });
    const def = r.switch("coder");
    expect(def?.model).toBe("deepseek-flash");
  });

  it("构造时可注入自定义定义（含磁盘加载场景）", () => {
    const r = new AgentRegistry([
      ...BUILTIN_AGENTS,
      { name: "memo", prompt: "写备忘录", model: "gpt-4o-mini" },
    ]);
    expect(r.list()).toHaveLength(3);
    expect(r.get("memo")!.model).toBe("gpt-4o-mini");
  });
});
