# @zqagent/shared — Shared Library

`packages/shared` holds the base modules **shared by** the node/CLI and the control plane,
so the two do not depend on each other. Each consumer references its sources directly through
`tsconfig` `paths` and bundles them at build time.

> This repository contains the core side only. The cloud control plane (Hub) is closed source
> and also consumes this package, so the "Used by" column below mentions `hub`, which is not
> part of this repository.

## Subpath exports

| Subpath | Contents | Used by |
| --- | --- | --- |
| `@zqagent/shared/fleet` | Node command protocol: envelope signing/verification, nonce and timestamp validation, `FleetCmdType`, `FleetCredential` (topic construction was retired along with the broker) | core (node bridge, command dispatch/tests) |
| `@zqagent/shared/secrets` | Credential encryption `SecretBox` (AES-256-GCM), `encryptWithKey`/`decryptWithKey`/`loadOrCreateMasterKey` | core (notifications/QQ), hub (node management keys, channel credentials) |
| `@zqagent/shared/approval-view` | Approval views: `approvalInputFromData` / `approvalToMarkdownTable` / `approvalToHtmlTable` / `approvalFields` | core (node bridge / QQ / notifications), shared/notify |
| `@zqagent/shared/notify` | Notification abstraction and channels: `Notifier` interface, `channelWants`/`notifyTitle`/`notifyBody`, `NotificationHub`, `createNotificationHub`, plus Bark / ServerChan / Webhook / Email implementations | core (server), hub (push channels) |
| `@zqagent/shared` (root) | Re-exports all of the above | Convenience imports |

The generic helpers used by `fleet` (`generateToken` / `isFreshTimestamp` / `NonceTracker` /
clock window) live in the internal `common.ts`, which is self-contained and does not depend on core.

## Notification event types

`NotifyKind` (`approval_request` / `question_asked` / `turn_completed` / `turn_stopped` / `error`),
`NotifyEvent`, `NotificationChannelType`, and `NotificationChannelConfig` are defined in
`packages/shared/src/types.ts`; core's `packages/core/src/server/types.ts` re-exports them for
backward compatibility.

## Compatibility re-exports in core

To avoid changing existing import paths inside core, core keeps thin files that re-export shared:

- `packages/core/src/crypto/secrets.ts` → `…/secrets`
- `packages/core/src/engine/approvalView.ts` → `…/approval-view`
- `packages/core/src/server/notify/{index,Notifier,NotificationHub}.ts` → `…/notify`

## Build

```bash
pnpm --filter @zqagent/shared typecheck   # tsc --noEmit
pnpm --filter @zqagent/shared build       # tsup → multi-entry ESM+CJS+dts
pnpm --filter @zqagent/shared dev         # tsup --watch
```

Output goes to `packages/shared/dist/` (`index` / `fleet` / `secrets` / `approval-view` /
`notify/index`). Third-party runtime dependencies (nodemailer) are marked external and are
provided by the consumer's `node_modules`.
