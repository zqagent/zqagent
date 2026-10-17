/**
 * 模型上下文长度元数据单元测试
 *
 * 覆盖 /models 响应里的上下文长度提取（OpenRouter / vLLM 等字段名不一）、
 * 单体探测兜底（/models/{id}）、查找与规范化逻辑。
 * 上下文长度直接决定压缩触发阈值（TurnEngine._getContextWindow），
 * 因此解析到错值比解析不到更危险，这里对边界值一并锁定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchModels,
  modelContextWindow,
  normalizeModelMeta,
} from "../src/providers/models.js";

/** 构造一个最小可用的 Response 形状 */
function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as never;
}

/** 按 URL 分发的 fetch stub；未匹配的 URL 返回 404 */
function stubFetch(routes: Record<string, unknown>) {
  const mock = vi.fn(async (url: unknown) => {
    const key = String(url);
    if (!(key in routes)) return mockResponse({ error: "not_found" }, false);
    return mockResponse(routes[key]);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.stubEnv("SOCKS5_PROXY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("normalizeModelMeta", () => {
  it("去重、丢弃非法上下文长度，并保留无长度的模型条目", () => {
    expect(
      normalizeModelMeta([
        { id: "a", contextWindow: 128_000 },
        { id: "a", contextWindow: 1 },
        { id: "b", contextWindow: 0 },
        { id: "c", contextWindow: Number.NaN },
        { id: " d ", contextWindow: 32_000 },
        "oops",
      ]),
    ).toEqual([
      { id: "a", contextWindow: 128_000 },
      { id: "b" },
      { id: "c" },
      { id: "d", contextWindow: 32_000 },
    ]);
  });

  it("非数组输入返回 undefined", () => {
    expect(normalizeModelMeta(undefined)).toBeUndefined();
    expect(normalizeModelMeta({ id: "a" })).toBeUndefined();
  });
});

describe("modelContextWindow", () => {
  const meta = [
    { id: "gpt-4o", contextWindow: 128_000 },
    { id: "gpt-4o-mini", contextWindow: 128_000 },
    { id: "glm-4", contextWindow: 128_000 },
    { id: "no-ctx" },
  ];

  it("精确匹配优先于前缀匹配", () => {
    expect(modelContextWindow(meta, "gpt-4o-mini")).toBe(128_000);
  });

  it("日期后缀等变体走前缀匹配", () => {
    expect(modelContextWindow(meta, "gpt-4o-2024-08-06")).toBe(128_000);
  });

  it("未命中或元数据缺失时返回 undefined（交由引擎内置表兜底）", () => {
    expect(modelContextWindow(meta, "qwen-max")).toBeUndefined();
    expect(modelContextWindow(meta, "")).toBeUndefined();
    expect(modelContextWindow(undefined, "gpt-4o")).toBeUndefined();
  });
});

describe("fetchModels 上下文长度提取", () => {
  it("解析 OpenRouter 风格的 context_length", async () => {
    stubFetch({
      "https://api.example.com/v1/models": {
        data: [
          { id: "openai/gpt-4o", context_length: 128_000 },
          { id: "openai/gpt-4o-mini", context_length: 128_000 },
        ],
      },
    });
    const r = await fetchModels("https://api.example.com/v1", "sk-test");
    expect(r?.models).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    expect(r?.modelMeta).toEqual([
      { id: "openai/gpt-4o", contextWindow: 128_000 },
      { id: "openai/gpt-4o-mini", contextWindow: 128_000 },
    ]);
  });

  it("解析 context_window / max_model_len 等别名，忽略非法值", async () => {
    stubFetch({
      "https://api.example.com/v1/models": {
        data: [
          { id: "gateway-a", context_window: 262_144 },
          { id: "vllm-b", max_model_len: 32_768 },
          { id: "plain-c" },
          { id: "bad-d", context_length: "128k" },
        ],
      },
    });
    const r = await fetchModels("https://api.example.com/v1", "sk-test");
    expect(r?.modelMeta).toEqual([
      { id: "gateway-a", contextWindow: 262_144 },
      { id: "vllm-b", contextWindow: 32_768 },
    ]);
  });

  it("列表未给出长度时，对已选模型单体探测一次兜底", async () => {
    const mock = stubFetch({
      "https://api.example.com/v1/models": {
        data: [{ id: "other-model" }, { id: "picked-model" }],
      },
      "https://api.example.com/v1/models/picked-model": {
        data: { id: "picked-model", context_length: 1_000_000 },
      },
    });
    const r = await fetchModels("https://api.example.com/v1", "sk-test", "picked-model");
    expect(mock).toHaveBeenCalledWith(
      "https://api.example.com/v1/models/picked-model",
      expect.anything(),
    );
    expect(r?.modelMeta).toEqual([{ id: "picked-model", contextWindow: 1_000_000 }]);
  });

  it("无已选模型时对列表首个模型探测；探测失败不产生元数据", async () => {
    stubFetch({
      "https://api.example.com/v1/models": { data: [{ id: "only-model" }] },
      "https://api.example.com/v1/models/only-model": {
        id: "only-model",
        max_input_tokens: 200_000,
      },
    });
    const ok = await fetchModels("https://api.example.com/v1", "sk-test");
    expect(ok?.modelMeta).toEqual([{ id: "only-model", contextWindow: 200_000 }]);

    stubFetch({ "https://api.example.com/v1/models": { data: [{ id: "only-model" }] } });
    const failed = await fetchModels("https://api.example.com/v1", "sk-test");
    expect(failed?.modelMeta).toBeUndefined();
  });
});
