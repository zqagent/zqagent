# 多租户云端 Agent Server — API 测试教程（curl）

本文档手把手演示如何用 `curl` 测试 `packages/core/src/server` 的多租户 Agent 服务，
重点覆盖**审批挂起 → 持久化 → 超时回收 → 恢复运行**这条关键链路。

- 一键脚本：`bash scripts/test-server.sh`（自动启动测试实例并跑完全部场景，见文末）
- 所有示例默认：`http://localhost:8787`、演示租户 `demo`（apiKey 首次启动随机生成并打印在日志中）

## 1. 启动 Server

```bash
# 无 LLM Key 也能启动（认证/会话/状态/隔离等都能测，只是对话 turn 会报错）
pnpm run server

# 带真实模型（推荐，可完整演示对话与审批链路）
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=... OPENAI_MODEL=gpt-4o-mini pnpm run server
```

启动日志会打印演示租户信息：

```
zqagent server 监听 http://localhost:8787
数据目录: ./data
审批挂起超时: 900s（超时后回收内存任务，可经 resume 恢复）
已创建演示租户: id=demo apiKey=zk_xxxx（本次随机生成） model=gpt-4o-mini
```

环境变量（均可在启动前设置）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `8787` |
| `DATA_DIR` | 状态/租户根目录 | `./.zqagent_data` |
| `APPROVAL_TIMEOUT_SECONDS` | 审批/提问挂起超时，超时回收内存任务 | `900` |
| `TENANT_ID` / `TENANT_API_KEY` / `MODEL` | 首次启动自动创建的演示租户 | `demo` / 随机生成 / `gpt-4o-mini` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 演示租户的模型配置 | — |

## 2. 认证

除 `/healthz` 外所有接口都需要 `Authorization: Bearer <租户API Key>`：

```bash
export BASE=http://localhost:8787
export TOKEN=zk_xxxx   # 取启动日志「已创建演示租户」那一行的 apiKey

# 健康检查（公开）
curl -s $BASE/healthz
# => {"status":"ok"}

# 无 Key → 401
curl -s -w "\nHTTP %{http_code}\n" $BASE/api/v1/sessions
# => {"error":{"code":"unauthorized","message":"无效的 API Key"}}   HTTP 401

# 错误 Key → 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer bad" $BASE/api/v1/sessions
# => 401

# 正确 Key → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
# => 200
```

## 3. 会话 CRUD 与状态

```bash
# 创建会话（可指定模型，缺省用租户默认）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini"}' $BASE/api/v1/sessions
# => {"data":{"sessionId":"e4df66d64d5b4d9bacea","tenantId":"demo","model":"gpt-4o-mini",
#             "messages":[],"compaction":null,"status":"idle","approvals":[],"questions":[],
#             "sessionAllowTools":[],"sessionAllowCommands":[],"savedAt":"..."}}

export SID=e4df66d64d5b4d9bacea   # 替换为上面返回的 sessionId

# 获取会话 / 列表 / 删除
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID
# => {"data":{"deleted":true}}

# 会话状态（含挂起中的审批/提问）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => {"data":{"sessionId":"...","status":"idle","model":"...","messageCount":0,
#             "compaction":null,"approvals":[],"questions":[],"savedAt":"..."}}
```

## 4. 提交任务（turn）与事件

> **运行中补充信息（steering）**：若会话正在执行任务，`POST /turns` 会自动转为
> 补充信息注入当前任务（返回 `{"data":{"accepted":true,"status":"steering"}}`），
> 而不是报 409 `busy`；该消息会在下一个迭代间隙作为一条 user 消息注入。
> 也可显式调用 `POST /api/v1/sessions/:id/steer`（见下）。
> 若存在未决的审批/提问，提交 turn 仍会返回 409 `has_pending_interaction`
> （此时应先走审批/提问接口）。

```bash
# 提交任务（立即返回 accepted，任务后台异步执行）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"你好，请介绍一下自己"}' $BASE/api/v1/sessions/$SID/turns
# => {"data":{"accepted":true,"status":"running"}}

# 运行中追加补充信息（显式 steer，与自动转补充等价）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"顺便把错误处理也补上"}' $BASE/api/v1/sessions/$SID/steer
# => {"data":{"accepted":true}}

# 轮询状态直到完成（since 游标增量拉取事件）
curl -s "$BASE/api/v1/sessions/$SID/events?since=0"
# => {"data":{"events":[{"seq":1,"ts":"...","type":"TURN_START","data":{...}},
#                        {"seq":2,"type":"ASSISTANT_DELTA","data":{"text":"..."}},
#                        {"seq":N,"type":"TURN_END","data":{"status":"completed","iterations":1,...}}],
#             "latestSeq":N}}

# SSE 实时订阅（打开一个终端持续观察）
curl -N -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" \
  $BASE/api/v1/sessions/$SID/events
# id: 1
# event: TURN_START
# data: {...}
```

## 5. 工具审批流程（核心场景）

交互模式下，模型请求**有副作用的工具**（写文件、执行命令等）时会触发审批挂起。
让模型做一件需要写文件的事：

