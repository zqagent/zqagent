/**
 * 模型列表与自检单测
 *
 * 背景：网关的 /models 常是「全量目录」——阿里云百炼会把向量、语音、图像、
 * 专用通道（cmaas-*）等**不能对话**的模型一并列出，用户在 /connect 里
 * 一眼选到就只能收到 InvalidParameter。覆盖：
 *   - isChatModel：非对话/专用通道模型的识别，且不误伤多模态对话模型
 *   - fetchModels：对话模型排在前面，并回报 nonChat 清单
 *   - probeModel：真发一次最小请求，把顶层 {code,message} 错误体读出来；
 *     推理模型（o 系列 / gpt-5）按 isReasoningModel 走 max_completion_tokens
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  describeModelFetchFailure,
  fetchModels,
  fetchModelsWithDiagnostics,
  isChatModel,
  modelListCandidates,
  probeModel,
} from "../src/providers/models.js";
import { isReasoningModel } from "../src/providers/diagnostics.js";

/** 目录里明显不能当 Agent 后端的模型（取自阿里百炼 /models 实采样本） */
const NON_CHAT = [
  "cmaas-qwen3.8-flash", // 专用/机密通道：/chat/completions 与 /responses 均 400
  "qwen3.7-text-embedding-flash",
  "qwen3.7-text-embedding",
  "qwen3.7-text-rerank",
  "qwen3-tts-flash",
  "qwen3-asr-flash-realtime",
  "qwen-audio-3.0-asr-flash",
  "MiniMax/speech-2.8-hd",
  "unisound/unisound-u2",
  "qwen3.8-omni-flash-realtime",
  "qwen3.5-livetranslate-flash-realtime",
  "qwen3-s2s-flash-realtime-2025-09-22",
  "qwen-image-2.1-pro",
  "wan2.7-image-pro",
  "z-image-turbo",
  "qwen-deep-research-2025-12-15",
  "qwen-deep-search-planning",
  "sre-gpu-auto-handle",
  "test-sre-gpu-auto-handle",
];

/** 目录里应当保留为对话模型的样本（含多模态/代码/翻译等仍可走 chat 的） */
const CHAT = [
  "qwen3.8-flash",
  "qwen3.8-max",
  "qwen-plus",
  "qwen-flash",
  "qwen3-coder-flash",
  "qwen3-vl-plus",
  "qwen3.5-ocr",
  "qwen-vl-ocr",
  "qwen-mt-plus",
  "qwen3.8-omni-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "kimi-k3",
  "MiniMax/MiniMax-M3",
  "qwen-long",
];

describe("isChatModel", () => {
  it("识别非对话/专用通道模型", () => {
    for (const m of NON_CHAT) {
      expect(isChatModel(m), m).toBe(false);
    }
  });

  it("不误伤对话/多模态模型", () => {
    for (const m of CHAT) {
      expect(isChatModel(m), m).toBe(true);
    }
  });
});

// ===================== 假网关 =====================

