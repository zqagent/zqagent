/**
 * 会话历史分页与轮次汇总
 *
 * 现场：会话详情的聊天页只显示最后一次助手返回，滚到顶部也无法加载更早内容。
 * 原因：事件接口只有 `since`（向后增量），节点回执又按 512KB 字节预算截尾。
 * 修复：`before` 向前翻页（按字节）+ `get_session_turns` 轻量轮次列表。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import type { EventEntry, TenantConfig } from "../src/server/types.js";

function seedEvents(
  store: Store,
  tenantId: string,
  sessionId: string,
  entries: EventEntry[],
): void {
  const dir = store.sessionDir(tenantId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

function tmpStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-events-page-")));
}

const TENANT = { id: "t1", apiKey: "k", model: "m" } as TenantConfig;
const TS = new Date("2026-01-01T00:00:00.000Z").toISOString();

/** 造 n 条 reasoning_delta（每条约 240B），用于制造大历史 */
function deltas(from: number, to: number): EventEntry[] {
  const out: EventEntry[] = [];
  const text = "推理增量".repeat(20);
  for (let i = from; i <= to; i++) {
    out.push({ seq: i, ts: TS, type: "reasoning_delta", data: { text } });
  }
  return out;
}

describe("store.loadEventPage（按字节向前翻页）", () => {
  it("不传 before：取最新一页，且少于全量", () => {
    const store = tmpStore();
    const all = deltas(1, 4000); // ≈ 960KB
    seedEvents(store, TENANT.id, "s1", all);

    const page = store.loadEventPage(TENANT.id, "s1", { maxBytes: 64 * 1024 });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThan(all.length);
    // 尾部连续且最后一条是最新
    expect(page.events.at(-1)!.seq).toBe(4000);
    expect(page.events[0]!.seq).toBe(4000 - page.events.length + 1);
    expect(page.hasMore).toBe(true);
  });

  it("before：只取更早的事件，且逐页衔接无空洞", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", deltas(1, 4000));

    const first = store.loadEventPage(TENANT.id, "s1", { maxBytes: 64 * 1024 });
    const second = store.loadEventPage(TENANT.id, "s1", {
      before: first.events[0]!.seq,
      maxBytes: 64 * 1024,
    });

    expect(second.events.length).toBeGreaterThan(0);
    // 第二页严格早于第一页，且紧邻（seq 连续）
    expect(second.events.at(-1)!.seq).toBe(first.events[0]!.seq - 1);
    expect(second.hasMore).toBe(true);
  });

  it("翻到文件开头时 hasMore 为 false，且能取到 seq=1", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", deltas(1, 50));

    const page = store.loadEventPage(TENANT.id, "s1", { maxBytes: 1024 * 1024 });
    expect(page.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(page.hasMore).toBe(false);
  });

  it("单条超出预算时也至少返回一条，保证翻页能推进", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", [
      { seq: 1, ts: TS, type: "assistant_message", data: { text: "x".repeat(4096) } },
    ]);
    const page = store.loadEventPage(TENANT.id, "s1", { maxBytes: 64 });
    expect(page.events.map((e) => e.seq)).toEqual([1]);
  });

  it("空会话返回空页", () => {
    const store = tmpStore();
    fs.mkdirSync(store.sessionDir(TENANT.id, "s1"), { recursive: true });
    expect(store.loadEventPage(TENANT.id, "s1", { maxBytes: 1024 })).toEqual({
      events: [],
      hasMore: false,
    });
  });
});

describe("eventsPage（since / before 组合）", () => {
  it("同时给 since + before：取 [since, before) 区间", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", deltas(1, 20));
    const manager = new SessionManager(store, 60000, {});

    const r = manager.eventsPage(TENANT.id, "s1", { since: 4, before: 9 });
    expect(r.events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
  });

  it("只给 before：向前翻页，earliestSeq 指向本页最早一条", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", deltas(1, 200));
    const manager = new SessionManager(store, 60000, {});

    // 预算够大 → 一次取完更早的全部，没有「还有更早的」
    const all = manager.eventsPage(TENANT.id, "s1", { before: 150 });
    expect(all.events.at(-1)!.seq).toBe(149);
    expect(all.earliestSeq).toBe(all.events[0]!.seq);
    expect(all.hasMore).toBe(false);

    // 预算收紧 → 只返回紧邻 before 的一段，并标记还能继续向前
    const page = manager.eventsPage(TENANT.id, "s1", { before: 150, maxBytes: 1024 });
    expect(page.events.at(-1)!.seq).toBe(149);
    expect(page.events.length).toBeLessThan(149);
    expect(page.earliestSeq).toBe(page.events[0]!.seq);
    expect(page.hasMore).toBe(true);
  });

  it("只给 since：保持原有向后增量语义", () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", deltas(1, 10));
    const manager = new SessionManager(store, 60000, {});

    const r = manager.eventsPage(TENANT.id, "s1", { since: 7 });
    expect(r.events.map((e) => e.seq)).toEqual([8, 9, 10]);
  });
});

