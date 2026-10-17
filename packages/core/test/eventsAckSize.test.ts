/**
 * get_events 回执大小（MQTT/WS 单包约束）
 *
 * 现场：节点重启后控制台打开会话 → get_events since=0 返回整段历史（数万事件、>1MB），
 * 经 MQTT 发布时被 EMQX 以 frame_too_large 终止连接（节点侧 write EPIPE 刷屏）。
 * 修复：eventsSince 按字节预算只回传最近的事件尾部。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import type { EventEntry, TenantConfig } from "../src/server/types.js";

function seedEvents(store: Store, tenantId: string, sessionId: string, entries: EventEntry[]): void {
  const dir = store.sessionDir(tenantId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

describe("eventsSince 回执大小", () => {
  it("历史巨大时只回传最近的事件尾部（保留最后一条，且远小于 1MB）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-ack-"));
    const store = new Store(root);
    const t = { id: "t1", apiKey: "k", model: "m" } as TenantConfig;
    const sessionId = "s1";
    const total = 5000;
    const text = "推理增量".repeat(20); // ~240B/条，历史总量约 1.6MB
    const all: EventEntry[] = [];
    for (let i = 1; i <= total; i++) {
      all.push({
        seq: i,
        ts: new Date().toISOString(),
        type: "reasoning_delta",
        data: { text, reqId: "r", taskId: "t" },
      });
    }
    seedEvents(store, t.id, sessionId, all);

    const manager = new SessionManager(store, 60000, {});
    const { events, latestSeq } = manager.eventsSince(t.id, sessionId, 0);
    const bytes = Buffer.byteLength(JSON.stringify({ events }));
    expect(latestSeq).toBe(total);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(total);
    expect(events.at(-1)!.seq).toBe(total);
    // 尾部连续（从某条开始到最新，无空洞）
    expect(events[0]!.seq).toBe(total - events.length + 1);
    // 回执远小于 EMQX 默认单包上限（1MB）
    expect(bytes).toBeLessThan(600 * 1024);
    expect(bytes).toBeGreaterThan(256 * 1024);
  });

  it("since > 0 时只回传增量", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-ack-"));
    const store = new Store(root);
    const t = { id: "t1", apiKey: "k", model: "m" } as TenantConfig;
    const sessionId = "s1";
    const all: EventEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      all.push({ seq: i, ts: new Date().toISOString(), type: "x", data: { i } });
    }
    seedEvents(store, t.id, sessionId, all);

    const manager = new SessionManager(store, 60000, {});
    const { events } = manager.eventsSince(t.id, sessionId, 7);
    expect(events.map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("单条事件超预算时仍保留最后一条（宁可漏历史，不漏最新状态）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-ack-"));
    const store = new Store(root);
    const t = { id: "t1", apiKey: "k", model: "m" } as TenantConfig;
    const sessionId = "s1";
    const big = "x".repeat(1024 * 1024); // 1MB 单条
    seedEvents(store, t.id, sessionId, [
      { seq: 1, ts: new Date().toISOString(), type: "assistant_message", data: { text: big } },
    ]);

    const manager = new SessionManager(store, 60000, {});
    const { events } = manager.eventsSince(t.id, sessionId, 0);
    expect(events.map((e) => e.seq)).toEqual([1]);
  });
});

describe("loadEventsTail（尾部读取，不整文件解析）", () => {
  it("大文件只读尾部且最后一条为最新事件；小文件全量", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-tail-"));
    const store = new Store(root);
    const t = "t1";
    const sessionId = "s1";
    const all: EventEntry[] = [];
    for (let i = 1; i <= 2000; i++) {
      all.push({
        seq: i,
        ts: new Date().toISOString(),
        type: "reasoning_delta",
        data: { text: "推理增量".repeat(20) },
      });
    }
    seedEvents(store, t, sessionId, all);

    const tail = store.loadEventsTail(t, sessionId, 256 * 1024);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(all.length);
    expect(tail.at(-1)!.seq).toBe(2000);
    // 尾部连续
    expect(tail[0]!.seq).toBe(2000 - tail.length + 1);

    // 小文件（窗口足够大）→ 全量
    const full = store.loadEventsTail(t, sessionId, 16 * 1024 * 1024);
    expect(full.length).toBe(all.length);
    expect(full.at(-1)!.seq).toBe(2000);
  });

  it("窗口内无完整行（单条超大）时回退整文件读取", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-tail-"));
    const store = new Store(root);
    const t = "t1";
    const sessionId = "s1";
    seedEvents(store, t, sessionId, [
      {
        seq: 1,
        ts: new Date().toISOString(),
        type: "assistant_message",
        data: { text: "x".repeat(512 * 1024) },
      },
    ]);

    const tail = store.loadEventsTail(t, sessionId, 1024);
    expect(tail.map((e) => e.seq)).toEqual([1]);
  });
});
