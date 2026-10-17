/**
 * todo_write 工具单元测试
 *
 * 覆盖：任务列表整体替换、状态归一化（completed→done、非法值→pending）、
 * 纯字符串数组输入、items 键名兼容。
 */
import { describe, it, expect } from "vitest";
import { TodoList, registerTodoTool, ToolRegistry } from "../src/index.js";

function make() {
  const registry = new ToolRegistry();
  const todo = new TodoList();
  registerTodoTool(registry, todo);
  return { registry, todo };
}

describe("todo_write", () => {
  it("初始任务列表为空", () => {
    const { todo } = make();
    expect(todo.items).toEqual([]);
  });

  it("用对象数组整体替换任务列表", () => {
    const { registry, todo } = make();
    const result = registry.execute("todo_write", {
      todos: [
        { content: "任务A", status: "in_progress" },
        { content: "任务B", status: "pending" },
      ],
    });
    expect(result).toEqual({
      count: 2,
      todos: [
        { content: "任务A", status: "in_progress" },
        { content: "任务B", status: "pending" },
      ],
    });
    expect(todo.items).toHaveLength(2);
  });

  it("状态归一化：completed→done，非法值→pending", () => {
    const { registry, todo } = make();
    registry.execute("todo_write", {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "weird" },
        { content: "c" }, // 缺省 status → pending
      ],
    });
    expect(todo.items.map((i) => i.status)).toEqual(["done", "pending", "pending"]);
  });

  it("纯字符串数组视为 pending 任务", () => {
    const { registry, todo } = make();
    registry.execute("todo_write", { todos: ["step1", "step2"] });
    expect(todo.items).toEqual([
      { content: "step1", status: "pending" },
      { content: "step2", status: "pending" },
    ]);
  });

  it("兼容 items 键名", () => {
    const { registry, todo } = make();
    registry.execute("todo_write", { items: [{ content: "x", status: "done" }] });
    expect(todo.items).toEqual([{ content: "x", status: "done" }]);
  });
});