describe("sessionTurns（按轮汇总）", () => {
  function seedSession(store: Store, turns: number, perTurnDeltas = 2): void {
    const all: EventEntry[] = [];
    let seq = 0;
    for (let t = 1; t <= turns; t++) {
      all.push({
        seq: ++seq,
        ts: TS,
        type: "turn_start",
        data: { input: `第 ${t} 个问题` },
      });
      for (let i = 0; i < perTurnDeltas; i++) {
        all.push({ seq: ++seq, ts: TS, type: "reasoning_delta", data: { text: "想" } });
      }
      all.push({
        seq: ++seq,
        ts: TS,
        type: "assistant_message",
        data: { text: `第 ${t} 个回答`, usage: { input: 10 * t, output: 5 * t } },
      });
      all.push({
        seq: ++seq,
        ts: TS,
        type: "tool_started",
        data: { reqId: `r${t}`, name: "read_file" },
      });
      all.push({
        seq: ++seq,
        ts: TS,
        type: "tool_finished",
        data: { reqId: `r${t}`, name: "read_file", status: "ok", duration: 12 },
      });
      all.push({ seq: ++seq, ts: TS, type: "turn_end", data: { status: "completed" } });
    }
    seedEvents(store, TENANT.id, "s1", all);
  }

  it("默认返回最近若干轮的标题与统计", async () => {
    const store = tmpStore();
    seedSession(store, 5);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurns(TENANT.id, "s1", { limit: 3 });
    expect(r.turns).toHaveLength(3);
    expect(r.hasMore).toBe(true);
    expect(r.turns.map((t) => t.input)).toEqual([
      "第 3 个问题",
      "第 4 个问题",
      "第 5 个问题",
    ]);
    const last = r.turns[2]!;
    expect(last.status).toBe("completed");
    expect(last.reply).toBe("第 5 个回答");
    expect(last.llmCalls).toBe(1);
    expect(last.toolCalls).toBe(1);
    expect(last.tokensIn).toBe(50);
    expect(last.tokensOut).toBe(25);
    expect(last.startSeq).toBeGreaterThan(0);
    expect(last.endSeq).toBeGreaterThan(last.startSeq);
    expect(last.endedAt).toBeTruthy();
  });

  it("向前翻页衔接上一批，且不重复", async () => {
    const store = tmpStore();
    seedSession(store, 5);
    const manager = new SessionManager(store, 60000, {});

    const page1 = await manager.sessionTurns(TENANT.id, "s1", { limit: 2 });
    const page2 = await manager.sessionTurns(TENANT.id, "s1", {
      before: page1.earliestSeq,
      limit: 2,
    });

    expect(page1.turns.map((t) => t.input)).toEqual(["第 4 个问题", "第 5 个问题"]);
    expect(page2.turns.map((t) => t.input)).toEqual(["第 2 个问题", "第 3 个问题"]);
    // 与上一页无重叠
    const overlap = page2.turns.filter((t) => page1.turns.some((x) => x.startSeq === t.startSeq));
    expect(overlap).toHaveLength(0);
    expect(page2.hasMore).toBe(true);
  });

  it("翻到头时 hasMore 为 false，能拿到第一轮", async () => {
    const store = tmpStore();
    seedSession(store, 3);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurns(TENANT.id, "s1", { limit: 100 });
    expect(r.turns.map((t) => t.input)).toEqual([
      "第 1 个问题",
      "第 2 个问题",
      "第 3 个问题",
    ]);
    expect(r.hasMore).toBe(false);
  });

  it("未结束的轮次状态为 running，错误轮次带 error", async () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", [
      { seq: 1, ts: TS, type: "turn_start", data: { input: "跑着呢" } },
      { seq: 2, ts: TS, type: "reasoning_delta", data: { text: "…" } },
      { seq: 3, ts: TS, type: "turn_start", data: { input: "炸了" } },
      { seq: 4, ts: TS, type: "error", data: { message: "boom" } },
      { seq: 5, ts: TS, type: "turn_end", data: { status: "error" } },
      { seq: 6, ts: TS, type: "turn_start", data: { input: "被打断" } },
      { seq: 7, ts: TS, type: "interrupted", data: {} },
    ]);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurns(TENANT.id, "s1", { limit: 10 });
    expect(r.turns.map((t) => t.status)).toEqual(["running", "error", "interrupted"]);
    expect(r.turns[1]!.error).toBe("boom");
  });

  it("轮次太多时按 limit 截断并标记 hasMore（截断发生在页内）", async () => {
    const store = tmpStore();
    seedSession(store, 4);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurns(TENANT.id, "s1", { limit: 1 });
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.input).toBe("第 4 个问题");
    expect(r.hasMore).toBe(true);
  });
});

describe("前端接入", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("useEventStream 支持向前加载且不裁掉已加载的历史", () => {
    const src = read("packages/console-core/src/useEventStream.ts");
    expect(src).toContain("loadEarlier");
    expect(src).toMatch(/before: earliest/);
    expect(src).toContain("keepAllRef");
  });

  it("ChatPanel 顶部提供「加载更早的对话」按钮", () => {
    const src = read("packages/console-ui/src/components/ChatPanel.tsx");
    expect(src).toContain("cq-load-earlier");
    expect(src).toMatch(/hasEarlier === true/);
    expect(src).toContain("onLoadEarlier");
    // prepend 后补偿滚动位置，避免视口跳动
    expect(src).toMatch(/scrollHeight - prevHeight \+ prevTop/);
  });

  it("会话详情走轮次接口，点开某轮再取该轮回复", () => {
    const src = read("packages/console-ui/src/components/SessionDetailsDialog.tsx");
    expect(src).toContain("getSessionTurns");
    expect(src).toContain("TurnReplyDialog");
    expect(src).toContain("sdLoadEarlierTurns");
    const reply = read("packages/console-ui/src/components/TurnReplyDialog.tsx");
    expect(reply).toContain("getSessionTurnReply");
    expect(reply).toContain("ProducedFiles");
  });

  it("两条传输都实现了新增方法", () => {
    for (const f of ["packages/console-core/src/transport/http.ts", "packages/console-core/src/transport/gateway.ts"]) {
      const src = read(f);
      expect(src, f).toContain("getEvents");
      expect(src, f).toContain("getSessionTurns");
      expect(src, f).toContain("getSessionTurnReply");
    }
  });
});
