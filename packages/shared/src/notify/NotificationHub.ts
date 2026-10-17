/**
 * NotificationHub — 通知中枢
 *
 * 注册各通知通道（Notifier），把 SessionManager 产出的 NotifyEvent
 * 按租户配置分发到启用的通道。发送是「尽力而为」，异常降级不冒泡。
 */
import type {
  Notifier,
} from "./Notifier.js";
import { channelWants } from "./Notifier.js";
import type {
  NotificationChannelConfig,
  NotificationChannelType,
  NotifyEvent,
} from "../types.js";

export class NotificationHub {
  private readonly notifiers = new Map<NotificationChannelType, Notifier>();

  /** 注册一个通道实现（幂等，后注册覆盖） */
  register(notifier: Notifier): void {
    this.notifiers.set(notifier.type, notifier);
  }

  /** 已注册的通道类型 */
  registeredTypes(): NotificationChannelType[] {
    return [...this.notifiers.keys()];
  }

  /**
   * 分发通知到给定的启用通道。
   * 单个通道失败仅记录，不影响其他通道与核心逻辑。
   */
  async dispatch(channels: NotificationChannelConfig[], ev: NotifyEvent): Promise<void> {
    for (const ch of channels) {
      if (!ch.enabled) continue;
      if (!channelWants(ch, ev.kind)) continue;
      const notifier = this.notifiers.get(ch.type);
      if (!notifier) continue;
      try {
        await notifier.send(ch, ev);
      } catch (e) {
        console.log(
          `[notify] ${ch.type} 发送失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}
