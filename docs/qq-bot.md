# QQ 机器人接入 + 任务完成邮件通知

本文档介绍如何用 **QQ 官方机器人** 向 zqagent Agent 发起任务，并在任务完成时
通过 **邮件（SMTP）** 通知你。支持单聊、群聊（@机器人）、频道，多租户映射，
以及审批 / 提问 / 中断等完整交互闭环。

## 1. 架构

```
QQ 用户（单聊 / 群聊@ / 频道）
  │ 腾讯事件推送（WebSocket 网关）
  ▼
zqagent server
  ├─ OfficialBotClient    # access_token、WS 网关、心跳/Resume、发消息
  ├─ QqAdapter            # 绑定映射、命令路由、会话闭环、通知回发
  └─ NotificationHub
       └─ EmailNotifier   # SMTP → 你的邮箱（任务完成）
```

关键点：官方机器人走 **WebSocket 出站长连接**，**无需公网入站**，自建/内网服务器
也能收消息（只需能访问外网）。

## 2. 平台准备（一次性）

1. 在 [QQ 开放平台](https://q.qq.com) 注册并创建机器人，获得 `AppID` + `AppSecret`。
2. 申请/确认 **`GROUP_AND_C2C_EVENT`（1<<25）** 等 intents 权限（单聊+群聊消息事件
   属特殊权限，需申请；否则网关鉴权会拒绝）。频道 @ 与频道私信分别对应
   `PUBLIC_GUILD_MESSAGES`（1<<30）与 `DIRECT_MESSAGE`（1<<12）。
3. 联调阶段使用**沙箱环境**（仅沙箱成员可测试），正式上线需审核。

## 3. 配置（环境变量 或 热配置）

方式一：`.env` 环境变量（启动时读入）

```bash
# .env
QQ_BOT_APP_ID=你的AppID
QQ_BOT_APP_SECRET=你的AppSecret
QQ_BOT_SANDBOX=1          # 沙箱=1；正式环境=0 或留空
```

方式二：**热配置**（server 已启动时，无需重启，立即重连生效）

```bash
# 查看当前配置（脱敏）
curl -s -H "Authorization: Bearer <租户apiKey>" http://localhost:8787/api/v1/qq/config

# 配置 / 更新
curl -s -X POST -H "Authorization: Bearer <租户apiKey>" -H "Content-Type: application/json" \
  -d '{"appId":"你的AppID","appSecret":"你的AppSecret","sandbox":true}' \
  http://localhost:8787/api/v1/qq/config

# 删除配置（断开）
curl -s -X DELETE -H "Authorization: Bearer <租户apiKey>" http://localhost:8787/api/v1/qq/config
```

设置后日志出现 `QQ 机器人: 已启用`。热配置会持久化到 `{DATA_DIR}/qq/config.json`，
重启后仍生效（配置来源优先级：**环境变量 > config.json**）。

## 4. 多租户绑定（单租户免绑定）

QQ 会话（单聊用户/群/频道）与 zqagent 租户的对应关系：

**方式一：单租户免绑定（推荐个人使用）**

系统只有一个租户（如默认的 `demo`）时，**无需任何绑定操作**，直接发消息即自动绑定
到唯一租户并开始任务：

```
（直接发消息）
→ 任务已提交，执行中…
```

**方式二：配对码绑定（多租户）**

多个租户时，用配对码精确指定绑定目标。生成配对码（管理员，REST API）：

```bash
curl -X POST http://localhost:8787/api/v1/qq/pairing-code \
  -H "Authorization: Bearer <租户apiKey>"
# → { "data": { "code": "AB3CD5K7", "expiresIn": 300 } }
```

用户在 QQ 内绑定：

```
/bind AB3CD5K7
→ 绑定成功 ✅ 租户：demo。现在直接发消息即可开始任务。
```

- 配对码 5 分钟有效、单次使用（避免 apiKey 明文进入聊天记录）。
- 每个 QQ 会话对应一个租户 + 一个 zqagent session；首次发任务时自动创建会话。
- 绑定映射落盘于 `{DATA_DIR}/qq/bindings.json`。

## 5. 命令列表

| 命令 | 行为 |
| --- | --- |
| 直接发消息 | 提交任务（等待提问时作为答案；任务运行中则作为补充信息） |
| `/bind <配对码>` | 绑定当前 QQ 会话到租户 |
| `/unbind` | 解除绑定 |
| `/new` | 新建会话并切换绑定 |
| `/status` | 查看当前会话状态 |
| `/list` | 会话列表 |
| `/stop` | 中断当前任务 |
| `/approve <once\|always_tool\|always_command\|deny>` | 审批（也可直接发「同意/全部同意/拒绝」） |
| `/answer <内容>` | 回答提问 |
| `/help` | 帮助 |

> 任务运行中直接发消息，会作为**补充信息（steering）**注入当前任务（而非报错或另起新任务），
> agent 在下一个迭代间隙看到并纳入上下文继续执行；需要另起任务时请先 `/stop` 或等任务结束。

## 6. 通知回发与邮件

任务执行中的关键事件会**回发到对应 QQ 会话**（审批请求、提问、完成、错误）。
审批请求会附上**工具名 + 工具参数 + 原因**，可直接在 QQ 里回复决策：

```
需要审批：write_file
参数：
{
  "path": "/tmp/a.txt",
  "content": "hello"
}
原因：需要写文件
回复：同意(仅本次) / 全部同意(总是允许) / 拒绝
```

- `同意` / `允许` / `y` → 仅本次允许（once）
- `全部同意` / `总是允许` → 本会话内总是允许该工具（always_tool，以后同类审批自动通过）
- `拒绝` / `n` → 拒绝（deny）
- 或显式 `/approve once|always_tool|always_command|deny`

同时，若配置了邮件通道，**任务完成会发邮件**到你的邮箱。

> ⚠️ QQ 官方机器人对**主动消息**有严格配额（且用户可关闭主动推送）；任务完成
> 通常超出「被动回复 5 分钟窗口」，因此**完成通知以邮件为可靠通道**，QQ 内回发
> 尽力而为（失败仅记日志）。

### 6.1 配置邮件通知

```bash
curl -X POST http://localhost:8787/api/v1/notifications \
  -H "Authorization: Bearer <租户apiKey>" -H "Content-Type: application/json" \
  -d '{
    "type": "email",
    "enabled": true,
    "config": {
      "host": "smtp.qq.com",
      "port": "465",
      "secure": "true",
      "user": "you@qq.com",
      "pass": "<QQ邮箱授权码>",
      "from": "you@qq.com",
      "to": "you@qq.com"
    },
    "events": { "approval": false, "question": false, "completed": true, "error": true }
  }'
```

- QQ 邮箱：`smtp.qq.com:465`（SSL）+ **授权码**（不是登录密码）。
- 163：`smtp.163.com:465`；Gmail：`smtp.gmail.com:587`（`secure:"false"`）。
- `pass` 等敏感字段会用 `SECRET_KEY`（或 `DATA_DIR/secret.key`）AES 加密落盘。
- `events` 控制触发时机；上例只在「完成/错误」时发邮件。
- **短任务不打扰**：`minDurationSeconds`（默认 `60`）——任务成功完成且执行时长
  未超过该阈值时不发邮件，避免琐碎短任务刷屏。想所有完成都提醒可设 `"minDurationSeconds":"0"`。

## 7. 文件结构

```
packages/core/src/server/qq/
  types.ts            # QqTarget / QqMessage / QqClient 抽象
  OfficialBotClient.ts# 官方机器人低层客户端（token/WS/发送）
  QqManager.ts        # 配置持久化 + 热更新（重建 client 重连）
  QqAdapter.ts        # 命令路由 / 会话闭环 / 通知回发
  commands.ts         # 命令解析纯函数
  bindings.ts         # 多租户绑定映射存储
  pairingCodes.ts     # 配对码（内存、单次、短时）
packages/core/src/server/notify/notifiers/EmailNotifier.ts  # SMTP 邮件通道
packages/core/src/server/routes.ts  # POST /api/v1/qq/pairing-code、GET/POST/DELETE /api/v1/qq/config
packages/core/src/server/index.ts   # 装配（env/文件配置 + 通知回发 + 优雅退出）
```

## 8. 官方接口对照（实现时以官方文档为准）

| 能力 | 接口 |
| --- | --- |
| 获取 access_token | `POST {base}/app/getAppAccessToken` `{appId, clientSecret}` |
| 鉴权头 | `Authorization: QQBot {token}` |
| 网关地址 | `GET {base}/gateway` → `{ url }` |
| 发送（单聊） | `POST /v2/users/{openid}/messages` `{content, msg_type:0, msg_id?}` |
| 发送（群聊） | `POST /v2/groups/{group_openid}/messages` |
| 发送（频道@） | `POST /channels/{channel_id}/messages` |
| 发送（频道私信） | `POST /dms/{guild_id}/messages` |

- API base：正式 `https://api.bot.qq.com`，沙箱 `https://sandbox.api.bot.qq.com`。
- 事件类型：`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` /
  `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE`。
- WS 网关 OpCode：`10 Hello` → `2 Identify` → `0 Dispatch` → `1 心跳` → `11 ACK`；
  断线用 `6 Resume`（带 `session_id` + `seq` 补发遗漏事件）。

## 9. 风险与注意

1. **intents 权限**：单聊/群聊事件需平台申请，沙箱阶段即可验证。
2. **主动消息配额**：完成通知可能发不出 → 邮件兜底；被动回复 5 分钟窗口内可靠。
3. **绑定安全**：配对码短时单次，不在聊天里传 apiKey。
4. **频道**：公域 @ 与私信是两套事件/发送接口，代码已按 `guild_id`/`channel_id` 区分。
5. 发送接口字段细节可能随平台更新，接入遇错请对照官方文档调整 `OfficialBotClient.ts`。
