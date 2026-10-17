# @zqagent/shared

core 与 hub 共用的基础模块（不依赖任何业务包）。core/hub 通过各自 `tsconfig` 的 `paths`
直接引用本包源码，构建期打进各自 bundle。

| 子路径 | 内容 |
| --- | --- |
| `@zqagent/shared/fleet` | MQTT 节点管理协议 v2（topic / 签名 / nonce / 时间戳） |
| `@zqagent/shared/secrets` | 凭据加密 `SecretBox`（AES-256-GCM） |
| `@zqagent/shared/approval-view` | 审批视图（表格 HTML/Markdown） |
| `@zqagent/shared/notify` | 通知抽象与渠道（Bark / Server酱 / Webhook / Email） |
| 根 | 以上全部 |

## 命令

```bash
pnpm --filter @zqagent/shared typecheck
pnpm --filter @zqagent/shared build      # tsup → dist/（ESM+CJS+dts）
pnpm --filter @zqagent/shared dev        # watch
```

详见 [../../docs/shared.md](../../docs/shared.md)。
