/**
 * 会话轮次索引（turns.ndjson）
 *
 * 现场：会话详情页几乎全是 0，且大会话只能列出 1~4 轮。
 * 原因：轮次列表每次从 events.jsonl 尾部反向扫（6 × 512KB），遇到超长轮次
 * 就翻不到更早的轮；前端回退用的又是「最近 2000 条事件」，里面没有 turn_start。
 * 修复：写入时旁路轮次索引，列表/单轮详情只读索引，与历史长度解耦。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import type { EventEntry, TenantConfig } from "../src/server/types.js";

function tmpStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-turn-index-")));
}

function seedEvents(store: Store, tenantId: string, sessionId: string, entries: EventEntry[]): void {
  const dir = store.sessionDir(tenantId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

const TENANT = { id: "t1", apiKey: "k", model: "m" } as TenantConfig;
const TS = new Date("2026-01-01T00:00:00.000Z").toISOString();

/** 造一轮：turn_start + 可选补充消息 + 若干 delta + assistant_message + turn_end */
function turn(
  seq: number,
  input: string,
  opts: {
    deltas?: number;
    steering?: string[];
    reply?: string;
    replyTextNull?: boolean;
    produced?: string[];
    status?: string;
    usage?: { input: number; output: number };
  } = {},
): { events: EventEntry[]; nextSeq: number } {
  const events: EventEntry[] = [
    { seq, ts: TS, type: "turn_start", data: { input } },
  ];
  let s = seq;
  for (const text of opts.steering ?? []) {
    events.push({ seq: ++s, ts: TS, type: "queue_steering", data: { text } });
  }
  for (let i = 0; i < (opts.deltas ?? 0); i++) {
    events.push({ seq: ++s, ts: TS, type: "reasoning_delta", data: { text: "推理".repeat(40) } });
  }
  events.push({
    seq: ++s,
    ts: TS,
    type: "assistant_message",
    data: {
      text: opts.replyTextNull ? null : (opts.reply ?? ""),
      usage: opts.usage ?? { input: 10, output: 5 },
    },
  });
  events.push({ seq: ++s, ts: TS, type: "tool_started", data: { reqId: `r${seq}`, name: "write_file" } });
  events.push({
    seq: ++s,
    ts: TS,
    type: "tool_finished",
    data: { reqId: `r${seq}`, name: "write_file", status: "ok" },
  });
  events.push({
    seq: ++s,
    ts: TS,
    type: "turn_end",
    data: {
      status: opts.status ?? "completed",
      iterations: 3,
      produced_files: opts.produced ?? [],
    },
  });
  return { events, nextSeq: s };
}

