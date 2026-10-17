/**
 * Node ↔ Rust 网关 真实 socket 端到端测试（M2a）
 *
 * 与 `wire.test.ts`（纯编解码 + 向量）互补：这里跑真实 WebSocket，验证连接层行为——
 * 握手认证、快照、状态聚合、事件扇出、断线续传、离线广播。
 *
 * 前提：网关二进制已构建（`cd gateway && cargo build`）。未构建时跳过并提示——
 * 在测试内跑 cargo build 会让耗时不可控。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  FrameType,
  decodeAuthOk,
  decodeEvent,
  decodeFrame,
  decodeNodeState,
  decodeSnapshot,
  encodeAuth,
  encodeEvent,
  encodeFrame,
  encodeResume,
  encodeStatus,
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

const SECRET = "e2e-gateway-secret";
const TERMINAL_SECRET = "e2e-gateway-terminal-secret";
const PORT = 18790 + Math.floor(Math.random() * 500);

/** WS 客户端：把二进制帧流封装成「发一帧 / 等一帧」 */
class Peer {
  private readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => this.queue.push(decodeFrame(new Uint8Array(data))));
    ws.on("close", () => {
      this.closed = true;
    });
    ws.on("error", () => {
      this.closed = true;
    });
  }

  static connect(port: number): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const peer = new Peer(ws);
      ws.on("open", () => resolve(peer));
      ws.on("error", reject);
    });
  }

  static async authed(
    port: number,
    id: string,
    kind: "node" | "terminal",
    client = "",
    scope: string[] = [],
  ): Promise<Peer> {
    const peer = await Peer.connect(port);
    peer.send(FrameType.AUTH, authFrame(id, kind, client, scope));
    const res = decodeAuthOk((await peer.next(FrameType.AUTH_OK)).payload);
    if (!res.ok) throw new Error(`握手失败: ${res.error}`);
    return peer;
  }

  send(type: number, payload: Uint8Array, seq = 0): void {
    this.ws.send(encodeFrame({ type, seq, payload }));
  }

  async next(type: number, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.queue.findIndex((f) => f.type === type);
      if (idx >= 0) return this.queue.splice(idx, 1)[0]!;
      if (this.closed) throw new Error("连接已关闭");
      if (Date.now() > deadline) throw new Error(`等待帧超时（type=${type}）`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 等某节点的状态帧（跳过其他节点的） */
  async waitStatus(nodeId: string, online?: boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(FrameType.STATUS, Math.max(1, deadline - Date.now()));
      const st = decodeNodeState(frame.payload);
      if (st.nodeId === nodeId && (online === undefined || st.online === online)) return st;
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

function authFrame(id: string, kind: "node" | "terminal", client = "", scope: string[] = []): Uint8Array {
  const base: Auth = { id, ts: Date.now(), nonce: `n-${id}`, proto: 1, kind, client };
  // 终端面（M5）：令牌必须带 scope（网关 fail closed），且用独立的 terminal secret 签
  const auth: Auth = kind === "terminal" ? { ...base, scope, expires: Date.now() + 3_600_000 } : base;
  const secret = kind === "terminal" ? TERMINAL_SECRET : SECRET;
  return encodeAuth({ ...auth, token: hmacSha256(secret, signableAuthBytes(auth)) });
}

let gateway: ChildProcess | undefined;

async function waitHealthy(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error("网关未在时限内就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const suite = hasBinary ? describe : describe.skip;

if (!hasBinary) {
  console.warn(
    `[gateway-e2e] 跳过连接层测试：未找到 ${path.relative(repoRoot, binary)}（先执行 cd gateway && cargo build）`,
  );
}

suite("Rust 网关连接层（M2a）", () => {
  beforeAll(async () => {
    gateway = spawn(binary, [], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(PORT),
        GATEWAY_FLEET_SECRET: SECRET,
        GATEWAY_TERMINAL_SECRET: TERMINAL_SECRET,
        GATEWAY_HEARTBEAT_SECS: "5",
        GATEWAY_IDLE_TIMEOUT_SECS: "20",
        GATEWAY_EVENT_BUFFER: "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (d) => process.stderr.write(`[gateway] ${d}`));
    await waitHealthy(PORT);
  }, 25_000);

  afterAll(() => {
    gateway?.kill("SIGKILL");
  });

  it("节点握手成功并收到 AUTH_OK", async () => {
    const node = await Peer.connect(PORT);
    node.send(FrameType.AUTH, authFrame("node-1", "node"));
    const ok = decodeAuthOk((await node.next(FrameType.AUTH_OK)).payload);
    expect(ok.ok).toBe(true);
    expect(ok.serverTs).toBeGreaterThan(0);
    node.close();
  });

  it("错误 token 被拒绝（ok=false + 原因）", async () => {
    const node = await Peer.connect(PORT);
    const bad: Auth = {
      id: "node-bad",
      ts: Date.now(),
      nonce: "x",
      proto: 1,
      kind: "node",
      token: new Uint8Array(32),
    };
    node.send(FrameType.AUTH, encodeAuth(bad));
    const res = decodeAuthOk((await node.next(FrameType.AUTH_OK)).payload);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("签名");
    node.close();
  });

  it("首帧不是 AUTH 即被拒绝", async () => {
    const node = await Peer.connect(PORT);
    node.send(FrameType.STATUS, encodeStatus({ nodeId: "node-1", online: true, ts: Date.now() }));
    const res = decodeAuthOk((await node.next(FrameType.AUTH_OK)).payload);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("AUTH");
    node.close();
  });

  it("过期时间戳被拒绝（±60s 窗口）", async () => {
    const node = await Peer.connect(PORT);
    const old: Auth = { id: "node-old", ts: Date.now() - 120_000, nonce: "old", proto: 1, kind: "node" };
    node.send(FrameType.AUTH, encodeAuth({ ...old, token: hmacSha256(SECRET, signableAuthBytes(old)) }));
    const res = decodeAuthOk((await node.next(FrameType.AUTH_OK)).payload);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/时间戳/);
    node.close();
  });

  it("终端订阅后收到状态快照与增量", async () => {
    const terminal = await Peer.authed(PORT, "user-1", "terminal", "miniapp", ["node-1"]);
    const before = decodeSnapshot((await terminal.next(FrameType.SNAPSHOT)).payload);
    expect(before.nodes).toHaveLength(0);

    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-1"]));
    const snap = decodeSnapshot((await terminal.next(FrameType.SNAPSHOT)).payload);
    expect(snap.nodes).toHaveLength(0); // 尚未上报状态

    const node = await Peer.authed(PORT, "node-1", "node");
    node.send(
      FrameType.STATUS,
      encodeStatus({ nodeId: "node-1", online: true, ts: Date.now(), platform: "linux", version: "0.1.0" }),
    );
    const st = await terminal.waitStatus("node-1", true);
    expect(st.platform).toBe("linux");

    node.close();
    terminal.close();
  });

  it("事件扇出 + 断线续传（resume 只回放游标之后的帧）", async () => {
    const terminal = await Peer.authed(PORT, "user-2", "terminal", "web", ["node-ev"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-ev"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(PORT, "node-ev", "node");
    for (let i = 1; i <= 3; i++) {
      node.send(FrameType.EVENT, encodeEvent({ seq: i, ts: Date.now(), type: "tick", data: new Uint8Array([i]) }));
    }
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      seqs.push(decodeEvent((await terminal.next(FrameType.EVENT)).payload).seq);
    }
    expect(new Set(seqs).size).toBe(3);
    expect(Math.min(...seqs)).toBeGreaterThan(0);

    // 新终端从游标 1 续传
    const late = await Peer.authed(PORT, "user-3", "terminal", "app", ["node-ev"]);
    late.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-ev"]));
    await late.next(FrameType.SNAPSHOT);
    late.send(FrameType.RESUME, encodeResume(1));
    const replayed = decodeEvent((await late.next(FrameType.EVENT)).payload);
    expect(replayed.seq).toBeGreaterThan(1);

    node.close();
    terminal.close();
    late.close();
  });

  it("未订阅的节点不推送事件（多路复用隔离）", async () => {
    const terminal = await Peer.authed(PORT, "user-4", "terminal", "web", ["node-other"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-other"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(PORT, "node-unsub", "node");
    node.send(FrameType.EVENT, encodeEvent({ seq: 1, ts: Date.now(), type: "tick" }));

    await expect(terminal.next(FrameType.EVENT, 400)).rejects.toThrow(/超时/);
    node.close();
    terminal.close();
  });

  it("节点断开后向订阅者广播离线", async () => {
    const terminal = await Peer.authed(PORT, "user-5", "terminal", "web", ["node-byebye"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-byebye"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(PORT, "node-byebye", "node");
    node.send(FrameType.STATUS, encodeStatus({ nodeId: "node-byebye", online: true, ts: Date.now() }));
    expect((await terminal.waitStatus("node-byebye", true)).online).toBe(true);

    node.close();
    expect((await terminal.waitStatus("node-byebye", false)).online).toBe(false);
    terminal.close();
  });

  it("HTTP 可观测端点可用", async () => {
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
    expect(metrics).toContain("zqagent_gateway_connections");
    expect(metrics).toContain("zqagent_gateway_fanout_frames_total");
  });
});
