/**
 * Bark 通知通道（iOS）
 *
 * Bark 是一个 iOS 推送 App，只需一个 HTTP 请求即可推送。
 * config: { key: "设备推送Key", server?: "https://api.day.app" }
 */
import type { Notifier } from "../Notifier.js";
import { notifyTitle, notifyBody } from "../Notifier.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
} from "../../types.js";

const TIMEOUT_MS = 10_000;

export class BarkNotifier implements Notifier {
  readonly type = "bark" as const;

  async send(config: NotificationChannelConfig, ev: NotifyEvent): Promise<void> {
    const key = config.config["key"];
    if (!key) return;
    const server = (config.config["server"] ?? "https://api.day.app").replace(/\/+$/, "");
    const url =
      `${server}/${encodeURIComponent(key)}/` +
      `${encodeURIComponent(notifyTitle(ev.kind))}/${encodeURIComponent(notifyBody(ev))}`;
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
