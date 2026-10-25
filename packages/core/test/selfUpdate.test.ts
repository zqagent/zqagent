/**
 * 节点自更新：远端指令 `self_update` + 版本比对结论
 *
 * 现场：远端无法让节点自动更新并重启，只能借 `run_command` 执行
 * `zqagent update --now && systemctl restart`——而 `--now` 成功时以 70 退出，
 * 命令链会断掉，且回执随重启丢失。
 *
 * 修复：新增 `self_update` 指令（status / check / install），install 先回执、
 * 后台安装并退出，由服务管理器拉起新版本；重启后 `fleet.json` 里的凭据让节点
 * 自动重连 Hub。
 *
 * 这里锁住三件事：
 *   1. 版本比对口径（已最新 / 需手动升级 / 可更新）；
 *   2. 指令分发（action 分派、force 透传、未知 action 与不可用时的报错）；
 *   3. 指令已在共享清单注册（未注册会被 parseFleetEnvelope 直接拒绝）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import { createApp } from "../src/server/routes.js";
import type { TenantConfig } from "../src/server/types.js";
import {
  evaluateManifest,
  type UpdateInspect,
  type UpdateInstallStart,
  type UpdaterStatus,
} from "../src/update/controller.js";
import type { SelfUpdater } from "../src/server/fleet/FleetCommands.js";
import {
  FLEET_CMD_TYPES,
  generateToken,
  parseFleetEnvelope,
  type FleetAckPayload,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";

const BASE = {
  currentVersion: "0.2.15",
  channel: "stable",
  manifestUrl: "https://example.com/stable.json",
};

describe("evaluateManifest（版本比对口径）", () => {
  it("清单版本更高 → 可更新", () => {
    const r = evaluateManifest(BASE, { version: "0.2.16", notes: "修复若干问题" });
    expect(r.updateAvailable).toBe(true);
    expect(r.latestVersion).toBe("0.2.16");
    expect(r.notes).toBe("修复若干问题");
    expect(r.reason).toBeUndefined();
  });

  it("同版本 / 更低版本 → 已是最新", () => {
    for (const v of ["0.2.15", "0.2.14"]) {
      const r = evaluateManifest(BASE, { version: v });
      expect(r.updateAvailable).toBe(false);
      expect(r.latestVersion).toBe(v);
      expect(r.reason).toContain("已是最新版本");
    }
  });

  it("当前版本低于 minimumVersion → 需手动升级，不自动安装", () => {
    const r = evaluateManifest(BASE, { version: "0.3.0", minimumVersion: "0.2.20" });
    expect(r.updateAvailable).toBe(false);
    expect(r.manualUpgradeRequired).toBe("0.2.20");
    expect(r.reason).toContain("需手动升级");
  });

  it("满足 minimumVersion 时照常可更新", () => {
    const r = evaluateManifest(BASE, { version: "0.3.0", minimumVersion: "0.2.10" });
    expect(r.updateAvailable).toBe(true);
    expect(r.manualUpgradeRequired).toBeUndefined();
  });
});

/** 记录调用的假控制器 */
function fakeUpdater(overrides: Partial<SelfUpdater> = {}) {
  const calls: {
    installs: boolean[];
  } = { installs: [] };
  const status: UpdaterStatus = {
    enabled: true,
    currentVersion: "0.2.15",
    channel: "stable",
    manifestUrl: BASE.manifestUrl,
    serviceManager: "systemd",
    backupVersion: "0.2.14",
  };
  const inspect: UpdateInspect = { ...BASE, updateAvailable: true, latestVersion: "0.2.16" };
  const updater: SelfUpdater = {
    status: () => status,
    inspect: async () => inspect,
    requestInstall: async (force = false): Promise<UpdateInstallStart> => {
      calls.installs.push(force);
      return {
        accepted: true,
        fromVersion: "0.2.15",
        toVersion: "0.2.16",
        message: force ? "开始安装 v0.2.16（立即重启）" : "开始安装 v0.2.16（等待节点空闲后重启）",
      };
    },
    ...overrides,
  };
  return { updater, calls };
}

