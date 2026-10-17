/**
 * ToolRegistry 单元测试
 *
 * 覆盖工具注册（含 schema 推导、func.name 覆写）、查询、批量导出
 * schema、执行，以及未注册/无名字等错误路径；
 * 以及运行时管理能力：source 字段、remove/has/list、disable/enable、
 * 同名替换恢复启用、异步 func 支持。
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry, type ToolMetadata } from "../src/index.js";

const metadata: ToolMetadata = {
  category: "test",
  riskLevel: "low",
  capabilities: ["greet"],
  requiresApproval: false,
};

function addGreet(registry: ToolRegistry, name = "greet") {
  return registry.register(
    (args) => `hello ${String(args.name ?? "world")}`,
    metadata,
    {
      type: "function",
      function: {
        name,
        description: "打招呼",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: [],
        },
      },
    },
  );
}

describe("ToolRegistry 注册", () => {
  it("注册后可通过 get 查询并返回完整 spec", () => {
    const registry = new ToolRegistry();
    const spec = addGreet(registry);
    expect(registry.get("greet")).toBe(spec);
    expect(registry.get("greet")?.metadata).toBe(metadata);
  });

  it("names() 返回全部注册的工具名", () => {
    const registry = new ToolRegistry();
    addGreet(registry, "a");
    addGreet(registry, "b");
    expect(registry.names().sort()).toEqual(["a", "b"]);
  });

  it("schemas() 返回 OpenAI 格式的工具 schema", () => {
    const registry = new ToolRegistry();
    addGreet(registry);
    const schemas = registry.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toBe("function");
    expect(schemas[0].function.name).toBe("greet");
  });

  it("未提供 schema 时自动生成默认 schema（工具名取函数名，描述取 capabilities）", () => {
    const registry = new ToolRegistry();
    function namedFunc(args: Record<string, unknown>) {
      return args;
    }
    registry.register(namedFunc, metadata);
    const schemas = registry.schemas();
    expect(schemas[0].function.name).toBe("namedFunc");
    expect(schemas[0].function.description).toBe("greet");
  });

  it("匿名函数且无 schema 时注册抛错", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register((args) => args, metadata)).toThrow(/must have a name/);
  });
});

describe("ToolRegistry 执行", () => {
  it("execute 调用注册的函数并返回结果", () => {
    const registry = new ToolRegistry();
    addGreet(registry);
    expect(registry.execute("greet", { name: "ow" })).toBe("hello ow");
  });

  it("execute 未注册的工具抛错", () => {
    const registry = new ToolRegistry();
    expect(() => registry.execute("nope", {})).toThrow(/not registered/i);
  });
});

describe("ToolRegistry 运行时管理", () => {
  it("register 记录 source；has/remove/list 可用", () => {
    const registry = new ToolRegistry();
    addGreet(registry);
    registry.register(
      (args) => args,
      metadata,
      {
        type: "function",
        function: {
          name: "bar",
          description: "bar",
          parameters: { type: "object", properties: {} },
        },
      },
      "mcp:test",
    );
    expect(registry.get("bar")?.source).toBe("mcp:test");
    expect(registry.has("greet")).toBe(true);
    expect(registry.names().sort()).toEqual(["bar", "greet"]);

    expect(registry.remove("greet")).toBe(true);
    expect(registry.has("greet")).toBe(false);
    expect(registry.remove("greet")).toBe(false); // 已删除
  });

  it("list 返回副本，外部修改不影响内部", () => {
    const registry = new ToolRegistry();
    addGreet(registry);
    const list = registry.list();
    list[0]!.name = "hacked";
    expect(registry.has("hacked")).toBe(false);
  });

  it("disable 从 schemas 移除（模型不可见），enable 恢复", () => {
    const registry = new ToolRegistry();
    addGreet(registry, "a");
    addGreet(registry, "b");
    expect(registry.schemas().map((s) => s.function.name).sort()).toEqual([
      "a",
      "b",
    ]);

    expect(registry.disable("a")).toBe(true);
    expect(registry.isDisabled("a")).toBe(true);
    expect(registry.schemas().map((s) => s.function.name)).toEqual(["b"]);
    // 禁用的工具仍可被显式执行（已排队的调用不失败）
    expect(registry.execute("a", {})).toBe("hello world");

    expect(registry.enable("a")).toBe(true);
    expect(registry.schemas().map((s) => s.function.name).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(registry.enable("a")).toBe(false); // 已启用，再次启用返回 false
  });

  it("同名 register 替换并自动恢复启用", () => {
    const registry = new ToolRegistry();
    addGreet(registry);
    registry.disable("greet");
    registry.register(
      (args) => ({ replaced: true }),
      { ...metadata, requiresApproval: true },
      {
        type: "function",
        function: {
          name: "greet",
          description: "new greet",
          parameters: { type: "object", properties: {} },
        },
      },
      "cli:command",
    );
    expect(registry.get("greet")?.source).toBe("cli:command");
    expect(registry.isDisabled("greet")).toBe(false); // 替换后自动启用
    expect(registry.execute("greet", {})).toEqual({ replaced: true });
  });

  it("支持异步 func（引擎会 await）", async () => {
    const registry = new ToolRegistry();
    registry.register(
      async (args) => `async:${String(args.x)}`,
      metadata,
      {
        type: "function",
        function: {
          name: "afn",
          description: "async",
          parameters: { type: "object", properties: {} },
        },
      },
    );
    const result = registry.execute("afn", { x: 1 });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe("async:1");
  });
});
