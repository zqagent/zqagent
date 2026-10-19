/**
 * 自动上下文压缩 (对齐 Python 版 compaction.py)
 *
 * 当 outbound 消息历史接近 LLM 上下文窗口限制时，将旧的消息转换为
 * (a) LLM 生成的摘要 + (b) 机械提取的当前工作状态，保留最近的消息不变。
 * 持久化的对话历史永不被修改——只影响发送给模型的内容。
 */

import type { Message, ReasoningEffort, TokenUsage } from "./types.js";
import { contextTokens } from "./types.js";
import type {
  ProviderClient,
  StreamOpts,
} from "../providers/OpenAIProvider.js";

// ==================== 常量 ====================

/** 触发阈值比例（占上下文窗口的比例） */
export const DEFAULT_THRESHOLD_PCT = 0.8;

/** 未知模型的默认上下文窗口 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

// ==================== 模型上下文窗口映射 ====================

/** 已知模型的上下文窗口大小（token 数） */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // ==================== OpenAI ====================
  // 来源: OpenAI 官方 API 文档 (platform.openai.com/docs/models)
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-4-32k": 32_768,
  "gpt-3.5-turbo": 16_385,
  o1: 200_000,
  "o1-preview": 128_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  o4: 200_000,
  "o4-mini": 200_000,

  // ==================== Anthropic ====================
  // 来源: Anthropic 官方文档 (docs.anthropic.com)
  // 注: Claude 系列模型上下文窗口均为 200K
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3.5-haiku": 200_000,
  "claude-4-sonnet": 200_000,
  "claude-4-opus": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,

  // ==================== Google Gemini ====================
  // 来源: Google AI 官方文档 (ai.google.dev)
  // 注: Gemini 模型以超大上下文窗口著称
  "gemini-2.5-pro": 2_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_048_576,
  "gemini-3-pro": 2_000_000,
  "gemini-3-flash": 1_000_000,

  // ==================== Meta Llama ====================
  // 来源: NVIDIA NIM 文档及 Oracle Cloud 文档
  // 注意: 不同部署平台的上下文长度可能有差异
  "llama-4-scout": 128_000,
  "llama-4-maverick": 512_000,
  "llama-3.3": 128_000,
  "llama-3.1": 128_000,
  "llama-3": 128_000,

  // ==================== DeepSeek ====================
  // 来源: DeepSeek 官方文档 (api-docs.deepseek.com)
  // 注: deepseek-flash 当前由 DeepSeek-V4.1-Flash 提供服务，上下文 1M
  "deepseek-flash": 1_000_000,
  "deepseek-v4.1-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v3": 128_000,
  "deepseek-r1": 128_000,
  "deepseek-reasoner": 128_000,

  // ==================== Alibaba Qwen (通义千问) ====================
  // 来源: 阿里云百炼文档 (help.aliyun.com/zh/model-studio)
  // 注: Qwen3.8 系列支持 1M，Qwen3.5/3.6 原生 262K
  "qwen3.8-max": 1_000_000,
  "qwen3.8-flash": 1_000_000,
  "qwen3.7-max": 1_000_000,
  "qwen3.7-plus": 1_000_000,
  "qwen3.6": 262_144,
  "qwen3.5": 262_144,
  "qwen-3.5": 262_144,
  "qwen-3.6": 262_144,
  "qwen-max": 128_000,
  "qwen-plus": 128_000,
  "qwen-turbo": 128_000,

  // ==================== 智谱 GLM ====================
  // 来源: 智谱 AI 开放文档 (docs.bigmodel.cn)
  "glm-5.3": 128_000,
  "glm-5.2": 128_000,
  "glm-4-plus": 128_000,
  "glm-4-flash": 128_000,
  "glm-4": 128_000,

  // ==================== Kimi / Moonshot ====================
  // 来源: Moonshot API 文档 (platform.moonshot.cn/docs)
  "kimi-k3": 256_000,
  "kimi-k2.7": 256_000,
  "kimi-k2.6": 256_000,
  "kimi-k2": 256_000,
  "moonshot-v1-128k": 128_000,
  "moonshot-v1-32k": 32_000,
  "moonshot-v1-8k": 8_000,

  // ==================== 小米 MiMo ====================
  "mimo-v2.5-pro": 128_000,

  // ==================== Mistral ====================
  // 来源: Mistral AI 官方文档及 AWS Bedrock 文档
  "mistral-large-3": 256_000,
  "mistral-large": 128_000,
  "mistral-small": 128_000,
  "mixtral-8x22b": 65_536,

  // ==================== MiniMax ====================
  "minimax-m3": 1_000_000,
};

