# 系统架构

**简体中文** · [English](en/architecture.md)

本仓库是 ZQAgent 的**开源部分**：Agent 引擎、内置工具、权限系统、CLI 与节点服务。
本文说明这些模块如何组织、一次任务如何流动，以及如何构建与打包。

> 云端账号、订阅与计费（Hub）为闭源实现，不在本仓库。它们通过
> `docs/wire-protocol.md` 描述的协议与本仓库的节点服务通信，因此不影响本地完整使用。

## 1. 分层概览

```
┌──────────────────────────────────────────────────────────┐
│  入口                                                     │
│  ├─ CLI（packages/core/src/cli）      终端交互            │
│  ├─ 库（packages/core/src/index.ts）  供其它程序嵌入      │
│  └─ Server（packages/core/src/server）HTTP/SSE，可多租户  │
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│  TurnEngine（engine/）                                    │
│  思考 → 工具调用 → 观察 → 下一轮；steering / 压缩 / 重试   │
└───────┬───────────────────────────────┬──────────────────┘
        ▼                               ▼
┌──────────────────┐          ┌──────────────────────┐
│ PermissionEngine │          │ Provider             │
│ 风险分级/模式门控 │          │ OpenAI 兼容流式调用   │
└───────┬──────────┘          └──────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────┐
│  ToolRegistry：文件 / Shell / 网络 / Git / 补丁 / 协作 …  │
└──────────────────────────────────────────────────────────┘

共享层：@zqagent/shared（协议、加密、审批视图、通知）
协议契约：proto/fleet.proto（与 docs/wire-protocol.md 对应）
```

## 2. 目录职责

| 目录 | 职责 |
| --- | --- |
| `packages/core/src/engine` | `TurnEngine` 事件循环、事件类型、上下文压缩、会话持久化 |
| `packages/core/src/tools` | 内置工具；每个工具声明风险等级与参数 schema |
| `packages/core/src/permissions` | 风险分类、运行模式门控、审批决策 |
| `packages/core/src/providers` | OpenAI 兼容 provider（流式 / 非流式），含重试与诊断 |
| `packages/core/src/mcp` | MCP 客户端（stdio / HTTP），工具动态注入 |
| `packages/core/src/agents` | Agent 注册表（名称 + Prompt + 可选模型） |
| `packages/core/src/cli` | 交互式 CLI、连接向导、会话管理 |
| `packages/core/src/server` | 多租户 HTTP 服务、项目/会话/用量、节点接入 |
| `packages/shared` | 跨模块共享：线协议、加密、审批视图、通知渠道 |
| `proto/` | 线协议 schema 与交叉验证向量 |

依赖方向是单向的：`shared ← core`。core 通过 `tsconfig` 的 `paths` 直接引用
`packages/shared` 源码，构建时打进同一个 bundle，所以发布出去的包不依赖私有包。

## 3. 一次任务的执行流程

1. CLI 收集用户输入，连同历史消息交给 `TurnEngine`。
2. 引擎向 provider 发起流式请求，模型返回文本或工具调用。
3. 每个工具调用先经过 `PermissionEngine`：
   - `discuss` / `plan`：只读工具放行，其余拒绝；
   - `interactive`：有副作用的操作弹出审批，等待用户选择；
   - `auto`：全部放行。
4. 工具执行结果作为观察回填，进入下一轮，直到模型不再调用工具或达到轮次上限。
5. 会话状态随时可持久化，恢复后从断点继续。

## 4. 运行时数据

- **会话**：`SessionRecord` 保存消息、物化状态、待处理的审批/提问。
- **项目**：`workspaceRoot` 决定工具能访问的边界。
- **节点**：`nodeId` + 签名凭据；经 WSS 上报 `status` / `info` / `event` / `notify`。
- **配置**：模型连接加密存放在 `~/.config/zqagent/`。

## 5. 构建与开发

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm build            # tsup → packages/core/dist
pnpm dev              # 源码方式启动 CLI
```

运行服务：

```bash
pnpm --filter @zqagent/core run server   # 本地 Server :8787
```

## 6. 打包与发布

| 产物 | 命令 | 说明 |
| --- | --- | --- |
| npm 包 | `pnpm build` | `@zqagent/core`，含 d.ts |
| CLI 单文件 | `pnpm --filter @zqagent/core run build:cli-bin` | Node SEA，免装 Node 运行 |
| 服务镜像 | `bash scripts/build_server_image.sh` | 多架构镜像 |

CLI 单文件的打包链路（tsup → SEA blob → postject 注入基座）与常见故障见
[cli-sea-troubleshooting.md](cli-sea-troubleshooting.md)。

## 7. 文档索引

| 主题 | 文档 |
| --- | --- |
| 本总览 | architecture.md |
| 共享库（协议 / 加密 / 审批 / 通知） | [shared.md](shared.md) |
| 上下文压缩 | [context-compaction.md](context-compaction.md) |
| 线协议 v1（帧 · 信封 · 消息 · 签名） | [wire-protocol.md](wire-protocol.md) |
| 节点服务 REST API | [server-api.md](server-api.md) |
| QQ 机器人 + 邮件通知 | [qq-bot.md](qq-bot.md) |
| Windows 工具兼容 | [windows-tool-compat.md](windows-tool-compat.md) |
| CLI 单文件打包与排错 | [cli-sea-troubleshooting.md](cli-sea-troubleshooting.md) |
| LLM 连接错误排查 | [llm-connection-troubleshooting.md](llm-connection-troubleshooting.md) |

英文版：[docs/en/architecture.md](en/architecture.md) ·
[docs/en/wire-protocol.md](en/wire-protocol.md) ·
[docs/en/server-api.md](en/server-api.md) ·
[docs/en/shared.md](en/shared.md) ·
[docs/en/context-compaction.md](en/context-compaction.md) ·
[docs/en/llm-connection-troubleshooting.md](en/llm-connection-troubleshooting.md)
