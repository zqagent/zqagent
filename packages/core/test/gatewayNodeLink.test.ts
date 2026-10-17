/**
 * 节点端接入 Rust 网关（M4）：真实 FleetNodeBridge 走二进制 WSS
 *
 * 与 M2b/M2c 的测试不同，这里**不再手工构造帧**，而是用生产代码
 * （`FleetNodeBridge.connect()` → `WssLink` → `fleetWire` 适配层 →
 * `dispatchFleetCommand`）完整跑一遍：
 *
 *   终端 → 网关 → [WSS] → 节点（校验签名 → 解码 → 执行） → 回执 → 网关 → 终端
 *
 * 因此它覆盖的是真实的节点侧接入路径，而不是协议本身。前提：网关二进制已构建
 * （`cd gateway && cargo build`），未构建则跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  FrameType,
  decodeAck,
  decodeAuthOk,
  decodeFrame,
  decodeSnapshot,
  decodeStatus,
  encodeAuth,
  encodeEnvelope,
  encodeFrame,
  encodeSubscribe,
  signableAuthBytes,
  type Auth,
  type Envelope,
  type Frame,
} from "@zqagent/shared/wire";
import { hmacSha256 } from "@zqagent/shared/wire/node";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import type { TenantConfig } from "../src/server/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const binary = path.join(repoRoot, "gateway/target/debug/zqagent-gateway");
const hasBinary = fs.existsSync(binary);

const SECRET = "e2e-m4-secret";
const TERMINAL_SECRET = "e2e-m5-terminal-secret";
const ADMIN_TOKEN = "e2e-admin-token";
const FLEET = "ft-m4";
const NODE = "node-m4";
const PORT = 19600 + Math.floor(Math.random() * 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轻量终端：只用于发指令、收回执（与 gatewayCommands.test.ts 同一套用法） */
class Peer {
  private readonly queue: Frame[] = [];
  private closed = false;
  private constructor(private readonly ws: WebSocket) {
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
    // 终端面（M5）：令牌必须带 scope（网关 fail closed），且用 terminal secret 签
    const base: Auth = { id, ts: Date.now(), nonce: `n-${id}`, proto: 1, kind, client };
    const auth: Auth =
      kind === "terminal"
        ? { ...base, scope, expires: Date.now() + 3_600_000 }
        : base;
    const secret = kind === "terminal" ? TERMINAL_SECRET : SECRET;
    peer.send(FrameType.AUTH, encodeAuth({ ...auth, token: hmacSha256(secret, signableAuthBytes(auth)) }));
    const ok = decodeAuthOk((await peer.next(FrameType.AUTH_OK)).payload);
    if (!ok.ok) throw new Error(`握手失败: ${ok.error}`);
    return peer;
  }

  send(type: number, payload: Uint8Array, seq = 0): void {
    this.ws.send(encodeFrame({ type, seq, payload }));
  }

  async next(type: number, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((f) => f.type === type);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (this.closed) throw new Error("连接已关闭");
      if (Date.now() > deadline) throw new Error(`等待帧超时（type=${type}）`);
      await sleep(15);
    }
  }

  /** 丢弃指定类型的待取帧（重试订阅时用，避免取到上一轮的快照） */
  drain(type: number): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]!.type === type) this.queue.splice(i, 1);
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

function envelope(nodeId: string, reqId: string, type: string): Envelope {
  return { t: Date.now(), nonce: `n-${reqId}`, reqId, type, clientId: "web-m4", nodeId };
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
    await sleep(100);
  }
}

/**
 * 订阅并等快照里出现该节点。
 *
 * 不能只订阅一次：`node.isConnected()` 只说明 AUTH 握手完成，STATUS 帧是随后
 * 异步处理的；此刻快照里可能还没有该节点（实测偶发为空）。重新订阅会重新下发
 * 快照，因此「重试到看见」是最贴近真实的等待方式。
 */
async function subscribeAndSeeNode(
  terminal: Peer,
  nodeId: string,
  timeoutMs = 5000,
): Promise<{ online: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    terminal.drain(FrameType.SNAPSHOT);
    terminal.send(FrameType.SUBSCRIBE, encodeSubscribe([nodeId]));
    const snap = decodeSnapshot((await terminal.next(FrameType.SNAPSHOT, 1000)).payload);
    const state = snap.nodes.find((n) => n.nodeId === nodeId);
    if (state) return state;
    if (Date.now() > deadline) throw new Error(`快照中始终没有节点 ${nodeId}`);
    await sleep(50);
  }
}

/** 等节点链路就绪（AUTH 完成） */
async function waitConnected(node: FleetNodeBridge, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!node.isConnected() && Date.now() < deadline) await sleep(20);
  expect(node.isConnected()).toBe(true);
}

