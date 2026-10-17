/**
 * 自动上下文压缩 (对齐 Python 版 compaction.py)
 *
 * 当 outbound 消息历史接近 LLM 上下文窗口限制时，将旧的消息转换为
 * (a) LLM 生成的摘要 + (b) 机械提取的当前工作状态，保留最近的消息不变。
 * 持久化的对话历史永不被修改——只影响发送给模型的内容。
 */

import type { Message, TokenUsage } from "./types.js";
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

/** 摘要器调用的 max_tokens */
const SUMMARY_MAX_TOKENS = 3_000;

/** 渲染给摘要器的 tool 结果最大字符数 */
const SPAN_TOOL_RESULT_CLIP = 400;
const SPAN_BUDGET_CHARS = 400_000;

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

/** 是否需要压缩 */
export function shouldCompact(
  signal: number,
  contextWindow?: number | null,
  thresholdPct?: number,
  capTokens?: number | null,
): boolean {
  return signal >= triggerTokens(contextWindow, thresholdPct, capTokens);
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

/** 调用摘要器 LLM */
export async function summarizeSpan(
  provider: ProviderClient,
  model: string,
  span: Message[],
  priorSummary = "",
  opts: StreamOpts,
): Promise<string> {
  const msgs = summarizerMessages(span, priorSummary);
  // 使用非流式 complete（摘要器不需要流式输出）
  const chunks = await provider.stream(model, msgs, [], opts);
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