```bash
# ① 提交会触发审批的任务
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"请在 /tmp/demo.txt 中写入 hello world"}' \
  $BASE/api/v1/sessions/$SID/turns
# => {"data":{"accepted":true,"status":"running"}}

# ② 轮询状态：任务挂起等待审批
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_approval"

# ③ 查看待审批列表（id 就是工具调用 ID）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/approvals
# => {"data":[{"id":"call_xxx","toolName":"write_file","arguments":{"path":"/tmp/demo.txt",...},
#              "reason":"...","status":"pending","createdAt":"..."}]}

# ④ 回答审批（decision: once | always_tool | always_command | deny；
#    always_command 仅对 run_shell 有效，其他工具会被 400 拒绝）
export AID=call_xxx
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"once"}' $BASE/api/v1/sessions/$SID/approvals/$AID
# => {"data":{"answered":true,"decision":"once"}}

# ⑤ 任务继续执行直至完成
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"completed"
```

## 6. 提问流程（ask_user / propose_plan）

模型调用 `ask_user` / `propose_plan` / `request_directory` 时同样挂起等待回答：

```bash
# 让模型问你一个问题
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"请调用 ask_user 工具问我是否继续"}' \
  $BASE/api/v1/sessions/$SID/turns

# 状态变为 waiting_question
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_question"

# 查看问题
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/questions
# => {"data":[{"id":"qid_xxx","kind":"ask","question":"是否继续？","options":[],"status":"pending",...}]}

# 回答问题
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"answer":"继续"}' $BASE/api/v1/sessions/$SID/questions/qid_xxx
# => {"data":{"answered":true}}
```

## 7. 长时间不审批：持久化 → 超时回收 → resume 恢复（重点）

设计目标：用户长时间不回答时，服务把**完整挂起点落盘**并**回收内存中的 run 实例**；
之后用户回答，任务从磁盘状态精确恢复继续执行（进程重启也一样）。

用短超时便于观察：

```bash
# 用 10 秒审批超时启动
APPROVAL_TIMEOUT_SECONDS=10 OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini pnpm run server
```

```bash
# ① 提交任务触发审批/提问（同上）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"请调用 ask_user 问我是否继续"}' $BASE/api/v1/sessions/$SID/turns

# ② 等状态到 waiting_question
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_question"

# ③ 不回答，等待超过 10s —— 内存 run 被回收，磁盘保持挂起点：
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => 仍是 "status":"waiting_question"（挂起点已持久化，approvals/questions 仍 pending）
# 磁盘上可看到：{DATA_DIR}/tenants/demo/sessions/$SID/session.json（完整消息历史 + 挂起记录）

# ④ 用户回答 → 服务检测到 run 已回收 → 经 engine.resume() 精确恢复执行
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"answer":"继续"}' $BASE/api/v1/sessions/$SID/questions/qid_xxx

# ⑤ 轮询到完成（恢复时重放未执行的工具调用，不会重复提问/重复审批）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"completed"
```

> 注：超时回收是内存行为，没有专门 API 查看"是否已回收"。可观察现象：
> 回收后（超过超时时间再回答），任务仍能正常恢复完成——这正是
> 「挂起点已持久化 + resume 恢复」在起作用。若服务在挂起期间进程崩溃/重启，
> 重启后回答同样经 resume 恢复，效果一致。

## 8. 多租户隔离

```bash
# 手工预置第二个租户（DATA_DIR/tenants/t2/config.json）
mkdir -p .zqagent_data/tenants/t2
cat > .zqagent_data/tenants/t2/config.json <<'EOF'
{"id":"t2","apiKey":"key2","model":"gpt-4o-mini","provider":{"apiKey":"sk-..."}}
EOF

# 租户 t2 的 Key 访问租户 demo 的会话 → 404（隔离生效）
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer key2" $BASE/api/v1/sessions/$SID
# => 404
```

## 9. 错误码速查

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `unauthorized` | 无 Key / Key 无效 |
| 404 | `not_found` | 会话不存在 / 未知路由 / 跨租户访问 / 审批或提问不存在 |
| 409 | `busy` | 会话正在运行中（POST /turns 不再触发，会自动转为补充信息） |
| 409 | `not_running` | 显式 steer 时会话未在运行中 |
| 409 | `has_pending_interaction` | 存在未决审批/提问，不能提交新 turn |
| 400 | `bad_request` | body 非法 JSON / input 为空 |
| 400 | `invalid_decision` | decision 不是 once/always_tool/always_command/deny，或对非 run_shell 工具提交 always_command |

## 10. 一键测试脚本

```bash
# 烟雾测试（无需 LLM Key）：认证/会话/状态/事件/隔离/错误路径，18 项
bash scripts/test-server.sh

# 完整链路（自动读取项目 .env 中的 OPENAI_API_KEY 等配置）：
# 真实对话 + ask_user 挂起 + 超时回收 + resume 恢复，24 项
bash scripts/test-server.sh

# 自定义端口 / 覆盖 .env 中的模型配置（显式传入优先于 .env）
PORT=8790 OPENAI_MODEL=deepseek-flash bash scripts/test-server.sh
```

