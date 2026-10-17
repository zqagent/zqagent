/**
 * 租户通知配置的加解密读写
 *
 * 敏感字段（渠道 token / sendkey / webhook url 等）随整个 notifications
 * 数组一起用 AES-256-GCM 加密后存到 TenantConfig.notificationsEnc，
 * 内存态用 notifications。无 SecretBox 时退化为明文存 notifications。
 */
import type { SecretBox } from "../../crypto/secrets.js";
import type {
  NotificationChannelConfig,
  TenantConfig,
} from "../types.js";

/** 读取租户通知配置（解密）。返回数组，可能为空。 */
export function decryptNotifications(
  tenant: TenantConfig,
  secretBox: SecretBox | null,
): NotificationChannelConfig[] {
  if (!secretBox) return tenant.notifications ?? [];
  if (tenant.notificationsEnc) {
    const plain = secretBox.decrypt(tenant.notificationsEnc);
    if (plain) {
      try {
        const arr = JSON.parse(plain);
        if (Array.isArray(arr)) return arr as NotificationChannelConfig[];
      } catch {
        // 解密成功但非数组 → 忽略，走明文回退
      }
    }
  }
  return tenant.notifications ?? [];
}

/** 写回租户通知配置（加密）。调用方随后需 saveTenant。 */
export function saveNotifications(
  tenant: TenantConfig,
  secretBox: SecretBox | null,
  notifications: NotificationChannelConfig[],
): void {
  if (secretBox) {
    tenant.notificationsEnc = secretBox.encrypt(JSON.stringify(notifications));
    tenant.notifications = undefined;
  } else {
    tenant.notifications = notifications;
    tenant.notificationsEnc = undefined;
  }
}
