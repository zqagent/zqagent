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
  fetchModels,
  isChatModel,
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
