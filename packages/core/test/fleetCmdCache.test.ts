/**
 * 只读结果缓存的失效（写后读一致）
 *
 * 背景（实地灰度 S4b 探测确认）：节点侧为去重「控制台页签恢复时的并发重复查询」，
 * 对只读结果做了 `CMD_CACHE_TTL_MS=1500` 的缓存；但写操作（如 `create_project`）
 * 不清缓存，于是**写入后 1.5s 内再读会拿到写入前的数据**——控制台表现为
 * 「新建项目后立刻刷新列表看不到新项目」。
 *
 * 本测试用**真实 Store + 真实指令分发**（不打桩 `_dispatch`，否则会绕过缓存），
 * 走完整路径：cmd → `_dispatchEnvelope` → 调度 → `dispatchFleetCommand`。
 *
 * 两道防线都要测到：
 *   1. 写完成后清缓存（覆盖「读 → 写 → 读」）；
 *   2. 写代次比对（覆盖「读跨越写操作」——该读结果不得入缓存）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import {
  generateToken,
  type FleetAckPayload,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";
import type { TenantConfig } from "../src/server/types.js";

const FLEET = "ft-cache";
const SECRET = "cache-secret-0123456789abcdef";
const NODE = "n-cache";

interface Internals {
  _dispatchEnvelope: (env: FleetCmdEnvelope) => void;
  _publishAck: (env: FleetCmdEnvelope, ack: FleetAckPayload) => void;
  _execute: (env: FleetCmdEnvelope) => Promise<FleetAckPayload>;
  cmdResultCache: Map<string, { at: number; ack: FleetAckPayload }>;
  writeEpoch: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-cache-"));
  const store = new Store(root);
  store.saveTenant({ id: "p1", apiKey: "k1", model: "m", provider: { apiKey: "a" } } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  // 不建链：直接驱动 _dispatchEnvelope，专心测缓存行为
  const node = new FleetNodeBridge({
    fleetToken: FLEET,
    fleetSecret: SECRET,
    nodeId: NODE,
    deps: { store, manager },
  });
  const internals = node as unknown as Internals;

  const acks: FleetAckPayload[] = [];
  internals._publishAck = (_env, ack) => acks.push(ack);

  let seq = 0;
  /** 发一条已签名指令，返回它的回执（等 ack 队列里出现对应 reqId） */
  const send = async (
    type: FleetCmdType,
    payload: Record<string, unknown> = {},
    opts: { projectId?: string; sessionId?: string } = {},
  ): Promise<FleetAckPayload> => {
    seq += 1;
    const reqId = `r${seq}`;
    const base: Omit<FleetCmdEnvelope, "sig"> = {
      t: Date.now(),
      nonce: generateToken(16),
      reqId,
      type,
      clientId: "c1",
      nodeId: NODE,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      payload,
    };
    // 校验（签名/nonce）现在在 WssLink 里；这里直接进调度，专测本层行为
    internals._dispatchEnvelope({ ...base, sig: "test" });
    const deadline = Date.now() + 3000;
    for (;;) {
      const hit = acks.find((a) => a.reqId === reqId);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`等待回执超时（${type}）`);
      await sleep(10);
    }
  };

  return { node, internals, send, store };
}

