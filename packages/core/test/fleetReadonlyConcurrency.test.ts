/**
 * 节点侧指令调度：只读查询并发、写操作串行。
 *
 * 背景（现场实测）：所有指令原先挂在同一条串行链上，一个慢的只读查询
 * （如大历史 `get_events`，单次回执可达 512KB）会把它之后的**全部**指令一起堵住
 * —— 实测卡住期间 80 个 ping 中有 65 个无响应，控制台表现为整台节点失联。
 *
 * 现在：只读查询（含「全为只读子指令」的 batch）走有限并发池，
 * 写操作仍严格串行；两条通道互不阻塞。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import {
  generateToken,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";
import type { TenantConfig } from "../src/server/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FLEET = "ft-conc";
const SECRET = "0123456789abcdef0123456789abcdef";
const NODE = "n1";
/** 慢指令的人为耗时（毫秒） */
const SLOW_MS = 400;

interface Entry {
  ev: "start" | "end";
  type: string;
  at: number;
}

interface Internals {
  _dispatch: (env: FleetCmdEnvelope) => Promise<void>;
  _dispatchEnvelope: (env: FleetCmdEnvelope) => void;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ro-conc-"));
  const store = new Store(root);
  store.saveTenant({
    id: "p1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
  } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  // 不建链：直接驱动 _dispatchEnvelope，只测调度行为
  const node = new FleetNodeBridge({
    fleetToken: FLEET,
    fleetSecret: SECRET,
    nodeId: NODE,
    deps: { store, manager },
  });

  const internals = node as unknown as Internals;
  const log: Entry[] = [];
  /** 需要人为变慢的指令类型（含 "batch" 可让整批变慢） */
  const slowTypes = new Set<string>();
  internals._dispatch = async (env: FleetCmdEnvelope) => {
    log.push({ ev: "start", type: `${env.type}${env.reqId}`, at: Date.now() });
    if (slowTypes.has(env.type)) await sleep(SLOW_MS);
    log.push({ ev: "end", type: `${env.type}${env.reqId}`, at: Date.now() });
  };

  let seq = 0;
  /** 投递一条指令（直接进调度层，链路校验由 WssLink 负责） */
  const deliver = (type: FleetCmdType, payload: Record<string, unknown> = {}): string => {
    seq += 1;
    const reqId = `r${seq}`;
    const base: Omit<FleetCmdEnvelope, "sig"> = {
      t: Date.now(),
      nonce: generateToken(16),
      reqId,
      type,
      clientId: "c1",
      nodeId: NODE,
      payload,
    };
    // 校验（签名/nonce）现在在 WssLink 里；这里直接进调度，专测本层行为
    internals._dispatchEnvelope({ ...base, sig: "test" });
    return reqId;
  };

  const at = (ev: Entry["ev"], suffix: string): number => {
    const hit = log.find((e) => e.ev === ev && e.type.endsWith(suffix));
    if (!hit) throw new Error(`未找到 ${ev} ${suffix}（log=${JSON.stringify(log)}）`);
    return hit.at;
  };
  /** 第 n 个匹配项的结束时间 */
  const nthEnd = (type: string, n: number): number => {
    const hits = log.filter((e) => e.ev === "end" && e.type.startsWith(type + "r"));
    if (hits.length <= n) throw new Error(`第 ${n + 1} 个 ${type} 尚未结束`);
    return hits[n]!.at;
  };
  const nthStart = (type: string, n: number): number => {
    const hits = log.filter((e) => e.ev === "start" && e.type.startsWith(type + "r"));
    if (hits.length <= n) throw new Error(`第 ${n + 1} 个 ${type} 尚未开始`);
    return hits[n]!.at;
  };

  return { node, deliver, log, slowTypes, at, nthStart, nthEnd };
}

describe("节点侧指令调度：只读并发 / 写串行", () => {
  it("慢的只读查询不再阻塞 ping（原先会被串行链堵住）", async () => {
    const { deliver, slowTypes, nthEnd } = setup();
    slowTypes.add("get_events");

    deliver("get_events"); // 慢查询先发
    await sleep(60);
    deliver("ping"); // 轻量指令随后

    await sleep(SLOW_MS + 300);
    // ping 在慢查询结束前就已返回 → 两者并发
    expect(nthEnd("ping", 0)).toBeLessThan(nthEnd("get_events", 0));
  });

  it("写操作严格串行（后一条等前一条完成）", async () => {
    const { deliver, slowTypes, nthStart, nthEnd } = setup();
    slowTypes.add("submit_turn");

    deliver("submit_turn");
    deliver("submit_turn");

    await sleep(SLOW_MS * 2 + 400);
    // 第二条写操作的开始时间不早于第一条的结束时间
    expect(nthStart("submit_turn", 1)).toBeGreaterThanOrEqual(nthEnd("submit_turn", 0));
  });

  it("写操作不阻塞只读查询（两条通道相互独立）", async () => {
    const { deliver, slowTypes, nthStart, nthEnd } = setup();
    slowTypes.add("submit_turn");

    deliver("submit_turn"); // 慢写操作占住串行链
    await sleep(60);
    deliver("list_projects"); // 只读查询

    await sleep(SLOW_MS + 300);
    expect(nthEnd("list_projects", 0)).toBeLessThan(nthEnd("submit_turn", 0));
    expect(nthStart("list_projects", 0)).toBeGreaterThan(nthStart("submit_turn", 0));
  });

  it("全为只读子指令的 batch 走并发池（不被慢写阻塞）", async () => {
    const { deliver, slowTypes, nthEnd } = setup();
    slowTypes.add("submit_turn");

    deliver("submit_turn");
    await sleep(60);
    deliver("batch", { commands: [{ type: "list_projects" }, { type: "get_state" }] });

    await sleep(SLOW_MS + 300);
    expect(nthEnd("batch", 0)).toBeLessThan(nthEnd("submit_turn", 0));
  });

  it("含写子指令的 batch 仍走串行链（保序）", async () => {
    const { deliver, slowTypes, nthStart, nthEnd } = setup();
    slowTypes.add("batch");

    // 子指令含 submit_turn → 不满足「全只读」→ 走串行链
    deliver("batch", { commands: [{ type: "submit_turn" }] });
    deliver("batch", { commands: [{ type: "submit_turn" }] });

    await sleep(SLOW_MS * 2 + 400);
    expect(nthStart("batch", 1)).toBeGreaterThanOrEqual(nthEnd("batch", 0));
  });
});
