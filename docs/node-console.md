# 节点控制台（桌面 / 浏览器 / 手机）

一套控制台，三种承载：桌面壳内嵌（本地引擎 + 云端节点）、Hub 用户中心（浏览器）、
手机浏览器（响应式 + PWA）。

## 1. 结构（共性）

```
@zqagent/console-core   传输与逻辑（无 UI）
  transport/(http|mqtt|hub) · useEventStream · 节点注册表 · 浏览器节点管理协议
@zqagent/console-ui     节点控制台 UI（响应式 mobile-first）
  NodeConsole · SessionPanel · ChatPanel · Approvals · Questions · Markdown · NodeOverview
        └── packages/portal（统一控制台：桌面壳内嵌 + 浏览器；本地 http + 云端 mqtt/hub）
```

- `NodeClient` 是唯一接口；UI 不感知传输。portal 经 Hub 指令代理，
  浏览器**永不接触** fleetSecret / 节点 broker 口令。
- 主题：console-ui 用 `.cq-` 命名空间与 CSS 变量映射宿主主题（portal 明暗跟随系统）。

## 2. 节点接入机器（三种载体）

| 载体 | 命令/入口 | 说明 |
| --- | --- | --- |
| 已运行节点（热接入） | `zqagent link --hub <url> --code <码>` | 调本机 `/api/v1/fleet/enroll`，免重启 |
| 启动即接入 | `HUB_URL=<url> HUB_ENROLL_CODE=<码> pnpm run server` | 启动异步接入 |
| 桌面应用 | 顶栏「接入云端」→ 填 Hub 地址 + 注册码 | 桌面壳自带 sidecar；亦可一键解绑 |

凭据落盘 `{DATA_DIR}/fleet.json`（0600，优先于环境变量）；注册码在
Hub 用户中心 → 节点管理详情「生成接入码」（一次性、15 分钟）。

## 3. Hub 端节点控制台（portal）

路由：`#/fleets/:fleetId/nodes/:nodeId`

- **概览**：在线态、最近在线、平台/IP、项目会话汇总（totals）、
  运行统计（stats：回合/工具调用/Tokens 进-出/错误）。
- **控制台**：项目 → 会话 → 对话（与桌面同组件）：
  - 实时事件流（SSE，断线按 `since` 环形回放补齐；历史用 `get_events` 指令回填）；
  - 发消息 / steer / 中断 / resume；
  - 审批（once/always_tool/always_command/deny）与提问（选项/自由输入）。
- **提醒**：节点上下线/接入/支付 → 站内信 + MQTT 即时 toast（账号通知 topic）；
  节点任务 notify（审批/提问/回合/错误）→ 即时 toast，点击直达节点页。

### 移动端 + PWA

- ≤720px 单栏：页签（概览/控制台）、会话列表 ↔ 对话切换、返回键；
  表格卡片化、safe-area 适配、44px 触控。
- `manifest.webmanifest` + Service Worker（仅预缓存应用壳；API/SSE 不缓存）；
  可「添加到主屏幕」独立窗口运行。

## 4. 实时链路

| 通道 | 内容 | 客户端 |
| --- | --- | --- |
| MQTT `zqagent/user/{uid}/notify` | 站内消息（Hub 写库后即发） | portal RealtimeProvider（账号凭据 `portal:{uid}`） |
| MQTT `.../node/+/status` | 在线态（retained + LWT） | portal（在线指示灯/列表刷新） |
| MQTT `.../node/+/notify` | 任务通知（审批/提问/回合/错误） | portal → toast |
| MQTT `.../node/+/info` | 项目/统计快照（retained） | 节点详情页按需订阅（动态 topic） |
| SSE `/api/hub/fleets/:id/nodes/:nodeId/events` | 会话事件流 | console-core `streamEvents`（Hub 传输） |

- Hub 为每节点保留最近事件环形缓冲（`HUB_NODE_EVENT_BUFFER`，默认 500），
  SSE 支持 `?since=` / `Last-Event-ID` 回放 + 15s 心跳；手机切后台回来不丢最近事件。
- 历史回填：`get_events {since}` 节点管理指令读节点 `events.jsonl`，长会话打开即有全文。

## 5. 安全

- portal broker 账号 ACL：仅本人节点管理 `node/+/status|notify|info` 与本人通知 topic；
  越权订阅被 EMQX 拒绝（`NO_MATCH=deny`）。
- Hub 指令代理：归属校验 + 付费/许可闸门 + 每用户 240 次/分限流。
- 权限确认（审批）与提问均在浏览器端完成，决策经签名指令下发节点。

## 6. 验证

```bash
# 端到端（真实 broker + 模拟节点 + 无头 Chrome，桌面/移动视口）
node tmp-e2e-console.ts   # 输出 READY {fleetId,nodeId}（验证脚本临时文件）
node cdp-portal-console.mjs
# 单测：节点统计计数 / Hub totals·since 回放
pnpm --filter @zqagent/core test
```