/**
 * 根据模型 ID 查找上下文窗口大小（token 数）。
 *
 * 查找策略：先精确匹配，再前缀匹配（如 "gpt-4o-2024-08-06" 匹配 "gpt-4o"），
 * 均未命中时回退到 {@link DEFAULT_CONTEXT_WINDOW}。
 */
export function lookupContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (MODEL_CONTEXT_WINDOWS[lower]) return MODEL_CONTEXT_WINDOWS[lower]!;
  for (const [key, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.startsWith(key)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 格式化 token 数便于展示。
 *
 * 示例：128_000 → "128K"，115_200 → "115.2K"，8_000 → "8K"。
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return `${tokens}`;
}

/** 保留最近 KEEP_RECENT_FRACTION × trigger_tokens 的完整内容不变 */
export const KEEP_RECENT_FRACTION = 0.25;

/**
 * 软阈值：达到它只淘汰旧工具结果（零 LLM 成本），不触发摘要。
 *
 * 相对硬阈值的比例；默认 0.75 × 0.8 = 60% 窗口。大部分长任务在水位到
 * 60% 时就被压回去，不必等到 80% 再调用一次昂贵的摘要。
 */
export const SOFT_THRESHOLD_RATIO = 0.75;

/** 软阈值淘汰后保留的最近工具结果预算（相对硬阈值 token 数的比例） */
export const ELIDE_KEEP_FRACTION = 0.15;

/** 摘要器调用的 max_tokens（限制摘要输出长度，避免压缩本身变成一次大请求） */
const SUMMARY_MAX_TOKENS = 3_000;

/** 渲染给摘要器的 tool 结果最大字符数 */
const SPAN_TOOL_RESULT_CLIP = 200;
/**
 * 单次摘要送入模型的 span 总字符预算。
 *
 * 早期轮次本来就是「将被遗忘」的内容，送给摘要器只需足以提炼结论；
 * 过大只会让压缩本身变慢、变贵（长任务里每次压缩都要重读几十万字符）。
 */
const SPAN_BUDGET_CHARS = 80_000;

/** 用户消息保留设置 */
const USER_MESSAGE_CLIP = 600;
const USER_MESSAGES_MAX = 40;

/** 裁剪比例（trim 降级时丢弃的比例） */
const TRIM_FRACTION = 0.1;

// ==================== 状态 ====================

/** 一次压缩的状态 */
export interface CompactionState {
  boundaryIndex: number; // 边界索引
  summaryText: string; // 摘要
  workingState: string; // 临时状态
  userMessages: string[]; // 用户消息
  userMessagesDropped: number; // 用户消息被裁减的个数
  createdAt: number; // 创建时间
  modelUsed: string; // 模型标识
  trimmed: boolean; // 是否已 trim
}

// ==================== Token 估算 ====================

/** chars/4 估算 token 数（对齐 Python 版 estimate_tokens） */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += String(m).length;
    }
  }
  return Math.floor(total / 4);
}

/**
 * 计算触发阈值：threshold_pct × context_window，可被 capTokens 截断。
 * capTokens 缺省（undefined / null / 非正数）时不截断——
 * 即大上下文模型按比例用满窗口（如 1M 窗口在 800K 才触发压缩）。
 */
export function triggerTokens(
  contextWindow: number | undefined | null,
  thresholdPct: number = DEFAULT_THRESHOLD_PCT,
  capTokens?: number | null,
): number {
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const base = Math.floor(thresholdPct * window);
  if (capTokens != null && Number.isFinite(capTokens) && capTokens > 0) {
    return Math.min(base, Math.floor(capTokens));
  }
  return base;
}

/**
 * 计算软阈值：达到它只淘汰旧工具结果，不调用 LLM。
 *
 * 未显式指定 softThresholdPct 时按硬阈值的 {@link SOFT_THRESHOLD_RATIO} 取比例
 * （默认 0.8 × 0.75 = 60% 窗口）。显式值同样受 capTokens 约束。
 */