describe("轮次索引：列表与单轮详情", () => {
  it("超长轮次（单轮 > 旧 3MB 扫描预算）也能列出完整历史", async () => {
    const store = tmpStore();
    const all: EventEntry[] = [];
    let seq = 0;
    // 12 轮，每轮约 1MB delta：旧实现一页最多跨 3MB，必然列不全
    for (let i = 1; i <= 12; i++) {
      const t = turn(++seq, `第 ${i} 个问题`, { deltas: 4000, reply: `第 ${i} 个回答` });
      all.push(...t.events);
      seq = t.nextSeq;
    }
    seedEvents(store, TENANT.id, "s1", all);
    const manager = new SessionManager(store, 60000, {});

    const seen: string[] = [];
    let before: number | undefined;
    let guard = 0;
    for (;;) {
      const page = await manager.sessionTurns(TENANT.id, "s1", { before, limit: 5 });
      expect(page.total).toBe(12);
      expect(page.userTotal).toBe(12);
      seen.unshift(...page.turns.map((t) => t.input));
      if (!page.hasMore || guard++ > 10) break;
      before = page.earliestSeq;
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 个问题`));
    // 索引已落盘，后续读取不再扫事件
    expect(fs.existsSync(path.join(store.sessionDir(TENANT.id, "s1"), "turns.ndjson"))).toBe(true);
  });

  it("用户消息数包含补充消息，顺序与事件一致", async () => {
    const store = tmpStore();
    const t = turn(1, "原始问题", { steering: ["补充一", "补充二"], reply: "答" });
    seedEvents(store, TENANT.id, "s1", t.events);
    const manager = new SessionManager(store, 60000, {});

    const page = await manager.sessionTurns(TENANT.id, "s1", { limit: 20 });
    expect(page.userTotal).toBe(3);
    expect(page.turns[0]!.userCount).toBe(3);
    expect(page.turns[0]!.inputs?.map((m) => m.text)).toEqual(["原始问题", "补充一", "补充二"]);
    expect(page.turns[0]!.input).toBe("原始问题");
  });

  it("单轮详情返回全部用户消息、最终回复与产出文件", async () => {
    const store = tmpStore();
    const t = turn(1, "做个文档", {
      steering: ["顺便更新 openapi"],
      reply: "已完成，见 docs/openapi.yaml",
      produced: ["docs/openapi.yaml", "src/router.ts"],
    });
    seedEvents(store, TENANT.id, "s1", t.events);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurnReply(TENANT.id, "s1", 1);
    expect(r.userMessages.map((m) => m.text)).toEqual(["做个文档", "顺便更新 openapi"]);
    expect(r.reply?.text).toBe("已完成，见 docs/openapi.yaml");
    expect(r.producedFiles).toEqual(["docs/openapi.yaml", "src/router.ts"]);
    expect(r.truncated).toBe(false);
    expect(r.status).toBe("completed");
  });

  it("最终回复取最后一条「非空文本」的 assistant_message（跳过纯工具轮）", async () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", [
      { seq: 1, ts: TS, type: "turn_start", data: { input: "跑一下" } },
      { seq: 2, ts: TS, type: "assistant_message", data: { text: null, tool_calls: ["run_shell"] } },
      { seq: 3, ts: TS, type: "tool_started", data: { reqId: "r1", name: "run_shell" } },
      { seq: 4, ts: TS, type: "tool_finished", data: { reqId: "r1", name: "run_shell", status: "ok" } },
      { seq: 5, ts: TS, type: "assistant_message", data: { text: "都通过了" } },
      { seq: 6, ts: TS, type: "turn_end", data: { status: "completed" } },
    ]);
    const manager = new SessionManager(store, 60000, {});

    const page = await manager.sessionTurns(TENANT.id, "s1", {});
    expect(page.turns[0]!.reply).toBe("都通过了");
    expect(page.turns[0]!.replySeq).toBe(5);
    const r = await manager.sessionTurnReply(TENANT.id, "s1", 1);
    expect(r.reply).toEqual({ seq: 5, ts: TS, text: "都通过了" });
  });

  it("本轮没有文本回复时 reply 为 null", async () => {
    const store = tmpStore();
    const t = turn(1, "只跑工具", { replyTextNull: true });
    seedEvents(store, TENANT.id, "s1", t.events);
    const manager = new SessionManager(store, 60000, {});

    const r = await manager.sessionTurnReply(TENANT.id, "s1", 1);
    expect(r.reply).toBeNull();
  });

  it("轮次不存在时返回 404", async () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", turn(1, "hi").events);
    const manager = new SessionManager(store, 60000, {});

    await expect(manager.sessionTurnReply(TENANT.id, "s1", 999)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("索引落后（进程重启前未落盘）时按尾部新 turn 自动重建", async () => {
    const store = tmpStore();
    const first = turn(1, "第一轮");
    const second = turn(first.nextSeq + 1, "第二轮");
    seedEvents(store, TENANT.id, "s1", [...first.events, ...second.events]);

    // 手工写一份只含第一轮的旧索引，模拟崩溃遗留
    await store.saveTurnIndex(TENANT.id, "s1", [
      {
        v: 1,
        startSeq: 1,
        endSeq: first.nextSeq,
        startedAt: TS,
        endedAt: TS,
        status: "completed",
        inputs: [{ seq: 1, ts: TS, text: "第一轮" }],
        replyPreview: "",
        producedFiles: [],
        llmCalls: 1,
        toolCalls: 1,
        tokensIn: 10,
        tokensOut: 5,
      },
    ]);

    const manager = new SessionManager(store, 60000, {});
    const page = await manager.sessionTurns(TENANT.id, "s1", { limit: 20 });
    expect(page.turns.map((t) => t.input)).toEqual(["第一轮", "第二轮"]);
  });

  it("崩溃遗留的 running 轮：重启后按事件重建为 interrupted", async () => {
    const store = tmpStore();
    seedEvents(store, TENANT.id, "s1", [
      { seq: 1, ts: TS, type: "turn_start", data: { input: "跑到一半" } },
      { seq: 2, ts: TS, type: "reasoning_delta", data: { text: "想" } },
      { seq: 3, ts: TS, type: "interrupted", data: {} },
    ]);
    // 模拟崩溃前只落了 running 版本
    await store.saveTurnIndex(TENANT.id, "s1", [
      {
        v: 1,
        startSeq: 1,
        endSeq: 1,
        startedAt: TS,
        endedAt: null,
        status: "running",
        inputs: [{ seq: 1, ts: TS, text: "跑到一半" }],
        replyPreview: "",
        producedFiles: [],
        llmCalls: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
    ]);

    const manager = new SessionManager(store, 60000, {});
    const page = await manager.sessionTurns(TENANT.id, "s1", {});
    expect(page.turns[0]!.status).toBe("interrupted");
    expect(page.turns[0]!.endedAt).toBe(TS);
  });

  it("空会话返回空列表而不是报错", async () => {
    const store = tmpStore();
    fs.mkdirSync(store.sessionDir(TENANT.id, "s1"), { recursive: true });
    const manager = new SessionManager(store, 60000, {});

    const page = await manager.sessionTurns(TENANT.id, "s1", {});
    expect(page).toMatchObject({ turns: [], hasMore: false, total: 0, userTotal: 0 });
  });
});

describe("运行中轮次的索引维护", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("真实跑一轮后，索引立即可读（无需等进程重启重建）", async () => {
    const store = tmpStore();
    const tenant = {
      id: "t1",
      apiKey: "k1",
      model: "m",
      provider: { apiKey: "a" },
    } as TenantConfig;
    store.saveTenant(tenant);
    const provider = {
      async stream() {
        return (async function* () {
          yield {
            content: "你好呀，我是助手",
            reasoning: null,
            toolCalls: null,
            usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
            finishReason: "stop",
          };
        })();
      },
      async chat() {
        return null;
      },
    };
    const manager = new SessionManager(store, 60000, {
      providerFactory: () => provider as never,
    });
    const rec = manager.createSession(tenant, {});
    manager.submitTurn(tenant, rec.sessionId, "你好");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const st = manager.getSession(tenant.id, rec.sessionId)!.status;
      if (st === "completed" || st === "error" || st === "stopped") break;
      await sleep(20);
    }

    const page = await manager.sessionTurns(tenant.id, rec.sessionId, {});
    expect(page.total).toBe(1);
    expect(page.userTotal).toBe(1);
    expect(page.turns[0]!.status).toBe("completed");
    expect(page.turns[0]!.reply).toContain("你好呀");
    expect(page.turns[0]!.tokensIn).toBe(3);
    expect(page.turns[0]!.tokensOut).toBe(4);

    const detail = await manager.sessionTurnReply(tenant.id, rec.sessionId, page.turns[0]!.startSeq);
    expect(detail.userMessages.map((m) => m.text)).toEqual(["你好"]);
    expect(detail.reply?.text).toContain("你好呀");
  });

  it("带图片附件的一轮：字节落盘、事件 / 索引带引用、可回读", async () => {
    const store = tmpStore();
    const tenant = {
      id: "t1",
      apiKey: "k1",
      model: "vision-model",
      provider: {
        apiKey: "a",
        modelMeta: [{ id: "vision-model", capabilities: ["text", "image"] }],
      },
    } as unknown as TenantConfig;
    store.saveTenant(tenant);
    const provider = {
      async stream() {
        return (async function* () {
          yield {
            content: "图里是一只猫",
            reasoning: null,
            toolCalls: null,
            usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
            finishReason: "stop",
          };
        })();
      },
      async chat() {
        return null;
      },
    };
    const manager = new SessionManager(store, 60000, {
      providerFactory: () => provider as never,
    });
    const rec = manager.createSession(tenant, {});
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    manager.submitTurn(tenant, rec.sessionId, "看看这张图", [
      {
        name: "cat.png",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      },
    ]);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const st = manager.getSession(tenant.id, rec.sessionId)!.status;
      if (st === "completed" || st === "error" || st === "stopped") break;
      await sleep(20);
    }

    // 1) 轮次索引里带附件引用（控制台的缩略图与详情回看都靠它）
    const page = await manager.sessionTurns(tenant.id, rec.sessionId, {});
    const att = page.turns[0]!.inputs![0]!.attachments;
    expect(att).toHaveLength(1);
    expect(att![0]).toMatchObject({ name: "cat.png", mimeType: "image/png", size: bytes.length });
    expect(att![0]!.path).toMatch(/^attachments\//);

    // 2) 字节真的写进了会话目录，且 session.json 里没有 base64
    const sessionJson = fs.readFileSync(
      path.join(store.sessionDir(tenant.id, rec.sessionId), "session.json"),
      "utf-8",
    );
    expect(sessionJson).not.toContain(bytes.toString("base64"));
    expect(sessionJson).toContain("attachmentRefs");

    // 3) 按引用能取回原始字节
    const back = manager.sessionAttachment(tenant.id, rec.sessionId, att![0]!.path);
    expect(back.base64).toBe(bytes.toString("base64"));
    expect(back.mimeType).toBe("image/png");
    expect(back.name).toBe("cat.png");

    // 4) 越界路径被拒
    expect(() => manager.sessionAttachment(tenant.id, rec.sessionId, "../session.json")).toThrow();
  });
});
