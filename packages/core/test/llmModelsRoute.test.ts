/**
 * 刷新模型（POST /api/v1/node/llm/models）：多端点回退与失败原因回传
 *
 * 用户视角的回归点：点「刷新模型」后如果拿不到列表，必须看到**为什么**
 * （试过哪些 URL、各自的状态码），而不是一句「✓ 0」。
 *
 * 这里用假供应商复刻 DeepSeek 的形态：`GET /models` 可用，`/v1/models` 不存在。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { createApp } from "../src/server/routes.js";

/** 起一个假供应商：/models 返回模型，其它路径 404 */
async function startProvider(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/models") {
      json(200, {
        object: "list",
        data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
      });
      return;
    }
    json(404, { error: { message: "no such path" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 起节点 HTTP 服务 + 假供应商，结束后一并清理 */
async function withApi<T>(
  fn: (args: { base: string; providerBase: string }) => Promise<T>,
): Promise<T> {
  const provider = await startProvider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zq-llm-models-"));
  const store = new Store(root, { llmConfigFile: path.join(root, "connections.json") });
  const manager = new SessionManager(store, 60_000);
  const server = createApp(store, manager, { adminKey: "adminkey" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, providerBase: provider.base });
  } finally {
    server.close();
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function postModels(base: string, payload: Record<string, unknown>) {
  return fetch(`${base}/api/v1/node/llm/models`, {
    method: "POST",
    headers: { Authorization: "Bearer adminkey", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/v1/node/llm/models", () => {
  it("Base URL 多填了 /v1 时，回退到根 /models 仍能刷出模型", async () => {
    await withApi(async ({ base, providerBase }) => {
      const res = await postModels(base, { baseURL: `${providerBase}/v1`, apiKey: "sk-test" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
      expect(body.data.endpoint).toBe(`${providerBase}/models`);
    });
  });

  it("全部端点不可用时返回 400，并列出尝试过的 URL 与状态码", async () => {
    await withApi(async ({ base }) => {
      // 127.0.0.1:1 上没有任何服务：每个候选都是连接失败
      const res = await postModels(base, { baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-test" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("模型列表刷新失败");
      expect(body.error.message).toContain("已尝试");
      expect(body.error.message).toContain("/v1/models");
    });
  }, 30_000);

  it("缺少 Base URL / API Key 时给出明确 400", async () => {
    await withApi(async ({ base }) => {
      const noUrl = await postModels(base, { apiKey: "sk-test" });
      expect(noUrl.status).toBe(400);
      expect((await noUrl.json()).error.message).toContain("Base URL");

      const noKey = await postModels(base, { baseURL: "https://api.deepseek.com" });
      expect(noKey.status).toBe(400);
      expect((await noKey.json()).error.message).toContain("API Key");
    });
  });
});