describe("只读结果缓存：写操作后必须失效", () => {
  it("写后读一致：create_project 之后立刻 list_projects 能看到新项目", async () => {
    const { node, send } = setup();
    try {
      const before = (await send("list_projects")).data as Array<{ id: string }>;
      expect(before).toHaveLength(1); // 首次启动自带默认项目

      const created = (await send("create_project", { name: "新项目" })).data as { id: string };
      expect(created.id).toBeTruthy();

      // 关键：**不等待**缓存窗口，立刻读——修复前这里会返回旧列表
      const after = (await send("list_projects")).data as Array<{ id: string }>;
      expect(after.map((p) => p.id)).toContain(created.id);
      expect(after).toHaveLength(2);
    } finally {
      node.close();
    }
  });

  it("删除项目后同样立即生效", async () => {
    const { node, send } = setup();
    try {
      const created = (await send("create_project", { name: "待删除" })).data as { id: string };
      // 先读一次把列表灌进缓存
      expect(((await send("list_projects")).data as unknown[]).length).toBe(2);

      await send("delete_project", { projectId: created.id });
      const after = (await send("list_projects")).data as Array<{ id: string }>;
      expect(after.map((p) => p.id)).not.toContain(created.id);
    } finally {
      node.close();
    }
  });

  it("只读结果的复用未被削弱（去重仍在）", async () => {
    const { node, internals, send } = setup();
    try {
      await send("list_projects");
      // 只读结果仍会入缓存 —— 否则就退化成了「每次实算」
      expect(internals.cmdResultCache.size).toBeGreaterThan(0);
      // 第二次读命中缓存：回执 reqId 会被改写为当前请求
      const again = await send("list_projects");
      expect(again.ok).toBe(true);
    } finally {
      node.close();
    }
  });

  it("会话状态事件到达后，get_state 不再返回审批出现前的旧快照", async () => {
    const { node, send, store } = setup();
    try {
      const created = (await send("create_session", {}, { projectId: "p1" })).data as {
        sessionId: string;
      };
      const sid = created.sessionId;

      // 先读一次，把「无审批」的会话状态灌入只读缓存
      const before = (await send("get_state", {}, { projectId: "p1", sessionId: sid })).data as {
        approvals: unknown[];
      };
      expect(before.approvals).toEqual([]);

      // 模拟引擎内部审批挂起：直接落盘（不经过写指令，缓存不会自动失效）
      const rec = store.loadSession("p1", sid)!;
      rec.status = "waiting_approval";
      rec.approvals = [
        {
          id: "a1",
          toolName: "run_shell",
          arguments: {},
          reason: "需要执行命令",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ];
      store.saveSessionSync(rec);

      // 引擎广播 permission_required（生产路径：bridge.onEvent）
      node.onEvent("p1", sid, {
        seq: 1,
        ts: new Date().toISOString(),
        type: "permission_required",
        data: { name: "run_shell" },
      });

      // 关键：不等待 1.5s TTL，控制台收到事件后立刻刷新必须能看到审批
      const after = (await send("get_state", {}, { projectId: "p1", sessionId: sid })).data as {
        status: string;
        approvals: Array<{ id: string }>;
      };
      expect(after.status).toBe("waiting_approval");
      expect(after.approvals.map((a) => a.id)).toContain("a1");
    } finally {
      node.close();
    }
  });

  it("会话通知（session_status / approval_request）同样让会话缓存失效", async () => {
    const { node, internals, send } = setup();
    try {
      const created = (await send("create_session", {}, { projectId: "p1" })).data as {
        sessionId: string;
      };
      await send("get_state", {}, { projectId: "p1", sessionId: created.sessionId });
      expect(internals.cmdResultCache.size).toBeGreaterThan(0);

      node.notify("p1", {
        kind: "approval_request",
        sessionId: created.sessionId,
        ts: new Date().toISOString(),
        data: { approvalId: "a1" },
      });
      expect(internals.cmdResultCache.size).toBe(0);
    } finally {
      node.close();
    }
  });

  it("跨越写操作的只读结果不入缓存（代次防线）", async () => {
    const { node, internals } = setup();
    try {
      const env: FleetCmdEnvelope = {
        t: Date.now(),
        nonce: "n-epoch",
        reqId: "epoch-1",
        type: "list_projects",
        clientId: "c1",
        nodeId: NODE,
        payload: {},
        sig: "",
      };
      // 只读查询「在写操作期间完成」：调用后同步自增代次（模拟写已完成），再取结果。
      // `_execute` 会在 await 处让出，因此代次比对发生在自增之后。
      const pending = internals._execute(env);
      internals.writeEpoch += 1;
      const stale = await pending;
      expect(stale.ok).toBe(true);
      // 该结果跨界于写操作，不得入缓存（否则后续 TTL 内仍返回旧数据）
      expect(internals.cmdResultCache.size).toBe(0);

      // 对照：没有写操作介入时，同样的只读结果会正常入缓存
      const fresh = await internals._execute({ ...env, reqId: "epoch-2" });
      expect(fresh.ok).toBe(true);
      expect(internals.cmdResultCache.size).toBe(1);
    } finally {
      node.close();
    }
  });
});
