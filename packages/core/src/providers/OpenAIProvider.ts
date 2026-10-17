/**
 * LLM Provider
 *
 * 定义引擎与 LLM 之间的抽象接口（ProviderClient），并提供基于
 * OpenAI SDK 的流式实现（OpenAIProvider）。上层 TurnEngine 只依赖
 * ProviderClient 接口，因此可以替换为任意兼容 OpenAI 格式的服务
 * （如 DeepSeek、本地 vLLM 等，通过 OPENAI_BASE_URL 切换）。
 *
 * API 模式（Responses 优先）：
 *   - 默认优先使用 OpenAI Responses API（client.responses.create）。
 *   - 失败分类决定降级（见 `_responsesFailureKind`）：
 *       · "endpoint"（404/405、not supported/unknown endpoint 等）
 *         → 降级 Chat Completions **并按模型缓存**（同一模型后续直走 Chat）
 *       · "param"（阿里兼容模式的 InvalidParameter、模型未开通等）
 *         → 仅本次降级重试 Chat，**不写缓存**（Chat 的参数集不同，可能可用）
 *       · 鉴权 401 / 限流 429 / 5xx / 网络类 → 不降级，原样抛出
 *   - 降级同时覆盖**流内失败**：DashScope 等网关先回 HTTP 200 建流、再在
 *     SSE 里下发 `response.failed`，SDK 不抛错，故在尚未 yield 任何 chunk
 *     时捕获并改走 Chat（已输出内容则绝不重放，避免重复输出）。
 *   - 非标准错误体（顶层 `{code,message,request_id}`）在 fetch 层归一化，
 *     否则 SDK 只会给出 "400 status code (no body)"（见 diagnostics.normalizeErrorFetch）。
 *   - 环境变量 OPENAI_FORCE_API_MODE=responses|chat 可强制指定模式。
 *
 * DeepSeek 内置搜索工具：
 *   - 模型名或 baseURL 含 "deepseek" 时，Responses 路径自动注入
 *     DeepSeek 服务端内置工具 {type:"web_search"}（服务端执行，
 *     无需本地审批），并过滤本地注册的同名 web_search 函数工具，
 *     避免模型在两个同名工具间混淆。
 *   - Chat Completions 路径下 DeepSeek 不支持内置 web_search，
 *     保留本地注册的 web_search 函数工具（现状）。
 *
 * 当设置 logDir 时，每次 LLM 请求会按 reqId 写入独立 JSON 文件，
 * 请求完成后补充响应信息（token 用量、工具调用、错误等）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { sanitizeEmoji } from "../terminal.js";
import { cleanLlmValue, enrichLlmError, isReasoningModel, llmMaxRetries, llmStreamIdleMs, llmTimeoutMs, normalizeBaseURL, normalizeErrorFetch } from "./diagnostics.js";
import { makeSocksFetch, socksAgent, unsupportedProxyHint } from "./proxy.js";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type {
  StreamChunk,
  Message,
  ToolSchema,
  ToolCall,
  TokenUsage,
  ReasoningEffort,
} from "../engine/types.js";
import { RequestOptions } from "openai/core.mjs";

/** stream 方法的可选参数 */
export interface StreamOpts {
  /** 请求 ID（8 位 hex），关联审计日志 */
  reqId: string;
  logTime: string; // 请求时间戳（ISO 8601），关联审计日志
  /**
   * 推理强度（可选）。OpenAI 系模型映射为 Responses 的
   * reasoning.effort / Chat Completions 的 reasoning_effort；
   * DeepSeek 不支持级别控制，自动跳过。
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * 中止信号（可选）。引擎按下「停止」时 abort，用于掐断在飞的流式请求 ——
   * 仅置引擎内部的取消标志位无法结束已静默挂死的网络流。
   */
  signal?: AbortSignal;
  /**
   * 内部字段：流空闲看门狗（由 `stream()` 注入，各流路径复用）。
   * 引擎侧无需感知，请勿在 `stream()` 之外构造。
   */
  idle?: { ms: number; onIdle: () => void };
}

/** 空闲看门狗的竞争结果（用判别字段避免 Promise.race 的类型坍塌） */
type RaceOutcome<T> = { timedOut: true } | { timedOut: false; result: IteratorResult<T> };

/** LLM Provider 抽象接口 */
export interface ProviderClient {
  /**
   * 流式调用 LLM
   *
   * @param model    模型标识
   * @param messages 对话消息（内部 Message 格式）
   * @param tools    可用的工具 Schema（可省略）
   * @param opts     可选参数（如 reqId 用于审计日志关联）
   * @returns 流式 chunk 的异步可迭代对象
   */
  stream(
    model: string,
    messages: Message[],
    tools: ToolSchema[],
    opts: StreamOpts,
  ): Promise<AsyncIterable<StreamChunk>>;

  chat(
    model: string,
    messages: any[],
    options: RequestOptions,
    opts: StreamOpts,
    params?: ChatParams,
  ): Promise<string | null>;
}

/** chat 请求的附加参数（用于会话命名等轻量请求，限制输出长度） */
export interface ChatParams {
  /** 最大输出 token 数（Responses → max_output_tokens；Chat → max_tokens / max_completion_tokens） */
  maxTokens?: number;
}

