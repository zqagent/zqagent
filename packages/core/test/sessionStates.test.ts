/**
 * 跨项目会话状态汇总（节点首页 / 工作台初始快照）
 *
 * 只验证形状与聚合：必须只含标识 + status，不能把消息、模型、token 等明细带出去。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { allSessionStates } from "../src/server/projects.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { createApp } from "../src/server/routes.js";
import type { NotifyEvent, TenantConfig } from "../src/server/types.js";

function tenant(id: string, name: string): TenantConfig {
  return { id, name, apiKey: `k-${id}`, model: "m", provider: { apiKey: "a" } };
}

describe("allSessionStates", () => {
  it("跨项目汇总会话标识与状态，且不含明细字段", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-states-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000);
    setupServerHandlers(manager);

    const t1 = tenant("t1", "项目一");
    const t2 = tenant("t2", "项目二");
    store.saveTenant(t1);
    store.saveTenant(t2);

    const a = manager.createSession(t1, {});
    const b = manager.createSession(t2, {});

    const out = allSessionStates(store, manager);
    expect(out).toHaveLength(2);

    const ra = out.find((s) => s.sessionId === a.sessionId)!;
    expect(ra).toEqual({
      projectId: "t1",
      projectName: "项目一",
      sessionId: a.sessionId,
      name: null,
      status: "idle",
      lastUserMessage: null,
      lastCompletedAt: null,
    });
    expect(out.find((s) => s.sessionId === b.sessionId)!.projectId).toBe("t2");

    // 明细字段一律不出现（消息/模型/token 只在会话详情接口返回）
    for (const s of out) {
      expect(Object.keys(s).sort()).toEqual([
        "lastCompletedAt",
        "lastUserMessage",
        "name",
        "projectId",
        "projectName",
        "sessionId",
        "status",
      ]);
    }
  });

  it("带出最后一条用户消息与最后完成时间（长消息截断）", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-states-last-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000);
    setupServerHandlers(manager);

    const t1 = tenant("t1", "项目一");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});

    const rec = store.loadSession("t1", a.sessionId)!;
    await store.saveSession({
      ...rec,
      lastInput: "把登录页的错误提示统一一下",
      lastCompletedAt: "2026-10-17T04:00:00.000Z",
    });

    const s = allSessionStates(store, manager).find((x) => x.sessionId === a.sessionId)!;
    expect(s.lastUserMessage).toBe("把登录页的错误提示统一一下");
    expect(s.lastCompletedAt).toBe("2026-10-17T04:00:00.000Z");

    // 超长消息截断，避免快照体积随对话膨胀
    const long = "长".repeat(300);
    await store.saveSession({ ...store.loadSession("t1", a.sessionId)!, lastInput: long });
    const s2 = allSessionStates(store, manager).find((x) => x.sessionId === a.sessionId)!;
    expect(s2.lastUserMessage!.length).toBe(201);
    expect(s2.lastUserMessage!.endsWith("…")).toBe(true);
  });

  it("历史会话缺 lastCompletedAt 时用最后一条 assistant 消息时间近似", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-states-legacy-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000);
    setupServerHandlers(manager);

    const t1 = tenant("t1", "项目一");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});
    const ts = Date.parse("2026-10-16T02:30:00.000Z");

    const rec = store.loadSession("t1", a.sessionId)!;
    store.saveSessionSync({
      ...rec,
      status: "completed",
      messages: [
        { role: "user", content: "旧会话里的问题" },
        { role: "assistant", content: "回答", ts },
      ],
    });

    const s = allSessionStates(store, manager).find((x) => x.sessionId === a.sessionId)!;
    expect(s.lastCompletedAt).toBe("2026-10-16T02:30:00.000Z");
    // 消息里没有 lastInput 时回退扫描 history
    expect(s.lastUserMessage).toBe("旧会话里的问题");
  });

  it("新建即广播 session_status(idle)，删除广播 deleted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-states-notify-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000);
    setupServerHandlers(manager);

    const t1 = tenant("t1", "项目一");
    store.saveTenant(t1);

    const events: Array<{ tenantId: string; ev: NotifyEvent }> = [];
    manager.setNotifyHandler((tenantId, ev) => events.push({ tenantId, ev }));

    const rec = manager.createSession(t1, {});
    expect(events.map((e) => e.ev)).toEqual([
      expect.objectContaining({
        kind: "session_status",
        sessionId: rec.sessionId,
        data: { status: "idle" },
      }),
    ]);
    expect(events[0]!.tenantId).toBe("t1");

    events.length = 0;
    manager.deleteSession(t1.id, rec.sessionId);
    expect(events.map((e) => e.ev)).toEqual([
      expect.objectContaining({
        kind: "session_status",
        sessionId: rec.sessionId,
        data: { status: "deleted" },
      }),
    ]);
  });

  it("GET /api/v1/node/session-states 跨项目返回状态", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-states-http-"));
    const store = new Store(root);
    const manager = new SessionManager(store, 60_000);
    setupServerHandlers(manager);

    const t1 = tenant("t1", "项目一");
    store.saveTenant(t1);
    const a = manager.createSession(t1, {});

    const server = createApp(store, manager, { adminKey: "admin-key" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/node/session-states`, {
        headers: { Authorization: "Bearer admin-key" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { sessions: Array<{ sessionId: string; status: string; projectName: string }> };
      };
      expect(body.data.sessions).toEqual([
        {
          projectId: "t1",
          projectName: "项目一",
          sessionId: a.sessionId,
          name: null,
          status: "idle",
          lastUserMessage: null,
          lastCompletedAt: null,
        },
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
