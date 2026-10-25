/**
 * OpenAIProvider 单元测试 — Responses API 优先与降级逻辑
 *
 * 通过替换 provider 内部 client 的 responses / chat.completions
 * 方法来 mock 网络层（不发起真实请求），覆盖：
 *   - Responses 流事件解析（文本 / 推理 / 函数调用参数拼接 / usage）
 *   - 不支持 Responses 时降级 Chat Completions 并按模型缓存
 *   - 非"不支持"错误（鉴权等）不降级
 *   - DeepSeek 内置 web_search 注入 + 本地同名工具过滤
 *   - Responses input / tools 格式转换
 *   - chat()（非流式）的 Responses 路径与降级
 *   - OPENAI_FORCE_API_MODE 强制模式
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";
import type { Message, StreamChunk, ToolSchema } from "../src/engine/types.js";

/** 构造 provider 并替换内部 client 的网络方法为 mock */
function makeProvider() {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    baseURL: "https://api.example.com",
  });
  const client = (provider as any).client as Record<string, any>;
  const responsesCreate = vi.fn();
  const chatCreate = vi.fn();
  client.responses = { create: responsesCreate };
  client.chat = { completions: { create: chatCreate } };
  return { provider, responsesCreate, chatCreate };
}

/** 生成 Responses 风格事件的异步可迭代对象 */
async function* eventsOf(...events: unknown[]): AsyncIterable<unknown> {
  yield* events;
}

/** 生成 Chat Completions 风格的流式 chunk */
async function* chatChunksOf(...chunks: unknown[]): AsyncIterable<unknown> {
  yield* chunks;
}

