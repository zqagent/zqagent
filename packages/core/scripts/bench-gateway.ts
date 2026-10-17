/**
 * Rust 网关连接容量测量（M2 门禁）
 *
 * 目标规模：100 节点 / 100 终端并发。本脚本逐级加压并报告：
 *   - 单连接内存（RSS 增量 / 连接数）
 *   - 握手与订阅延迟（p50/p95）
 *   - 事件扇出吞吐（一条事件 → N 个订阅者的端到端时延）
 *
 * 用法（cwd = packages/core）：
 *   npx tsx scripts/bench-gateway.ts                 # 默认 100/100
 *   npx tsx scripts/bench-gateway.ts --nodes 500 --terminals 500
 *   GATEWAY_BIN=gateway/target/release/zqagent-gateway npx tsx scripts/bench-gateway.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import {
  FrameType,
  decodeAuthOk,
  decodeEvent,
  decodeFrame,
  encodeAuth,
  encodeEvent,
  encodeFrame,
  encodeStatus,
  encodeSubscribe,
  signableAuthBytes,
  type Auth,
} from "@zqagent/shared/wire";
import { hmacSha256 } from "@zqagent/shared/wire/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const arg = (k: string, d: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const NODES = arg("nodes", 100);
const TERMINALS = arg("terminals", 100);
/** 每终端订阅的节点数（终端多路复用） */
const SUBS_PER_TERMINAL = arg("subs", 1);
/** 扇出测量：发多少条事件 */
const FANOUT_EVENTS = arg("events", 200);

const binary = process.env.GATEWAY_BIN
  ? path.resolve(repoRoot, process.env.GATEWAY_BIN)
  : path.join(repoRoot, "gateway/target/release/zqagent-gateway");
const fallbackBinary = path.join(repoRoot, "gateway/target/debug/zqagent-gateway");
const bin = fs.existsSync(binary) ? binary : fallbackBinary;
if (!fs.existsSync(bin)) {
  console.error(`未找到网关二进制：${bin}\n先执行：cd gateway && cargo build --release`);
  process.exit(1);
}

const SECRET = "bench-gateway-secret";
const PORT = 18900 + Math.floor(Math.random() * 500);

