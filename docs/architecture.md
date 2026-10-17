# 系统架构与构建

本文档是 zqagent 的**总览**：仓库（monorepo）结构、各子项目职责、运行时拓扑、
数据模型、构建与打包发布。各子系统的深入说明见文末「文档索引」。

> **术语说明**：面向用户的「节点管理」在代码与协议中仍沿用内部标识 `fleet`
> （如 `Fleet` 类型、路由 `#/fleets`、`FLEET_*` 环境变量、`fleet.json`）。
> 显示名与内部标识的解耦仅发生在 UI 文案层。

## 1. 分层概览

```
┌─────────────────────────────────────────────────────────────────┐
│  客户端 / 控制台 / 官网                                            │
│  ├─ CLI（@zqagent/core，终端交互）                                │
│  ├─ 统一控制台（zqagent-portal：桌面壳内嵌 + 浏览器，本地/云端节点）  │
│  └─ 官网（zqagent-site：VitePress 宣传/文档/下载）                 │
└───────────────┬───────────────────────────┬─────────────────────┘
        REST+SSE │                    HTTPS（只读状态/签凭据）
                ▼                           ▼
   ┌────────────────────────┐   ┌──────────────────────────────┐
   │ Agent Server（本地/内网） │   │ Hub 控制面（公网，付费 SaaS）  │
   │ = @zqagent/core/server  │   │ = @zqagent/hub               │
   │ 多租户(项目) + 会话      │   │ 账号/分组/设备/计费/许可         │
   │ 审批/提问挂起-恢复       │   │ 读取节点聚合状态、签发终端凭据    │
   └───────────┬────────────┘   └──────────────┬───────────────┘
               │ 出站 wss                      │ GET /state（内网）
               │                               │
               ▼                               ▼
        ┌──────────── Rust 网关（二进制 WSS）──────────────┐
               ▲                               ▲
        ┌──────┴───────┐              ┌────────┴────────┐
        │ 终端节点 A    │   …          │ 终端节点 N      │  每台 = 一个 core server
        └──────────────┘              └─────────────────┘
```

两种交互形态（控制台侧由 `NodeClient` 抽象统一）：
- **本地 HTTP**：控制台 → 本地 server（`:8787`），REST + SSE。桌面/开发默认。
- **网关直连**：控制台向 Hub 换取只授权该节点的短时效令牌，随后直连网关（二进制 WSS）；
  指令、事件、通知都在这一条连接上。远端节点一律走这条路径。

## 2. 仓库结构（pnpm workspace，根 = 聚合器）

| 包 | 名称 | 职责 | 主要产物 |
| --- | --- | --- | --- |
| `packages/core` | `@zqagent/core` | 引擎（TurnEngine/ToolRegistry/PermissionEngine/Provider）、CLI、多租户 Server（含节点→网关的 WSS 桥） | npm 包 `dist/`、`bin/zqagent`、SEA 单文件 |
| `packages/shared` | `@zqagent/shared` | 节点管理协议 v2、凭据加密（SecretBox）、审批视图、通知渠道 | `dist/`（ESM+CJS） |
| `packages/hub` | `@zqagent/hub` | 公网控制面：账号/分组/设备纳管/通知聚合/SSE/计费/许可/限流/存储（节点流量与指令都不经 Hub） | `dist/index.js`（ESM）、镜像 |
| `packages/console-core` | `@zqagent/console-core` | 控制台共享核心：NodeClient 接口 + http/gateway 传输、事件流 hook、账号级实时通道、节点注册表 | 源码包（web/portal 源码级引用） |
| `packages/console-ui` | `@zqagent/console-ui` | 共享节点控制台 UI（响应式）：会话/对话/审批/提问/概览/事件日志，`.cq-` 命名空间 + 宿主主题变量映射 | 源码包（web/portal 源码级引用） |
| `packages/portal` | `zqagent-portal` | **统一控制台**（同一份代码，两种承载）：桌面壳内嵌（本地引擎独立态 + 登录后云端态）+ 浏览器用户中心（账号/套餐/节点管理/节点/消息、远程节点控制台）；响应式 + PWA | `dist/`（Tauri 内嵌 / Hub 域托管） |
| `packages/desktop` | `zqagent-desktop` | Tauri 2 外壳 + 内嵌 Node sidecar（复用 web 前端） | DMG/NSIS/MSI/deb/AppImage/rpm |
| `packages/site` | `zqagent-site` | VitePress 官网与文档（中英双语，AI 翻译） | `docs/.vitepress/dist` |
| `scripts/`（根） | — | 仓库级脚本：sidecar 刷新、镜像构建、许可签发、联调 mock | — |