脚本行为：自动用**临时数据目录**启动独立测试实例（审批超时 8s），
测试完毕自动回收进程与临时数据，不影响已有服务；端口被占用时提示换端口。
模型配置（`OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`）优先取
显式设置的环境变量，未设置时自动从项目根目录的 `.env` 读取。
完整链路演示依赖模型按指令调用 `ask_user`（提示词已尽量明确）；若模型未调用，
脚本会提示并跳过交互演示，其余 18 项烟雾测试不受影响。

## 11. 控制台（React 单页）

`packages/portal/` 是 Vite + React + TypeScript 统一控制台（`pnpm --filter zqagent-portal dev`），
按「节点 → 项目 → 会话」三层管理，覆盖全部 API：健康检查、项目管理、
会话 CRUD、任务执行（turn/resume/steer/interrupt）、工具审批、用户提问、
状态与事件（纯 SSE 实时流，断线自动重连）。

```bash
# 1. 启动 Server（需可用的模型配置，见第 1 节）
pnpm run server

# 2. 启动控制台
pnpm --filter zqagent-portal dev
# 浏览器访问 http://localhost:8080（dev 服务器把 /api 代理到 8787，也可直接填 8787 跨域用）

# 3a. 桌面态：外壳自动注入本地引擎（管理员密钥），开箱即用；
# 3b. 浏览器态：顶栏「+ 节点」填 BASE URL（http://localhost:8787）+ 密钥（管理员或项目 Key）
```

管理员密钥见启动日志「管理员密钥: ...」（或 `{DATA_DIR}/admin.json`）。用它可创建/切换/
删除项目；也可用单个项目 Key 连接（退化为单项目视图）。

## 12. 控制台 API：项目与节点（管理员）

管理员密钥（`Authorization: Bearer <adminKey>`）可跨项目操作。项目级接口需附
`X-Project-Id: <projectId>` 头指定目标项目；项目自己的 Key 则忽略该头。

```bash
export ADMIN=$(node -e "console.log(require('./.zqagent_data/admin.json').apiKey)")

# 列出 / 新建 / 删除项目（= 租户）
curl -s -H "Authorization: Bearer $ADMIN" $BASE/api/v1/projects
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"openworker","workspaceRoot":"/path/to/repo","model":"deepseek-v4-flash"}' \
  $BASE/api/v1/projects
# => {"data":{"id":"...","name":"openworker","apiKey":"zk_...", ...}}   # apiKey 仅创建时回传一次
curl -s -X DELETE -H "Authorization: Bearer $ADMIN" $BASE/api/v1/projects/<id>

# 节点元信息（管理员=全部项目；租户 Key=仅自身）
curl -s -H "Authorization: Bearer $ADMIN" $BASE/api/v1/node/info

# 管理员在指定项目上创建会话
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H "X-Project-Id: <id>" \
  -H "Content-Type: application/json" -d '{}' $BASE/api/v1/sessions

# 可用模型列表（用项目当前 baseURL + apiKey 拉取 OpenAI 兼容 /models）
curl -s -H "Authorization: Bearer $ADMIN" -H "X-Project-Id: <id>" $BASE/api/v1/models
# => {"data":{"models":["deepseek-flash","deepseek-reasoner"],"endpoint":"https://api.deepseek.com/models"}}

# 浏览节点/本地引擎的文件系统目录（创建项目时选择工作目录）
curl -s -H "Authorization: Bearer $ADMIN" "$BASE/api/v1/fs/list?path=/home/user"
# => {"data":{"path":"/home/user","parent":"/home","entries":[{"name":"repo","path":"/home/user/repo","type":"dir"}, ...]}}
```

## 13. 会话命名（自动 + 手动）

参考 CLI：**任务成功完成第 1/3/5 次时**，服务端后台用 LLM 生成会话标题并落盘；
用户一旦手动改名（`nameSource=user`），此后不再自动生成。

- 会话记录与状态新增字段：`name` / `nameSource`（`auto` | `user`）/ `taskCount`。
- 自动命名在后台进行，不阻塞 turn；完成时向该会话事件流写入 `session_named` 事件
  （`data: { name, source }`），SSE / MQTT 订阅方据此实时刷新。
- `name` 的生成 prompt 只要求输出短标题；若模型返回空（如推理模型的输出配额过小），
  静默跳过，不影响主流程。

```bash
# 手动改名（置 nameSource=user，之后不再自动命名）
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"登录超时修复"}' $BASE/api/v1/sessions/$SID
# => {"data":{"sessionId":"...","name":"登录超时修复","nameSource":"user"}}

# 会话列表回传 name（控制台据此展示标题）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
```



> 注：Server 自 2026-08-08 起已支持 CORS（`Access-Control-Allow-Origin: *`），
> 浏览器跨域调试可直接使用；SSE 因浏览器 `EventSource` 无法携带
> `Authorization` 头，控制台改用 `fetch` 流式读取实现。