function rssKb(pid: number): number {
  try {
    // macOS/Linux 通用：ps -o rss= 输出 KB
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf-8" });
    return Number.parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

class Client {
  readonly ws: WebSocket;
  private readonly queue: Array<{ type: number; seq: number; payload: Uint8Array }> = [];
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d: Buffer) => this.queue.push(decodeFrame(new Uint8Array(d))));
    this.ws.on("close", () => {
      this.closed = true;
    });
    this.ws.on("error", () => {
      this.closed = true;
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
    });
  }

  send(type: number, payload: Uint8Array, seq = 0): void {
    this.ws.send(encodeFrame({ type, seq, payload }));
  }

  async waitType(type: number, timeoutMs = 5000): Promise<number> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((f) => f.type === type);
      if (i >= 0) {
        this.queue.splice(i, 1);
        return 0;
      }
      if (performance.now() > deadline) throw new Error(`等待帧超时 type=${type}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  drainEvents(): number {
    let n = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.type === FrameType.EVENT) {
        this.queue.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  close(): void {
    try {
      this.ws.terminate();
    } catch {
      /* 忽略 */
    }
  }
}

function authPayload(id: string, kind: "node" | "terminal", client = ""): Uint8Array {
  const base: Auth = { id, ts: Date.now(), nonce: `n-${id}`, proto: 1, kind, client };
  return encodeAuth({ ...base, token: hmacSha256(SECRET, signableAuthBytes(base)) });
}

async function waitHealthy(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* 未就绪 */
    }
    if (performance.now() > deadline) throw new Error("网关未就绪");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const gateway: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(PORT),
      GATEWAY_FLEET_SECRET: SECRET,
      GATEWAY_SHARDS: "4",
      GATEWAY_EVENT_BUFFER: "64",
      GATEWAY_HEARTBEAT_SECS: "30",
      GATEWAY_IDLE_TIMEOUT_SECS: "90",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const pid = gateway.pid!;
  await waitHealthy(PORT);
  await new Promise((r) => setTimeout(r, 300));

  const baseRss = rssKb(pid);
  console.log(`# Rust 网关容量测量`);
  console.log(
    `\n二进制：${path.relative(repoRoot, bin)}\n规模：${NODES} 节点 · ${TERMINALS} 终端 · 每终端订阅 ${SUBS_PER_TERMINAL} 节点\n`,
  );
  console.log(`空闲 RSS：${(baseRss / 1024).toFixed(1)} MB`);

  // ---- 建连 + 握手 ----
  const handshakeMs: number[] = [];
  const nodes: Client[] = [];
  for (let i = 0; i < NODES; i++) {
    const c = new Client(PORT);
    await c.opened();
    const t0 = performance.now();
    c.send(FrameType.AUTH, authPayload(`bench-node-${i}`, "node"));
    await c.waitType(FrameType.AUTH_OK);
    handshakeMs.push(performance.now() - t0);
    c.send(FrameType.STATUS, encodeStatus({ nodeId: `bench-node-${i}`, online: true, ts: Date.now() }));
    nodes.push(c);
  }
  const afterNodesRss = rssKb(pid);

  const terminals: Client[] = [];
  for (let i = 0; i < TERMINALS; i++) {
    const c = new Client(PORT);
    await c.opened();
    // **热点模式**：所有终端订阅同一个节点（扇出最坏情况，也是「多端同看」的真实形态）
    const subs = Array.from({ length: SUBS_PER_TERMINAL }, (_, k) => `bench-node-${k % NODES}`);
    c.send(FrameType.AUTH, authPayload(`bench-user-${i}`, "terminal", "web"));
    await c.waitType(FrameType.AUTH_OK);
    c.send(FrameType.SUBSCRIBE, encodeSubscribe(subs));
    await c.waitType(FrameType.SNAPSHOT);
    terminals.push(c);
  }
  await new Promise((r) => setTimeout(r, 500));
  const fullRss = rssKb(pid);

  const totalConns = NODES + TERMINALS;
  console.log("\n### 连接与内存");
  console.log("| 指标 | 值 |");
  console.log("| --- | ---: |");
  console.log(`| 总连接数 | ${totalConns} |`);
  console.log(`| 接入全部节点后 RSS | ${(afterNodesRss / 1024).toFixed(1)} MB |`);
  console.log(`| 接入全部连接后 RSS | ${(fullRss / 1024).toFixed(1)} MB |`);
  console.log(`| 每连接增量 | ${(((fullRss - baseRss) * 1024) / totalConns).toFixed(0)} B |`);
  const p = (arr: number[], q: number) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * q)] ?? 0;
  console.log(`| 握手延迟 p50 / p95 | ${p(handshakeMs, 0.5).toFixed(2)} / ${p(handshakeMs, 0.95).toFixed(2)} ms |`);

  // ---- 扇出吞吐：一条事件 → N 个订阅者 ----
  const publisher = nodes[0]!;
  const t0 = performance.now();
  for (let i = 0; i < FANOUT_EVENTS; i++) {
    publisher.send(
      FrameType.EVENT,
      encodeEvent({ seq: i + 1, ts: Date.now(), type: "bench", data: new Uint8Array(600) }),
    );
  }
  // 热点模式：publisher 是 bench-node-0，所有终端都订阅了它 → 每个终端应收到 FANOUT_EVENTS 帧
  const expectedPerTerminal = FANOUT_EVENTS;
  const waitOne = async (t: Client) => {
    const deadline = performance.now() + 20_000;
    let got = 0;
    // 注意：drainEvents 返回「本次清空的数量」，必须累加而不是直接比较
    while (got < expectedPerTerminal) {
      got += t.drainEvents();
      if (performance.now() > deadline) throw new Error(`扇出未完成：${got}/${expectedPerTerminal}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  let fanoutError: unknown = null;
  try {
    await Promise.all(terminals.map(waitOne));
  } catch (e) {
    fanoutError = e;
  }
  const elapsed = performance.now() - t0;
  const received = FANOUT_EVENTS * TERMINALS;
  console.log("\n### 事件扇出");
  console.log("| 指标 | 值 |");
  console.log("| --- | ---: |");
  console.log(`| 上行事件数 | ${FANOUT_EVENTS} |`);
  console.log(`| 下行帧数（事件 × 订阅者） | ${received} |`);
  console.log(`| 端到端耗时 | ${elapsed.toFixed(1)} ms |`);
  console.log(`| 上行吞吐 | ${Math.round((FANOUT_EVENTS / elapsed) * 1000).toLocaleString()} 条/秒 |`);
  console.log(`| 下行扇出吞吐 | ${Math.round((received / elapsed) * 1000).toLocaleString()} 帧/秒 |`);
  if (fanoutError) console.log(`| ⚠️ 扇出超时 | ${String(fanoutError)} |`);

  const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
  const line = (k: string) => metrics.split("\n").find((l) => l.startsWith(k))?.split(" ")[1] ?? "?";
  console.log("\n### 网关自报指标");
  console.log("| 指标 | 值 |");
  console.log("| --- | ---: |");
  console.log(`| 连接数 | ${line("zqagent_gateway_connections")} |`);
  console.log(`| 在线节点 | ${line("zqagent_gateway_nodes")} |`);
  console.log(`| 终端数 | ${line("zqagent_gateway_terminals")} |`);
  console.log(`| 订阅总数 | ${line("zqagent_gateway_subscriptions")} |`);
  console.log(`| 扇出帧累计 | ${line("zqagent_gateway_fanout_frames_total")} |`);
  console.log(`| 丢弃帧累计 | ${line("zqagent_gateway_dropped_frames_total")} |`);
  console.log(`| 峰值 RSS | ${(rssKb(pid) / 1024).toFixed(1)} MB |`);

  for (const c of [...nodes, ...terminals]) c.close();
  gateway.kill("SIGKILL");
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