依赖方向：`shared ← core`、`shared ← hub`；**hub 不依赖 core**（独立/可闭源）。
core/hub 通过各自 `tsconfig` 的 `paths` 直接引用 `packages/shared` 源码（构建期打进 bundle）。

## 3. 运行时数据模型

- **Server / 项目**：租户 `TenantConfig`（= 一个「项目」）→ `workspaceRoot` + 会话 `SessionRecord`
  （物化状态 + 审批/提问挂起-恢复）。`{DATA_DIR}/tenants/{id}/…`。
- **节点**：`nodeId` + `fleetToken`（命名空间标识）/`fleetSecret`（签名密钥）。
  运行时经 WSS 上报 `status`/`info`/`event`/`notify`，网关持有权威状态并在连接建立时推快照。
- **Hub**：`User` → `Fleet` → `Node`；`Subscription`/`Order`（计费）、`Enrollment`（注册码）、
  `License`（自托管授权）。默认 JSON 存储，`DATABASE_URL` 时用 Postgres。

## 4. 构建与开发

```bash
pnpm install                 # 仓库根 ts/：安装全部 workspace 依赖
pnpm run typecheck           # shared/core/hub 类型检查
pnpm test                    # @zqagent/core 的 Vitest（492 用例）
pnpm run build               # 构建 @zqagent/core → packages/core/dist
pnpm run hub:build           # 构建 @zqagent/hub
pnpm run portal:build         # 构建统一控制台（浏览器/PWA）→ packages/portal/dist
pnpm run portal:build:desktop # 构建桌面壳内嵌版（不注册 SW）→ packages/portal/dist
pnpm run site:build          # 构建官网/文档
```

运行：
```bash
pnpm run dev                 # CLI（tsx）
pnpm run server              # 本地 Server :8787（读 ts/.env，数据在 ts/data）
pnpm --filter zqagent-portal dev   # 统一控制台 :8080
GATEWAY_STATE_URL=http://127.0.0.1:8790 pnpm run hub    # 控制面 :8788
```

> 依赖管理全量 pnpm（根仅 `pnpm-lock.yaml`）。`packages/core/package.json` 另有
> npm `package-lock.json`，仅供 desktop sidecar 打包时 `npm ci` 使用。

## 5. 打包与发布

| 通道 | 命令 | 产物 | CI |
| --- | --- | --- | --- |
| CLI 单文件（免装 Node） | `pnpm run build:cli-bin` | `packages/core/release/cli/zqagent-<plat>-<arch>` | `release-cli.yml` |
| Desktop 安装包 | `packages/desktop/scripts/build_*.{sh,ps1}` | `packages/desktop/dist/*` | `release-desktop.yml` |
| Server 镜像 | `bash scripts/build_server_image.sh` | server 多架构镜像（`Dockerfile`） | `release-server.yml` |
| Hub 镜像 | `docker build -f Dockerfile.hub` | hub 多架构镜像（`Dockerfile.hub`） | `release-hub.yml` |
| npm 发布 | `bash publish_npm.sh` / `publish_zq2.sh` | `@zqagent/core` | 手动 |

- CLI SEA：`build:sea`（tsup 打成单 CJS）→ `--experimental-sea-config` 生成 blob → postject 注入 Node 基座。
  细节与故障排查见 [cli-sea-troubleshooting.md](cli-sea-troubleshooting.md)。
- Server/Hub 镜像在各自 Dockerfile 内用 pnpm workspace 构建；desktop sidecar 用 `packages/core` 的
  npm 锁 `npm ci --omit=dev`（离线依赖 openai + dotenv）。

## 6. 文档索引

| 主题 | 文档 |
| --- | --- |
| 本总览（架构/构建） | docs/architecture.md |
| 共享库（协议/加密/审批/通知） | [shared.md](shared.md) |
| 引擎/CLI 使用 | [packages/site/docs/guide/](../packages/site/docs/guide/) |
| 上下文压缩 | [context-compaction.md](context-compaction.md) |
| Windows 工具兼容 | [windows-tool-compat.md](windows-tool-compat.md) |
| Server REST API | [server-api.md](server-api.md) |
| 部署与配置 | [deploy-guide.md](deploy-guide.md) |
| Web 控制台 | [web-console.md](web-console.md) |
| 线协议规范 v1（帧 · 信封 · 消息 · 签名） | [wire-protocol.md](wire-protocol.md) |
| Hub 控制面（账号/计费/许可） | [hub.md](hub.md) |
| Rust 网关（节点与终端统一二进制 WSS） | [rust-gateway-plan.md](rust-gateway-plan.md) |
| QQ 机器人 + 邮件 | [qq-bot.md](qq-bot.md) |
| CLI SEA 故障排查 | [cli-sea-troubleshooting.md](cli-sea-troubleshooting.md) |
