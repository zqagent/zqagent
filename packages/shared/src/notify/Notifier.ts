/**
 * 通知通道接口
 *
 * 每种通知渠道（Telegram / 企微 / 钉钉 / 飞书 / Bark / 邮件 / 短信 / …）
 * 实现本接口。NotificationHub 按租户配置把 NotifyEvent 分发到各通道。
 * 实现必须是「尽力而为」：发送失败应抛出异常由 Hub 捕获降级，或自行吞掉。
 */
import type {
  NotificationChannelConfig,
  NotificationChannelType,
  NotifyEvent,
} from "../types.js";
import {
  approvalInputFromData,
  approvalToMarkdownTable,
} from "../approval-view.js";

export interface Notifier {
  /** 通道类型标识 */
  readonly type: NotificationChannelType;

  /**
   * 发送一条通知。
   * @param config 该租户此通道的配置（明文态，敏感字段已由上层解密）
   * @param ev 结构化通知事件
   */
  send(config: NotificationChannelConfig, ev: NotifyEvent): Promise<void>;
}

/** 依据通知事件类型判断是否命中该通道的事件过滤开关 */
export function channelWants(channel: NotificationChannelConfig, kind: NotifyEvent["kind"]): boolean {
  const ev = channel.events;
  switch (kind) {
    case "approval_request":
      return ev.approval;
    case "question_asked":
      return ev.question;
    case "turn_completed":
    case "turn_stopped":
      return ev.completed;
    case "error":
      return ev.error;
    case "session_status":
      // 纯状态同步：频率高、无用户动作，任何第三方渠道都不该收到
      return false;
    default:
      return true;
  }
}

/** 生成简短的通知标题（供各通道复用） */
export function notifyTitle(kind: NotifyEvent["kind"]): string {
  switch (kind) {
    case "approval_request":
      return "需要审批";
    case "question_asked":
      return "需要回答";
    case "turn_completed":
      return "任务完成";
    case "turn_stopped":
      return "达到迭代上限";
    case "error":
      return "任务出错";
    default:
      return "Agent 通知";
  }
}

/** 生成简短的通知正文（供各通道复用，超长截断） */
export function notifyBody(ev: NotifyEvent, maxLen = 300): string {
  const d = ev.data;
  switch (ev.kind) {
    case "approval_request":
      return approvalToMarkdownTable(approvalInputFromData(d), {
        title: "🔒 需要审批",
      });
    case "question_asked":
      return String(d["question"] ?? "");
    case "turn_completed":
      return `状态: ${String(d["status"] ?? "completed")}`;
    case "turn_stopped":
      return "已达最大迭代次数，可继续完成剩下的任务";
    case "error":
      return String(d["error"] ?? "未知错误");
    default:
      return "";
  }
}
