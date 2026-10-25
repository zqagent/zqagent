/**
 * 任务结束通知的载荷：必须带「会话名 + 最后一条用户消息」
 *
 * 这是节点侧的权威来源。前端虽然有实时缓存可以回退，但刚打开页面、或通知
 * 与快照乱序到达时缓存可能是空的；那时若载荷里也没有，右下角弹窗就只剩
 * 「任务已完成」四个字。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../../core/src/server/store.js";
import { SessionManager } from "../../core/src/server/session.js";
import { setupServerHandlers } from "../../core/src/server/interact.js";
import type { NotifyEvent, TenantConfig } from "../../core/src/server/types.js";

function tenant(id: string): TenantConfig {
  return { id, name: id, model: "gpt-4o", provider: {}, allowedCommands: [] } as TenantConfig;
}

/** 只回一段文本的假 provider（不触发工具调用） */
function textProvider(text: string) {
  return {
    async *stream() {
      yield { content: text, reasoning: null, toolCalls: null, usage: null, finishReason: "stop" };
    },
  } as never;
}

describe("turn_completed / turn_stopped 通知载荷", () => {
  it("带上会话名与最后一条用户消息（截断到 200 字）", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-turnnotify-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000, {
      providerFactory: () => textProvider("好的"),
    });
    setupServerHandlers(manager);

    const events: NotifyEvent[] = [];
    manager.setNotifyHandler((_t, ev) => events.push(ev));

    const t1 = tenant("t1");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});
    await manager.renameSession(t1, a.sessionId, "修复登录超时");
    manager.submitTurn(t1, a.sessionId, "帮我把登录页的报错改一下");

    // 等 turn 跑完（事件循环推进）
    for (let i = 0; i < 100 && !events.some((e) => e.kind === "turn_completed"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const done = events.find((e) => e.kind === "turn_completed");
    expect(done, "应产生 turn_completed 通知").toBeTruthy();
    const data = done!.data as Record<string, unknown>;
    expect(data.sessionName).toBe("修复登录超时");
    expect(data.lastUserMessage).toBe("帮我把登录页的报错改一下");
    // 回答摘要仍保留（前端在拿不到用户消息时兜底）
    expect(data.summary).toBe("好的");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("超长用户消息按 200 字截断，与 session_status 口径一致", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-turnnotify-long-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000, {
      providerFactory: () => textProvider("好"),
    });
    setupServerHandlers(manager);
    const events: NotifyEvent[] = [];
    manager.setNotifyHandler((_t, ev) => events.push(ev));

    const t1 = tenant("t1");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});
    const long = "长".repeat(300);
    manager.submitTurn(t1, a.sessionId, long);

    for (let i = 0; i < 100 && !events.some((e) => e.kind === "turn_completed"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const data = events.find((e) => e.kind === "turn_completed")!.data as Record<string, unknown>;
    const msg = String(data.lastUserMessage);
    expect(msg.length).toBe(201);
    expect(msg.endsWith("…")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
