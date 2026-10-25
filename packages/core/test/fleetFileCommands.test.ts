/**
 * 舰队指令：文件改名 / 移动 / 压缩下载
 *
 * 走完整的节点侧分派路径（cmd → _dispatchEnvelope → 调度 → dispatchFleetCommand），
 * 确保 `rename_path` / `move_paths` / `zip_download` 被真正识别并执行——而不是落到
 * default 分支回「未知指令」。远端节点（网关传输）控制台的右键菜单 / 拖拽移动依赖
 * 这几个指令。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { FleetNodeBridge } from "../src/server/fleet/FleetNodeBridge.js";
import { FrameType, decodeAck, decodeFrame, utf8Decode } from "@zqagent/shared/wire";
import {
  generateToken,
  type FleetAckPayload,
  type FleetCmdEnvelope,
  type FleetCmdType,
} from "@zqagent/shared/fleet";
import type { TenantConfig } from "../src/server/types.js";

const NODE = "n-files";

interface Internals {
  _dispatchEnvelope: (env: FleetCmdEnvelope) => void;
  wssLink: unknown;
}

let root: string;
let ws: string;
let acks: FleetAckPayload[];
let internals: Internals;
let seq: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-fleetfiles-"));
  ws = path.join(root, "ws");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");

  const store = new Store(root);
  store.saveTenant({
    id: "p1",
    apiKey: "k1",
    model: "m",
    provider: { apiKey: "a" },
    workspaceRoot: ws,
  } as TenantConfig);
  const manager = new SessionManager(store, 60_000);
  const node = new FleetNodeBridge({
    fleetToken: "ft-files",
    fleetSecret: "files-secret-0123456789abcdef",
    nodeId: NODE,
    deps: { store, manager },
  });
  internals = node as unknown as Internals;
  acks = [];
  /**
   * 拦截**真正的发送出口**（而不是替换 `_publishAck`）。
   *
   * 只有这样「回执大小保护」才会真的被执行到 —— 直接换掉 `_publishAck`
   * 等于把待测的那段逻辑一起短路了。
   */
  internals.wssLink = {
    isReady: () => true,
    send: (frame: Uint8Array) => {
      const f = decodeFrame(frame);
      if (f.type !== FrameType.ACK) return;
      const w = decodeAck(f.payload);
      acks.push({
        reqId: w.reqId,
        type: w.type,
        ok: w.ok,
        error: w.error,
        data: w.data && w.data.length > 0 ? JSON.parse(utf8Decode(w.data)) : undefined,
      } as FleetAckPayload);
    },
  };
  seq = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 发一条指令并等它的回执 */
async function send(
  type: FleetCmdType,
  payload: Record<string, unknown> = {},
): Promise<FleetAckPayload> {
  seq += 1;
  const reqId = `r${seq}`;
  const base: Omit<FleetCmdEnvelope, "sig"> = {
    t: Date.now(),
    nonce: generateToken(16),
    reqId,
    type,
    clientId: "c1",
    nodeId: NODE,
    projectId: "p1",
    payload,
  };
  internals._dispatchEnvelope({ ...base, sig: "test" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const hit = acks.find((a) => a.reqId === reqId);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`等待回执超时: ${type}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("舰队指令：文件改名 / 压缩下载", () => {
  it("rename_path 改名并回执新路径", async () => {
    const ack = await send("rename_path", { path: "src/a.ts", name: "b.ts" });
    expect(ack.ok).toBe(true);
    expect(ack.data).toEqual({ from: "src/a.ts", path: "src/b.ts" });
    expect(fs.existsSync(path.join(ws, "src/b.ts"))).toBe(true);
  });

  it("rename_path 重名时回执失败而不是未知指令", async () => {
    fs.writeFileSync(path.join(ws, "src", "b.ts"), "x");
    const ack = await send("rename_path", { path: "src/a.ts", name: "b.ts" });
    expect(ack.ok).toBe(false);
    expect(ack.error ?? "").toMatch(/已存在/);
  });

  it("move_paths 移动到目标目录并回执新旧路径", async () => {
    fs.mkdirSync(path.join(ws, "dest"));
    const ack = await send("move_paths", { paths: ["src/a.ts"], dest: "dest" });
    expect(ack.ok).toBe(true);
    expect(ack.data).toEqual({ moved: [{ from: "src/a.ts", path: "dest/a.ts" }], failed: [] });
    expect(fs.existsSync(path.join(ws, "dest/a.ts"))).toBe(true);
  });

  it("move_paths 冲突时逐条回执失败而不是未知指令", async () => {
    fs.mkdirSync(path.join(ws, "dest"));
    fs.writeFileSync(path.join(ws, "dest", "a.ts"), "keep");
    const ack = await send("move_paths", { paths: ["src/a.ts"], dest: "dest" });
    expect(ack.ok).toBe(true);
    const data = ack.data as { moved: unknown[]; failed: Array<{ error: string }> };
    expect(data.moved).toEqual([]);
    expect(data.failed[0]?.error).toMatch(/已存在/);
  });

  it("move_paths 空选择回执失败", async () => {
    const ack = await send("move_paths", { paths: [], dest: "" });
    expect(ack.ok).toBe(false);
  });

  it("zip_download 打包目录并回执 base64", async () => {
    const ack = await send("zip_download", { paths: ["src"] });
    expect(ack.ok).toBe(true);
    const data = ack.data as { name: string; base64: string };
    expect(data.name).toBe("src.zip");
    expect(Buffer.from(data.base64, "base64").readUInt32LE(0)).toBe(0x04034b50);
  });

  it("zip_download 尊重调用方传入的更小上限（网关单帧限制）", async () => {
    fs.writeFileSync(path.join(ws, "src", "big.txt"), "x".repeat(4096));
    const ack = await send("zip_download", { paths: ["src"], maxBytes: 1024 });
    expect(ack.ok).toBe(false);
    expect(ack.error ?? "").toMatch(/不支持压缩下载/);
  });

  it("zip_download 空选择回执失败", async () => {
    const ack = await send("zip_download", { paths: [] });
    expect(ack.ok).toBe(false);
  });

  it("回执超单帧时降级为明确的错误回执，而不是没有回执", async () => {
    // 6MB 真随机：deflate 压不动，zip ≈ 6MB → base64 ≈ 8MB → 必然超过 4MB 帧上限。
    // 放开 maxBytes 模拟「上限算错」的情况，验证兜底仍然给出可读的回执。
    fs.writeFileSync(path.join(ws, "big.bin"), randomBytes(6 * 1024 * 1024));
    const ack = await send("zip_download", { paths: ["big.bin"], maxBytes: 100 * 1024 * 1024 });
    expect(ack.ok).toBe(false);
    expect(ack.error ?? "").toMatch(/结果过大/);
    expect(ack.error ?? "").toMatch(/单帧传输上限/);
    // 不得把巨大的 base64 留在回执里（否则降级等于没做）
    expect(ack.data).toBeUndefined();
  });
});
