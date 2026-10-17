/**
 * M2c 端到端测试：NOTIFY 上行、TLS 自终结（wss）、慢消费者逐出
 *
 * 前提：网关二进制已构建（`cd gateway && cargo build`），未构建则跳过。
 * TLS 用 openssl 现场生成自签证书（仅测试用）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  FrameType,
  decodeAuthOk,
  decodeFrame,
  decodeNotify,
  encodeAuth,
  encodeEvent,
  encodeFrame,
  encodeNotify,
  encodeResume,
  encodeSubscribe,
  signableAuthBytes,
  type Auth,
  type Frame,
} from "@zqagent/shared/wire";
import { hmacSha256 } from "@zqagent/shared/wire/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const binary = path.join(repoRoot, "gateway/target/debug/zqagent-gateway");
const hasBinary = fs.existsSync(binary);

const SECRET = "e2e-m2c-secret";
const TERMINAL_SECRET = "e2e-m2c-terminal-secret";
const PORT = 19600 + Math.floor(Math.random() * 300);
const TLS_PORT = PORT + 900;

class Peer {
  private ws: WebSocket;
  private readonly queue: Frame[] = [];
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d: Buffer) => this.queue.push(decodeFrame(new Uint8Array(d))));
    ws.on("close", () => {
      this.closed = true;
    });
    ws.on("error", () => {
      this.closed = true;
    });
  }

  static connect(url: string, opts: { rejectUnauthorized?: boolean } = {}): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, opts);
      const peer = new Peer(ws);
      ws.on("open", () => resolve(peer));
      ws.on("error", reject);
    });
  }

  static async authed(
    url: string,
    id: string,
    kind: "node" | "terminal",
    opts: { rejectUnauthorized?: boolean } = {},
    scope: string[] = [],
  ): Promise<Peer> {
    const peer = await Peer.connect(url, opts);
    // 终端面（M5）：令牌必须带 scope（网关 fail closed），且用独立的 terminal secret 签
    const base: Auth = { id, ts: Date.now(), nonce: `n-${id}`, proto: 1, kind };
    const auth: Auth = kind === "terminal" ? { ...base, scope, expires: Date.now() + 3_600_000 } : base;
    const secret = kind === "terminal" ? TERMINAL_SECRET : SECRET;
    peer.send(FrameType.AUTH, encodeAuth({ ...auth, token: hmacSha256(secret, signableAuthBytes(auth)) }));
    const ok = decodeAuthOk((await peer.next(FrameType.AUTH_OK)).payload);
    if (!ok.ok) throw new Error(`握手失败: ${ok.error}`);
    return peer;
  }

  send(type: number, payload: Uint8Array, seq = 0): void {
    this.ws.send(encodeFrame({ type, seq, payload }));
  }

  /** 只发不解析（用于「慢消费者」场景，避免本地队列抢在网关之前吸收数据） */
  sendRaw(buf: Uint8Array): void {
    this.ws.send(buf);
  }

  /** 暂停底层 socket 读取 → 模拟只连不读的终端（TCP 缓冲会被灌满） */
  pauseReading(): void {
    // ws 的底层 socket；Node 类型里没有公开，测试内直接取用
    const socket = (this.ws as unknown as { _socket?: { pause(): void } })._socket;
    socket?.pause();
  }

  drain(): Frame[] {
    const out = this.queue.slice();
    this.queue.length = 0;
    return out;
  }

  async next(type: number, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((f) => f.type === type);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (this.closed) throw new Error("连接已关闭");
      if (Date.now() > deadline) throw new Error(`等待帧超时（type=${type}）`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  waitClosed(timeoutMs = 3000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("连接未在时限内关闭")), timeoutMs);
      this.ws.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function waitHealthy(port: number, https = false, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (https) {
        // 自签证书：Node 的 fetch(undici) 会拒绝，这里显式放行
        const httpsMod = await import("node:https");
        const agent = new httpsMod.Agent({ rejectUnauthorized: false });
        const ok = await new Promise<boolean>((resolve) => {
          httpsMod
            .get({ host: "127.0.0.1", port, path: "/healthz", agent }, (res) => {
              resolve((res.statusCode ?? 0) === 200);
              res.resume();
            })
            .on("error", () => resolve(false));
        });
        if (ok) return;
      } else if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
        return;
      }
    } catch {
      /* 未就绪 */
    }
    if (Date.now() > deadline) throw new Error(`网关未在时限内就绪（${port}）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 启动一个网关实例 */
function startGateway(port: number, extraEnv: Record<string, string> = {}): ChildProcess {
  const proc = spawn(binary, [], {
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(port),
      GATEWAY_FLEET_SECRET: SECRET,
      GATEWAY_TERMINAL_SECRET: TERMINAL_SECRET,
      GATEWAY_HEARTBEAT_SECS: "10",
      GATEWAY_IDLE_TIMEOUT_SECS: "30",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr?.on("data", (d) => process.stderr.write(`[gw:${port}] ${d}`));
  return proc;
}

const suite = hasBinary ? describe : describe.skip;
if (!hasBinary) {
  console.warn(
    `[gateway-m2c-e2e] 跳过：未找到 ${path.relative(repoRoot, binary)}（先执行 cd gateway && cargo build）`,
  );
}

suite("M2c：NOTIFY 上行", () => {
  let gw: ChildProcess | undefined;

  beforeAll(async () => {
    gw = startGateway(PORT, { GATEWAY_EVENT_BUFFER: "32" });
    await waitHealthy(PORT);
  }, 25_000);

  afterAll(() => gw?.kill("SIGKILL"));

  it("通知扇出给订阅终端，并与事件共用游标空间", async () => {
    const url = `ws://127.0.0.1:${PORT}/ws`;
    const terminal = await Peer.authed(url, "tn1", "terminal", {}, ["node-n"]);
    await terminal.next(FrameType.SNAPSHOT);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-n"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(url, "node-n", "node");
    node.send(FrameType.EVENT, encodeEvent({ seq: 0, ts: Date.now(), type: "tick" }));
    node.send(
      FrameType.NOTIFY,
      encodeNotify({
        seq: 0,
        ts: Date.now(),
        kind: "approval_request",
        projectId: "p1",
        sessionId: "s1",
        data: new TextEncoder().encode('{"approvalId":"a1"}'),
      }),
    );

    const evFrame = await terminal.next(FrameType.EVENT);
    const ntFrame = await terminal.next(FrameType.NOTIFY);
    expect(evFrame.seq).toBeGreaterThan(0);
    expect(ntFrame.seq).toBeGreaterThan(evFrame.seq); // 同一游标空间，顺序递增

    const nt = decodeNotify(ntFrame.payload);
    expect(nt.kind).toBe("approval_request");
    expect(nt.projectId).toBe("p1");
    expect(new TextDecoder().decode(nt.data!)).toContain("a1");

    node.close();
    terminal.close();
  });

  it("通知与事件一起被 resume 回放（审批不因断线丢失）", async () => {
    const url = `ws://127.0.0.1:${PORT}/ws`;
    const node = await Peer.authed(url, "node-r", "node");
    const terminal = await Peer.authed(url, "tn2", "terminal", {}, ["node-r"]);
    await terminal.next(FrameType.SNAPSHOT);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-r"]));
    await terminal.next(FrameType.SNAPSHOT);

    // 事件风暴之后才发通知：通知必须仍可回放（缓冲淘汰优先保通知）
    for (let i = 0; i < 5; i++) {
      node.send(FrameType.EVENT, encodeEvent({ seq: 0, ts: Date.now(), type: "tick" }));
    }
    node.send(FrameType.NOTIFY, encodeNotify({ seq: 0, ts: Date.now(), kind: "question_asked", sessionId: "s9" }));

    for (let i = 0; i < 5; i++) await terminal.next(FrameType.EVENT);
    expect(decodeNotify((await terminal.next(FrameType.NOTIFY)).payload).kind).toBe("question_asked");

    // 新终端从头续传：应能拿到那条通知
    const late = await Peer.authed(url, "tn3", "terminal", {}, ["node-r"]);
    await late.next(FrameType.SNAPSHOT);
    late.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-r"]));
    await late.next(FrameType.SNAPSHOT);
    late.send(FrameType.RESUME, encodeResume(0));

    const replayed = await late.next(FrameType.NOTIFY, 3000);
    expect(decodeNotify(replayed.payload).kind).toBe("question_asked");

    node.close();
    terminal.close();
    late.close();
  });

  it("慢消费者被逐出（连续丢弃超阈值即被网关释放）", async () => {
    const port = PORT + 200;
    const gw2 = startGateway(port, {
      GATEWAY_MAX_CONSECUTIVE_DROPS: "3",
      GATEWAY_REAPER_INTERVAL_SECS: "1",
      // 写超时设得很大，确保命中的是「丢弃逐出」而非写超时
      GATEWAY_WRITE_TIMEOUT_SECS: "120",
      // 队列取最小：阻断的写 + 1 帧在队 + 1 帧即将入队 → 立刻开始丢
      GATEWAY_SEND_QUEUE: "1",
    });
    try {
      await waitHealthy(port);
      const url = `ws://127.0.0.1:${port}/ws`;
      const slow = await Peer.authed(url, "t-slow", "terminal", {}, ["node-flood"]);
      await slow.next(FrameType.SNAPSHOT);
      slow.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-flood"]));
      await slow.next(FrameType.SNAPSHOT);
      const node = await Peer.authed(url, "node-flood", "node");
      const metrics = async () => {
        const m = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
        return (k: string) => Number(m.split("\n").find((l) => l.startsWith(k))?.split(" ")[1] ?? "0");
      };
      expect((await metrics())("zqagent_gateway_terminals")).toBe(1);

      // 关键：暂停读取。否则本地 ws 会把数据读进内存，网关队列永远不会满。
      // 注意：暂停后客户端**看不到** TCP FIN，因此这里断言网关侧状态而不是 waitClosed。
      slow.pauseReading();

      // 大载荷：快速灌满 TCP 缓冲，让网关的写侧尽早阻塞
      const payload = encodeEvent({
        seq: 0,
        ts: Date.now(),
        type: "flood",
        data: new Uint8Array(64 * 1024),
      });
      const frame = encodeFrame({ type: FrameType.EVENT, seq: 0, payload });
      for (let i = 0; i < 600; i++) node.sendRaw(frame);

      // 轮询直到被网关逐出
      const deadline = Date.now() + 25_000;
      let val = (k: string) => Promise.resolve(0);
      for (;;) {
        val = await metrics();
        if ((await val("zqagent_gateway_slow_evicted_total")) > 0) break;
        if (Date.now() > deadline) throw new Error("慢消费者未被逐出");
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(await val("zqagent_gateway_dropped_frames_total")).toBeGreaterThan(0);
      expect(await val("zqagent_gateway_slow_evicted_total")).toBeGreaterThan(0);
      // 终端已被释放：连接数与终端数都只剩节点那一条
      expect(await val("zqagent_gateway_terminals")).toBe(0);
      expect(await val("zqagent_gateway_connections")).toBe(1);

      node.close();
    } finally {
      gw2.kill("SIGKILL");
    }
  }, 45_000);

  it("健康消费者不会被误逐出", async () => {
    const url = `ws://127.0.0.1:${PORT}/ws`;
    const terminal = await Peer.authed(url, "t-healthy", "terminal", {}, ["node-ok"]);
    await terminal.next(FrameType.SNAPSHOT);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-ok"]));
    await terminal.next(FrameType.SNAPSHOT);
    const node = await Peer.authed(url, "node-ok", "node");

    // 正常读取（Peer 会持续把帧收进队列），不应触发逐出
    for (let i = 0; i < 50; i++) {
      node.send(FrameType.EVENT, encodeEvent({ seq: 0, ts: Date.now(), type: "tick" }));
      await new Promise((r) => setTimeout(r, 5));
    }
    const got = terminal.drain().filter((f) => f.type === FrameType.EVENT).length;
    expect(got).toBeGreaterThan(0);
    expect(terminal["closed"]).toBe(false); // 仍在线

    const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
    const evicted = Number(
      metrics.split("\n").find((l) => l.startsWith("zqagent_gateway_slow_evicted_total"))?.split(" ")[1] ?? "0",
    );
    expect(evicted).toBe(0);

    node.close();
    terminal.close();
  });
});