/**
 * Responses API 的失败（含 SSE 流内 `response.failed` 事件）。
 *
 * 部分网关（阿里云百炼/DashScope 兼容模式等）**先回 200 + 流，再在流里下发
 * `response.failed`**，此时 OpenAI SDK 不会抛错，错误信息里若只剩 message
 * 就丢失了 `code` / `request_id`，既无法判断"端点不支持"（不能降级），
 * 也无法拿出去排查。这里把三样都带在错误对象上。
 */
export class ResponsesApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly type?: string,
    readonly requestId?: string,
  ) {
    const parts = [`Responses API 调用失败: ${message}`];
    if (code) parts.push(`code=${code}`);
    if (requestId) parts.push(`request_id=${requestId}`);
    super(parts.join(" | "));
    this.name = "ResponsesApiError";
  }
}

/** OpenAI-compatible Provider（Responses API 优先，失败降级 Chat Completions） */
export class OpenAIProvider implements ProviderClient {
  /** OpenAI SDK 客户端 */
  private client: OpenAI;
  /** LLM 请求日志根目录（不传则不记录） */
  private _logDir?: string;
  /** 服务端点 baseURL（用于识别 DeepSeek 等特定供应商） */
  private _baseURL: string;
  /** 模型 → API 模式缓存：某模型不支持 Responses 后，后续直走 Chat */
  private _modeByModel: Map<string, "responses" | "chat"> = new Map();

  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    /** LLM 请求日志根目录，按日期分目录，不传则不记录 */
    logDir?: string;
  }) {
    // API Key 优先级：显式参数 > 环境变量 > 占位符（让 SDK 不报错，
    // 实际请求会因无 Key 失败并返回可读错误）
    // 配置统一做归一化：去掉 BOM/CRLF/包裹引号，Base URL 补协议、去端点后缀
    const apiKey = cleanLlmValue(opts.apiKey ?? process.env.OPENAI_API_KEY);
    // baseURL 优先级：显式参数 > 环境变量；两者都缺省时使用 openai SDK
    // 默认端点（https://api.openai.com/v1），因此 baseURL 是可选的。
    const baseURL = normalizeBaseURL(opts.baseURL ?? process.env.OPENAI_BASE_URL);
    if (!apiKey) {
      throw new Error(sanitizeEmoji("❌ 未设置 OPENAI_API_KEY 环境变量"));
    }
    this._baseURL = baseURL ?? "";

    // 网络出口：配置了 SOCKS5 代理时，把 SDK 的内置 fetch 换成 node-fetch + agent，
    // 保证「对话」与「/connect 刷新模型」走同一条链路；若检测到不支持的环境变量代理，
    // 打印可执行提示（避免只看到 Connection error.）。
    const agent = socksAgent();
    const proxyHint = unsupportedProxyHint();
    if (proxyHint) console.warn(`[llm] ${proxyHint}`);
    // 出口链路：SOCKS5 时换成 node-fetch + agent；两者都再套一层
    // normalizeErrorFetch —— 把非标准错误体（阿里兼容模式顶层 {code,message}）
    // 归一化成 SDK 认得的形状，否则用户只会看到 "400 status code (no body)"。
    const baseFetch = agent
      ? (makeSocksFetch(agent) as unknown as (input: any, init?: any) => Promise<any>)
      : ((input: any, init?: any) => globalThis.fetch(input, init)) as unknown as (
          input: any,
          init?: any,
        ) => Promise<any>;

    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      timeout: llmTimeoutMs(),
      maxRetries: llmMaxRetries(),
      // 类型：SDK 期望 (RequestInfo, RequestInit) => Promise<Response>，
      // node-fetch 的 Response 与 DOM Response 结构不同，此处显式放宽
      fetch: normalizeErrorFetch(baseFetch) as never,
    });

    if (opts.logDir) {
      this._logDir = opts.logDir;
      fs.mkdirSync(opts.logDir, { recursive: true });
    }
  }

  // =====================================================================
  // API 模式探测与降级
  // =====================================================================

  /**
   * 解析指定模型的 API 模式。
   *
   * 优先级：环境变量 OPENAI_FORCE_API_MODE（responses|chat）强制指定
   * > 运行时降级缓存（该模型曾因"不支持"失败而缓存为 chat）
   * > 默认 responses（Responses 优先）。
   */
  private _resolveMode(model: string): "responses" | "chat" {
    const forced = process.env.OPENAI_FORCE_API_MODE?.toLowerCase();
    if (forced === "responses" || forced === "chat") return forced;
    return this._modeByModel.get(model) ?? "responses";
  }

  /**
   * Responses 失败的分类（决定「能不能改走 Chat Completions」以及要不要缓存降级）。
   *
   * @param connectionStage 失败是否发生在连接阶段（首字节之前）。
   *   流内失败（已建立 SSE 后才收到 response.failed）只在**尚未 yield 任何
   *   chunk** 时才允许重试，否则会向用户重复输出前半段内容。
   *
   * 返回值：
   *   - "endpoint"：该端点/模型不支持 Responses → 降级 Chat 并写入缓存
   *   - "param"：参数或模型不被接受（如阿里兼容模式的 InvalidParameter）
   *     → 本次改走 Chat（Chat 的参数集不同，可能可用），但不写缓存
   *   - null：鉴权(401)/限流(429)/服务端(5xx)/网络类 → 不降级，原样抛出
   */
  private _responsesFailureKind(
    err: unknown,
    connectionStage: boolean,
  ): "endpoint" | "param" | null {
    const status = (err as { status?: number }).status;
    const code = String((err as { code?: unknown }).code ?? "");
    const msg = err instanceof Error ? err.message : String(err);
    const text = `${code} ${msg}`;

    // 鉴权 / 限流 / 服务端 / 网络：换端点也是同样结果，不降级
    if (status === 401 || status === 429 || (status ?? 0) >= 500) return null;

    // 连接阶段的 404/405：端点不存在 → 明确不支持
    if (connectionStage && (status === 404 || status === 405)) return "endpoint";

    if (/not[_\s]*support|unsupported|unknown[_\s]*(endpoint|path|model)|not[_\s]*implemented|does[_\s]*not[_\s]*exist|no[_\s]*such/i.test(text)) {
      return "endpoint";
    }
    if (/invalid[_\s]*parameter|invalidparameter|required[_\s]+parameter|missing[_\s]+parameter|invalid[_\s]*request|invalid[_\s]*model|model[_\s]*not[_\s]*found/i.test(text)) {
      return "param";
    }
    // 连接阶段的其它 4xx：大概率是 Responses 的参数集不被接受
    if (connectionStage && status !== undefined && status >= 400 && status < 500) {
      return "param";
    }
    return null;
  }

  /** 识别 DeepSeek 供应商（模型名或 baseURL 含 "deepseek"） */
  private _isDeepSeek(model: string): boolean {
    return /deepseek/i.test(model) || /deepseek/i.test(this._baseURL);
  }

  // =====================================================================
  // 非流式调用（会话名称生成等轻量场景）
  // =====================================================================

  /**
   * 暂时不用写日志，目前只用于名称生成
   *
   * 与 stream 一致：Responses API 优先，不支持时降级 Chat Completions
   * （降级决策写入缓存，后续请求直走 Chat）。
   *
   * @param model    模型标识
   * @param messages 对话消息
   * @param options  请求选项（透传给 SDK）
   * @param opts     reqId 等审计信息
   * @returns 模型回复文本；失败返回 null
   */
  public async chat(
    model: string,
    messages: ChatCompletionMessageParam[],
    options: RequestOptions,
    opts: StreamOpts,
    params?: ChatParams,
  ): Promise<string | null> {
    const startTime = Date.now();
    const reqId = opts.reqId;
    try {
      // 审计日志：写入请求参数
      this._writeRequestLog(reqId, model, messages, undefined, opts.logTime);

      // ---- Responses API 路径 ----
      if (this._resolveMode(model) === "responses") {
        try {
          const response = await this.client.responses.create({
            model,
            input: this._toResponsesInput(messages as unknown as Message[]),
            // 推理强度：DeepSeek 不支持，跳过
            ...(opts.reasoningEffort && !this._isDeepSeek(model)
              ? { reasoning: { effort: opts.reasoningEffort } }
              : {}),
            // 限制输出长度（轻量请求用）
            ...(params?.maxTokens
              ? { max_output_tokens: params.maxTokens }
              : {}),
          } as any);
          this._appendResponse(reqId, startTime, { response }, opts.logTime);
          const text = (response as unknown as { output_text?: string }).output_text;
          if (text && text.trim()) return text;
          // Responses 返回空文本（部分推理模型的 output_text 为空）→ 本次降级到
          // Chat Completions 重试（不改缓存，避免影响流式主路径）。
          console.warn(
            `[llm] ${model} Responses API 返回空文本，本次改用 Chat Completions 重试`,
          );
        } catch (err) {
          // "不支持"/"参数不被接受"类错误 → 落到 Chat 路径重试；其它错误直接抛出
          const kind = this._responsesFailureKind(err, true);
          if (kind) {
            if (kind === "endpoint") this._modeByModel.set(model, "chat");
            console.warn(
              `[llm] ${model} Responses API 不可用(${kind})，改用 Chat Completions (${String(
                (err as Error)?.message ?? err,
              ).slice(0, 160)})`,
            );
          } else {
            throw err;
          }
        }
      }

      // ---- Chat Completions 路径（默认或降级后）----
      const response = await this.client.chat.completions.create(
        {
          model,
          messages,
          // 推理强度：DeepSeek 不支持，跳过
          ...(opts.reasoningEffort && !this._isDeepSeek(model)
            ? { reasoning_effort: opts.reasoningEffort }
            : {}),
          // 限制输出长度：o 系列 / gpt-5 推理模型仅支持 max_completion_tokens
          // （判断与 probeModel 共用 isReasoningModel，避免两处各写一份而漂移）
          ...(params?.maxTokens
            ? isReasoningModel(model)
              ? { max_completion_tokens: params.maxTokens }
              : { max_tokens: params.maxTokens }
            : {}),
        },
        options,
      );
      this._appendResponse(reqId, startTime, { response }, opts.logTime);
      return response.choices[0].message.content;
    } catch (err) {
      console.error("调用失败:", err);
      // 连接阶段失败：补充错误到日志
      this._appendResponse(reqId, startTime, {
        error: err instanceof Error ? err.message : String(err),
      }, opts.logTime);
    }
    return null;
  }

  // =====================================================================
  // 流式调用
  // =====================================================================

  /** 发起流式对话请求，返回包装后的 chunk 迭代器 */
  async stream(
    model: string,
    messages: Message[],
    tools: ToolSchema[] = [],
    opts: StreamOpts,
  ): Promise<AsyncIterable<StreamChunk>> {
    const startTime = Date.now();
    const reqId = opts.reqId;
    // 审计日志：写入请求参数
    this._writeRequestLog(reqId, model, messages, tools, opts.logTime);

    // 中止链路：引擎「停止」→ opts.signal.abort() → 底层 SDK 请求中断。
    // 空闲看门狗复用同一个 controller：chunk 间隔超时同样中止请求（见 _trackedStream）。
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const reqOpts: StreamOpts = {
      ...opts,
      signal: controller.signal,
      idle: { ms: llmStreamIdleMs(), onIdle: () => controller.abort() },
    };
    const requestOptions = { signal: controller.signal } as RequestOptions;

    // ---- Responses API 路径（默认优先）----
    if (this._resolveMode(model) === "responses") {
      try {
        // stream:true 时 SDK 返回 Stream<ResponseStreamEvent>；
        // 参数经 as any 传入后 TS 匹配到非流式 overload，此处显式收窄
        const rawStream = (await this.client.responses.create({
          model,
          input: this._toResponsesInput(messages),
          // 工具 schema（Responses 扁平格式；DeepSeek 额外注入内置 web_search）
          tools: this._toResponsesTools(tools, model),
          // 推理强度：DeepSeek 不支持，跳过
          ...(opts.reasoningEffort && !this._isDeepSeek(model)
            ? { reasoning: { effort: opts.reasoningEffort } }
            : {}),
          stream: true,
        } as any, requestOptions)) as unknown as AsyncIterable<unknown>;
        // 流内失败（HTTP 200 + response.failed）的降级在此处理
        return this._responsesStream(reqId, startTime, rawStream, {
          model,
          messages,
          tools,
          opts: reqOpts,
        });
      } catch (err) {
        const kind = this._responsesFailureKind(err, true);
        if (kind) {
          // 连接阶段可降级错误："不支持"类缓存决策；参数类仅本次降级
          if (kind === "endpoint") this._modeByModel.set(model, "chat");
          console.warn(
            `[llm] ${model} Responses API 不可用(${kind})，改用 Chat Completions (${String(
              (err as Error)?.message ?? err,
            ).slice(0, 160)})`,
          );
        } else {
          // 其它错误（鉴权/超时等）：记录日志后原样抛出，不降级
          this._appendResponse(reqId, startTime, {
            error: err instanceof Error ? err.message : String(err),
          }, opts.logTime);
          // 补「端点 + 底层错误码」，便于定位（DNS/TLS/代理/超时）
          throw enrichLlmError(err, this._baseURL);
        }
      }
    }

    return this._chatStream(reqId, startTime, model, messages, tools, reqOpts);
  }

  /**
   * Responses 流 + 流内失败降级。
   *
   * 阿里云百炼（DashScope 兼容模式）等网关在模型/参数不被接受时，
   * **先回 HTTP 200 建流，再下发 `response.failed` 事件**，SDK 不抛错，
   * 因此 `stream()` 里的连接阶段降级判定完全不会触发 —— 用户只看到一句
   * "Responses API 调用失败"，且永远不会走 Chat。这里在**尚未 yield 任何
   * chunk 之前**捕获该失败并按 `_responsesFailureKind` 降级重发。
   *
   * 安全边界：一旦已向引擎吐出过任何 chunk（正文/思考/工具调用），绝不重放，
   * 否则用户会看到重复输出 —— 此时原样抛出。
   */
  private async *_responsesStream(
    reqId: string,
    startTime: number,
    rawStream: AsyncIterable<unknown>,
    ctx: { model: string; messages: Message[]; tools: ToolSchema[]; opts: StreamOpts },
  ): AsyncIterable<StreamChunk> {
    let emitted = false;
    try {
      for await (const chunk of this._trackedStream(
        reqId,
        startTime,
        rawStream,
        "responses",
        ctx.opts.logTime,
        ctx.opts.idle,
      )) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const kind = emitted ? null : this._responsesFailureKind(err, false);
      if (!kind) throw enrichLlmError(err, this._baseURL);
      if (kind === "endpoint") this._modeByModel.set(ctx.model, "chat");
      console.warn(
        `[llm] ${ctx.model} Responses 流内失败(${kind})，改用 Chat Completions (${String(
          (err as Error)?.message ?? err,
        ).slice(0, 160)})`,
      );
      try {
        yield* this._chatStream(
          reqId,
          Date.now(),
          ctx.model,
          ctx.messages,
          ctx.tools,
          ctx.opts,
        );
      } catch (fallbackErr) {
        // 降级也失败：保留 Responses 的原始失败作为 cause（两边信息都要能看到）
        if (fallbackErr instanceof Error && !fallbackErr.cause) {
          try {
            fallbackErr.cause = err;
          } catch {
            // cause 只读时忽略
          }
        }
        throw fallbackErr;
      }
    }
  }

  /** Chat Completions 流式路径（默认或 Responses 降级后） */
  private async *_chatStream(
    reqId: string,
    startTime: number,
    model: string,
    messages: Message[],
    tools: ToolSchema[],
    opts: StreamOpts,
  ): AsyncIterable<StreamChunk> {
    const openaiMessages = this._toOpenAIMessages(messages);

    let rawStream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      rawStream = await this.client.chat.completions.create({
        model,
        messages: openaiMessages,
        // 工具 schema 列表（若为空则模型不会发起工具调用）
        tools: tools?.map((t) => ({
          type: "function" as const,
          function: t.function,
        })),
        // 推理强度：DeepSeek 不支持，跳过
        ...(opts.reasoningEffort && !this._isDeepSeek(model)
          ? { reasoning_effort: opts.reasoningEffort }
          : {}),
        stream: true,
        // 要求返回 Token 用量统计（在流结束前的一个 chunk 中携带）
        stream_options: { include_usage: true },
      }, { signal: opts.signal });
    } catch (err) {
      // 连接阶段失败：补充错误到日志
      this._appendResponse(reqId, startTime, {
        error: err instanceof Error ? err.message : String(err),
      }, opts.logTime);
      throw enrichLlmError(err, this._baseURL);
    }

    yield* this._trackedStream(reqId, startTime, rawStream, "chat", opts.logTime, opts.idle);
  }

  // =====================================================================
  // 消息 / 工具格式转换
  // =====================================================================

  /** 将内部 Message 转换为 OpenAI Chat Completions 格式 */
  private _toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return (
      messages
        // notice 消息仅用于展示，不发给模型
        .filter((m) => m.role !== "notice")
        .map((m) => {
          const base: Record<string, unknown> = {
            role: m.role,
            content: m.content,
          };
          if (m.tool_calls) base.tool_calls = m.tool_calls;
          if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
          return base as unknown as ChatCompletionMessageParam;
        })
    );
  }

  /**
   * 将内部 Message 转换为 OpenAI Responses API 的 input items。
   *
   * 映射规则（对齐 DeepSeek/OpenAI Responses 格式）：
   *   - system/user → message item，内容为 input_text 块
   *   - assistant    → message item，内容为 output_text 块；
   *                    携带的 tool_calls 追加为 function_call items
   *                    （DeepSeek 会把 function_call 归并到相邻
   *                    assistant 消息）
   *   - tool         → function_call_output item（call_id 关联调用）
   *   - notice       → 过滤（仅展示，不发模型）
   */
  private _toResponsesInput(messages: Message[]): unknown[] {
    const items: unknown[] = [];

    for (const m of messages) {
      if (m.role === "notice") continue;

      if (m.role === "tool") {
        // 工具执行结果：function_call_output
        items.push({
          type: "function_call_output",
          call_id: m.tool_call_id ?? "",
          output: m.content ?? "",
        });
        continue;
      }

      if (m.role === "system" || m.role === "user" || m.role === "assistant") {
        // 常规消息：system/user 用 input_text，assistant 用 output_text
        const textBlockType = m.role === "assistant" ? "output_text" : "input_text";
        items.push({
          role: m.role,
          content: [{ type: textBlockType, text: m.content ?? "" }],
        });

        // assistant 的历史工具调用 → 追加 function_call items
        if (m.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) {
            items.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        }
      }
    }

    return items;
  }

  /**
   * 将内部 ToolSchema 列表转换为 Responses API 的 tools 格式。
   *
   * - function 工具：Chat 嵌套格式 {type:"function",function:{...}}
   *   扁平化为 Responses 格式 {type:"function",name,description,parameters}
   * - DeepSeek：额外注入服务端内置工具 {type:"web_search"}，
   *   并过滤本地注册的同名 web_search 函数工具（避免模型混淆）
   *
   * 注：Chat Completions 路径不经过本方法（该路径下 DeepSeek 不支持
   * 内置 web_search，保留本地注册的 web_search 函数工具）。
   */
  private _toResponsesTools(tools: ToolSchema[], model: string): unknown[] {
    const out: unknown[] = [];

    const isDeepSeek = this._isDeepSeek(model);

    for (const t of tools) {
      // DeepSeek 场景：本地 web_search 函数工具让位于内置 web_search
      if (isDeepSeek && t.function.name === "web_search") continue;
      out.push({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      });
    }

    // DeepSeek：注入服务端内置搜索工具（服务端执行，无需本地审批）
    if (isDeepSeek) {
      out.push({ type: "web_search" });
    }

    return out;
  }

  // =====================================================================
  // 审计日志
  // =====================================================================

  /**
   * 写入请求日志的初始 JSON（仅含请求参数，后续会补充响应）。
   *
   * 文件路径：{logDir}/{YYYY-MM-DD}/{reqId}.json
   * logTime 为请求时刻的 ISO 字符串（决定日志归档日期），
   * 由调用方按请求传入，避免并发请求互相覆盖归档日期。
   */
  private _writeRequestLog(
    reqId: string,
    model: string,
    messages: any[],
    tools: ToolSchema[] | undefined,
    logTime: string,
  ): void {
    if (!this._logDir) return;
    try {
      const today = logTime?.split("T")[0]!;
      const dir = path.join(this._logDir, today);
      fs.mkdirSync(dir, { recursive: true });

      const entry = {
        reqId,
        ts: logTime,
        request: {
          model,
          messageCount: messages.length,
          messages,
          toolCount: tools?.length ?? 0,
          toolNames: tools?.map((t) => t.function.name) ?? [],
        },
      };

      fs.writeFileSync(
        path.join(dir, `${reqId}.json`),
        JSON.stringify(entry, null, 2),
        "utf-8",
      );
    } catch (e) {
      // 日志写入失败不影响核心逻辑
      console.error(e);
    }
  }

  /**
   * 流完成或异常时，补充响应信息到日志 JSON 文件。
   *
   * 读取已有文件并追加 response / error / elapsedMs 字段。
   * logTime 为请求时刻的 ISO 字符串（决定日志归档日期），
   * 由调用方按请求传入，避免并发请求互相覆盖归档日期。
   */
  private _appendResponse(
    reqId: string,
    startTime: number,
    data: {
      response?: any;
      error?: string;
    },
    logTime: string,
  ): void {
    if (!this._logDir) return;
    try {
      const today = logTime?.split("T")[0]!;
      const filePath = path.join(this._logDir, today, `${reqId}.json`);
      if (!fs.existsSync(filePath)) return;

      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.elapsedMs = Date.now() - startTime;

      if (data.response) {
        entry.response = data.response;
      }
      if (data.error) {
        entry.error = data.error;
      }

      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
    } catch (e) {
      // 日志写入失败不影响核心逻辑
      console.error(e);
    }
  }

  // =====================================================================
  // 流包装（Chat Completions / Responses 两条路径共用外层）
  // =====================================================================

  /**
   * 流空闲看门狗：相邻两个 chunk 之间超过 idleMs 无数据即视为网关静默断供，
   * 先 onIdle() 中止底层请求，再抛错结束迭代。
   *
   * 用 Promise.race 而不只依赖 abort：底层 HTTP 实现未必响应 signal，
   * 此时引擎侧仍能退出等待，不会永久卡在 running 状态。
   */
  private async *_withIdleTimeout<T>(
    source: AsyncIterable<T>,
    idleMs: number,
    onIdle: () => void,
  ): AsyncIterable<T> {
    const iter = source[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const idle = new Promise<RaceOutcome<T>>((resolve) => {
          timer = setTimeout(() => {
            onIdle();
            resolve({ timedOut: true });
          }, idleMs);
        });
        const next = iter.next();
        let outcome: RaceOutcome<T>;
        try {
          outcome = await Promise.race([
            next.then((result) => ({ timedOut: false as const, result })),
            idle,
          ]);
        } finally {
          clearTimeout(timer);
          timer = undefined;
        }
        if (outcome.timedOut) {
          // 被中止的底层流稍后会 reject：挂个空 catch，避免 unhandled rejection
          void next.catch(() => undefined);
          throw new Error(`LLM 响应流空闲超时（${idleMs}ms 无数据），已中止本次请求`);
        }
        if (outcome.result.done) return;
        yield outcome.result.value;
      }
    } finally {
      clearTimeout(timer);
      // 消费方提前退出（引擎中断 / break）：关闭底层流，释放连接
      if (typeof iter.return === "function") {
        void Promise.resolve(iter.return(undefined as never)).catch(() => undefined);
      }
    }
  }

  /**
   * 包装 _wrapStream / _wrapResponsesStream：在流结束时补充响应日志；
   * 异常时补充错误日志。
   *
   * @param kind 流来源（responses / chat），决定用哪个底层解析器
   */
  private async *_trackedStream(
    reqId: string,
    startTime: number,
    rawStream: AsyncIterable<unknown>,
    kind: "responses" | "chat",
    logTime: string,
    idle?: { ms: number; onIdle: () => void },
  ): AsyncIterable<StreamChunk> {
    let fullText = "";
    let fullReasoning = "";
    // 空闲看门狗包在最内层（原始 SDK 流之上）：外层各解析器仍在正常等待，
    // 超时错误可沿链路传播到引擎，不会留下无人接管的挂起 Promise。
    const source = idle
      ? this._withIdleTimeout(rawStream, idle.ms, idle.onIdle)
      : rawStream;
    // 按流来源选择解析器（两种解析器输出契约一致）
    const wrapped =
      kind === "responses"
        ? this._wrapResponsesStream(source)
        : this._wrapStream(
            source as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
          );
    try {
      for await (const chunk of wrapped) {
        // 累积文本 / 推理内容（最终 chunk 的 content/reasoning 为 null）
        if (chunk.content) fullText += chunk.content;
        if (chunk.reasoning) fullReasoning += chunk.reasoning;

        yield chunk;

        // 最终 chunk（携带 finishReason / toolCalls）→ 补充完整响应日志
        if (chunk.finishReason) {
          this._appendResponse(reqId, startTime, {
            response: {
              text: fullText.slice(0, 1000) || undefined,
              reasoning: fullReasoning.slice(0, 500) || undefined,
              usage: chunk.usage ?? undefined,
              finishReason: chunk.finishReason,
              toolCalls: chunk.toolCalls?.map((tc) => tc.name) ?? undefined,
            },
          }, logTime);
        }
      }
    } catch (err) {
      this._appendResponse(reqId, startTime, {
        error: err instanceof Error ? err.message : String(err),
      }, logTime);
      throw err;
    }
  }

  /**
   * 将 OpenAI 流式响应包装为 async iterable
   *
   * 主要工作：
   *   - 逐 chunk 提取文本增量 / 推理增量并即时 yield
   *   - 按 index 累积工具调用片段（OpenAI 会把工具参数分多个 chunk 下发，
   *     需要按 index 拼接成完整的 JSON 字符串）
   *   - 流结束时汇总 usage 与 finishReason，yield 最终 chunk
   */
  private async *_wrapStream(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ): AsyncIterable<StreamChunk> {
    let text = "";
    let reasoning = "";
    // 工具调用累积表：index → { id, name, args 片段拼接 }
    const toolAccum: Map<number, { id: string; name: string; args: string }> =
      new Map();
    let usage: TokenUsage | null = null;
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // 提取 usage（带 cache 明细）。兼容两种缓存命中字段：
      //   - OpenAI：prompt_tokens_details.cached_tokens
      //   - DeepSeek：prompt_cache_hit_tokens
      if (chunk.usage) {
        const usageRaw = chunk.usage as unknown as Record<string, unknown>;
        const cachedOpenAI = (usageRaw.prompt_tokens_details as
          | Record<string, number>
          | undefined)?.cached_tokens;
        const cachedDeepSeek = usageRaw.prompt_cache_hit_tokens as
          | number
          | undefined;
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cacheRead: cachedOpenAI ?? cachedDeepSeek ?? 0,
          cacheWrite: 0,
        };
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 推理内容 (reasoning_content / reasoning)：逐段 yield 给上层展示
      const reasoningContent = (delta as Record<string, unknown>)[
        "reasoning_content"
      ] as string | undefined;
      if (reasoningContent) {
        reasoning += reasoningContent;
        yield {
          content: null,
          reasoning: reasoningContent,
          toolCalls: null,
          usage: null,
          finishReason: null,
        };
      }

      // 文本增量
      if (delta.content) {
        text += delta.content;
        yield {
          content: delta.content,
          reasoning: null,
          toolCalls: null,
          usage: null,
          finishReason: null,
        };
      }

      // 工具调用增量：按 index 归并拼接（id/name 可能只出现在首个片段）
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        const acc = toolAccum.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAccum.set(idx, acc);
      }

      // 捕获结束原因
      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    // 构建最终的 ToolCall 列表（按 index 排序，并解析参数 JSON；
    // 解析失败时保留原始字符串兜底）
    const toolCalls: ToolCall[] = [];
    for (const [, acc] of [...toolAccum.entries()].sort(([a], [b]) => a - b)) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(acc.args);
      } catch {
        args = { _raw: acc.args };
      }
      toolCalls.push({ id: acc.id, name: acc.name, arguments: args });
    }

    // 最终 chunk — 流结束：携带完整工具调用列表、用量与结束原因
    yield {
      content: null,
      reasoning: null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage,
      finishReason,
    };
  }

  /**
   * 将 Responses API 流式事件包装为 async iterable（输出契约与
   * _wrapStream 完全一致）。
   *
   * 事件处理：
   *   - response.output_text.delta → 文本增量
   *   - response.reasoning_text.delta / reasoning_summary_text.delta
   *     → 推理增量（DeepSeek 用前者，OpenAI 用后者）
   *   - response.output_item.added → 捕获 function_call item
   *     （id/name/初始 arguments）；web_search_call item 仅记录日志
   *     （服务端自包含：搜索→生成答案在同一流内完成，不产出 ToolCall）
   *   - response.function_call_arguments.delta/done → 按 item_id
   *     拼接 / 覆盖参数 JSON
   *   - response.web_search_call.* → DeepSeek 内置搜索状态事件，仅日志
   *   - response.completed → 提取 usage 与 status，yield 最终 chunk
   *   - response.failed → 抛出错误（含响应错误信息）
   */
  private async *_wrapResponsesStream(
    stream: AsyncIterable<unknown>,
  ): AsyncIterable<StreamChunk> {
    let text = "";
    let reasoning = "";
    // 工具调用累积表：call_id → { id, name, args }
    const toolAccum: Map<string, { id: string; name: string; args: string }> =
      new Map();
    let usage: TokenUsage | null = null;
    let finishReason: string | null = null;

    for await (const ev of stream) {
      const event = ev as { type?: string; [key: string]: unknown };
      const type = event.type ?? "";

      switch (type) {
        // ---- 文本增量 ----
        case "response.output_text.delta": {
          const delta = event.delta as string;
          if (delta) {
            text += delta;
            yield {
              content: delta,
              reasoning: null,
              toolCalls: null,
              usage: null,
              finishReason: null,
            };
          }
          break;
        }

        // ---- 推理增量（DeepSeek / OpenAI 两种事件名）----
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta": {
          const delta = event.delta as string;
          if (delta) {
            reasoning += delta;
            yield {
              content: null,
              reasoning: delta,
              toolCalls: null,
              usage: null,
              finishReason: null,
            };
          }
          break;
        }

        // ---- 输出 item 开始 ----
        case "response.output_item.added": {
          const item = event.item as Record<string, unknown>;
          if (item?.type === "function_call") {
            // 函数调用：注册到累积表（id 可能出现在 arguments delta 前）
            const id = String(item.call_id ?? item.id ?? "");
            const name = String(item.name ?? "");
            const args = String(item.arguments ?? "");
            toolAccum.set(id, { id, name, args });
          } else if (item?.type === "web_search_call") {
            // DeepSeek 内置搜索：服务端执行，仅记录日志
            console.log(
              `[llm] 内置 web_search 调用: ${JSON.stringify(item).slice(0, 300)}`,
            );
          }
          break;
        }

        // ---- 函数调用参数流 ----
        case "response.function_call_arguments.delta": {
          const itemId = String(event.item_id ?? "");
          const delta = event.delta as string;
          const acc = toolAccum.get(itemId);
          if (acc && delta) acc.args += delta;
          break;
        }
        case "response.function_call_arguments.done": {
          // done 事件携带完整参数，直接覆盖
          const itemId = String(event.item_id ?? "");
          const args = event.arguments as string;
          const acc = toolAccum.get(itemId);
          if (acc && args) acc.args = args;
          break;
        }
        case "response.output_item.done": {
          // 兜底：function_call item 完成时若参数为空则补全
          const item = event.item as Record<string, unknown>;
          if (item?.type === "function_call") {
            const id = String(item.call_id ?? item.id ?? "");
            const acc = toolAccum.get(id);
            const args = String(item.arguments ?? "");
            if (acc && !acc.args && args) acc.args = args;
            if (acc && !acc.name && item.name) acc.name = String(item.name);
          }
          break;
        }

        // ---- DeepSeek 内置 web_search 状态事件（仅日志）----
        case "response.web_search_call.in_progress":
        case "response.web_search_call.searching":
        case "response.web_search_call.completed":
          console.log(`[llm] 内置 web_search 状态: ${type}`);
          break;

        // ---- 流结束事件 ----
        case "response.completed": {
          const resp = event.response as Record<string, unknown>;
          usage = this._responsesUsage(resp?.usage);
          finishReason = resp?.status === "completed" ? "stop" : null;
          break;
        }
        case "response.incomplete": {
          // 输出被截断（如达到 max_output_tokens）
          const resp = event.response as Record<string, unknown>;
          usage = this._responsesUsage(resp?.usage);
          finishReason = "length";
          break;
        }
        case "response.failed": {
          // 流内失败：保留 code / type / request_id，供上层判定能否降级到 Chat
          throw this._responsesFailure(event.response);
        }
        // 部分网关（含 OpenAI 兼容代理）用独立 error 事件下发流内错误
        case "error": {
          const e = event.error as Record<string, unknown> | undefined;
          throw new ResponsesApiError(
            String(e?.message ?? event.message ?? "未知错误"),
            typeof e?.code === "string" ? e.code : undefined,
            typeof e?.type === "string" ? e.type : undefined,
            typeof event.request_id === "string" ? event.request_id : undefined,
          );
        }
      }
    }

    // 构建最终的 ToolCall 列表（解析参数 JSON；失败时保留原始字符串兜底）
    const toolCalls: ToolCall[] = [];
    for (const [, acc] of toolAccum) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(acc.args);
      } catch {
        args = { _raw: acc.args };
      }
      toolCalls.push({ id: acc.id, name: acc.name, arguments: args });
    }

    // 最终 chunk — 流结束：携带完整工具调用列表、用量与结束原因
    yield {
      content: null,
      reasoning: null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage,
      finishReason,
    };
  }

  /**
   * 从 `response.failed` 事件的 response 对象构造错误。
   *
   * 保留 `error.code` / `error.type` / `request_id`：阿里兼容模式下
   * 典型返回是 `{code:"InvalidParameter", message:"Required parameter(s)
   * missing or invalid", request_id:"..."}`，只有 message 时既无法判断
   * 能否降级，也无从排查。
   */
  private _responsesFailure(resp: unknown): ResponsesApiError {
    const r = (resp ?? {}) as Record<string, unknown>;
    const e = (r.error ?? {}) as Record<string, unknown>;
    return new ResponsesApiError(
      String(e.message ?? "未知错误"),
      typeof e.code === "string" ? e.code : undefined,
      typeof e.type === "string" ? e.type : undefined,
      typeof r.request_id === "string"
        ? r.request_id
        : typeof r.id === "string"
          ? r.id
          : undefined,
    );
  }

  /**
   * Responses API 的 usage → 标准化 TokenUsage。
   *
   * usage 结构：{ input_tokens, output_tokens,
   *   input_tokens_details: { cached_tokens } }
   */
  private _responsesUsage(u: unknown): TokenUsage | null {
    if (!u || typeof u !== "object") return null;
    const raw = u as Record<string, unknown>;
    const details = raw.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    return {
      input: Number(raw.input_tokens ?? 0),
      output: Number(raw.output_tokens ?? 0),
      cacheRead: Number(details?.cached_tokens ?? 0),
      cacheWrite: 0,
    };
  }
}
