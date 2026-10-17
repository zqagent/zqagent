/**
 * QqManager 单测
 *
 * mock OfficialBotClient 避免真实 WebSocket 连接，重点验证：
 * 配置来源优先级（env > 文件）、热更新持久化、脱敏、清空。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../src/server/qq/OfficialBotClient.js", () => ({
  OfficialBotClient: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    send = vi.fn().mockResolvedValue(undefined);
    onMessage = vi.fn();
    onStatus = vi.fn();
  },
}));

import { QqManager } from "../src/server/qq/QqManager.js";
import { QqBindingsStore } from "../src/server/qq/bindings.js";
import { PairingCodeStore } from "../src/server/qq/pairingCodes.js";
import { Store } from "../src/server/store.js";
import type { SessionManager } from "../src/server/session.js";

let dir: string;
let store: Store;
let manager: SessionManager;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-mgr-"));
  store = new Store(dir);
  store.saveTenant({ id: "demo", apiKey: "demo-key", model: "m", provider: {} });
  manager = {} as unknown as SessionManager;
  // 清空 QQ 相关环境变量，隔离测试
  for (const k of ["QQ_BOT_APP_ID", "QQ_BOT_APP_SECRET", "QQ_BOT_SANDBOX"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeManager(): QqManager {
  return new QqManager({
    store,
    manager,
    bindings: QqBindingsStore.in(dir),
    pairingCodes: new PairingCodeStore(),
    dataDir: dir,
  });
}

describe("QqManager", () => {
  it("无配置时 start 不连接", () => {
    const m = makeManager();
    m.start();
    expect(m.isRunning()).toBe(false);
    expect(m.getConfig()).toBeNull();
  });

  it("updateConfig 热更新后运行，且配置脱敏", () => {
    const m = makeManager();
    m.updateConfig({ appId: "app-1", appSecret: "secret-1", sandbox: true });
    expect(m.isRunning()).toBe(true);
    expect(m.getConfig()).toEqual({ appId: "app-1", sandbox: true });
    // 不泄露 secret
    expect(JSON.stringify(m.getConfig())).not.toContain("secret-1");
  });

  it("热配置持久化到 config.json，重启后可复用（env 未设置时）", () => {
    const m1 = makeManager();
    m1.updateConfig({ appId: "app-2", appSecret: "secret-2", sandbox: false });

    const m2 = makeManager();
    m2.start();
    expect(m2.isRunning()).toBe(true);
    expect(m2.getConfig()).toEqual({ appId: "app-2", sandbox: false });
  });

  it("clearConfig 后停止并删除配置", () => {
    const m = makeManager();
    m.updateConfig({ appId: "app-3", appSecret: "secret-3", sandbox: false });
    m.clearConfig();
    expect(m.isRunning()).toBe(false);
    expect(m.getConfig()).toBeNull();
    expect(fs.existsSync(path.join(dir, "qq", "config.json"))).toBe(false);
  });

  it("issuePairingCode 委托配对码", () => {
    const m = makeManager();
    const { code, expiresIn } = m.issuePairingCode("demo");
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(expiresIn).toBe(300);
  });
});