export function softTriggerTokens(
  contextWindow: number | undefined | null,
  thresholdPct: number = DEFAULT_THRESHOLD_PCT,
  capTokens?: number | null,
  softThresholdPct?: number | null,
): number {
  const hard = triggerTokens(contextWindow, thresholdPct, capTokens);
  if (softThresholdPct != null && Number.isFinite(softThresholdPct) && softThresholdPct > 0) {
    // 软阈值必须低于硬阈值，否则「先淘汰再摘要」的分层就失去意义
    return Math.min(
      triggerTokens(contextWindow, softThresholdPct, capTokens),
      Math.floor(hard * 0.95),
    );
  }
  return Math.floor(hard * SOFT_THRESHOLD_RATIO);
}

/** 是否需要压缩 */
export function shouldCompact(
  signal: number,
  contextWindow?: number | null,
  thresholdPct?: number,
  capTokens?: number | null,
): boolean {
  return signal >= triggerTokens(contextWindow, thresholdPct, capTokens);
}

/**
 * 计算工具结果淘汰后应保留的字符预算。
 *
 * 与 token 估算保持一致（4 字符 ≈ 1 token），保证淘汰后能明显低于软阈值。
 */
export function elisionKeepChars(
  hardTriggerTokens: number,
  fraction: number = ELIDE_KEEP_FRACTION,
): number {
  return Math.max(4_000, Math.floor(hardTriggerTokens * fraction * 4));
}

// ==================== 边界查找 ====================

/** 候选边界索引：user 消息索引（turn 开始，首选）和 assistant 索引（迭代开始） */
function turnStarts(
  messages: Message[],
  start: number,
): { users: number[]; assistants: number[] } {
  const users: number[] = [];
  const assistants: number[] = [];
  for (let i = start; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") users.push(i);
    else if (role === "assistant") assistants.push(i);
  }
  return { users, assistants };
}

/** 找到压缩边界：保留最近 keep_tokens 的完整消息 */
export function pickBoundary(
  messages: Message[],
  keepTokens: number,
): number | null {
  const start = messages[0]?.role === "system" ? 1 : 0;
  const { users, assistants } = turnStarts(messages, start);

  const fit = (candidates: number[]): number | null => {
    for (const i of candidates) {
      if (estimateTokens(messages.slice(i)) <= keepTokens) return i;
    }
    return null;
  };

  let boundary = fit(users);
  if (boundary === null && users.length > 0) {
    const inside = assistants.filter((i) => i > users[users.length - 1]!);
    boundary = fit(inside);
    if (boundary === null)
      boundary = inside[inside.length - 1] ?? users[users.length - 1]!;
  }
  if (boundary === null) {
    boundary =
      fit(assistants) ??
      (assistants.length > 0 ? assistants[assistants.length - 1]! : null);
  }
  if (boundary === null || boundary <= start) return null;
  return boundary;
}

// ==================== 机械提取（零幻觉风险） ====================

const WRITE_HINTS = ["write", "edit", "append", "save", "create", "patch"];

/** 提取工作状态：文件、命令、工具列表 */
export function extractWorkingState(span: Message[]): string {
  const files: string[] = [];
  const commands: string[] = [];
  const tools: Set<string> = new Set();

  // 收集 tool_call_id → tool result 的映射
  const results = new Map<string, string>();
  for (const m of span) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(m.tool_call_id, m.content);
    }
  }

  for (const m of span) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function.name;
      tools.add(name);
      const args = tc.function.arguments
        ? (() => {
            try {
              return JSON.parse(tc.function.arguments);
            } catch {
              return {};
            }
          })()
        : {};
      const lowered = name.toLowerCase();
      const pathStr = args.path ?? args.file_path;
      if (pathStr && WRITE_HINTS.some((h) => lowered.includes(h))) {
        files.push(String(pathStr));
      }
      if (lowered === "run_shell" && args.command) {
        const cmd = String(args.command).replace(/\s+/g, " ").slice(0, 160);
        const r = results.get(tc.id);
        const status = resultStatus(r);
        commands.push(cmd + (status ? `  [${status}]` : ""));
      }
    }
  }

  const dedupe = (items: string[], limit: number): string[] => {
    const seen: string[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (!seen.includes(items[i]!)) seen.push(items[i]!);
      if (seen.length >= limit) break;
    }
    return seen;
  };

  const lines: string[] = [
    "## Working state (extracted mechanically from tool records)",
  ];
  const written = dedupe(files, 20);
  if (written.length) {
    lines.push("Files written/edited (most recent first):");
    lines.push(...written.map((f) => `- ${f}`));
  }
  const recentCmds = commands.slice(-10);
  if (recentCmds.length) {
    lines.push("Recent shell commands:");
    lines.push(...recentCmds.map((c) => `- ${c}`));
  }
  if (tools.size) {
    lines.push(
      "Tools used in the summarized span: " + [...tools].sort().join(", "),
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function resultStatus(result?: string): string {
  if (!result) return "";
  try {
    const parsed = JSON.parse(result);
    if (parsed?.error) return "error";
    if ("exit_code" in parsed) {
      return parsed.exit_code === 0 || parsed.exit_code === "0"
        ? "ok"
        : `exit ${parsed.exit_code}`;
    }
  } catch {
    /* not JSON */
  }
  return "";
}

// ==================== 用户消息提取 ====================

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p?.type === "text"
          ? String(p.text ?? "")
          : p?.type === "image_url"
            ? "[image]"
            : "",
      )
      .join("\n");
  }
  return content != null ? String(content) : "";
}

