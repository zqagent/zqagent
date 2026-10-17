/**
 * Todo 工具
 *
 * 提供 todo_write 工具与共享的 TodoList 状态对象。
 * 用户进度面板基于 todo 列表渲染，因此 Agent 在开始多步骤任务前
 * 必须先调用 todo_write 建立任务列表。
 */
import { ToolRegistry } from "./ToolRegistry.js";

/**
 * TodoList 共享状态对象 (对齐 Python 版)
 *
 * 持有当前任务列表；CLI/UI 可读取 items 渲染进度面板。
 * todo_write 每次调用会整体替换该列表。
 */
export class TodoList {
  /** 任务列表（content=任务描述，status=状态） */
  items: { content: string; status: "pending" | "in_progress" | "done" }[] = [];
}

/**
 * todo_write — 替换任务列表 (对齐 Python 版)
 *
 * 接受数组输入，兼容两种形态：对象数组（{content, status}）
 * 或纯字符串数组（视为 pending 状态）。状态字段做归一化：
 * "completed" → "done"，非法值回退为 "pending"。
 */
function makeTodoWrite(todo: TodoList) {
  return function todo_write(args: Record<string, unknown>) {
    const todos = (args.todos ?? args.items ?? []) as unknown[];
    const normalized: { content: string; status: "pending" | "in_progress" | "done" }[] = [];

    for (const entry of todos) {
      if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>;
        let status = String(e.status ?? "pending");
        if (status === "completed") status = "done";
        if (!["pending", "in_progress", "done"].includes(status)) status = "pending";
        normalized.push({
          content: String(e.content ?? ""),
          status: status as "pending" | "in_progress" | "done",
        });
      } else {
        // 纯字符串条目 → 默认 pending
        normalized.push({ content: String(entry), status: "pending" });
      }
    }

    todo.items = normalized;
    return { count: normalized.length, todos: normalized };
  };
}

/** 注册 Todo 工具（低风险，无需审批） */
export function registerTodoTool(registry: ToolRegistry, todo: TodoList): void {
  const func = makeTodoWrite(todo);

  registry.register(
    (args) => func(args),
    { category: "planning", riskLevel: "low", capabilities: ["todo"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "todo_write",
        description: "替换任务列表。每次调用提供完整的 todo 列表。每个 todo 包含 content 和 status (pending, in_progress, done)。用户进度面板是基于它渲染的。",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "done"] },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
        },
      },
    },
  );
}
