/**
 * WssLink 链路层单测（用本地假网关，不依赖 Rust 网关二进制）
 *
 * 为什么单独测：网关的集成测试只能覆盖「一切正常」的路径，而链路层的绝大多数
 * 风险都在异常分支——握手失败、静默断链、断线重连、伪造帧。这些必须能在不启动
 * 真网关的情况下确定性地复现。
 *
 * 覆盖：握手/心跳/静默判定/重连退避/指令签名与重放拒绝/畸形帧容错。
 */
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  FrameType,
  decodeAuth,
  decodeEnvelope,
  decodeFrame,
  encodeAuth,
  encodeEnvelope,
  encodeFrame,
  type Auth,
  type Envelope,
} from "@zqagent/shared/wire";
import { signAuth, signEnvelope } from "@zqagent/shared/wire/node";
import { WssLink } from "../src/server/fleet/wssLink.js";

const SECRET = "wsslink-test-secret";
const NODE = "n-link";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 3000, what = "条件"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(10);
  }
}

/** 极简假网关：只做握手应答、PING/PONG，并记录收到的帧 */
class FakeGateway {
  private readonly wss: WebSocketServer;
  readonly peers = new Set<WebSocket>();
  readonly seen: number[] = [];
  /** 置 false 可让握手失败（用于测链路的重连） */
  acceptAuth = true;
  /** 是否回 PONG（置 false 模拟对端静默） */
  replyPong = true;
  /** 最近一次解析到的 AUTH 载荷 */
  lastAuth: Auth | null = null;
  private port = 0;

  private constructor(server: WebSocketServer) {
    this.wss = server;
    server.on("connection", (ws) => {
      this.peers.add(ws);
      ws.on("message", (d: Buffer) => this.onMessage(ws, new Uint8Array(d)));
      ws.on("close", () => this.peers.delete(ws));
    });
  }

  static async listen(): Promise<FakeGateway> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const gw = new FakeGateway(server);
    await new Promise<void>((r) => server.on("listening", () => r()));
    gw.port = (server.address() as AddressInfo).port;
    return gw;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  private onMessage(ws: WebSocket, bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return; // 客户端发了畸形帧：假网关不关心
    }
    this.seen.push(frame.type);
    if (frame.type === FrameType.AUTH) {
      const auth = decodeAuth(frame.payload);
      this.lastAuth = auth;
      if (!this.acceptAuth) {
        ws.close(4001, "unauthorized");
        return;
      }
      const ok = signAuth(SECRET, auth);
      ws.send(encodeFrame({ type: FrameType.AUTH_OK, seq: 0, payload: encodeAuth(ok) }));
      return;
    }
    if (frame.type === FrameType.PING && this.replyPong) {
      ws.send(encodeFrame({ type: FrameType.PONG, seq: 0, payload: new Uint8Array(0) }));
    }
  }

  /** 主动给所有客户端推一个 CMD 帧 */
  pushCmd(env: Envelope): void {
    const frame = encodeFrame({ type: FrameType.CMD, seq: 0, payload: encodeEnvelope(env) });
    for (const ws of this.peers) ws.send(frame);
  }

  /** 推原始字节（测畸形帧容错） */
  pushRaw(bytes: Uint8Array): void {
    for (const ws of this.peers) ws.send(bytes);
  }

  /** 强断所有客户端（模拟网关重启） */
  dropAll(): void {
    for (const ws of this.peers) ws.terminate();
    this.peers.clear();
  }

  close(): void {
    this.dropAll();
    this.wss.close();
  }
}

function makeLink(gw: FakeGateway) {
  const events = { ready: 0, down: [] as string[], commands: [] as Envelope[], rejects: [] as string[] };
  const link = new WssLink({
    url: gw.url,
    nodeId: NODE,
    fleetSecret: SECRET,
    pingMs: 40,
    idleMs: 200,
    logger: { info: () => undefined, warn: () => undefined },
    onReady: () => (events.ready += 1),
    onDown: (r) => events.down.push(r),
    onCommand: (env) => events.commands.push(env),
    onReject: (r) => events.rejects.push(r),
  });
  return { link, events };
}

function cmdEnv(reqId: string, type = "ping", nodeId = NODE): Envelope {
  return { t: Date.now(), nonce: `n-${reqId}`, reqId, type, clientId: "web", nodeId };
}

let gateway: FakeGateway | undefined;
let link: WssLink | undefined;

afterEach(() => {
  link?.stop();
  link = undefined;
  gateway?.close();
  gateway = undefined;
});

