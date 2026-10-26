import { ToolRegistry } from "./ToolRegistry.js";
import { Mode } from "../permissions/PermissionEngine.js";

/**
 * propose_plan — 计划提案工具
 * 对齐 Python 版 tools/plan.py
 * 在 CLI 模式下通过 readline 审批实现
 */

/**
 * 肯定回答（批准 / 授权）：单词或句首。
 * 中文口语的「好 / 行 / 嗯」也要认：否则用户敲一个「好」，会被当成补充要求。
 */
const APPROVE_WORDS = new Set([
  "y",
  "yes",
  "approve",
  "approved",
  "ok",
  "true",
  "a",
  "1",
  "好",
  "好的",
  "行",
  "嗯",
]);
const APPROVE_PREFIX = /^(yes|approve|同意|批准|允许|确定|可以|好的|确认)/;

/** 明确的拒绝词（Web 端点「拒绝」按钮提交的就是 reject） */
const REJECT_WORDS = new Set([
  "d",
  "n",
  "no",
  "reject",
  "rejected",
  "deny",
  "false",
  "0",
  "不",
  "不行",
  "不用",
  "拒绝",
  "不同意",
  "取消",
]);

/** 是否肯定回答（批准计划 / 授权目录） */
export function isAffirmativeText(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return false;
  if (APPROVE_WORDS.has(a)) return true;
  return APPROVE_PREFIX.test(a);
}

/**
 * 是否明确的拒绝：只有整句就是拒绝词才算。
 * 「不要改 A，改用 B」这类是修改意见，不能当成否决。
 */
export function isRejectionText(answer: string): boolean {
  const a = answer.trim().toLowerCase().replace(/[。.!！]$/, "");
  return REJECT_WORDS.has(a);
}

/**
 * 解析用户对计划提案的一句话回应。
 *
 * CLI 与 Web 共用同一套判定，避免两处词表各自漂移：
 *   - approve：批准；
 *   - reject：否决；
 *   - revise：既没批准也没拒绝 → 视为补充要求，合并进计划后重新提案；
 *   - empty：空输入（CLI 重新提示，不改变任何状态）。
 */
export type PlanReply =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "revise"; feedback: string }
  | { kind: "empty" };

export function interpretPlanReply(answer: string): PlanReply {
  const text = answer.trim();
  if (!text) return { kind: "empty" };
  if (isAffirmativeText(text)) return { kind: "approve" };
  if (isRejectionText(text)) return { kind: "reject" };
  return { kind: "revise", feedback: text };
}

/**
 * 提案审批结果。
 *
 * `revised` 表示「用户没有批准也没有拒绝，而是提出了补充要求」：把 feedback
 * 合并进原计划后重新提案即可，不要开始实施，也不要把它当成否决而放弃方案。
 */
export type PlanHandler = (plan: string) => Promise<{
  approved: boolean;
  mode?: string;
  feedback?: string;
  revised?: boolean;
}>;

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
      /*
       * 用户提出补充要求（既没批准也没拒绝）：这是「修订」，不是否决。
       * 明确告诉模型下一步该做什么——把反馈合并进计划、再次调用 propose_plan。
       * 否则模型容易把它当作拒绝而从零重来，或者直接开始动手。
       */
      if (result.revised) {
        return {
          approved: false,
          revised: true,
          feedback: result.feedback ?? "用户要求补充修正计划",
          note:
            "用户没有批准，而是对计划提出了补充要求。请把这些要求合并进原计划" +
            "（保留仍然有效的部分），然后再次调用 propose_plan 提交修订后的计划，" +
            "不要开始实施，也不要从头重写整个方案。",
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
