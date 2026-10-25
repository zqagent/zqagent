/**
 * 撤销未注入的补充信息（steer）
 *
 * 背景：补充信息提交后在输入区上方排队，要等当前迭代结束才注入聊天流。
 * 这段时间用户反悔只能中断整个任务，所以补了「撤销单条」的能力。
 *
 * 这里锁住两个容易出错的地方：
 *   1. 引擎队列与 session 的 pendingSteers 必须同时删——只删一边，
 *      要么被删的内容仍出现在对话里，要么残留一条永不注入的条目；
 *   2. 撤掉的若是「最近用户指令」，列表展示要跟着还原，否则工作台
 *      还显示这条已经取消的内容。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../../core/src/server/store.js";
import { SessionManager } from "../../core/src/server/session.js";
import { setupServerHandlers } from "../../core/src/server/interact.js";
import { TurnEngine } from "../../core/src/engine/TurnEngine.js";
import type { TenantConfig } from "../../core/src/server/types.js";

function tenant(id: string): TenantConfig {
  return { id, name: id, model: "gpt-4o", provider: {}, allowedCommands: [] } as TenantConfig;
}

/** 一直挂起的 provider：让 turn 停在运行中，便于观察排队状态 */
function hangingProvider() {
  return {
    async *stream() {
      await new Promise((r) => setTimeout(r, 60_000));
      yield { content: "", reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
    },
  } as never;
}

describe("TurnEngine.removeSteering", () => {
  it("按文本删第一条，返回 true；不存在的文本返回 false", () => {
    const engine = new TurnEngine({ provider: hangingProvider() } as never);
    engine.queueSteering("A");
    engine.queueSteering("B");
    expect(engine.removeSteering("A")).toBe(true);
    // 已删掉的再删一次：false，调用方据此判断是否已经被注入
    expect(engine.removeSteering("A")).toBe(false);
    expect(engine.removeSteering("B")).toBe(true);
  });

  it("同名多条只删一条（用户只想撤回其中一条）", () => {
    const engine = new TurnEngine({ provider: hangingProvider() } as never);
    engine.queueSteering("同一个");
    engine.queueSteering("同一个");
    expect(engine.removeSteering("同一个")).toBe(true);
    // 还剩一条
    expect(engine.removeSteering("同一个")).toBe(true);
    expect(engine.removeSteering("同一个")).toBe(false);
  });
});

describe("SessionManager.unsteer", () => {
  let root: string;
  let manager: SessionManager;
  let t1: TenantConfig;
  /** 本用例建过的会话：afterEach 先中断再删目录，避免后台 turn 落盘报 ENOENT 噪音 */
  const sessions: string[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-unsteer-"));
    const store = new Store(root);
    manager = new SessionManager(store, 60_000, {
      providerFactory: () => hangingProvider(),
    });
    setupServerHandlers(manager);
    t1 = tenant("t1");
    store.saveTenant(t1);
  });

  afterEach(async () => {
    for (const sid of sessions) {
      try {
        manager.interrupt(t1, sid);
      } catch {
        /* 已结束 */
      }
    }
    // 让中断走到 finally（release runtime）后再删目录
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
    sessions.length = 0;
  });

  /** 起一个不结束的 turn，再排入若干补充信息 */
  function startWithSteers(...texts: string[]): string {
    const a = manager.createSession(t1, {});
    sessions.push(a.sessionId);
    manager.submitTurn(t1, a.sessionId, "原始任务");
    for (const t of texts) manager.steer(t1, a.sessionId, t);
    return a.sessionId;
  }

  it("撤销后返回剩余队列，两侧同时移除", () => {
    const sid = startWithSteers("第一条", "第二条");
    expect(manager.pendingSteers(sid)).toEqual(["第一条", "第二条"]);

    const left = manager.unsteer(t1, sid, 0);
    expect(left).toEqual(["第二条"]);
    expect(manager.pendingSteers(sid)).toEqual(["第二条"]);
  });

  it("撤销最后一条时，最近用户指令回退到前一条", () => {
    const sid = startWithSteers("第一条", "第二条");
    // steer 会把 lastInput 更新为该条
    expect(manager.pendingSteers(sid)).toEqual(["第一条", "第二条"]);

    manager.unsteer(t1, sid, 1); // 撤掉「第二条」
    const rt = (manager as unknown as { runtimes: Map<string, { lastInput?: string }> }).runtimes.get(sid)!;
    expect(rt.lastInput).toBe("第一条");
  });

  it("撤空全部后，最近用户指令回到本轮被覆盖前的原始任务", () => {
    const sid = startWithSteers("唯一一条");
    manager.unsteer(t1, sid, 0);
    const rt = (manager as unknown as { runtimes: Map<string, { lastInput?: string }> }).runtimes.get(sid)!;
    // 原始任务是提交 turn 时的输入，不能被已撤销的补充信息顶替
    expect(rt.lastInput).toBe("原始任务");
    expect(manager.pendingSteers(sid)).toEqual([]);
  });

  it("索引越界报 409（通常意味着它已经被注入对话）", () => {
    const sid = startWithSteers("第一条");
    expect(() => manager.unsteer(t1, sid, 5)).toThrowError(/已进入对话|无法撤销/);
    // 队列不受影响
    expect(manager.pendingSteers(sid)).toEqual(["第一条"]);
  });

  it("非整数索引被拒", () => {
    const sid = startWithSteers("第一条");
    expect(() => manager.unsteer(t1, sid, 0.5)).toThrowError();
    expect(() => manager.unsteer(t1, sid, Number.NaN)).toThrowError();
  });

  it("会话没有在运行时拒绝（队列随任务结束清空，无从撤销）", () => {
    const a = manager.createSession(t1, {});
    expect(() => manager.unsteer(t1, a.sessionId, 0)).toThrowError(/未在运行中/);
  });
});
