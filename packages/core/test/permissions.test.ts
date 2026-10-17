/**
 * PermissionEngine 单元测试
 *
 * 覆盖评估决策的完整优先级链：只读模式门控、路径范围检查、
 * 低风险放行、AUTO 模式、命令白名单（前缀匹配 + shell 运算符拦截）、
 * 会话级白名单，以及兜底「需要审批」。
 */
import { describe, it, expect } from "vitest";
import {
  PermissionEngine,
  Mode,
  RiskClass,
  type ToolMetadata,
} from "../src/index.js";

/** 构造带默认元数据的工具元数据 */
function meta(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    category: "test",
    riskLevel: "low",
    capabilities: [],
    requiresApproval: false,
    ...overrides,
  };
}

function makeEngine(mode: Mode = Mode.INTERACTIVE) {
  return new PermissionEngine({
    workspaceRoot: "/work",
    mode,
    allowedCommands: ["ls", "git status"],
  });
}

describe("PermissionEngine 风险分类", () => {
  it("写文件工具按默认映射归类为 WRITE_LOCAL", () => {
    const engine = makeEngine();
    // write_file 无元数据也按内置映射归类 → 有副作用 → 需审批
    const decision = engine.evaluate("write_file", { path: "a.txt" });
    expect(decision.allowed).toBe(false);
    expect(decision.needsUser).toBe(true);
  });

  it("requiresApproval 的工具归类为外部风险", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "web_fetch",
      { url: "https://example.com" },
      meta({ requiresApproval: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.needsUser).toBe(true);
  });

  it("低风险工具始终允许", () => {
    const engine = makeEngine();
    const decision = engine.evaluate("read_file", { path: "a.ts" }, meta());
    expect(decision.allowed).toBe(true);
    expect(decision.needsUser).toBe(false);
  });
});

describe("PermissionEngine 只读模式门控", () => {
  for (const mode of [Mode.DISCUSS, Mode.PLAN]) {
    it(`${mode} 模式拒绝写入`, () => {
      const engine = makeEngine(mode);
      const decision = engine.evaluate("write_file", { path: "a.txt" }, meta());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("只读");
    });

    it(`${mode} 模式拒绝 shell`, () => {
      const engine = makeEngine(mode);
      const decision = engine.evaluate("run_shell", { command: "ls" }, meta());
      expect(decision.allowed).toBe(false);
    });

    it(`${mode} 模式允许只读工具`, () => {
      const engine = makeEngine(mode);
      const decision = engine.evaluate("read_file", { path: "a.ts" }, meta());
      expect(decision.allowed).toBe(true);
    });
  }
});

describe("PermissionEngine 路径范围检查", () => {
  it("拒绝写入工作区之外的路径", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "write_file",
      { path: "../outside.txt" },
      meta(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("路径不在可写目录下");
  });

  it("绝对路径逃逸同样被拒绝", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "write_file",
      { path: "/etc/passwd" },
      meta(),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("PermissionEngine AUTO 模式", () => {
  it("放行所有有副作用的操作", () => {
    const engine = makeEngine(Mode.AUTO);
    const shell = engine.evaluate("run_shell", { command: "rm -rf /" }, meta());
    const write = engine.evaluate("write_file", { path: "a.txt" }, meta());
    expect(shell.allowed).toBe(true);
    expect(write.allowed).toBe(true);
  });
});

describe("PermissionEngine 命令白名单", () => {
  it("命中白名单前缀的命令直接放行", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "run_shell",
      { command: "ls -la" },
      meta(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("白名单");
  });

  it("含 shell 运算符的命令不自动放行（即使以白名单开头）", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "run_shell",
      { command: "ls; rm -rf /" },
      meta(),
    );
    expect(decision.allowed).toBe(false);
  });

  it("未命中白名单的命令需要审批", () => {
    const engine = makeEngine();
    const decision = engine.evaluate(
      "run_shell",
      { command: "rm -rf /" },
      meta(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.needsUser).toBe(true);
  });
});

describe("PermissionEngine 会话级白名单", () => {
  it("allowToolForSession 后该工具无需再审批", () => {
    const engine = makeEngine();
    engine.allowToolForSession("run_shell");
    const decision = engine.evaluate(
      "run_shell",
      { command: "anything" },
      meta(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("会话已允许");
  });

  it("allowCommandForSession 后该命令无需再审批", () => {
    const engine = makeEngine();
    engine.allowCommandForSession("git push");
    const decision = engine.evaluate(
      "run_shell",
      { command: "git push" },
      meta(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("会话已允许此命令");
  });

  it("按可执行程序名记忆，含路径调用与同类裸命令都放行", () => {
    const engine = makeEngine();
    engine.allowCommandForSession("/usr/bin/pdftotext a.pdf -");
    const decision = engine.evaluate(
      "run_shell",
      { command: "pdftotext b.pdf -" },
      meta(),
    );
    expect(decision.allowed).toBe(true);
  });

  it("不放过含 shell 运算符的复合命令", () => {
    const engine = makeEngine();
    engine.allowCommandForSession("echo hi");
    const compound = engine.evaluate(
      "run_shell",
      { command: "echo x; rm -rf /" },
      meta(),
    );
    expect(compound.allowed).toBe(false);
    expect(compound.needsUser).toBe(true);
    const piped = engine.evaluate(
      "run_shell",
      { command: "echo hi | sh" },
      meta(),
    );
    expect(piped.allowed).toBe(false);
  });

  it("不放过带路径的同名可执行文件", () => {
    const engine = makeEngine();
    engine.allowCommandForSession("/usr/bin/pdftotext a.pdf -");
    const decision = engine.evaluate(
      "run_shell",
      { command: "/tmp/evil/pdftotext b.pdf -" },
      meta(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.needsUser).toBe(true);
  });
});