export function extractUserMessages(
  span: Message[],
  clip = USER_MESSAGE_CLIP,
): string[] {
  const out: string[] = [];
  for (const m of span) {
    if (m.role !== "user") continue;
    const text = textOf(m.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push(text.length > clip ? text.slice(0, clip - 1) + "…" : text);
  }
  return out;
}

function capUserMessages(
  msgs: string[],
  priorDropped: number,
  limit = USER_MESSAGES_MAX,
): { messages: string[]; dropped: number } {
  if (msgs.length <= limit) return { messages: msgs, dropped: priorDropped };
  return {
    messages: msgs.slice(-limit),
    dropped: priorDropped + (msgs.length - limit),
  };
}

// ==================== 摘要器 ====================

export const SUMMARY_SYSTEM_PROMPT = `你正在压缩一个 AI 协作者的会话历史，以便协作者可以在更小的上下文中继续工作。请为下面的对话写一个结构化的摘要。这将是协作者对这些轮次的唯一记忆，因此保留所有关键信息。

按以下顺序生成所有以下章节，每章使用 Markdown 标题：

1. **主要请求和意图** — 用户试图完成什么，用他们的术语描述，包括在任何时候陈述的长期约束（例如"永远不要未经我批准就发送"）。约束比声明它们的轮次更持久。
2. **关键概念和决策** — 已建立的领域事实、技术选择和理由。包含为什么，而不仅仅是什么——一个没有理由的决策会被重新争论。
3. **工件和文件** — 创建、修改或读取过的每个仍然重要的文件/交付物：路径、它的角色，以及仅关键内容的简短摘录。
4. **错误和修复** — 遇到的问题及其解决方式，包括用户的纠正。
5. **所有用户消息** — 按时间顺序列出每条用户消息（粘贴的大量内容需裁剪）。这是意图的审计轨迹。
6. **待处理任务** — 明确未完成的项目、承诺的后续工作、用户说"稍后"的事情。
7. **当前工作** — 精确记录此时正在进行的工作：哪个步骤、哪个文件、什么状态。
8. **下一步** — 立即的下一个操作，以用户的请求为理由。

规则：
- 不要将完整的文件内容当作真理。只记录某个文件被读取/编辑过这一事实；协作者如果需要再次获取内容会重新读取。陈旧的文件记忆比没有记忆更糟糕。
- 若提供了上一版摘要：只把它仍然有效的结论并入对应章节，不要整段复述或逐条转抄。
- 要具体：路径、名称、命令、id——而不是模糊的引用。
- 仅输出摘要章节，不附加前言。`;

export const CONTINUATION_CONTRACT =
  "从你之前中断的地方继续：完全按照描述接续当前工作和下一步。不要重新询问已回答的问题，不要回顾，不要提及上下文已被压缩。如果你需要上述提到的文件的内容，请重新读取它。";

/** 渲染消息跨度为摘要器文本 */
function renderSpan(span: Message[], budgetChars = SPAN_BUDGET_CHARS): string {
  const lines: string[] = [];
  for (const m of span) {
    const role = m.role;
    if (role === "system" || role === "notice") continue;

    if (role === "tool") {
      let text = textOf(m.content).replace(/\s+/g, " ");
      if (text.length > SPAN_TOOL_RESULT_CLIP)
        text = text.slice(0, SPAN_TOOL_RESULT_CLIP - 1) + "…";
      lines.push(`[tool result] ${text}`);
      continue;
    }

    if (role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        let args = tc.function.arguments ?? "";
        args = args.replace(/\s+/g, " ");
        if (args.length > 200) args = args.slice(0, 199) + "…";
        lines.push(`[assistant → ${tc.function.name}] ${args}`);
      }
    }

    const text = textOf(m.content);
    if (text) lines.push(`[${role}] ${text}`);
  }

  let rendered = lines.join("\n");
  if (rendered.length > budgetChars) {
    rendered = "(…oldest turns elided…)\n" + rendered.slice(-budgetChars);
  }
  return rendered;
}

