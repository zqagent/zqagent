/**
 * 会话附件链路
 *
 * 关键约束：
 *   - 附件随本轮请求发给模型（provider 能收到）；
 *   - **不落盘**：session.json 里不能出现 base64（否则每次发送都把几 MB 写进磁盘，
 *     且历史轮次会重复计费）；
 *   - 模型未勾选对应能力时直接 400，而不是让供应商回一个看不懂的错误。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager, ApiError } from "../src/server/session.js";
import type { Message, ProviderClient, StreamChunk } from "../src/index.js";

const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 };

/** 记录最后一次请求消息的脚本化 Provider */
class RecordingProvider implements ProviderClient {
  lastMessages: Message[] = [];
  async stream(_model: string, messages: Message[]): Promise<AsyncIterable<StreamChunk>> {
    this.lastMessages = messages;
    const chunks: StreamChunk[] = [
      { content: "收到", reasoning: null, toolCalls: null, usage, finishReason: "stop" },
    ];
    return (async function* () {
      yield* chunks;
    })();
  }
}

const IMG = {
  name: "shot.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAAA",
};
const AUDIO = {
  name: "voice.mp3",
  mimeType: "audio/mpeg",
  dataUrl: "data:audio/mpeg;base64,BBBB",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(20);
  }
}

function makeEnv(capabilities: ("text" | "image" | "audio" | "video")[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-attach-"));
  const store = new Store(root);
  const tenant = {
    id: "t1",
    apiKey: "k1",
    model: "test-model",
    provider: {
      apiKey: "sk-test",
      modelMeta: [{ id: "test-model", capabilities }],
    },
  };
  store.saveTenant(tenant);
  const provider = new RecordingProvider();
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
  return { root, store, tenant, provider, manager };
}

describe("会话附件", () => {
  it("图片附件随本轮请求发送，且不写入会话记录", async () => {
    const env = makeEnv(["text", "image"]);
    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "看这张图", [IMG]);

    await waitFor(() => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed");

    // provider 收到的最后一条 user 消息带附件
    const user = env.provider.lastMessages.filter((m) => m.role === "user").pop();
    expect(user?.content).toBe("看这张图");
    expect(user?.attachments).toEqual([IMG]);

    // 落盘记录里没有 base64
    const file = path.join(env.root, "tenants", "t1", "sessions", rec.sessionId, "session.json");
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("data:image/png;base64");
    expect(raw).toContain("看这张图");
  });

  it("模型未勾选该类能力时拒绝（400），而不是把图发给供应商", () => {
    const env = makeEnv(["text"]);
    const rec = env.manager.createSession(env.tenant, {});
    expect(() => env.manager.submitTurn(env.tenant, rec.sessionId, "看图", [IMG])).toThrow(
      ApiError,
    );
    expect(() => env.manager.submitTurn(env.tenant, rec.sessionId, "看图", [IMG])).toThrow(
      /图片/,
    );
  });

  it("纯附件（无文本）也能提交", async () => {
    const env = makeEnv(["text", "image"]);
    const rec = env.manager.createSession(env.tenant, {});
    env.manager.submitTurn(env.tenant, rec.sessionId, "", [IMG]);

    await waitFor(() => env.manager.getSession(env.tenant.id, rec.sessionId)!.status === "completed");
    const user = env.provider.lastMessages.filter((m) => m.role === "user").pop();
    expect(user?.attachments).toEqual([IMG]);
    // 列表展示不会是一条空指令
    expect(env.manager.getSession(env.tenant.id, rec.sessionId)!.lastInput).toBe("[附件] shot.png");
  });

  it("音频能力未启用时同样拒绝", () => {
    const env = makeEnv(["text", "image", "video"]);
    const rec = env.manager.createSession(env.tenant, {});
    expect(() => env.manager.submitTurn(env.tenant, rec.sessionId, "听一下", [AUDIO])).toThrow(
      /音频/,
    );
  });
});
