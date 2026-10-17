/**
 * 通用 Webhook 通知通道
 *
 * 向用户配置的 URL POST JSON，作为自定义兜底（可对接任意中转/网关）。
 * config: { url: "https://..." }
 * payload: { title, body, kind, sessionId, ts, data }
 */
import type { Notifier } from "../Notifier.js";
import { notifyTitle, notifyBody } from "../Notifier.js";
import type {
  NotificationChannelConfig,
  NotifyEvent,
} from "../../types.js";

const TIMEOUT_MS = 10_000;

export class WebhookNotifier implements Notifier {
  readonly type = "webhook" as const;

  async send(config: NotificationChannelConfig, ev: NotifyEvent): Promise<void> {
    const url = config.config["url"];
    if (!url) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: notifyTitle(ev.kind),
        body: notifyBody(ev),
        kind: ev.kind,
        sessionId: ev.sessionId,
        ts: ev.ts,
        data: ev.data,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