/** 构建摘要器调用消息 */
function summarizerMessages(span: Message[], priorSummary = ""): Message[] {
  let body = renderSpan(span);
  if (priorSummary) {
    body =
      "[previous compaction summary — fold its still-relevant content into the new summary]\n" +
      priorSummary +
      "\n\n[conversation since]\n" +
      body;
  }
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: body },
  ];
}

/**
 * 摘要器使用的推理强度。
 *
 * 摘要只需结构化复述，不需要深度推理；沿用主模型的 high effort 会让
 * 每次压缩多消耗大量推理 token 与时间。可用 COMPACTION_REASONING_EFFORT 覆盖。
 */
export function summarizerReasoningEffort(): ReasoningEffort | undefined {
  const v = process.env.COMPACTION_REASONING_EFFORT?.toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return "low";
}

/** 调用摘要器 LLM */
export async function summarizeSpan(
  provider: ProviderClient,
  model: string,
  span: Message[],
  priorSummary = "",
  opts: StreamOpts,
): Promise<string> {
  const msgs = summarizerMessages(span, priorSummary);
  // 使用非流式 complete（摘要器不需要流式输出），并限制输出长度
  const chunks = await provider.stream(model, msgs, [], {
    ...opts,
    maxTokens: SUMMARY_MAX_TOKENS,
  });
  let text = "";
  for await (const chunk of chunks) {
    if (chunk.content) text += chunk.content;
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("摘要器返回了空摘要");
  return trimmed;
}

// ==================== 构建压缩状态 ====================

/** 完整构建 CompactionState */
export async function buildState(
  messages: Message[],
  provider: ProviderClient,
  model: string,
  keepTokens: number,
  prior: CompactionState | null = null,
  opts: StreamOpts,
): Promise<CompactionState | null> {
  const boundary = pickBoundary(messages, keepTokens);
  if (boundary === null) return null;
  if (prior !== null && boundary <= prior.boundaryIndex) return null;

  const spanStart = prior?.boundaryIndex ?? 0;
  const span = messages.slice(spanStart, boundary);
  const priorUsers = prior?.userMessages ? [...prior.userMessages] : [];
  const priorSummary = prior?.summaryText ?? "";

  const summary = await summarizeSpan(
    provider,
    model,
    span,
    priorSummary,
    opts,
  );
  const allUsers = [...priorUsers, ...extractUserMessages(span)];
  const { messages: cappedUsers, dropped } = capUserMessages(
    allUsers,
    prior?.userMessagesDropped ?? 0,
  );

  return {
    boundaryIndex: boundary,
    summaryText: summary,
    workingState: extractWorkingState(span),
    userMessages: cappedUsers,
    userMessagesDropped: dropped,
    createdAt: Date.now(),
    modelUsed: model,
    trimmed: false,
  };
}

// ==================== 裁剪降级 ====================

/** 无 LLM 降级：丢弃最旧 ~fraction 的消息 */
export function trimState(
  messages: Message[],
  prior: CompactionState | null = null,
  fraction: number = TRIM_FRACTION,
): CompactionState | null {
  const start = prior?.boundaryIndex ?? 0;
  const remaining = messages.length - start;
  if (remaining <= 2) return null;

  const step = Math.max(1, Math.floor(remaining * fraction));
  const target = start + step;

  // 找到合法的边界（user/assistant 消息，不能是 tool 消息）
  let boundary: number | null = null;
  for (let i = target; i < messages.length; i++) {
    if (messages[i]?.role === "user" || messages[i]?.role === "assistant") {
      boundary = i;
      break;
    }
  }
  if (boundary === null || boundary <= start || boundary >= messages.length)
    return null;

  const span = messages.slice(start, boundary);
  const priorUsers = prior?.userMessages ? [...prior.userMessages] : [];
  const priorSummary = prior?.summaryText ?? "";

  const summary =
    (priorSummary ? priorSummary + "\n\n" : "") +
    "(Older turns were trimmed to fit the context window; no summary is available " +
    "for them. Re-read files and re-run commands if earlier results are needed.)";

  const allUsers = [...priorUsers, ...extractUserMessages(span)];
  const { messages: cappedUsers, dropped } = capUserMessages(
    allUsers,
    prior?.userMessagesDropped ?? 0,
  );

  return {
    boundaryIndex: boundary,
    summaryText: summary,
    workingState: extractWorkingState(span),
    userMessages: cappedUsers,
    userMessagesDropped: dropped,
    createdAt: Date.now(),
    modelUsed: "",
    trimmed: true,
  };
}

// ==================== 压缩块构建 ====================

/** 构建压缩块文本 */
export function compactedBlock(state: CompactionState): string {
  const parts: string[] = [
    "<compacted-history>",
    "Earlier turns of this session were compacted. The summary below is your memory of them.",
    "",
    state.summaryText,
  ];
  if (state.workingState) {
    parts.push("", state.workingState);
  }
  if (state.userMessages.length > 0) {
    parts.push(
      "",
      "## User messages in the compacted span (verbatim, chronological)",
    );
    if (state.userMessagesDropped > 0) {
      parts.push(
        `(${state.userMessagesDropped} earlier user messages omitted — ` +
          "their intent is covered by the summary above)",
      );
    }
    parts.push(...state.userMessages.map((u) => `- ${u}`));
  }
  parts.push("", CONTINUATION_CONTRACT, "</compacted-history>");
  return parts.join("\n");
}

/** 构建 outbound 视图：系统提示词 + 压缩块 + 边界后的完整消息 */
export function applyToOutbound(
  messages: Message[],
  state: CompactionState | null,
): Message[] {
  if (!state) return messages;

  const boundary = state.boundaryIndex;
  if (boundary <= 0 || boundary >= messages.length) return messages;

  const head: Message[] = [];
  if (messages[0]?.role === "system") {
    head.push(messages[0]);
  }
  head.push({ role: "user", content: compactedBlock(state) });

  return [...head, ...messages.slice(boundary)];
}

// ==================== 软阈值：淘汰旧工具结果 ====================

/**
 * 永不淘汰的工具结果。
 *
 * - `explore`：子代理唯一的产出，丢弃等于白跑一次；
 * - 交互类工具：承载用户的明确回答/授权，是后续行为的依据；
 * - `todo_write`：共享进度状态，体积小且必须保持完整。
 */
export const ELIDE_EXEMPT_TOOLS = new Set([
  "explore",
  "ask_user",
  "propose_plan",
  "request_directory",
  "todo_write",
]);

/** 工具结果被淘汰后的占位文本（尽量保留落盘路径，方便按需取回） */
function elidedToolContent(m: Message): string {
  const name = m.tool_call_name || "tool";
  const size = m.content.length;
  const saved = /full output saved to ([^\]]+)/.exec(m.content)?.[1]?.trim();
  return saved
    ? `[old tool result elided: ${name}, ${size} chars; full output saved to ${saved}]`
    : `[old tool result elided: ${name}, ${size} chars; re-run the tool if its content is still needed]`;
}

