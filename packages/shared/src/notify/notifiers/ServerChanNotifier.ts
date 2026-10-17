/**
 * Server 酱通知通道（微信服务号推送，国内常用）
 *
 * config: { sendkey: "SCT 开头的 SendKey" }
 */
import type { Notifier } from "../Notifier.js";
import { notifyTitle, notifyBody } from "../Notifier.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
} from "../../types.js";

const TIMEOUT_MS = 10_000;

export class ServerChanNotifier implements Notifier {
  readonly type = "serverchan" as const;

  async send(config: NotificationChannelConfig, ev: NotifyEvent): Promise<void> {
    const sendkey = config.config["sendkey"];
    if (!sendkey) return;
    const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendkey)}.send`;
    const body = new URLSearchParams({
      title: notifyTitle(ev.kind),
      desp: notifyBody(ev),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