interface Internals {
  _dispatchEnvelope: (env: FleetCmdEnvelope) => void;
  _publishAck: (env: FleetCmdEnvelope, ack: FleetAckPayload) => void;
}

function makeNode(getUpdater?: () => SelfUpdater | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-selfupdate-"));
  const store = new Store(root);
  const manager = new SessionManager(store, 60_000);
  const node = new FleetNodeBridge({
    fleetToken: "ft-upd",
    fleetSecret: "upd-secret-0123456789abcdef",
    nodeId: "n-upd",
    deps: { store, manager, ...(getUpdater ? { getUpdater } : {}) },
  });
  const internals = node as unknown as Internals;
  const acks: FleetAckPayload[] = [];
  internals._publishAck = (_env, ack) => acks.push(ack);
  let seq = 0;

  async function send(
    type: FleetCmdType,
    payload: Record<string, unknown> = {},
  ): Promise<FleetAckPayload> {
    seq += 1;
    const reqId = `r${seq}`;
    internals._dispatchEnvelope({
      t: Date.now(),
      nonce: generateToken(16),
      reqId,
      type,
      clientId: "c1",
      nodeId: "n-upd",
      payload,
      sig: "test",
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const hit = acks.find((a) => a.reqId === reqId);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error("等待回执超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return { send, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("self_update 指令分发", () => {
  it("action=status 返回更新器状态", async () => {
    const { updater } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "status" });
      expect(ack.ok).toBe(true);
      expect(ack.data).toMatchObject({
        currentVersion: "0.2.15",
        enabled: true,
        serviceManager: "systemd",
        backupVersion: "0.2.14",
      });
    } finally {
      cleanup();
    }
  });

  it("action 缺省等价于 status", async () => {
    const { updater } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update");
      expect(ack.ok).toBe(true);
      expect((ack.data as { currentVersion: string }).currentVersion).toBe("0.2.15");
    } finally {
      cleanup();
    }
  });

  it("action=check 返回可更新的版本与说明", async () => {
    const { updater } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "check" });
      expect(ack.ok).toBe(true);
      expect(ack.data).toMatchObject({
        updateAvailable: true,
        latestVersion: "0.2.16",
        currentVersion: "0.2.15",
      });
    } finally {
      cleanup();
    }
  });

  it("action=install 默认等空闲（force=false）", async () => {
    const { updater, calls } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "install" });
      expect(ack.ok).toBe(true);
      expect(ack.data).toMatchObject({ accepted: true, toVersion: "0.2.16" });
      expect(calls.installs).toEqual([false]);
    } finally {
      cleanup();
    }
  });

  it("action=install 带 force 时透传强制重启", async () => {
    const { updater, calls } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "install", force: true });
      expect(ack.ok).toBe(true);
      expect(calls.installs).toEqual([true]);
    } finally {
      cleanup();
    }
  });

  it("无需更新时 accepted=false 且带上原因", async () => {
    const { updater } = fakeUpdater({
      inspect: async () => ({
        ...BASE,
        updateAvailable: false,
        latestVersion: "0.2.15",
        reason: "已是最新版本（v0.2.15）",
      }),
      requestInstall: async (): Promise<UpdateInstallStart> => ({
        accepted: false,
        fromVersion: "0.2.15",
        toVersion: "0.2.15",
        message: "已是最新版本（v0.2.15）",
      }),
    });
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "install" });
      expect(ack.ok).toBe(true);
      expect(ack.data).toMatchObject({ accepted: false, message: "已是最新版本（v0.2.15）" });
    } finally {
      cleanup();
    }
  });

  it("未知 action 返回失败回执", async () => {
    const { updater } = fakeUpdater();
    const { send, cleanup } = makeNode(() => updater);
    try {
      const ack = await send("self_update", { action: "explode" });
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("未知的 action");
    } finally {
      cleanup();
    }
  });

  it("节点不支持自更新（无控制器）时明确报错", async () => {
    const { send, cleanup } = makeNode();
    try {
      const ack = await send("self_update", { action: "status" });
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("自更新不可用");
    } finally {
      cleanup();
    }
  });

  it("指令已在共享清单注册（否则 parseFleetEnvelope 会拒绝）", () => {
    expect(FLEET_CMD_TYPES).toContain("self_update");
    const env = parseFleetEnvelope({
      t: Date.now(),
      nonce: generateToken(16),
      reqId: "r1",
      type: "self_update",
      clientId: "c1",
      nodeId: "n-upd",
      payload: { action: "check" },
      sig: "sig",
    });
    expect(env?.type).toBe("self_update");
  });
});