suite("M2c：TLS 自终结（wss）", () => {
  let gw: ChildProcess | undefined;
  let tlsDir = "";

  beforeAll(async () => {
    tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(tlsDir, "key.pem"),
        "-out", path.join(tlsDir, "cert.pem"),
        "-days", "1",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );

    gw = startGateway(TLS_PORT, {
      GATEWAY_TLS_CERT: path.join(tlsDir, "cert.pem"),
      GATEWAY_TLS_KEY: path.join(tlsDir, "key.pem"),
    });
    await waitHealthy(TLS_PORT, true);
  }, 60_000);

  afterAll(() => {
    gw?.kill("SIGKILL");
    if (tlsDir) fs.rmSync(tlsDir, { recursive: true, force: true });
  });

  it("wss 上完成握手、订阅与事件扇出", async () => {
    const url = `wss://127.0.0.1:${TLS_PORT}/ws`;
    const opts = { rejectUnauthorized: false }; // 自签证书
    const terminal = await Peer.authed(url, "tls-t", "terminal", opts, ["node-tls"]);
    await terminal.next(FrameType.SNAPSHOT);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-tls"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(url, "node-tls", "node", opts);
    node.send(FrameType.EVENT, encodeEvent({ seq: 0, ts: Date.now(), type: "tick" }));

    const got = await terminal.next(FrameType.EVENT);
    expect(got.type).toBe(FrameType.EVENT);

    node.close();
    terminal.close();
  });

  it("HTTPS 可观测端点可用（运维脚本可直连）", async () => {
    const https = await import("node:https");
    const agent = new https.Agent({ rejectUnauthorized: false });
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port: TLS_PORT, path: "/metrics", agent }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    expect(body).toContain("zqagent_gateway_connections");
    expect(body).toContain("zqagent_gateway_slow_evicted_total");
  });

  it("半配置 TLS（只有证书）时启动失败而不是降级为明文", async () => {
    const port = TLS_PORT + 1;
    const bad = startGateway(port, {
      GATEWAY_TLS_CERT: path.join(tlsDir, "cert.pem"),
      GATEWAY_TLS_KEY: "",
    });
    const code: number | null = await new Promise((resolve) => bad.on("exit", (c) => resolve(c)));
    expect(code).toBe(1);
  });
});
