/**
 * QQ 绑定映射与配对码单测
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  QqBindingsStore,
  conversationKey,
  targetFromKey,
} from "../src/server/qq/bindings.js";
import { PairingCodeStore } from "../src/server/qq/pairingCodes.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qq-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("conversationKey / targetFromKey", () => {
  it("各类目标往返一致", () => {
    const targets = [
      { kind: "c2c", openid: "u1" },
      { kind: "group", groupOpenid: "g1" },
      { kind: "channel", channelId: "c1" },
      { kind: "guild_direct", guildId: "d1" },
    ] as const;
    for (const t of targets) {
      expect(targetFromKey(conversationKey(t))).toEqual(t);
    }
  });

  it("非法键返回 null", () => {
    expect(targetFromKey("xyz")).toBeNull();
    expect(targetFromKey("bad:")).toBeNull();
  });
});

describe("QqBindingsStore", () => {
  it("读写与持久化", () => {
    const store = new QqBindingsStore(path.join(tmp, "bindings.json"));
    store.set("u:1", { tenantId: "demo", sessionId: null });
    store.set("u:1", { tenantId: "demo", sessionId: "sess-1" });

    // 重新实例化从磁盘读
    const store2 = new QqBindingsStore(path.join(tmp, "bindings.json"));
    expect(store2.get("u:1")).toEqual({
      tenantId: "demo",
      sessionId: "sess-1",
      updatedAt: expect.any(String),
    });
  });

  it("findByTenantSession 反查", () => {
    const store = new QqBindingsStore(path.join(tmp, "bindings.json"));
    store.set("u:1", { tenantId: "demo", sessionId: "sess-1" });
    store.set("g:2", { tenantId: "demo", sessionId: "sess-2" });
    expect(store.findByTenantSession("demo", "sess-2")).toBe("g:2");
    expect(store.findByTenantSession("demo", "nope")).toBeNull();
  });

  it("delete 移除", () => {
    const store = new QqBindingsStore(path.join(tmp, "bindings.json"));
    store.set("u:1", { tenantId: "demo", sessionId: null });
    store.delete("u:1");
    expect(store.get("u:1")).toBeNull();
  });
});

describe("PairingCodeStore", () => {
  it("生成后可单次消费", () => {
    const store = new PairingCodeStore(60_000);
    const { code } = store.issue("demo");
    expect(store.consume(code)).toBe("demo");
    expect(store.consume(code)).toBeNull(); // 已消费
  });

  it("过期后失效", () => {
    const store = new PairingCodeStore(1); // 1ms 过期
    const { code } = store.issue("demo");
    // 强制过期
    const entry = (store as unknown as { codes: Map<string, { expiresAt: number }> })
      .codes.get(code)!;
    entry.expiresAt = 0;
    expect(store.consume(code)).toBeNull();
  });

  it("非法码返回 null", () => {
    const store = new PairingCodeStore();
    expect(store.consume("NOPE")).toBeNull();
  });
});
