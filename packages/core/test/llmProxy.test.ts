/**
 * SOCKS5 代理出口端到端：OpenAI SDK（流式）经 socks agent 走通
 *
 * 起一个最小 SOCKS5 服务（CONNECT 隧道）+ 一个假的 OpenAI 兼容服务，
 * 断言：配置 SOCKS5_PROXY 后，provider.stream() 能正常流式拿到内容，
 * 且请求确实经过了代理（代理记录了目标地址）。
 */
import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import * as http from "http";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";

/** 记录被代理访问过的目标 */
const proxied: string[] = [];

/** 极简 SOCKS5 服务：仅支持无鉴权 + CONNECT */
function startSocks5(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    let stage: "greet" | "connect" = "greet";
    socket.once("data", (buf) => {
      // 握手：05 NMETHODS METHODS... → 05 00
      if (buf[0] !== 0x05) {
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([0x05, 0x00]));
      stage = "connect";
      socket.once("data", (req) => {
        if (stage !== "connect" || req[0] !== 0x05 || req[1] !== 0x01) {
          socket.destroy();
          return;
        }
        const atyp = req[3];
        let host = "";
        let port = 0;
        let off = 4;
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          off = 8;
        } else if (atyp === 0x03) {
          const len = req[4]!;
          host = req.slice(5, 5 + len).toString("utf-8");
          off = 5 + len;
        } else if (atyp === 0x04) {
          host = req.slice(4, 20).toString("hex").match(/.{4}/g)!.map((h) => parseInt(h, 16)).join(":");
          off = 20;
        }
        port = req.readUInt16BE(off);
        proxied.push(`${host}:${port}`);

        const upstream = net.connect(port, host, () => {
          // 成功响应：05 00 00 01 0.0.0.0 0
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
      });
    });
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

/** 假 LLM：POST /v1/chat/completions 返回 SSE 流 */
function startFakeLlm(text: string): Promise<{ port: number; hits: number; close: () => void }> {
  const state = { port: 0, hits: 0, close: () => {} };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end("{}");
      return;
    }
    state.hits++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra,
      })}\n\n`;
    res.write(chunk({ role: "assistant", content: text }));
    res.write(
      chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as net.AddressInfo).port;
      state.close = () => server.close();
      resolve(state);
    });
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.SOCKS5_PROXY;
  delete process.env.OPENAI_FORCE_API_MODE;
});

async function collectStream(provider: OpenAIProvider): Promise<string> {
  const stream = await provider.stream(
    "test-model",
    [{ role: "user", content: "ping" } as never],
    [],
    { reqId: "r1", logTime: new Date().toISOString() },
  );
  let out = "";
  for await (const c of stream) if (c.content) out += c.content;
  return out;
}

describe("SOCKS5 代理出口", () => {
  it("经 socks5 代理完成流式对话（SDK 走 node-fetch + agent）", async () => {
    const llm = await startFakeLlm("pong");
    const socks = await startSocks5();
    cleanups.push(() => llm.close(), () => socks.close());
    process.env.OPENAI_FORCE_API_MODE = "chat";
    process.env.SOCKS5_PROXY = `socks5://127.0.0.1:${socks.port}`;

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseURL: `http://127.0.0.1:${llm.port}/v1`,
    });
    expect(await collectStream(provider)).toBe("pong");
    expect(llm.hits).toBe(1);
    // 代理确实被使用：目标为假 LLM 的地址
    expect(proxied.some((t) => t.endsWith(`:${llm.port}`))).toBe(true);
  });

  it("未配置代理时直连（不经过 socks 服务）", async () => {
    const llm = await startFakeLlm("direct");
    const socks = await startSocks5();
    cleanups.push(() => llm.close(), () => socks.close());
    process.env.OPENAI_FORCE_API_MODE = "chat";
    proxied.length = 0;

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseURL: `http://127.0.0.1:${llm.port}/v1`,
    });
    expect(await collectStream(provider)).toBe("direct");
    expect(proxied).toEqual([]);
  });

  it("Base URL 带端点后缀 / 引号也能连（自动归一化）", async () => {
    const llm = await startFakeLlm("norm");
    cleanups.push(() => llm.close());
    process.env.OPENAI_FORCE_API_MODE = "chat";
    const provider = new OpenAIProvider({
      apiKey: '"sk-test"\r\n',
      baseURL: `"http://127.0.0.1:${llm.port}/v1/chat/completions"`,
    });
    expect(await collectStream(provider)).toBe("norm");
  });
});