describe("HTTP 路由 /api/v1/node/self-update", () => {
  it("status / check / install 与非法 action", async () => {
    const { updater, calls } = fakeUpdater();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-selfupdate-http-"));
    const store = new Store(root);
    store.saveTenant({ id: "p1", apiKey: "key1", model: "m" } as TenantConfig);
    const manager = new SessionManager(store, 60_000);
    const server = createApp(store, manager, { updater });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const post = (body: unknown) =>
      fetch(`${base}/api/v1/node/self-update`, {
        method: "POST",
        headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    try {
      const st = await post({ action: "status" });
      expect(st.status).toBe(200);
      expect((await st.json()).data.currentVersion).toBe("0.2.15");

      const ck = await post({ action: "check" });
      expect(ck.status).toBe(200);
      expect((await ck.json()).data.updateAvailable).toBe(true);

      const ins = await post({ action: "install", force: true });
      expect(ins.status).toBe(200);
      expect((await ins.json()).data).toMatchObject({ accepted: true, toVersion: "0.2.16" });
      expect(calls.installs).toEqual([true]);

      const bad = await post({ action: "explode" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.message).toContain("未知的 action");
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("未装配更新控制器时返回 400 且说明原因", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-selfupdate-http2-"));
    const store = new Store(root);
    store.saveTenant({ id: "p1", apiKey: "key1", model: "m" } as TenantConfig);
    const manager = new SessionManager(store, 60_000);
    const server = createApp(store, manager);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/node/self-update`, {
        method: "POST",
        headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("自更新不可用");
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("UpdateController 安全边界（不联网、不退出进程）", () => {
  it("非 SEA 形态：status 明确标记不可用，requestInstall 直接拒绝", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-upd-safe-"));
    const { UpdateController } = await import("../src/update/controller.js");
    const ctrl = new UpdateController({ dataDir: dir, isIdle: () => true, log: () => {} });
    try {
      const st = ctrl.status();
      expect(st.enabled).toBe(false);
      expect(st.reason).toContain("SEA");

      // 关键安全属性：不支持自更新时绝不能走到「替换文件并退出」
      const r = await ctrl.requestInstall(true);
      expect(r.accepted).toBe(false);
      expect(r.message).toContain("自更新不可用");
      expect(r.fromVersion).toBe(st.currentVersion);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ZQAGENT_AUTO_UPDATE=0 时调度不启动，但控制器仍可读取状态", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-upd-off-"));
    const prev = process.env.ZQAGENT_AUTO_UPDATE;
    process.env.ZQAGENT_AUTO_UPDATE = "0";
    const { UpdateController } = await import("../src/update/controller.js");
    const ctrl = new UpdateController({ dataDir: dir, isIdle: () => true, log: () => {} });
    try {
      ctrl.start();
      expect(ctrl.status().enabled).toBe(false);
    } finally {
      ctrl.stop();
      if (prev === undefined) delete process.env.ZQAGENT_AUTO_UPDATE;
      else process.env.ZQAGENT_AUTO_UPDATE = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