let server: http.Server;
let base = "";
/** 记录自检请求的路径，确认 probeModel 打的是 /chat/completions */
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if ((req.url ?? "").endsWith("/models")) {
      // 故意把非对话模型混在前面（贴近阿里 /models 的真实顺序）
      json(200, {
        object: "list",
        data: [
          "cmaas-qwen3.8-flash",
          "qwen-image-2.1-pro",
          "qwen3.8-flash",
          "qwen3.7-text-embedding-flash",
          "qwen-plus",
          "qwen3-coder-flash",
        ].map((id) => ({ id, object: "model" })),
      });
      return;
    }
    if ((req.url ?? "").endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = JSON.parse(body || "{}") as Record<string, unknown>;
        const model = String(payload.model ?? "");
        if (isChatModel(model) && model === "qwen3.8-flash") {
          json(200, {
            id: "cmpl-1",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" } }],
          });
          return;
        }
        // 推理模型（o 系列 / gpt-5）：复刻真实 OpenAI —— 传 max_tokens 直接 400
        if (isReasoningModel(model)) {
          if ("max_tokens" in payload) {
            json(400, {
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                code: "unsupported_parameter",
              },
            });
            return;
          }
          json(200, {
            id: "cmpl-2",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" } }],
          });
          return;
        }
        // 阿里兼容模式：顶层 {code,message,request_id}，没有 error 包裹
        json(400, {
          code: "InvalidParameter",
          message: "Required parameter(s) missing or invalid, please check the request parameters.",
          request_id: "c4fb412e-b457",
        });
      });
      return;
    }
    json(404, { error: { message: "no such path" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchModels", () => {
  it("对话模型排在前面，并回报 nonChat 清单", async () => {
    const r = await fetchModels(base, "sk-test");
    expect(r).not.toBeNull();
    const { models, nonChat } = r!;
    expect(models).toEqual([
      "qwen3.8-flash",
      "qwen-plus",
      "qwen3-coder-flash",
      "cmaas-qwen3.8-flash",
      "qwen-image-2.1-pro",
      "qwen3.7-text-embedding-flash",
    ]);
    expect(nonChat).toEqual([
      "cmaas-qwen3.8-flash",
      "qwen-image-2.1-pro",
      "qwen3.7-text-embedding-flash",
    ]);
    expect(models.length).toBe(6); // 一个都没丢
  });
});

describe("probeModel", () => {
  it("可用模型 → ok:true", async () => {
    const r = await probeModel(base, "sk-test", "qwen3.8-flash");
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("不可用模型 → ok:false，并读出顶层 code/message（不是 no body）", async () => {
    const r = await probeModel(base, "sk-test", "cmaas-qwen3.8-flash");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 400");
    expect(r.error).toContain("Required parameter(s)");
    expect(r.code).toContain("InvalidParameter");
    expect(r.code).toContain("c4fb412e-b457");
  });

  it("推理模型（o 系列 / gpt-5）用 max_completion_tokens，不被误判为不可用", async () => {
    for (const m of ["gpt-5", "o3-mini"]) {
      const r = await probeModel(base, "sk-test", m);
      expect(r.ok, `${m}: ${r.error}`).toBe(true);
    }
  });

  it("自检走的是 /chat/completions（供应商公共底线）", async () => {
    seen.length = 0;
    await probeModel(base, "sk-test", "qwen3.8-flash");
    expect(seen.some((u) => u.endsWith("/chat/completions"))).toBe(true);
  });
});

// ===================== 多路径候选与失败诊断 =====================

/** 只对指定路径返回 200 + 模型列表；其余路径按 map 给状态码 */
let pathServer: http.Server;
let pathBase = "";
const hits: string[] = [];

beforeAll(async () => {
  pathServer = http.createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(url);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // 模拟 DeepSeek：GET /models 可用，/v1/models 不存在
    if (url === "/models") {
      json(200, { object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
      return;
    }
    if (url === "/v1/models") {
      json(404, { error: { message: "not found" } });
      return;
    }
    json(404, { error: { message: "资源不存在" } });
  });
  await new Promise<void>((resolve) => pathServer.listen(0, "127.0.0.1", resolve));
  const { port } = pathServer.address() as AddressInfo;
  pathBase = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => pathServer.close(() => resolve()));
});

describe("modelListCandidates", () => {
  it("Base URL 只填到域名时，同时尝试 /models 与 /v1/models", () => {
    const c = modelListCandidates("https://api.deepseek.com");
    expect(c[0]).toBe("https://api.deepseek.com/models");
    expect(c).toContain("https://api.deepseek.com/v1/models");
  });

  it("Base URL 带 /v1 时，先去版本段再试根路径（DeepSeek 官方 /models 不在 /v1 下）", () => {
    const c = modelListCandidates("https://api.deepseek.com/v1");
    expect(c).toContain("https://api.deepseek.com/v1/models");
    expect(c).toContain("https://api.deepseek.com/models");
    expect(c.indexOf("https://api.deepseek.com/v1/models")).toBeLessThan(
      c.indexOf("https://api.deepseek.com/models"),
    );
  });

  it("兼容模式前缀与 /api 网关都会被尝试", () => {
    expect(modelListCandidates("https://dashscope.aliyuncs.com/compatible-mode/v1")).toEqual(
      expect.arrayContaining([
        "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
        "https://dashscope.aliyuncs.com/models",
      ]),
    );
    expect(modelListCandidates("https://gw.example.com")).toEqual(
      expect.arrayContaining([
        "https://gw.example.com/api/v1/models",
        "https://gw.example.com/api/models",
      ]),
    );
  });

  it("候选去重且数量有上限（避免一次刷新打太多次）", () => {
    const c = modelListCandidates("https://api.example.com/v1");
    expect(new Set(c).size).toBe(c.length);
    expect(c.length).toBeLessThanOrEqual(6);
  });
});

describe("fetchModelsWithDiagnostics", () => {
  it("带 /v1 的 Base URL 在 /v1/models 404 时，回退到根 /models 成功", async () => {
    const diag = await fetchModelsWithDiagnostics(`${pathBase}/v1`, "sk-test");
    expect(diag.result?.models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(diag.result?.endpoint).toBe(`${pathBase}/models`);
  });

  it("全部失败时回报每个尝试过的端点与状态码", async () => {
    const diag = await fetchModelsWithDiagnostics(`${pathBase}/nope`, "sk-test");
    expect(diag.result).toBeNull();
    expect(diag.attempts.length).toBeGreaterThan(1);
    expect(diag.attempts.every((a) => a.status !== undefined)).toBe(true);
    const msg = describeModelFetchFailure(`${pathBase}/nope`, diag);
    expect(msg).toContain("已尝试");
    expect(msg).toContain("HTTP 404");
  });

  it("鉴权失败仍会试完候选（有些网关对不存在的路径也回 401），最终按 Key 问题提示", async () => {
    const authServer = http.createServer((req, res) => {
      hits.push(`auth${req.url}`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const { port } = authServer.address() as AddressInfo;
    hits.length = 0;
    try {
      const diag = await fetchModelsWithDiagnostics(`http://127.0.0.1:${port}/v1`, "sk-bad");
      expect(diag.authFailed).toBe(true);
      // 不再早停：/v1/models 401 后继续试 /models 等组合
      expect(diag.attempts.length).toBeGreaterThan(1);
      expect(hits.length).toBe(diag.attempts.length);
      const msg = describeModelFetchFailure(`http://127.0.0.1:${port}/v1`, diag);
      expect(msg).toContain("API Key 无效");
      expect(msg).toContain("Authentication Fails");
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()));
    }
  });
});