/** 软阈值淘汰结果 */
export interface ElideResult {
  /** 新的消息数组（未淘汰的条目与原数组共享引用） */
  messages: Message[];
  /** 被淘汰的工具结果条数 */
  elided: number;
  /** 释放的字符数 */
  freedChars: number;
}

/** 内容是否已是淘汰/去重占位符（避免重复处理） */
function isPlaceholder(content: string): boolean {
  return (
    content.startsWith("[old tool result elided") ||
    content.startsWith("[superseded by a later read_file")
  );
}

/**
 * 软阈值时优先淘汰的「一次性消费」工具结果。
 *
 * `git_diff` 反映的是某一时刻的工作区差异，模型读完据此得出结论后，
 * 原文几乎不再被回看——相较于可能反复查阅的 `read_file`，它的价值衰减最快。
 * 因此软阈值一到就先淘汰旧 diff，把保留预算让给别的内容。
 */
export const ONE_SHOT_TOOLS = new Set(["git_diff"]);

/** 一次性结果保留的最近条数（超过的部分直接淘汰） */
export const ONE_SHOT_KEEP_RECENT = 1;

/**
 * 淘汰较早的一次性工具结果，只保留最近 `keepRecent` 条。
 *
 * 纯函数、无状态；只改 outbound 视图。占位符里保留落盘路径（若有），
 * 模型需要原文时可按路径取回或重新执行工具。
 */
