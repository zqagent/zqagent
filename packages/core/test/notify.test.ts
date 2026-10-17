/**
 * 通知中枢测试
 *
 * 覆盖：事件过滤、配置加解密往返、Hub 分发到启用且匹配的通道。
 */
import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { NotificationHub } from "../src/server/notify/NotificationHub.js";
import {
  channelWants,
  notifyTitle,
  notifyBody,
  type Notifier,
} from "../src/server/notify/Notifier.js";
import {
  decryptNotifications,
  saveNotifications,
} from "../src/server/notify/tenantNotifications.js";
import { SecretBox } from "../src/crypto/secrets.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
  TenantConfig,
} from "../src/server/types.js";

const evts = {
  approval: true,
  question: true,
  completed: true,
  error: true,
};

describe("channelWants 事件过滤", () => {
  const ch: NotificationChannelConfig = {
    id: "1",
    type: "bark",
    enabled: true,
    config: {},
    events: { approval: true, question: false, completed: true, error: false },
  };
  it("按事件类型过滤", () => {
    expect(channelWants(ch, "approval_request")).toBe(true);
    expect(channelWants(ch, "question_asked")).toBe(false);
    expect(channelWants(ch, "turn_completed")).toBe(true);
    expect(channelWants(ch, "error")).toBe(false);
  });
});

describe("notifyTitle/notifyBody", () => {
  it("生成标题与正文", () => {
    expect(notifyTitle("approval_request")).toContain("审批");
    expect(
      notifyBody({
        kind: "approval_request",
        sessionId: "s",
        ts: "",
        data: { toolName: "write_file", reason: "需要写文件" },
      }),
    ).toContain("write_file");
  });
});

describe("通知配置加解密", () => {
  it("加密后解密往返一致", () => {
    const box = new SecretBox(crypto.randomBytes(32));
    const chs: NotificationChannelConfig[] = [
      { id: "1", type: "bark", enabled: true, config: { key: "secret" }, events: evts },
    ];
    const tenant: TenantConfig = { id: "t", apiKey: "k", model: "m", provider: {} };
    saveNotifications(tenant, box, chs);
    expect(tenant.notifications).toBeUndefined();
    expect(tenant.notificationsEnc).toBeTruthy();
    expect(decryptNotifications(tenant, box)).toEqual(chs);
  });

  it("无 SecretBox 时退化为明文", () => {
    const chs: NotificationChannelConfig[] = [
      { id: "1", type: "bark", enabled: true, config: {}, events: evts },
    ];
    const tenant: TenantConfig = { id: "t", apiKey: "k", model: "m", provider: {} };
    saveNotifications(tenant, null, chs);
    expect(tenant.notifications).toEqual(chs);
    expect(decryptNotifications(tenant, null)).toEqual(chs);
  });
});

describe("NotificationHub 分发", () => {
  it("只发送到启用且事件匹配的通道", async () => {
    const hub = new NotificationHub();
    const sent: string[] = [];
    const mock: Notifier = {
      type: "bark",
      send: async (cfg, ev) => {
        sent.push(`${cfg.id}:${ev.kind}`);
      },
    };
    hub.register(mock);

    const tenant: TenantConfig = {
      id: "t",
      apiKey: "k",
      model: "m",
      provider: {},
      notifications: [
        {
          id: "a",
          type: "bark",
          enabled: true,
          config: {},
          events: { approval: true, question: false, completed: false, error: false },
        },
        {
          id: "b",
          type: "bark",
          enabled: false, // 禁用
          config: {},
          events: evts,
        },
      ],
    };
    const ev: NotifyEvent = {
      kind: "approval_request",
      sessionId: "s",
      ts: new Date().toISOString(),
      data: {},
    };
    await hub.dispatch(tenant.notifications ?? [], ev);
    expect(sent).toEqual(["a:approval_request"]);
  });
});
