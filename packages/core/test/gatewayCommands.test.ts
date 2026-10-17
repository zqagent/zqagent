/**
 * Node ↔ Rust 网关 指令闭环端到端测试（M2b）
 *
 * 覆盖：终端发起指令 → 网关 → 节点 → 回执 → 终端；以及离线/未订阅/超时/串行/INFO 聚合。
 * 前提：网关二进制已构建（`cd gateway && cargo build`），未构建则跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  FrameType,
  decodeAck,
  decodeAuthOk,
  decodeEnvelope,
  decodeFrame,
  decodeInfo,
  decodeSnapshot,
  encodeAck,
  encodeAuth,
  encodeEnvelope,
  encodeFrame,
  encodeInfo,
  encodeSubscribe,
  signableAuthBytes,
  type Auth,
  type Envelope,
  type Frame,
} from "@zqagent/shared/wire";
import { hmacSha256 } from "@zqagent/shared/wire/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const binary = path.join(repoRoot, "gateway/target/debug/zqagent-gateway");
const hasBinary = fs.existsSync(binary);

const SECRET = "e2e-cmd-secret";
const TERMINAL_SECRET = "e2e-cmd-terminal-secret";
const PORT = 19190 + Math.floor(Math.random() * 400);

class Peer {
  private readonly ws: WebSocket;
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

  static async authed(
    port: number,
    id: string,
    kind: "node" | "terminal",
    client = "",
    scope: string[] = [],
  ): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer = new Peer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    // 终端面（M5）：令牌必须带 scope（网关 fail closed），且用独立的 terminal secret 签
    const base: Auth = { id, ts: Date.now(), nonce: `n-${id}`, proto: 1, kind, client };
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

  /** 是否有指定类型的帧在队列里（不等待） */
  has(type: number): boolean {
    return this.queue.some((f) => f.type === type);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

function envelope(nodeId: string, reqId: string, type: string, timeoutMs = 0): Envelope {
  return { t: Date.now(), nonce: `n-${reqId}`, reqId, type, clientId: "e2e", nodeId, timeoutMs };
}

let gateway: ChildProcess | undefined;

async function waitHealthy(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* 未就绪 */
    }
    if (Date.now() > deadline) throw new Error("网关未在时限内就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const suite = hasBinary ? describe : describe.skip;
if (!hasBinary) {
  console.warn(
    `[gateway-cmd-e2e] 跳过指令闭环测试：未找到 ${path.relative(repoRoot, binary)}（先执行 cd gateway && cargo build）`,
  );
}

suite("Rust 网关指令闭环（M2b）", () => {
  beforeAll(async () => {
    gateway = spawn(binary, [], {
      env: {
        ...process.env,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(PORT),
        GATEWAY_FLEET_SECRET: SECRET,
        GATEWAY_TERMINAL_SECRET: TERMINAL_SECRET,
        GATEWAY_HEARTBEAT_SECS: "10",
        GATEWAY_IDLE_TIMEOUT_SECS: "30",
        // 缩短超时便于测试（默认 10s/60s 太慢）
        GATEWAY_CMD_TIMEOUT_MS: "300",
        GATEWAY_LONG_CMD_TIMEOUT_MS: "600",
        GATEWAY_MAX_CMD_TIMEOUT_MS: "1200",
        GATEWAY_CMD_BUDGET_MARGIN_MS: "50",
        GATEWAY_NODE_QUEUE_DEPTH: "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (d) => process.stderr.write(`[gateway] ${d}`));
    await waitHealthy(PORT);
  }, 25_000);

  afterAll(() => {
    gateway?.kill("SIGKILL");
  });

  it("指令闭环：终端 → 网关 → 节点 → 回执 → 终端", async () => {
    const terminal = await Peer.authed(PORT, "t1", "terminal", "web", ["node-cmd"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-cmd"]));
    await terminal.next(FrameType.SNAPSHOT);

    const node = await Peer.authed(PORT, "node-cmd", "node");

    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-cmd", "req-1", "ping")));

    // 节点应收到 CMD，且 reqId/nodeId 完好
    const cmdFrame = await node.next(FrameType.CMD);
    const got = decodeEnvelope(cmdFrame.payload);
    expect(got.reqId).toBe("req-1");
    expect(got.nodeId).toBe("node-cmd");
    expect(got.type).toBe("ping");

    // 节点回执 → 应回到发起终端
    node.send(
      FrameType.ACK,
      encodeAck({ reqId: "req-1", type: "ping", ok: true, data: new Uint8Array([9]) }),
    );
    const ack = decodeAck((await terminal.next(FrameType.ACK)).payload);
    expect(ack.ok).toBe(true);
    expect(ack.reqId).toBe("req-1");
    expect([...ack.data!]).toEqual([9]);

    node.close();
    terminal.close();
  });

  it("节点离线：立即回 node_offline，不必等超时", async () => {
    const terminal = await Peer.authed(PORT, "t2", "terminal", "web", ["node-absent"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-absent"]));
    await terminal.next(FrameType.SNAPSHOT);

    const t0 = Date.now();
    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-absent", "req-2", "ping")));
    const ack = decodeAck((await terminal.next(FrameType.ACK)).payload);
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("离线");
    expect(Date.now() - t0).toBeLessThan(250); // 必须即时失败，而不是等 300ms 超时
    terminal.close();
  });

  it("未订阅该节点：拒绝（终端只能操作自己订阅的节点）", async () => {
    // 授权范围含该节点，但**不订阅**——用于验证「未订阅即拒绝」
    const terminal = await Peer.authed(PORT, "t3", "terminal", "web", ["node-other"]);
    const node = await Peer.authed(PORT, "node-other", "node");

    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-other", "req-3", "ping")));
    const ack = decodeAck((await terminal.next(FrameType.ACK)).payload);
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("未订阅");

    node.close();
    terminal.close();
  });

  it("节点不回执：超时后收到错误回执（不挂起）", async () => {
    const terminal = await Peer.authed(PORT, "t4", "terminal", "web", ["node-silent"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-silent"]));
    await terminal.next(FrameType.SNAPSHOT);
    const node = await Peer.authed(PORT, "node-silent", "node");

    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-silent", "req-4", "ping")));
    await node.next(FrameType.CMD); // 节点收到但不回执

    const ack = decodeAck((await terminal.next(FrameType.ACK, 2000)).payload);
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("超时");

    node.close();
    terminal.close();
  });

  it("执行预算：timeout_ms 决定等待上限（慢指令预算更长）", async () => {
    const terminal = await Peer.authed(PORT, "t5", "terminal", "web", ["node-budget"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-budget"]));
    await terminal.next(FrameType.SNAPSHOT);
    const node = await Peer.authed(PORT, "node-budget", "node");

    // 预算 900ms（> 默认 300ms）：节点在 400ms 后回执，应当成功
    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-budget", "req-5", "run_command", 900)));
    await node.next(FrameType.CMD);
    await new Promise((r) => setTimeout(r, 400));
    node.send(FrameType.ACK, encodeAck({ reqId: "req-5", type: "run_command", ok: true }));
    const ack = decodeAck((await terminal.next(FrameType.ACK, 2000)).payload);
    expect(ack.ok).toBe(true);

    node.close();
    terminal.close();
  });

  it("每节点串行：前一条回执前不下发下一条", async () => {
    const terminal = await Peer.authed(PORT, "t6", "terminal", "web", ["node-serial"]);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-serial"]));
    await terminal.next(FrameType.SNAPSHOT);
    const node = await Peer.authed(PORT, "node-serial", "node");

    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-serial", "s1", "ping")));
    terminal.send(FrameType.CMD, encodeEnvelope(envelope("node-serial", "s2", "ping")));

    const first = decodeEnvelope((await node.next(FrameType.CMD)).payload);
    expect(first.reqId).toBe("s1");
    // 未回执前不应有第二条
    await expect(node.next(FrameType.CMD, 200)).rejects.toThrow(/超时/);

    node.send(FrameType.ACK, encodeAck({ reqId: "s1", type: "ping", ok: true }));
    await terminal.next(FrameType.ACK);
    const second = decodeEnvelope((await node.next(FrameType.CMD)).payload);
    expect(second.reqId).toBe("s2");
    node.send(FrameType.ACK, encodeAck({ reqId: "s2", type: "ping", ok: true }));
    await terminal.next(FrameType.ACK);

    node.close();
    terminal.close();
  });

  it("INFO 上报被聚合并反映在快照里", async () => {
    const node = await Peer.authed(PORT, "node-info", "node");
    node.send(
      FrameType.INFO,
      encodeInfo({
        nodeId: "node-info",
        platform: "linux",
        version: "0.1.0",
        projects: 3,
        sessions: 7,
        running: 1,
        waiting: 2,
        ts: Date.now(),
      }),
    );
    await new Promise((r) => setTimeout(r, 200));

    // 指标：区分「已注册连接」与「已知状态」，两者都应 ≥1
    const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
    const val = (k: string) => Number(metrics.split("\n").find((l) => l.startsWith(k))?.split(" ")[1] ?? "0");
    expect(val("zqagent_gateway_known_states")).toBeGreaterThan(0);

    const terminal = await Peer.authed(PORT, "t7", "terminal", "web", ["node-info"]);
    // 注意：连接建立时网关会先推一个「订阅为空」的初始快照；
    // 订阅后的是第二个快照，必须按序取，不能直接 find。
    const initial = decodeSnapshot((await terminal.next(FrameType.SNAPSHOT)).payload);
    expect(initial.nodes).toHaveLength(0);

    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["node-info"]));
    const afterSubscribe = decodeSnapshot((await terminal.next(FrameType.SNAPSHOT)).payload);
    expect(afterSubscribe.nodes.map((n) => n.nodeId)).toEqual(["node-info"]);

    node.close();
    terminal.close();
  });

  it("指令指标可观测（成功/超时/离线均计入）", async () => {
    const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
    const val = (k: string) =>
      Number(metrics.split("\n").find((l) => l.startsWith(k))?.split(" ")[1] ?? "0");
    expect(val("zqagent_gateway_commands_dispatched_total")).toBeGreaterThan(0);
    expect(val("zqagent_gateway_commands_succeeded_total")).toBeGreaterThan(0);
    expect(val("zqagent_gateway_commands_timed_out_total")).toBeGreaterThan(0);
    expect(val("zqagent_gateway_commands_rejected_offline_total")).toBeGreaterThan(0);
    expect(val("zqagent_gateway_pending_commands")).toBe(0); // 全部收敛，无泄漏
  });

  it("节点收到的 INFO 载荷可正确解码（编解码闭环）", async () => {
    // 反向验证：网关不解码 INFO 之外的字段，但节点侧编码必须与 JS 一致（向量已覆盖）
    const info = {
      nodeId: "n-x",
      platform: "darwin",
      projects: 1,
      sessions: 2,
      running: 0,
      waiting: 0,
      ts: 1_700_000_000_000,
    };
    const decoded = decodeInfo(encodeInfo(info));
    expect(decoded).toEqual(info);
  });
});