export function applyOneShotElision(
  messages: Message[],
  keepRecent: number = ONE_SHOT_KEEP_RECENT,
  tools: Set<string> = ONE_SHOT_TOOLS,
): ElideResult {
  const out = [...messages];
  let seen = 0;
  let elided = 0;
  let freed = 0;

  // 倒序：最近的先计数，超出保留条数的（更早的）才淘汰
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || !tools.has(m.tool_call_name ?? "")) continue;
    if (isPlaceholder(m.content)) continue;

    seen++;
    if (seen <= keepRecent) continue;

    const placeholder = elidedToolContent(m);
    freed += m.content.length - placeholder.length;
    out[i] = { ...m, content: placeholder };
    elided++;
  }

  return elided > 0
    ? { messages: out, elided, freedChars: freed }
    : { messages, elided: 0, freedChars: 0 };
}

/**
 * 淘汰最旧的工具结果，直到剩余总量不超过 keepChars。
 *
 * 只改 outbound 视图、不动持久化历史：tool 消息的 `tool_call_id` 与
 * 对应 assistant 的 `tool_calls` 仍然配对，协议合法。从最新往前累计，
 * 最近的结果完整保留；必要信息可重新执行工具取回。
 *
 * 纯函数、无状态：会话恢复后按同样的规则重算，无需持久化淘汰结果。
 */
export function applyToolResultElision(
  messages: Message[],
  keepChars: number,
  exempt: Set<string> = ELIDE_EXEMPT_TOOLS,
): ElideResult {
  // 先算总量：未超预算直接原样返回（避免无谓的数组拷贝）
  let total = 0;
  for (const m of messages) {
    if (m.role === "tool" && !exempt.has(m.tool_call_name ?? "")) {
      total += m.content.length;
    }
  }
  if (total <= keepChars) return { messages, elided: 0, freedChars: 0 };

  const out = [...messages];
  let budget = 0;
  let elided = 0;
  let freed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    if (exempt.has(m.tool_call_name ?? "")) continue;

    // 最新一条就超预算：部分保留，不能整条丢掉
    if (elided === 0 && budget === 0 && m.content.length > keepChars) {
      const kept = m.content.slice(0, keepChars) + "\n…(truncated)";
      freed += m.content.length - kept.length;
      out[i] = { ...m, content: kept };
      budget = keepChars;
      continue;
    }
    if (budget + m.content.length <= keepChars) {
      budget += m.content.length;
      continue;
    }
    const placeholder = elidedToolContent(m);
    freed += m.content.length - placeholder.length;
    out[i] = { ...m, content: placeholder };
    elided++;
  }
  return { messages: out, elided, freedChars: freed };
}

// ==================== 去重：同一路径的旧 read_file 结果 ====================

/**
 * 归一化工具参数里的文件路径。
 *
 * 只做轻量归一（分隔符、`./` 前缀、重复斜杠），不做绝对路径解析——
 * 去重判断需要的是「同一文件」的等价，而不是工作区内的真实路径。
 */
export function normalizeToolPath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/\/{2,}/g, "/");
}

/**
 * 可能改变文件内容的工具。
 *
 * `apply_patch` / `apply_unified_diff` 的补丁文本里路径不易可靠解析，
 * `run_shell` 也可能通过 sed / git checkout 改文件——一律保守视为写操作：
 * 宁可少淘汰，也不要让模型丢掉「改动前」的内容。
 */
export const MUTATING_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "apply_unified_diff",
  "run_shell",
]);

/** read_file 结果的行区间 */
export interface ReadFileSpan {
  path: string;
  start: number;
  end: number;
}

/**
 * 从 read_file 的工具结果中解析路径与行区间。
 *
 * 结果是 `{ path, start_line, end_line, total_lines, content }` 的 JSON；
 * 被工具结果预算截断时会多一行前缀，先剥掉再解析。整体 JSON 已不可解析时
 * （超长结果被头尾截断）用正则取前几个短字段——它们位于 `content` 之前。
 */
