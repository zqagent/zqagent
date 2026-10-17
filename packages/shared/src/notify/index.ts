/**
 * 通知模块装配入口
 *
 * 创建 NotificationHub 并注册各通道实现。
 * 新增通道只需实现 Notifier 接口并在 createNotificationHub 里注册。
 */
import { NotificationHub } from "./NotificationHub.js";
import { BarkNotifier } from "./notifiers/BarkNotifier.js";
import { ServerChanNotifier } from "./notifiers/ServerChanNotifier.js";
import { WebhookNotifier } from "./notifiers/WebhookNotifier.js";
import { EmailNotifier } from "./notifiers/EmailNotifier.js";

export { NotificationHub } from "./NotificationHub.js";
export type { Notifier } from "./Notifier.js";
export { channelWants, notifyTitle, notifyBody } from "./Notifier.js";
export {
  BarkNotifier,
  ServerChanNotifier,
  WebhookNotifier,
  EmailNotifier,
};

/** 装配默认通知中枢（注册内置通道） */
export function createNotificationHub(): NotificationHub {
  const hub = new NotificationHub();
  hub.register(new BarkNotifier());
  hub.register(new ServerChanNotifier());
  hub.register(new WebhookNotifier());
  hub.register(new EmailNotifier());
  return hub;
}
