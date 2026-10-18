# @zqagent/shared — 共享库

**简体中文** · [English](en/shared.md)

`packages/shared` 是节点/CLI 与控制面**共用**的基础模块，避免二者互相依赖。
使用方各自通过 `tsconfig` 的 `paths` 直接引用其源码，并在构建期打进 bundle。

> 本仓库只包含 core 一侧。云端控制面（Hub）为闭源实现，同样引用本包，
> 因此下表的「使用方」列中出现的 hub 不在本仓库内。

## 子路径导出

| 子路径 | 内容 | 使用方 |
| --- | --- | --- |
| `@zqagent/shared/fleet` | 节点指令协议：信封签名/验签、nonce/时间戳校验、`FleetCmdType`、`FleetCredential` 等（topic 构建已随 broker 退场） | core（节点桥、指令分发/测试） |
| `@zqagent/shared/secrets` | 凭据加密 `SecretBox`（AES-256-GCM）、`encryptWithKey`/`decryptWithKey`/`loadOrCreateMasterKey` | core（通知/QQ）、hub（节点管理密钥/渠道凭据） |
| `@zqagent/shared/approval-view` | 审批视图：`approvalInputFromData` / `approvalToMarkdownTable` / `approvalToHtmlTable` / `approvalFields` | core（节点桥 / QQ / 通知）、shared/notify |
| `@zqagent/shared/notify` | 通知抽象与渠道：`Notifier` 接口、`channelWants`/`notifyTitle`/`notifyBody`、`NotificationHub`、`createNotificationHub` + Bark/Server酱/Webhook/Email 实现 | core（server）、hub（推送渠道） |
| `@zqagent/shared`（根） | 以上全部再导出 | 便捷引用 |

`fleet` 依赖的通用工具（`generateToken`/`isFreshTimestamp`/`NonceTracker`/时钟窗口）在
内部 `common.ts` 中，自包含、不依赖 core。

## 通知事件类型

`NotifyKind`（`approval_request` / `question_asked` / `turn_completed` / `turn_stopped` / `error`）、
`NotifyEvent`、`NotificationChannelType`、`NotificationChannelConfig` 定义在
`packages/shared/src/types.ts`；core 的 `packages/core/src/server/types.ts` 再导出它们以保持兼容。

## core 的兼容再导出

为不改动 core 内既有 import 路径，core 保留同名薄文件再导出 shared：
- `packages/core/src/crypto/secrets.ts` → `…/secrets`
- `packages/core/src/engine/approvalView.ts` → `…/approval-view`
- `packages/core/src/server/notify/{index,Notifier,NotificationHub}.ts` → `…/notify`

## 构建

```bash
pnpm --filter @zqagent/shared typecheck   # tsc --noEmit
pnpm --filter @zqagent/shared build       # tsup → 多入口 ESM+CJS+dts
pnpm --filter @zqagent/shared dev         # tsup --watch
```

产物 `packages/shared/dist/`（`index` / `fleet` / `secrets` / `approval-view` / `notify/index`）。
第三方运行期依赖（nodemailer）标为 external，由使用方 node_modules 提供。