export function parseReadFileSpan(content: string): ReadFileSpan | null {
  const body = content.replace(/^\[tool output truncated:[^\n]*\]\n\n/, "");
  let path: unknown;
  let start: unknown;
  let end: unknown;
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    path = obj.path;
    start = obj.start_line;
    end = obj.end_line;
  } catch {
    const str = (key: string): string | undefined =>
      new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body)?.[1];
    const num = (key: string): number | undefined => {
      const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(body);
      return m ? Number(m[1]) : undefined;
    };
    path = str("path");
    start = num("start_line");
    end = num("end_line");
  }
  if (typeof path !== "string" || !path) return null;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { path, start, end };
}

/** 已读取的行区间（闭区间） */
type Span = [number, number];

/** 把新区间并入集合（合并重叠/相邻区间） */
function addSpan(spans: Span[], start: number, end: number): void {
  spans.push([start, end]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const cur of spans) {
    const last = merged[merged.length - 1];
    if (last && cur[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push([...cur] as Span);
    }
  }
  spans.length = 0;
  spans.push(...merged);
}

/** 区间集合是否完整覆盖 [start, end] */
function coversSpans(spans: Span[], start: number, end: number): boolean {
  return spans.some(([a, b]) => a <= start && b >= end);
}

/** 去重结果 */
export interface DedupResult {
  /** 新的消息数组（未替换的条目与原数组共享引用） */
  messages: Message[];
  /** 被替换掉的旧读取结果条数 */
  elided: number;
}

/**
 * 淘汰「已被后续读取完全覆盖」的 read_file 结果。
 *
 * 模型经常重复读取同一文件（确认改动、回到原文），旧结果对后续推理没有
 * 增量价值，却白占上下文。判定条件：
 *
 * 1. 同一路径（轻量归一后）；
 * 2. 后续读取的区间（可能是多次读取合并后的区间）完整覆盖旧区间——
 *    分段读同一文件的场景不会被误伤；
 * 3. 两次读取之间没有写操作——改动前后的两次读取是不同版本，
 *    丢掉「改动前」的内容会损失信息，此时不去重。
 *
 * 只改 outbound 视图，不修改持久化历史；纯函数、无状态。
 */
export function applyReadFileDedup(messages: Message[]): DedupResult {
  // 快路径：少于两次 read_file 结果时无可去重
  let candidates = 0;
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_name === "read_file") candidates++;
  }
  if (candidates < 2) return { messages, elided: 0 };

  const out = [...messages];
  /** 每个路径已被「写操作之后」的读取覆盖的行区间（倒序扫描：装的是更新的读取） */
  const covered = new Map<string, Span[]>();
  let elided = 0;

  // 倒序：后发生的读取先登记，旧读取若被它覆盖就淘汰——保留最新内容
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;

    if (m.role === "assistant") {
      // 写操作让之前的读取不再可比较：清空覆盖记录（已登记的是写之后的读）
      if (m.tool_calls?.some((tc) => MUTATING_TOOLS.has(tc.function.name))) {
        covered.clear();
      }
      continue;
    }

    if (m.role !== "tool" || m.tool_call_name !== "read_file") continue;

    const span = parseReadFileSpan(m.content);
    if (!span) continue;
    const key = normalizeToolPath(span.path);
    const seen = covered.get(key) ?? [];

    if (coversSpans(seen, span.start, span.end)) {
      out[i] = {
        ...m,
        content: `[superseded by a later read_file of ${span.path} (lines ${span.start}-${span.end})]`,
      };
      elided++;
      // 已被淘汰的结果不再参与后续覆盖判断
      continue;
    }

    addSpan(seen, span.start, span.end);
    covered.set(key, seen);
  }

  return { messages: elided > 0 ? out : messages, elided };
}

// ==================== 溢出检测 ====================

const OVERFLOW_MARKERS = [
  "context_length_exceeded",
  "maximum context length",
  "context window",
  "prompt is too long",
  "input is too long",
  "too many tokens",
  "input length and `max_tokens` exceed",
  "exceeds the maximum number of tokens",
];

/** 检测异常是否为上下文溢出 */
export function isContextOverflow(exc: unknown): boolean {
  const text = String(exc).toLowerCase();
  return OVERFLOW_MARKERS.some((m) => text.includes(m));
}
