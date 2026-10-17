/**
 * 邮件通知通道（通用 SMTP）
 *
 * 通过 SMTP 发送任务完成 / 审批 / 提问 / 错误等通知。兼容 QQ 邮箱
 * （smtp.qq.com:465 SSL + 授权码）、163、Gmail 等任意 SMTP 服务。
 *
 * config: {
 *   host: "smtp.qq.com",
 *   port: "465",            // 省略时按 secure 推断 465/587
 *   secure: "true",         // "true"=SSL，"false"=STARTTLS
 *   user: "you@qq.com",
 *   pass: "授权码",         // 密文落盘
 *   from: "you@qq.com",     // 省略时取 user
 *   to: "you@qq.com",       // 可多个逗号分隔
 *   subjectPrefix: "[zqagent]" // 可选，默认 [zqagent]
 * }
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Notifier } from "../Notifier.js";
import { notifyTitle } from "../Notifier.js";
import {
  approvalInputFromData,
  approvalToHtmlTable,
  approvalToMarkdownTable,
} from "../../approval-view.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
} from "../../types.js";

/** SMTP 连接参数（透传给 nodemailer.createTransport） */
export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/** 可注入的 transport 工厂（测试时替换为 fake） */
export type TransportFactory = (opts: SmtpOptions) => Transporter;

/** 默认工厂：创建真实 nodemailer transport */
export function defaultTransportFactory(opts: SmtpOptions): Transporter {
  return nodemailer.createTransport(opts);
}

/** 按事件类型生成纯文本正文（turn_completed 时附产出文件与摘要） */
function buildText(ev: NotifyEvent): string {
  const d = ev.data;
  switch (ev.kind) {
    case "turn_completed":
    case "turn_stopped": {
      const lines: string[] = [];
      lines.push(`会话: ${ev.sessionId}`);
      lines.push(`状态: ${String(d["status"] ?? ev.kind)}`);
      if (d["iterations"] !== undefined)
        lines.push(`迭代次数: ${String(d["iterations"])}`);
      const files = d["produced_files"] as string[] | undefined;
      if (Array.isArray(files) && files.length > 0)
        lines.push(`产出文件:\n  ${files.join("\n  ")}`);
      const summary = typeof d["summary"] === "string" ? d["summary"] : "";
      if (summary.trim()) lines.push(`\n摘要:\n${summary}`);
      return lines.join("\n");
    }
    case "approval_request":
      return `${approvalToMarkdownTable(approvalInputFromData(d), {
        title: "🔒 需要审批",
      })}\n会话: ${ev.sessionId}`;
    case "question_asked":
      return `问题: ${String(d["question"] ?? "")}\n会话: ${ev.sessionId}`;
    case "error":
      return `错误: ${String(d["error"] ?? "未知错误")}\n会话: ${ev.sessionId}`;
    default:
      return `会话: ${ev.sessionId}\n时间: ${ev.ts}`;
  }
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 将正文转成 HTML：审批渲染为真正的表格，其余保持 <pre> 换行 */
function buildHtml(ev: NotifyEvent): string {
  if (ev.kind === "approval_request") {
    const table = approvalToHtmlTable(approvalInputFromData(ev.data));
    return (
      table +
      `<p style="color:#6b7280;font-size:12px;margin:10px 0 0;">会话: ${escapeHtml(ev.sessionId)}</p>`
    );
  }
  return `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(buildText(ev))}</pre>`;
}

export class EmailNotifier implements Notifier {
  readonly type = "email" as const;

  constructor(
    private readonly transportFactory: TransportFactory = defaultTransportFactory,
  ) {}

  async send(config: NotificationChannelConfig, ev: NotifyEvent): Promise<void> {
    // 短任务过滤：任务成功完成且执行时长未超过阈值（默认 60s）时不发邮件。
    // 可用 config.minDurationSeconds 覆盖阈值。
    if (ev.kind === "turn_completed") {
      const minSec = Number(config.config["minDurationSeconds"] ?? 60);
      const durationMs = ev.data["durationMs"];
      if (typeof durationMs === "number" && durationMs < minSec * 1000) {
        return;
      }
    }

    const host = config.config["host"];
    const to = config.config["to"];
    if (!host || !to) return;

    const secure = config.config["secure"] === "true";
    const port =
      Number(config.config["port"]) || (secure ? 465 : 587);
    const user = config.config["user"] ?? "";
    const pass = config.config["pass"] ?? "";
    const from = config.config["from"] ?? user;
    if (!from) return;

    const prefix = config.config["subjectPrefix"] ?? "[zqagent]";
    const transport = this.transportFactory({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });

    try {
      await transport.sendMail({
        from,
        to,
        subject: `${prefix}${notifyTitle(ev.kind)}`,
        text: buildText(ev),
        html: buildHtml(ev),
      });
    } finally {
      // 关闭连接，避免每次通知都遗留连接（无连接池需求）
      try {
        transport.close();
      } catch {
        // 忽略关闭失败
      }
    }
  }
}
