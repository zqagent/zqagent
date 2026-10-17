import { ToolRegistry } from "./ToolRegistry.js";

/**
 * ask_user — 人机交互问答
 * 对齐 Python 版 tools/ask.py
 * CLI 模式下通过 readline 内联问答实现
 */

export type QuestionHandler = (question: string, options: string[], allowText: boolean, multi: boolean) => Promise<string>;

/**
 * 解析用户输入的选项序号，支持单选 "3" 与多选 "1,2,4" / "1 2 4"
 * （含中英文逗号 / 顿号 / 分号 / 空格分隔）。
 * 返回 1-based 序号数组；输入含非数字或越界时返回 null。
 */
export function parsePicks(input: string, max: number): number[] | null {
  const parts = input.split(/[\s,，、;；]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > max) return null;
    nums.push(n);
  }
  return nums;
}

let _questionHandler: QuestionHandler | null = null;

/** 注入 CLI 问答处理器 */
export function setQuestionHandler(handler: QuestionHandler): void {
  _questionHandler = handler;
}

function makeAskUser() {
  return async function ask_user(args: Record<string, unknown>) {
    const question = String(args.question ?? "");
    const options = (args.options as string[]) ?? [];
    const allowText = args.allow_text !== false;
    const multi = args.multi === true;

    if (!question.trim()) {
      return { answer: "", error: "问题不能为空" };
    }

    if (!_questionHandler) {
      return { answer: "", error: "当前环境不支持用户问答" };
    }

    try {
      const answer = await _questionHandler(question, options, allowText, multi);
      return { answer };
    } catch {
      return { answer: "", error: "用户未回答" };
    }
  };
}

/** 注册 ask_user 工具 */
export function registerAskTool(registry: ToolRegistry): void {
  const askFunc = makeAskUser();

  registry.register(
    (args) => askFunc(args),
    { category: "interaction", riskLevel: "low", capabilities: ["ask_user"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "ask_user",
        description: "向用户提问并等待回答——当你真正需要人工决策或你无法推断的信息时使用（一个偏好、一个缺失的事实、在几个真实选项之间的选择）。优先使用此方法而不是猜测或拖延。\n\n- question：完整问题，用平实的语言。\n- options：可选的快速回复选项。当答案是几个离散的选项之一时提供；留空则为开放式问题。\n- allow_text：即使提供了选项也保留自由文本回答的入口（默认开启）。\n- multi：允许用户选择多个选项。\n- header：简短标签（可选）。\n\n返回 {\"answer\": \"...\"} — 选择的选项或输入的文本。不要问你自己可以合理决定的事情；将此工具保留给真正需要用户来做出的选择。",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "完整的问题文本" },
            options: { type: "array", items: { type: "string" }, description: "可选的快速回复选项（留空为开放式问题）" },
            allow_text: { type: "boolean", description: "即使有选项也保留自由文本入口（默认 true）" },
            multi: { type: "boolean", description: "允许多选（默认 false）" },
            header: { type: "string", description: "简短标签（可选，≤12字符）" },
          },
          required: ["question"],
        },
      },
    },
  );
}