/** 收集流式输出为 StreamChunk 数组 */
async function collect(
  iter: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

/** 模拟 SDK 的 APIError（带 status 字段） */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const OPTS = { reqId: "req_test", logTime: new Date().toISOString() };

const MSGS: Message[] = [{ role: "user", content: "你好" }];

const TOOL_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "shell",
    description: "执行命令",
    parameters: { type: "object", properties: {} },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAIProvider.stream — Responses API 路径", () => {
  it("解析文本/推理增量并在流结束时产出最终 chunk（usage 映射）", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf(
        { type: "response.created", response: {} },
        { type: "response.output_text.delta", delta: "你" },
        { type: "response.output_text.delta", delta: "好" },
        { type: "response.reasoning_text.delta", delta: "思考中" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              input_tokens_details: { cached_tokens: 30 },
            },
          },
        },
      ),
    );

    const chunks = await collect(
      await provider.stream("gpt-4o", MSGS, [], OPTS),
    );

    // 2 个文本增量 + 1 个推理增量 + 1 个最终 chunk
    expect(chunks).toHaveLength(4);
    expect(chunks[0].content).toBe("你");
    expect(chunks[1].content).toBe("好");
    expect(chunks[2].reasoning).toBe("思考中");
    expect(chunks[3]).toEqual({
      content: null,
      reasoning: null,
      toolCalls: null,
      usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 0 },
      finishReason: "stop",
    });
    // 只走了 Responses，未触发 Chat
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("按 item_id 拼接函数调用参数并产出 toolCalls", async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf(
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            call_id: "fc_1",
            name: "shell",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"cmd":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"ls"}' },
        { type: "response.completed", response: { status: "completed" } },
      ),
    );

    const chunks = await collect(
      await provider.stream("gpt-4o", MSGS, [TOOL_SCHEMA], OPTS),
    );

    const final = chunks[chunks.length - 1]!;
    expect(final.toolCalls).toEqual([
      { id: "fc_1", name: "shell", arguments: { cmd: "ls" } },
    ]);
    expect(final.finishReason).toBe("stop");
  });

  it("DeepSeek：注入内置 web_search 并过滤本地同名工具（扁平化其余工具）", async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf({ type: "response.completed", response: { status: "completed" } }),
    );

    const tools: ToolSchema[] = [
      TOOL_SCHEMA,
      {
        type: "function",
        function: {
          name: "web_search",
          description: "本地搜索",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    await collect(
      await provider.stream("deepseek-v4-pro", MSGS, tools, OPTS),
    );

    const called = responsesCreate.mock.calls[0]![0] as any;
    expect(called.tools).toEqual([
      {
        type: "function",
        name: "shell",
        description: "执行命令",
        parameters: { type: "object", properties: {} },
      },
      { type: "web_search" }, // 内置工具注入
    ]);
  });

  it("非 DeepSeek：不注入内置工具，保留本地 web_search", async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf({ type: "response.completed", response: { status: "completed" } }),
    );

    const tools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "本地搜索",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    await collect(await provider.stream("gpt-4o", MSGS, tools, OPTS));

    const called = responsesCreate.mock.calls[0]![0] as any;
    expect(called.tools).toEqual([
      {
        type: "function",
        name: "web_search",
        description: "本地搜索",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("input 转换：tool_calls 转 function_call、tool 消息转 function_call_output、notice 过滤", async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf({ type: "response.completed", response: { status: "completed" } }),
    );

    const msgs: Message[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_9",
            type: "function",
            function: { name: "shell", arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_9", content: "file1.txt" },
      { role: "notice", content: "仅展示" },
    ];

    await collect(await provider.stream("gpt-4o", msgs, [], OPTS));

    const called = responsesCreate.mock.calls[0]![0] as any;
    expect(called.input).toEqual([
      {
        role: "system",
        content: [{ type: "input_text", text: "系统提示" }],
      },
      { role: "user", content: [{ type: "input_text", text: "问题" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
      {
        type: "function_call",
        call_id: "call_9",
        name: "shell",
        arguments: '{"cmd":"ls"}',
      },
      { type: "function_call_output", call_id: "call_9", output: "file1.txt" },
    ]);
  });
});

describe("OpenAIProvider.stream — 降级逻辑", () => {
  it("404 不支持 → 降级 Chat Completions 并按模型缓存（第二次直走 Chat）", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockRejectedValue(apiError(404, "404 Not Found"));
    chatCreate.mockResolvedValue(
      chatChunksOf(
        {
          usage: null,
          choices: [{ index: 0, delta: { content: "来自 Chat" }, finish_reason: null }],
        },
        {
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ),
    );

    // 第一次：Responses 404 → 降级 Chat
    const chunks1 = await collect(
      await provider.stream("gpt-4o", MSGS, [], OPTS),
    );
    expect(chunks1[0]!.content).toBe("来自 Chat");
    expect(chunks1[chunks1.length - 1]!.finishReason).toBe("stop");
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);

    // 第二次（同模型）：缓存生效，不再尝试 Responses
    await collect(await provider.stream("gpt-4o", MSGS, [], OPTS));
    expect(responsesCreate).toHaveBeenCalledTimes(1); // 未增加
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });

  it("400 且错误信息含 unsupported → 降级；其它 400 不降级", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockRejectedValue(
      apiError(400, "model does not support responses API"),
    );
    chatCreate.mockResolvedValue(
      chatChunksOf({
        usage: null,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );

    await collect(await provider.stream("gpt-4o", MSGS, [], OPTS));
    expect(chatCreate).toHaveBeenCalledTimes(1); // 降级成功
  });

  it("401 鉴权错误不降级，直接抛出", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockRejectedValue(apiError(401, "Invalid API key"));

    await expect(provider.stream("gpt-4o", MSGS, [], OPTS)).rejects.toThrow();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("网络超时错误不降级，直接抛出", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockRejectedValue(new Error("fetch failed: timeout"));

    await expect(provider.stream("gpt-4o", MSGS, [], OPTS)).rejects.toThrow();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("OPENAI_FORCE_API_MODE=chat 强制走 Chat Completions", async () => {
    vi.stubEnv("OPENAI_FORCE_API_MODE", "chat");
    const { provider, responsesCreate, chatCreate } = makeProvider();
    chatCreate.mockResolvedValue(
      chatChunksOf({
        usage: null,
        choices: [{ index: 0, delta: { content: "强制" }, finish_reason: null }],
      }),
    );

    const chunks = await collect(
      await provider.stream("gpt-4o", MSGS, [], OPTS),
    );
    expect(chunks[0]!.content).toBe("强制");
    expect(responsesCreate).not.toHaveBeenCalled();
  });
});

describe("OpenAIProvider.chat — 非流式路径", () => {
  it("Responses 路径返回 output_text", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue({ output_text: "会话名称" });

    const name = await provider.chat("gpt-4o", [], {}, OPTS);
    expect(name).toBe("会话名称");
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("Responses 不支持时降级 Chat Completions", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockRejectedValue(apiError(404, "not found"));
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: "备选名称" } }],
    });

    const name = await provider.chat("gpt-4o", [], {}, OPTS);
    expect(name).toBe("备选名称");
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIProvider.stream — 流内 response.failed 降级（阿里兼容模式行为）", () => {
  /** 模拟 DashScope 兼容模式：HTTP 200 建流后立刻下发 response.failed */
  function failedInStream(
    error: { code?: string; message?: string },
    requestId?: string,
  ) {
    return eventsOf({
      type: "response.failed",
      response: { id: "resp_1", status: "failed", error, ...(requestId ? { request_id: requestId } : {}) },
    });
  }

  const chatOk = () =>
    chatChunksOf(
      {
        usage: null,
        choices: [{ index: 0, delta: { content: "Chat 兜底" }, finish_reason: null }],
      },
      {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    );

  it("InvalidParameter（未产出任何内容）→ 本次改走 Chat，但不缓存（下次仍先试 Responses）", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      failedInStream({
        code: "InvalidParameter",
        message: "Required parameter(s) missing or invalid, please check the request parameters.",
      }),
    );
    chatCreate.mockResolvedValue(chatOk());

    const chunks = await collect(await provider.stream("cmaas-qwen3.8-flash", MSGS, [], OPTS));
    expect(chunks[0]!.content).toBe("Chat 兜底");
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);

    // 参数类失败不写缓存：第二个请求依旧先尝试 Responses
    await collect(await provider.stream("cmaas-qwen3.8-flash", MSGS, [], OPTS));
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it("流内明确「不支持」→ 降级并缓存为 chat", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      failedInStream({ code: "UnsupportedEndpoint", message: "responses api is not supported" }),
    );
    chatCreate.mockResolvedValue(chatOk());

    await collect(await provider.stream("m", MSGS, [], OPTS));
    await collect(await provider.stream("m", MSGS, [], OPTS));
    expect(responsesCreate).toHaveBeenCalledTimes(1); // 第二次直走 Chat
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });

  it("已经吐出内容后的流内失败不重放（避免重复输出），原样抛出", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf(
        { type: "response.output_text.delta", delta: "前半句" },
        { type: "response.failed", response: { status: "failed", error: { code: "InvalidParameter", message: "boom" } } },
      ),
    );

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const c of await provider.stream("m", MSGS, [], OPTS)) {
          if (c.content) seen.push(c.content);
        }
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual(["前半句"]);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("流内错误保留 code / request_id，便于排查", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    // 限流类失败不降级 → 原始错误（含 code / request_id）应完整冒泡
    responsesCreate.mockResolvedValue(
      eventsOf({
        type: "response.failed",
        response: {
          id: "resp_x",
          status: "failed",
          error: { code: "Throttling", message: "Rate limit exceeded, retry later" },
          request_id: "req-abc",
        },
      }),
    );

    const err = await (async () => {
      try {
        for await (const _c of await provider.stream("m", MSGS, [], OPTS)) {
          /* drain */
        }
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain("Responses API 调用失败: Rate limit exceeded, retry later");
    expect(err!.message).toContain("code=Throttling");
    expect(err!.message).toContain("request_id=req-abc");
    expect(err!.code).toBe("Throttling");
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("降级路径也失败时，保留 Responses 原始失败作为 cause", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      failedInStream({ code: "InvalidParameter", message: "bad model" }, "req-1"),
    );
    chatCreate.mockRejectedValue(apiError(400, "Required parameter(s) missing or invalid"));

    const err = await (async () => {
      try {
        await collect(await provider.stream("m", MSGS, [], OPTS));
        return null;
      } catch (e) {
        return e as Error & { cause?: Error };
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain("Required parameter(s)");
    expect(String(err!.cause?.message)).toContain("Responses API 调用失败: bad model");
  });

  it("鉴权/限流类流内失败不降级", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      failedInStream({ code: "Unauthorized", message: "invalid api key" }),
    );

    await expect(
      collect(await provider.stream("m", MSGS, [], OPTS)),
    ).rejects.toThrow();
    expect(chatCreate).not.toHaveBeenCalled();
  });
});

describe("OpenAIProvider — 用户附件（图片/音频/视频）", () => {
  const IMG = {
    name: "a.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
  };
  const MP3 = {
    name: "a.mp3",
    mimeType: "audio/mpeg",
    dataUrl: "data:audio/mpeg;base64,BBBB",
  };

  it("Chat：图片转为 image_url content part（DeepSeek/OpenAI 通用格式）", async () => {
    vi.stubEnv("OPENAI_FORCE_API_MODE", "chat");
    const { provider, chatCreate, responsesCreate } = makeProvider();
    chatCreate.mockResolvedValue(
      chatChunksOf({
        usage: null,
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
    );

    await collect(
      await provider.stream(
        "deepseek-flash",
        [{ role: "user", content: "看图", attachments: [IMG] }],
        [],
        OPTS,
      ),
    );

    const sent = chatCreate.mock.calls[0]![0] as any;
    expect(sent.messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: IMG.dataUrl } },
    ]);
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("Responses：图片转为 input_image part", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    responsesCreate.mockResolvedValue(
      eventsOf({ type: "response.completed", response: { status: "completed", usage: {} } }),
    );

    await collect(
      await provider.stream(
        "deepseek-flash",
        [{ role: "user", content: "看图", attachments: [IMG] }],
        [],
        OPTS,
      ),
    );

    const sent = responsesCreate.mock.calls[0]![0] as any;
    expect(sent.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "看图" },
          { type: "input_image", image_url: IMG.dataUrl },
        ],
      },
    ]);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("音频附件：Responses 无对应 part，直接走 Chat（input_audio）", async () => {
    const { provider, responsesCreate, chatCreate } = makeProvider();
    chatCreate.mockResolvedValue(
      chatChunksOf({
        usage: null,
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
    );

    await collect(
      await provider.stream(
        "whisper-compatible",
        [{ role: "user", content: "听一下", attachments: [MP3] }],
        [],
        OPTS,
      ),
    );

    expect(responsesCreate).not.toHaveBeenCalled();
    const sent = chatCreate.mock.calls[0]![0] as any;
    expect(sent.messages[0].content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "BBBB", format: "mp3" },
    });
  });

  it("审计日志只记录附件摘要，不写入 base64 载荷", async () => {
    vi.stubEnv("OPENAI_FORCE_API_MODE", "chat");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-log-"));
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseURL: "https://api.example.com",
      logDir: dir,
    });
    const client = (provider as any).client as Record<string, any>;
    const chatCreate = vi.fn().mockResolvedValue(
      chatChunksOf({
        usage: null,
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    client.chat = { completions: { create: chatCreate } };

    await collect(
      await provider.stream(
        "gpt-4o",
        [{ role: "user", content: "看图", attachments: [IMG] }],
        [],
        { ...OPTS, logTime: new Date().toISOString() },
      ),
    );

    const day = new Date().toISOString().split("T")[0]!;
    const file = path.join(dir, day, `${OPTS.reqId}.json`);
    const json = fs.readFileSync(file, "utf-8");
    expect(json).toContain('"mimeType": "image/png"');
    expect(json).not.toContain("data:image/png;base64");
  });
});
