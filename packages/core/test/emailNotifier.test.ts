/**
 * EmailNotifier 单测
 *
 * 通过注入 transport 工厂，验证 SMTP 参数、收件人、主题与正文构造。
 */
import { describe, it, expect } from "vitest";
import { EmailNotifier } from "../src/server/notify/notifiers/EmailNotifier.js";
import type { SmtpOptions } from "../src/server/notify/notifiers/EmailNotifier.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
} from "../src/server/types.js";

interface Sent {
  opts: SmtpOptions;
  mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  };
}

function makeNotifier(sent: Sent[]) {
  return new EmailNotifier((opts) => {
    return {
      sendMail: async (mail: unknown) => {
        sent.push({ opts, mail: mail as Sent["mail"] });
        return {};
      },
      close: () => {},
    } as never;
  });
}

const config: NotificationChannelConfig = {
  id: "1",
  type: "email",
  enabled: true,
  config: {
    host: "smtp.qq.com",
    port: "465",
    secure: "true",
    user: "a@qq.com",
    pass: "secret",
    from: "a@qq.com",
    to: "b@qq.com",
  },
  events: { approval: false, question: false, completed: true, error: false },
};

const completedEv: NotifyEvent = {
  kind: "turn_completed",
  sessionId: "sess-1",
  ts: new Date().toISOString(),
  data: {
    status: "completed",
    iterations: 3,
    produced_files: ["a.txt", "b.txt"],
    summary: "任务已全部完成",
  },
};

describe("EmailNotifier", () => {
  it("发送任务完成邮件（含摘要与产出文件）", async () => {
    const sent: Sent[] = [];
    await makeNotifier(sent).send(config, completedEv);

    expect(sent).toHaveLength(1);
    const { opts, mail } = sent[0]!;
    expect(opts.host).toBe("smtp.qq.com");
    expect(opts.port).toBe(465);
    expect(opts.secure).toBe(true);
    expect(mail.from).toBe("a@qq.com");
    expect(mail.to).toBe("b@qq.com");
    expect(mail.subject).toContain("任务完成");
    expect(mail.text).toContain("任务已全部完成");
    expect(mail.text).toContain("a.txt");
    expect(mail.html).toContain("任务已全部完成");
  });

  it("短任务（<60s）不发邮件", async () => {
    const sent: Sent[] = [];
    const ev: NotifyEvent = {
      ...completedEv,
      data: { ...completedEv.data, durationMs: 30_000 },
    };
    await makeNotifier(sent).send(config, ev);
    expect(sent).toHaveLength(0);
  });

  it("长任务（>=60s）发邮件", async () => {
    const sent: Sent[] = [];
    const ev: NotifyEvent = {
      ...completedEv,
      data: { ...completedEv.data, durationMs: 120_000 },
    };
    await makeNotifier(sent).send(config, ev);
    expect(sent).toHaveLength(1);
  });

  it("无 durationMs 时照常发送", async () => {
    const sent: Sent[] = [];
    await makeNotifier(sent).send(config, completedEv);
    expect(sent).toHaveLength(1);
  });

  it("自定义阈值 minDurationSeconds 生效", async () => {
    const sent: Sent[] = [];
    const cfg: NotificationChannelConfig = {
      ...config,
      config: { ...config.config, minDurationSeconds: "120" },
    };
    const ev: NotifyEvent = {
      ...completedEv,
      data: { ...completedEv.data, durationMs: 60_000 }, // 60s < 120s → 不发
    };
    await makeNotifier(sent).send(cfg, ev);
    expect(sent).toHaveLength(0);
  });

  it("secure=false 时默认端口 587", async () => {
    const sent: Sent[] = [];
    const cfg: NotificationChannelConfig = {
      ...config,
      config: { ...config.config, secure: "false", port: "" },
    };
    await makeNotifier(sent).send(cfg, completedEv);
    expect(sent[0]!.opts.port).toBe(587);
    expect(sent[0]!.opts.secure).toBe(false);
  });

  it("缺 host 或 to 时不发送", async () => {
    const sent: Sent[] = [];
    const noHost: NotificationChannelConfig = {
      ...config,
      config: { ...config.config, host: "" },
    };
    const noTo: NotificationChannelConfig = {
      ...config,
      config: { ...config.config, to: "" },
    };
    await makeNotifier(sent).send(noHost, completedEv);
    await makeNotifier(sent).send(noTo, completedEv);
    expect(sent).toHaveLength(0);
  });

  it("无 user 时不做 SMTP 认证", async () => {
    const sent: Sent[] = [];
    const cfg: NotificationChannelConfig = {
      ...config,
      config: { ...config.config, user: "", pass: "" },
    };
    await makeNotifier(sent).send(cfg, completedEv);
    expect(sent[0]!.opts.auth).toBeUndefined();
  });
});
