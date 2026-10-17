# @zqagent/core

zqagent 的引擎核心：`TurnEngine`（异步事件循环）、`ToolRegistry`、`PermissionEngine`、
`OpenAIProvider`，以及 CLI 与**多租户云端 Server**（含 MQTT 节点管理 v2 节点桥）。

依赖 `@zqagent/shared`（经 tsconfig `paths` 引用其源码，构建期打进 bundle）。

## 目录

```
src/
├── index.ts          # 库入口（re-export）
├── cli/              # CLI（index.ts 入口 / 连接向导 / 输入 / 会话元数据 …）
├── agents/           # Agent 注册表（运行时维护 agent）
├── mcp/              # MCP 客户端与管理（stdio / http）
├── engine/           # TurnEngine / events / compaction / hooks / renderer
├── permissions/      # 风险分类 + 模式门控 + 审批
├── providers/        # OpenAI 兼容 provider（流式 / chat）
├── prompts/          # 中文系统提示词
├── tools/            # 19 个内置工具（文件/shell/搜索/web/git/补丁/协作/子代理/媒体）
└── server/           # 多租户 API + 项目/节点 + MQTT 节点管理 v2 桥（FleetNodeBridge/FleetCommands）
bin/zqagent           # CLI 可执行入口
scripts/              # SEA 单文件构建 / 冒烟 / 探针 / busybox 下载
test/                 # Vitest（492 用例，覆盖引擎/server/hub/web 协议）
```

## 使用

```bash
# 库
import { TurnEngine, ToolRegistry, PermissionEngine, OpenAIProvider } from "@zqagent/core";
import { ... } from "@zqagent/core/server";   // 服务端 API
import { ... } from "@zqagent/core/tools/fs";  // 单个工具

# CLI（全局安装）
npm i -g @zqagent/core --registry=https://npm2.cd-zq.com/
zqagent
```

## 开发与构建（在仓库根 ts/ 或本目录）

```bash
pnpm run dev            # CLI（tsx packages/core/src/cli/index.ts）
pnpm run server         # 多租户 Server :8787
pnpm run build          # tsup → dist/（含 dts）
pnpm run test           # Vitest
pnpm run typecheck      # tsc --noEmit
pnpm run build:sea      # 单 CJS bundle（供 SEA）
pnpm run build:cli-bin  # SEA 单文件可执行 → release/cli/
pnpm run probes:sea     # 生成对照探针
pnpm run fetch:busybox  # 下载 BusyBox-w32（Windows）
```

## 相关文档

- 系统架构与构建：[../../docs/architecture.md](../../docs/architecture.md)
- CLI 使用/工具/Agent/MCP：[../../packages/site/docs/guide/](../../packages/site/docs/guide/)
- Server REST API：[../../docs/server-api.md](../../docs/server-api.md)
- 线协议规范（帧/信封/消息/签名）：[../../docs/wire-protocol.md](../../docs/wire-protocol.md)
- CLI SEA 故障排查：[../../docs/cli-sea-troubleshooting.md](../../docs/cli-sea-troubleshooting.md)
