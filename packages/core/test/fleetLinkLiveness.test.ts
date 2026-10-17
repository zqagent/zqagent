/**
 * 链路存活判定（回归测试）
 *
 * 背景（实地灰度 S8 抓到的真缺陷）：`connected` 原先是**单一可写标志**，被 MQTT 与
 * WSS 两条链路互相覆盖；broker 一断，MQTT 的 `_noteDown` 把 `connected` 置 false，
 * 于是 WSS 的上行（含指令回执）也被一起掐断——现场表现为节点明明还连着网关，
 * 控制台却判它失联、指令全部超时。
 *
 * 「去 EMQX」后只剩一条链路，那个具体缺陷已不可能复现，但**判定的正确性**仍需锁定：
 * `isConnected()` 必须如实反映 WSS 的就绪状态，且链路断开时立刻为假（否则控制台
 * 会乐观地继续下发指令，全部超时）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import { FrameType, decodeFrame, encodeAuthOk, encodeFrame } from "@zqagent/shared/wire";
import type { TenantConfig } from "../src/server/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 极简假网关：只接受握手并回 AUTH_OK */
class FakeGateway {
  private constructor(
    private readonly wss: WebSocketServer,
    private readonly port: number,
  ) {}

  static async listen(): Promise<FakeGateway> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const gw = new FakeGateway(wss, (wss.address() as AddressInfo).port);
    wss.on("connection", (ws) => {
      ws.on("message", (d: Buffer) => {
        if (decodeFrame(new Uint8Array(d)).type === FrameType.AUTH) {
          // 本测试不关心握手内容，只要链路进入就绪态
          ws.send(
            encodeFrame({
              type: FrameType.AUTH_OK,
              seq: 0,
              payload: encodeAuthOk({ ok: true, serverTs: Date.now() }),
            }),
          );
        }
      });
    });
    return gw;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  close(): void {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

function makeNode(gatewayUrl: string): FleetNodeBridge {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-liveness-"));
  const store = new Store(root);
  store.saveTenant({ id: "p1", apiKey: "k1", model: "m", provider: { apiKey: "a" } } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  return new FleetNodeBridge({
    gatewayUrl,
    fleetToken: "ft-live",
    fleetSecret: "live-secret",
    nodeId: "n-live",
    deps: { store, manager },
  });
}

let gateway: FakeGateway | undefined;
let node: FleetNodeBridge | undefined;

afterEach(() => {
  node?.close();
  node = undefined;
  gateway?.close();
  gateway = undefined;
});

describe("链路存活判定", () => {
  it("握手成功后可被管控", async () => {
    gateway = await FakeGateway.listen();
    node = makeNode(gateway.url);
    expect(node.isConnected()).toBe(false); // 建链前
    node.connect();

    const deadline = Date.now() + 5000;
    while (!node.isConnected() && Date.now() < deadline) await sleep(20);
    expect(node.isConnected()).toBe(true);
  });

  it("网关断开后立即判定为不可管控（不乐观地继续下发）", async () => {
    gateway = await FakeGateway.listen();
    node = makeNode(gateway.url);
    node.connect();
    const deadline = Date.now() + 5000;
    while (!node.isConnected() && Date.now() < deadline) await sleep(20);
    expect(node.isConnected()).toBe(true);

    gateway.close();
    gateway = undefined;
    const downDeadline = Date.now() + 5000;
    while (node.isConnected() && Date.now() < downDeadline) await sleep(20);
    expect(node.isConnected()).toBe(false);
  });

  it("未配置网关地址时不建链，只告警（本地功能不受影响）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-nogw-"));
    const store = new Store(root);
    const bridge = new FleetNodeBridge({
      fleetToken: "ft-x",
      fleetSecret: "s",
      nodeId: "n-x",
      deps: { store, manager: new SessionManager(store, 60_000) },
    });
    bridge.connect();
    expect(bridge.isConnected()).toBe(false);
    bridge.close();
  });
});