/** 造一个可用节点（真实 Store + SessionManager，与生产一致） */
function makeNode(gatewayUrl: string): { node: FleetNodeBridge; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-m4-"));
  const store = new Store(root);
  store.saveTenant({
    id: "p1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
  } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  const node = new FleetNodeBridge({
    gatewayUrl,
    fleetToken: FLEET,
    fleetSecret: SECRET,
    nodeId: NODE,
    deps: { store, manager },
  });
  return { node, cleanup: () => node.close() };
}

const suite = hasBinary ? describe : describe.skip;
if (!hasBinary) {
  console.warn(
    `[gateway-m4-e2e] 跳过节点接入测试：未找到 ${path.relative(repoRoot, binary)}（先执行 cd gateway && cargo build）`,
  );
}

suite("节点端接入 Rust 网关（M4）", () => {
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
        // 控制面端点（测试用；正式部署必须显式配置，网关侧 fail-closed）
        GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
        GATEWAY_CMD_TIMEOUT_MS: "800",
        GATEWAY_LONG_CMD_TIMEOUT_MS: "1000",
        GATEWAY_MAX_CMD_TIMEOUT_MS: "1500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (d) => process.stderr.write(`[gateway] ${d}`));
    await waitHealthy(PORT);
  }, 25_000);

  afterAll(() => {
    gateway?.kill("SIGKILL");
  });

  it("节点 WSS 接入后状态上报，并被终端在快照里看到", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const terminal = await Peer.authed(PORT, "t-snap", "terminal", "web", [NODE]);
      // 节点上报的 STATUS 帧被网关转成了权威 states（retained 语义的替代）
      const state = await subscribeAndSeeNode(terminal, NODE);
      expect(state.online).toBe(true);
      terminal.close();
    } finally {
      cleanup();
    }
  });

  it("指令闭环：终端 → 网关 → 节点执行 → 回执", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const terminal = await Peer.authed(PORT, "t-cmd", "terminal", "web", [NODE]);
      await subscribeAndSeeNode(terminal, NODE);

      // 终端**不**签名：它不持有 fleetSecret（那是节点密钥）。网关按令牌授权后
      // 代签再转发，因此节点侧的验签逻辑完全不用改。
      terminal.send(FrameType.CMD, encodeEnvelope(envelope(NODE, "req-m5-1", "ping")));
      const ack = decodeAck((await terminal.next(FrameType.ACK, 6000)).payload);
      expect(ack.reqId).toBe("req-m5-1");
      expect(ack.type).toBe("ping");
      // 节点验签通过 → 证明网关代签产生的签名与节点期望一致
      expect(ack.ok).toBe(true);
      terminal.close();
    } finally {
      cleanup();
    }
  });

  it("终端自带的签名被网关拒绝：终端不得伪造签名语义，同时合法指令不受影响", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const terminal = await Peer.authed(PORT, "t-bad", "terminal", "web", [NODE]);
      await subscribeAndSeeNode(terminal, NODE);

      // 先前置证明链路正常：未签名指令经网关代签后能拿到成功回执
      terminal.send(FrameType.CMD, encodeEnvelope(envelope(NODE, "req-good", "ping")));
      const good = decodeAck((await terminal.next(FrameType.ACK, 4000)).payload);
      expect(good.reqId).toBe("req-good");
      expect(good.ok).toBe(true);

      // 自带 sig：终端不可能算出正确签名（没有 fleetSecret），所以非空 sig 只可能
      // 是伪造。网关**直接拒绝**而不是覆盖，否则「终端可影响指令签名」就成了漏洞面。
      terminal.drain(FrameType.ACK);
      terminal.send(
        FrameType.CMD,
        encodeEnvelope({ ...envelope(NODE, "req-selfsig", "ping"), sig: new Uint8Array(32) }),
      );
      const bad = decodeAck((await terminal.next(FrameType.ACK, 4000)).payload);
      expect(bad.reqId).toBe("req-selfsig");
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("签名");
      terminal.close();
    } finally {
      cleanup();
    }
  });

  it("节点断开后网关判定离线（LWT 的替代机制）", async () => {    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const terminal = await Peer.authed(PORT, "t-down", "terminal", "web", [NODE]);
      const before = await subscribeAndSeeNode(terminal, NODE);
      expect(before.online).toBe(true);

      // 节点掉线：网关应把状态翻成 offline 并推给订阅者
      cleanup();
      const deadline = Date.now() + 5000;
      let sawOffline = false;
      while (Date.now() < deadline) {
        try {
          const f = await terminal.next(FrameType.STATUS, 500);
          if (decodeStatus(f.payload).online === false) {
            sawOffline = true;
            break;
          }
        } catch {
          /* 继续等 */
        }
      }
      expect(sawOffline).toBe(true);
      terminal.close();
    } finally {
      cleanup();
    }
  });

  // ===================== M5 终端授权（scope） =====================

  it("订阅越权节点被整帧拒绝（不静默过滤，否则客户端以为订阅成功却收不到数据）", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);
      // 令牌只授权 NODE（= NODE_ID），却去订阅别的节点
      const terminal = await Peer.authed(PORT, "t-scope-sub", "terminal", "web", [NODE]);
      terminal.send(FrameType.SUBSCRIBE, encodeSubscribe(["someone-elses-node"]));
      const res = decodeAuthOk((await terminal.next(FrameType.AUTH_OK, 3000)).payload);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("无权订阅");
      terminal.close();
    } finally {
      cleanup();
    }
  });

  it("对越权节点发指令被拒（授权是精确匹配，不做前缀/通配）", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const terminal = await Peer.authed(PORT, "t-scope-cmd", "terminal", "web", [NODE]);
      // 先用合法范围订阅，确保后续失败确实源于授权而非订阅检查
      await subscribeAndSeeNode(terminal, NODE);
      // 构造一个「前缀是合法 nodeId」的越权目标，验证不会因前缀匹配而放行
      terminal.send(
        FrameType.CMD,
        encodeEnvelope(envelope(`${NODE}-suffix`, "req-越权", "ping")),
      );
      const ack = decodeAck((await terminal.next(FrameType.ACK, 3000)).payload);
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("无权访问");
      terminal.close();
    } finally {
      cleanup();
    }
  });

  it("终端令牌缺 scope 时握手即失败（fail closed，不是放行）", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      const auth: Auth = {
        id: "t-no-scope",
        ts: Date.now(),
        nonce: "n-no-scope",
        proto: 1,
        kind: "terminal",
        client: "web",
        expires: Date.now() + 3_600_000,
        // 刻意不给 scope
      };
      ws.send(
        encodeFrame({
          type: FrameType.AUTH,
          seq: 0,
          payload: encodeAuth({
            ...auth,
            token: hmacSha256(TERMINAL_SECRET, signableAuthBytes(auth)),
          }),
        }),
      );
      const ok = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        ws.on("message", (d: Buffer) => resolve(decodeAuthOk(decodeFrame(new Uint8Array(d)).payload)));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("等待 AUTH_OK 超时")), 3000);
      });
      expect(ok.ok).toBe(false);
      expect(ok.error).toContain("授权范围");
      ws.close();
    } finally {
      cleanup();
    }
  });

  it("用节点密钥（fleetSecret）签的终端令牌不被接受：密钥分离切断节点提权路径", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      const auth: Auth = {
        id: "t-node-key",
        ts: Date.now(),
        nonce: "n-node-key",
        proto: 1,
        kind: "terminal",
        client: "web",
        scope: [NODE],
        expires: Date.now() + 3_600_000,
      };
      // 节点侧知道的就是 fleetSecret —— 用它签终端令牌必须失败
      ws.send(
        encodeFrame({
          type: FrameType.AUTH,
          seq: 0,
          payload: encodeAuth({ ...auth, token: hmacSha256(SECRET, signableAuthBytes(auth)) }),
        }),
      );
      const ok = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        ws.on("message", (d: Buffer) => resolve(decodeAuthOk(decodeFrame(new Uint8Array(d)).payload)));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("等待 AUTH_OK 超时")), 3000);
      });
      expect(ok.ok).toBe(false);
      expect(ok.error).toContain("签名");
      ws.close();
    } finally {
      cleanup();
    }
  });

  it("网关 /state 暴露节点聚合，detail 携带原始 info（控制面替代 retained info 的数据源）", async () => {
    const { node, cleanup } = makeNode(`ws://127.0.0.1:${PORT}/ws`);
    try {
      node.connect();
      await waitConnected(node);

      const fetchState = async (): Promise<{
        status: number;
        nodes: Array<Record<string, unknown>>;
      }> => {
        const res = await fetch(`http://127.0.0.1:${PORT}/state`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        if (!res.ok) return { status: res.status, nodes: [] };
        const body = (await res.json()) as { nodes?: Array<Record<string, unknown>> };
        return { status: res.status, nodes: body.nodes ?? [] };
      };

      // 等节点上报 INFO 被网关聚合（STATUS/INFO 是异步处理的）
      const deadline = Date.now() + 6000;
      let entry = null as Record<string, unknown> | null;
      while (Date.now() < deadline) {
        const st = await fetchState();
        expect(st.status).toBe(200);
        entry = st.nodes.find((n) => n["nodeId"] === NODE) ?? null;
        if (entry && entry["detail"]) break;
        await sleep(100);
      }
      expect(entry).not.toBeNull();
      expect(entry!["online"]).toBe(true);
      // platform/version 来自 STATUS/INFO 聚合
      expect(String(entry!["platform"])).toBe(process.platform);

      // detail 是节点上报的原始 info JSON —— Rust 侧必须能原样解出中文与结构
      const detail = entry!["detail"] as Record<string, unknown>;
      expect(detail).toBeTruthy();
      expect(detail["nodeId"]).toBe(NODE);
      expect(detail["label"]).toBeUndefined(); // 本节点未设 label，如实缺席
      expect(Array.isArray(detail["projects"])).toBe(true);
      expect(detail["totals"]).toBeTruthy();
      const totals = detail["totals"] as Record<string, number>;
      expect(typeof totals["projects"]).toBe("number");
      expect(typeof totals["sessions"]).toBe("number");
      // stats 也要完整带过来（控制面统计视图依赖）
      expect(typeof (detail["stats"] as Record<string, unknown>)["turns"]).toBe("number");
    } finally {
      cleanup();
    }
  });

  it("/state 未带令牌时被拒（fail-closed，不含节点明细）", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/state`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });
});
