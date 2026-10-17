import { ToolRegistry } from "./ToolRegistry.js";
import { Mode } from "../permissions/PermissionEngine.js";

/**
 * propose_plan — 计划提案工具
 * 对齐 Python 版 tools/plan.py
 * 在 CLI 模式下通过 readline Y/N 审批实现
 */

export type PlanHandler = (plan: string) => Promise<{ approved: boolean; mode?: string; feedback?: string }>;

let _planHandler: PlanHandler | null = null;

export function setPlanHandler(handler: PlanHandler): void {
  _planHandler = handler;
}

function makeProposePlan() {
  return async function propose_plan(args: Record<string, unknown>) {
    const plan = String(args.plan ?? "");

    if (!plan.trim()) {
      return { approved: false, error: "计划内容不能为空" };
    }

    if (!_planHandler) {
      return { approved: false, error: "当前环境不支持计划审批" };
    }

    try {
      const result = await _planHandler(plan);
      if (result.approved) {
        return {
          approved: true,
          mode: result.mode ?? "interactive",
          note: "计划已批准 — 现在开始实施",
        };
      }
      return {
        approved: false,
        feedback: result.feedback ?? "计划被拒绝",
      };
    } catch {
      return { approved: false, error: "计划审批已取消" };
    }
  };
}

/** 注册 propose_plan 工具 */
export function registerPlanTool(registry: ToolRegistry): void {
  const planFunc = makeProposePlan();

  registry.register(
    (args) => planFunc(args),
    { category: "planning", riskLevel: "low", capabilities: ["plan"], requiresApproval: false },
    {
      type: "function",
      function: {
        name: "propose_plan",
        description: "将你的实施计划呈现给用户审批。在探索充分、确定了一个方案后使用此工具：总结你将更改什么、在哪些文件中、以及你将如何验证它。如果被批准，会话将退出只读计划模式，你来实施计划；如果被拒绝，使用结果中的反馈意见修改计划。不要在还没有提案之前就描述实施步骤——先提案。",
        parameters: {
          type: "object",
          properties: {
            plan: { type: "string", description: "完整的实施计划描述（包含将更改什么、在哪些文件中、如何验证）" },
          },
          required: ["plan"],
        },
      },
    },
  );
}
