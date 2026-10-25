/** 通知通道选择、标题/正文生成与中枢分发。 */
import { describe, it, expect, vi } from "vitest";
import { NotificationHub } from "../src/notify/NotificationHub.js";
import { channelWants, notifyBody, notifyTitle } from "../src/notify/Notifier.js";
import type { NotificationChannelConfig, NotifyEvent } from "../src/types.js";

function channel(over: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return {
    id: "c1",
    type: "webhook",
    enabled: true,
    config: {},
    events: { approval: true, question: true, completed: true, error: true },
    ...over,
  };
}

function event(kind: NotifyEvent["kind"], data: Record<string, unknown> = {}): NotifyEvent {
  return { kind, sessionId: "s1", ts: "2024-01-01T00:00:00.000Z", data };
}

describe("channelWants", () => {
  it("按事件开关过滤", () => {
    const ch = channel({
      events: { approval: true, question: false, completed: true, error: false },
    });
    expect(channelWants(ch, "approval_request")).toBe(true);
    expect(channelWants(ch, "question_asked")).toBe(false);
    expect(channelWants(ch, "turn_completed")).toBe(true);
    expect(channelWants(ch, "turn_stopped")).toBe(true);
    expect(channelWants(ch, "error")).toBe(false);
  });

  it("session_status 永远不投递第三方渠道", () => {
    expect(channelWants(channel(), "session_status")).toBe(false);
  });
});

describe("notifyTitle / notifyBody", () => {
  it("按事件类型生成标题", () => {
    expect(notifyTitle("approval_request")).toBe("需要审批");
    expect(notifyTitle("question_asked")).toBe("需要回答");
    expect(notifyTitle("turn_completed")).toBe("任务完成");
    expect(notifyTitle("turn_stopped")).toBe("达到迭代上限");
    expect(notifyTitle("error")).toBe("任务出错");
    expect(notifyTitle("session_status")).toBe("Agent 通知");
  });

  it("审批正文为 Markdown 表格", () => {
    const body = notifyBody(
      event("approval_request", {
        toolName: "shell",
        reason: "执行命令",
        arguments: { cmd: "ls" },
      }),
    );
    expect(body).toContain("🔒 需要审批");
    expect(body).toContain("| 🔧 工具 | shell |");
    expect(body).toContain("| cmd | ls |");
  });

  it("其它类型取相应字段", () => {
    expect(notifyBody(event("question_asked", { question: "选哪个？" }))).toBe("选哪个？");
    expect(notifyBody(event("turn_completed", { status: "done" }))).toBe("状态: done");
    expect(notifyBody(event("turn_completed"))).toBe("状态: completed");
    expect(notifyBody(event("turn_stopped"))).toContain("最大迭代次数");
    expect(notifyBody(event("error", { error: "boom" }))).toBe("boom");
    expect(notifyBody(event("error"))).toBe("未知错误");
    expect(notifyBody(event("session_status", { status: "running" }))).toBe("");
  });
});

describe("NotificationHub", () => {
  it("注册幂等，后注册覆盖", () => {
    const hub = new NotificationHub();
    const a = { type: "bark" as const, send: vi.fn() };
    const b = { type: "bark" as const, send: vi.fn() };
    hub.register(a);
    hub.register(b);
    expect(hub.registeredTypes()).toEqual(["bark"]);
    return hub.dispatch([channel({ type: "bark" })], event("approval_request")).then(() => {
      expect(a.send).not.toHaveBeenCalled();
      expect(b.send).toHaveBeenCalledTimes(1);
    });
  });

  it("跳过未启用、事件不匹配、未注册的通道", async () => {
    const hub = new NotificationHub();
    const send = vi.fn();
    hub.register({ type: "bark", send });
    await hub.dispatch(
      [
        channel({ id: "off", type: "bark", enabled: false }),
        channel({ id: "filtered", type: "bark", events: {
          approval: false, question: false, completed: false, error: false,
        } }),
        channel({ id: "unregistered", type: "email" }),
        channel({ id: "ok", type: "bark" }),
      ],
      event("approval_request"),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]!.id).toBe("ok");
  });

  it("单个通道抛错不影响后续通道", async () => {
    const hub = new NotificationHub();
    const ok = vi.fn();
    hub.register({ type: "bark", send: async () => { throw new Error("down"); } });
    hub.register({ type: "email", send: ok });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await hub.dispatch([channel({ type: "bark" }), channel({ type: "email" })], event("error"));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("空通道列表不报错", async () => {
    await expect(new NotificationHub().dispatch([], event("error"))).resolves.toBeUndefined();
  });
});
