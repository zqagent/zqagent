/**
 * AI 生成 Git 提交说明（控制台 Git 面板）
 *
 * 取当前暂存区差异（没有暂存内容时退回工作区差异）作为上下文，调用
 * 项目/节点默认 LLM 生成一条 Conventional Commits 风格的提交说明。
 *
 * 这里只产出建议文本，不写仓库；真正的提交仍由用户在面板上确认。
 * LLM 未配置时返回明确的业务错误，前端原样展示。
 */
import * as crypto from "crypto";
import { OpenAIProvider } from "../providers/OpenAIProvider.js";
import { resolveSessionProvider } from "./nodeLlm.js";
import { projectGitDiff, projectGitStatus } from "./projectOps.js";
import { ApiError } from "./session.js";
import type { Store } from "./store.js";
import type { TenantConfig } from "./types.js";

/** 传给模型的最大差异字符数（约 3k token，给上下文留足余量） */
const MAX_DIFF_CHARS = 12_000;

/** 提交说明的最大长度（与常见 git 首行约定一致） */
const MAX_MESSAGE_CHARS = 200;

/** 生成提交说明的系统提示（与仓库现有 commit 风格一致：type(scope): 中文描述） */
export const GEN_COMMIT_MESSAGE_INSTRUCTIONS = `你是 Git 提交说明生成助手。根据给定的代码差异，生成一条准确、简洁的提交说明。

要求：
1. 使用 Conventional Commits 风格：type(scope): 描述（type 如 feat / fix / refactor / docs / test / chore / perf / build / ci）；
2. scope 取变更最集中的模块或目录，无法判断时省略；
3. 描述使用中文，概括本次变更的目的或效果，不要逐文件罗列；
4. 只输出提交说明本身，不要引号、代码块、换行或任何解释；
5. 不超过 72 个字符。`;

/** 生成短请求 ID（与引擎一致，用于关联 LLM 审计日志） */
function genReqId(): string {
  return crypto.randomBytes(6).toString("base64url");
}

/**
 * 清理模型输出：去掉代码块与「Commit message:」之类前缀，只保留首个非空行。
 * 模型偶尔会输出多行说明，提交说明首行已足够，且避免误带空行/列表。
 */
export function cleanCommitMessage(raw: string): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return first
    .replace(/^(commit message|提交说明|提交信息|message)\s*[:：]\s*/i, "")
    .replace(/^["'“”`]+|["'“”`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

/** 收集本次待提交的变更上下文：优先暂存区，其次工作区，最后文件列表 */
async function collectDiff(
  workspaceRoot: string | null | undefined,
  repo?: string,
): Promise<{ text: string; source: "staged" | "worktree" }> {
  const staged = await projectGitDiff(workspaceRoot, undefined, true, repo);
  if (!staged.error && String(staged.diff ?? "").trim()) {
    return { text: String(staged.diff), source: "staged" };
  }

  const worktree = await projectGitDiff(workspaceRoot, undefined, false, repo);
  if (!worktree.error && String(worktree.diff ?? "").trim()) {
    return { text: String(worktree.diff), source: "worktree" };
  }

  // 未跟踪文件不会出现在 diff 中，退回文件列表（模型仍可据此生成说明）
  const status = await projectGitStatus(workspaceRoot, undefined, repo);
  if (status.error) throw new ApiError(400, "git_error", String(status.error));
  const entries = (status.entries ?? []) as Array<{ status?: string; file?: string }>;
  if (entries.length === 0) throw new ApiError(400, "no_changes", "没有可提交的变更");
  return {
    text: entries.map((e) => `${e.status ?? ""} ${e.file ?? ""}`.trim()).join("\n"),
    source: "worktree",
  };
}

/**
 * 生成一条提交说明。
 *
 * provider 解析优先级与引擎一致：项目配置 > 节点默认（环境变量兜底）。
 * 未配置 API Key / 模型时抛 ApiError，由调用方转成可读错误。
 */
export async function generateGitCommitMessage(opts: {
  store: Store;
  tenant: TenantConfig;
  workspaceRoot: string | null | undefined;
  repo?: string;
}): Promise<string> {
  const { store, tenant } = opts;
  const { text, source } = await collectDiff(opts.workspaceRoot, opts.repo);
  const truncated = text.length > MAX_DIFF_CHARS;
  const clipped = text.slice(0, MAX_DIFF_CHARS);

  const eff = resolveSessionProvider(store, tenant);
  // 与 OpenAIProvider 的环境变量兜底保持一致（显式配置优先）
  const apiKey = eff.apiKey || process.env.OPENAI_API_KEY || "";
  const model = (
    eff.model ||
    tenant.model ||
    process.env.OPENAI_MODEL ||
    process.env.MODEL ||
    ""
  ).trim();
  if (!apiKey) {
    throw new ApiError(
      400,
      "llm_not_configured",
      "当前节点未配置可用的 LLM，请先在节点配置中添加模型与 API Key",
    );
  }
  if (!model) {
    throw new ApiError(
      400,
      "llm_not_configured",
      "当前节点未配置模型，请先在节点配置中选择模型",
    );
  }

  const provider = new OpenAIProvider({ apiKey, baseURL: eff.baseURL });
  const raw = await provider.chat(
    model,
    [
      { role: "system", content: GEN_COMMIT_MESSAGE_INSTRUCTIONS },
      {
        role: "user",
        content: `以下是本次待提交的变更${
          source === "staged" ? "（已暂存）" : "（工作区，尚未暂存）"
        }${truncated ? "，内容过长已截断" : ""}：\n\n${clipped}`,
      },
    ],
    {},
    { reqId: `llm_commit_${Date.now()}_${genReqId()}`, logTime: new Date().toISOString() },
    // 不设 maxTokens：推理模型的思考会占用输出配额，过小会导致 content 为空；
    // 提示词已约束只输出一行短说明。
    {},
  );

  const message = cleanCommitMessage(raw ?? "");
  if (!message) throw new ApiError(502, "llm_empty", "AI 未返回有效的提交说明，请重试");
  return message;
}