describe("WssLink 链路层", () => {
  it("握手：AUTH → AUTH_OK 后进入就绪状态", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady(), 3000, "链路就绪");
    expect(made.events.ready).toBe(1);
    // 客户端必须真的发了 AUTH（而不是靠什么隐式状态）
    expect(gateway.seen).toContain(FrameType.AUTH);
  });

  it("心跳：固定节拍发 PING，收到 PONG 不判定断线", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());
    await waitFor(() => gateway!.seen.filter((t) => t === FrameType.PING).length >= 2, 3000, "两次 PING");
    // PONG 一直在回，链路不该被判死
    expect(made.events.down).toEqual([]);
    expect(link.isReady()).toBe(true);
  });

  it("静默判定：对端不再回 PONG 时触发断线", async () => {
    gateway = await FakeGateway.listen();
    gateway.replyPong = false;
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());
    await waitFor(() => made.events.down.length > 0, 3000, "静默断线");
    expect(made.events.down[0]).toContain("idle");
  });

  it("对端断开后自动重连（网关重启场景）", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());
    expect(made.events.ready).toBe(1);

    gateway.dropAll();
    await waitFor(() => made.events.down.length > 0, 3000, "断线通知");
    // 退避后应自行连回（首轮退避 ~0.5~1.5s）
    await waitFor(() => made.events.ready >= 2, 6000, "重连成功");
  });

  it("握手被拒（如密钥不符）时持续退避重试，不崩溃", async () => {
    gateway = await FakeGateway.listen();
    gateway.acceptAuth = false;
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await sleep(1200);
    expect(link.isReady()).toBe(false);
    expect(made.events.ready).toBe(0);
    // 至少尝试过一次（AUTH 发出后被 close）
    expect(gateway.seen).toContain(FrameType.AUTH);
  });

  it("指令：签名正确才交给 onCommand，且字段完整", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    gateway.pushCmd(signEnvelope(SECRET, cmdEnv("r-ok", "get_state")));
    await waitFor(() => made.events.commands.length === 1);
    expect(made.events.commands[0]!.reqId).toBe("r-ok");
    expect(made.events.commands[0]!.type).toBe("get_state");
    expect(made.events.rejects).toEqual([]);
  });

  it("指令：签名错误被拒绝，不交给 onCommand", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    gateway.pushCmd({ ...cmdEnv("r-bad"), sig: new Uint8Array(32) });
    await waitFor(() => made.events.rejects.length === 1);
    expect(made.events.rejects[0]).toContain("签名");
    expect(made.events.commands).toEqual([]);
  });

  it("指令：目标节点不是自己 → 拒绝", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    gateway.pushCmd(signEnvelope(SECRET, cmdEnv("r-other", "ping", "someone-else")));
    await waitFor(() => made.events.rejects.length === 1);
    expect(made.events.rejects[0]).toContain("目标节点");
    expect(made.events.commands).toEqual([]);
  });

  it("指令：同一 nonce 重放被拒（防重放）", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    const env = signEnvelope(SECRET, { ...cmdEnv("r-1"), nonce: "same-nonce" });
    gateway.pushCmd(env);
    gateway.pushCmd(env);
    // 第一条接受，第二条因 nonce 已见被拒
    await waitFor(() => made.events.rejects.length === 1);
    expect(made.events.rejects[0]).toContain("nonce");
    expect(made.events.commands.length).toBe(1);
  });

  it("畸形帧不会打挂链路（magic 非法 / 截断 / 未知类型）", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    gateway.pushRaw(new Uint8Array([1, 2, 3, 4, 5, 6])); // magic 不符
    gateway.pushRaw(new Uint8Array([0x5a, 0x51, 0x1f, 0x0a])); // 未定义帧类型 15
    gateway.pushRaw(new Uint8Array([0x5a, 0x51, 0x10])); // 截断
    await sleep(100);

    // 链路必须还活着，且仍能正常处理合法指令
    expect(link.isReady()).toBe(true);
    gateway.pushCmd(signEnvelope(SECRET, cmdEnv("r-after")));
    await waitFor(() => made.events.commands.length === 1);
    expect(made.events.commands[0]!.reqId).toBe("r-after");
  });

  it("stop() 后不再重连（否则进程退不掉）", async () => {
    gateway = await FakeGateway.listen();
    const made = makeLink(gateway);
    link = made.link;
    link.start();
    await waitFor(() => link!.isReady());

    link.stop();
    expect(link.isReady()).toBe(false);
    gateway.dropAll();
    const readyCount = made.events.ready;
    await sleep(1500);
    expect(made.events.ready).toBe(readyCount);
    expect(link.isReady()).toBe(false);
  });

  it("AUTH 载荷语义正确（网关据此判身份与平台）", async () => {
    gateway = await FakeGateway.listen();
    link = makeLink(gateway).link;
    link.start();
    await waitFor(() => link!.isReady());

    expect(gateway.lastAuth?.id).toBe(NODE);
    expect(gateway.lastAuth?.kind).toBe("node");
    expect(gateway.lastAuth?.proto).toBe(1);
    // token 是对可签字节的 HMAC，必须非空（否则网关会判未授权）
    expect(gateway.lastAuth?.token?.length).toBe(32);
  });
});
