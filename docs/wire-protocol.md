# 线协议 v1（帧 · 信封 · 消息）

**简体中文** · [English](en/wire-protocol.md)

本文件是 zqagent 新通讯底座（Rust 网关 + 纯 Node 节点 + web/小程序/App 终端）的**规范性契约**。
权威 schema 见 [`proto/fleet.proto`](../proto/fleet.proto)；三方实现与交叉向量见 §7。

> 本协议**不是 MQTT 的复刻**（MQTT 已整体退场）：网关自己持有路由表，
> 因此不需要 topic 通配符匹配、retained、LWT、QoS1 机件。

## 1. 帧格式

所有连接（节点面与终端面共用一套帧）都以固定头 + 变长载荷传输：

```
┌──────────┬────────────┬────────────┬────────────┬────────────────┐
│  magic   │ ver │ type │    seq     │    len     │    payload     │
│  2 字节   │ 1 字节      │  varint    │   varint   │ protobuf 字节   │
└──────────┴────────────┴────────────┴────────────┴────────────────┘
 0x5A 0x51   v(4b)|t(4b)    u64          u32
```

| 字段 | 说明 |
| --- | --- |
| `magic` | 固定 `0x5A 0x51`（ASCII `ZQ`）。用于在公网暴露面上廉价地丢弃非法流量 |
| `ver` | 协议版本，高 4 位。当前 `1` |
| `type` | 帧类型，低 4 位（见 §3） |
| `seq` | 单调递增序号（varint, u64）。用于去重与断线续传定位 |
| `len` | 载荷字节长度（varint, u32）。**解码前必须校验上限** |
| `payload` | protobuf 编码的消息体（按 `type` 解释） |

**上限**：`len` 不得超过 `MAX_FRAME_BYTES = 4 MiB`（现状节点侧上报上限约 3.5 MB
`FleetNodeBridge.ts:53,992-996`）。超限直接判错并断开，避免内存放大攻击。

**解码顺序**：`magic` → `ver` → `type` 合法性 → `len` 上限 → `len` 与剩余字节数一致。
任一步失败即判错（不得部分解析后继续使用）。

> 与 0.1.59 的差异：旧路径把载荷格式塞在 MQTT 报文体里（1 字节 `0x01`=protobuf，否则按 JSON）。
> 帧化后**格式由帧头显式表达**，不再需要载荷内的格式探测。

## 2. 信封与签名

指令信封（[`Envelope`](../proto/fleet.proto)）字段与现有 `FleetCmdEnvelope`
（`packages/shared/src/fleet.ts:159-178`）一一对应，语义不变。

**签名**：

```
sig = HMAC-SHA256(fleetSecret, encode(Envelope_without_sig))
```

- 覆盖字段 `1..10` 的**编码字节**（`t`、`nonce`、`req_id`、`type`、`client_id`、`node_id`、
  `project_id`、`session_id`、`payload`、`timeout_ms`），**不含** `sig` 自身。
- `sig` 保存 **HMAC 原始 32 字节**（不再用 base64url 字符串——二进制协议下无必要）。
- 取代旧实现对 `JSON.stringify([...])` 的签名（`packages/shared/src/fleet.ts:283-307`）：
  JSON 规范化跨语言脆弱（浮点、字段序、转义），字节签名是确定性的。
- 时间戳窗口（±60s）与 nonce 去重语义**不变**（`packages/shared/src/common.ts:17-47`）。

**校验方式（确定性要求）**：`sig` 是最后一个字段（号 11），故
`encode(env, sig 置空) == 签名字节`。校验实现可「清空 `sig` 后重新编码再比对」——
这要求编码器满足 §5 的确定性规则，也要求 `sig` **始终是字段号最大的那个**。

**执行预算**：`timeout_ms` 由发起方填写，网关据此决定等待回执的上限。放在信封里而不是
塞进 opaque 的 `payload`，是为了让网关**无需解析载荷**即可分级超时（§5.2）；它参与签名，
因此篡改预算会导致签名失效。

### 2.1 指令超时分级

| 情形 | 等待上限 |
| --- | --- |
| 指定了 `timeout_ms` | `timeout_ms` + 余量（默认 5s），且不超过硬上限（默认 300s） |
| `run_command` / 慢指令（`read_file`/`download_file`/`get_events`/`search_files`/`git_diff`） | 60s |
| 其余控制/写操作 | 10s |
| 节点离线 | **不等待**，立即回 `ok=false`（`error` 含「离线」） |

分级语义沿用原 Hub 代理时期的约定（`isSlowCmd`/`cmdTimeoutMsFor`，现由网关实现，
网关不在本仓库）：慢指令超时只让本次请求失败，不据此判定节点僵死。

## 3. 帧类型

| 值 | 名称 | 方向 | 载荷 |
| --- | --- | --- | --- |
| 0 | `HELLO` | 节点/终端 → 网关 | 握手（M2） |
| 1 | `AUTH` | 节点/终端 → 网关 | 认证（M2） |
| 2 | `SNAPSHOT` | 网关 → 节点/终端 | 上线即推的权威状态（替代 retained，M2） |
| 3 | `STATUS` | 节点 → 网关 | `Status` |
| 4 | `INFO` | 节点 → 网关 | `Info`（能力/项目摘要） |
| 5 | `EVENT` | 节点 → 网关 | `Event` |
| 6 | `NOTIFY` | 节点 → 网关 → 终端 | `Notify`（审批/提问/回合完成；与 `EVENT` 共用游标与缓冲） |
| 7 | `CMD` | 终端 → 网关 → 节点 | `Envelope`（网关按 `node_id` 转发，等 `Ack` 回发起方） |
| 8 | `ACK` | 节点 → 网关 → 终端 | `Ack`（网关按 `req_id` 回到发起连接） |
| 9 | `SUBSCRIBE` | 终端 → 网关 | 多路复用订阅（M5） |
| 10 | `UNSUBSCRIBE` | 终端 → 网关 | 取消订阅（M5） |
| 11 | `RESUME` | 终端 → 网关 | 断线续传（M5） |
| 12 | `PING` / 13 `PONG` | 双向 | 应用层心跳 |
| 14 | `AUTH_OK` | 网关 → 节点/终端 | `AuthOk`（握手结果；与 `AUTH` 分开以避免同类型双向的解析歧义） |

**M1 已实现的载荷**：`Envelope`（CMD）、`Ack`、`Status`、`Event`。
**M2 已实现**：`Auth`/`AuthOk`（握手）、`Snapshot`/`NodeState`（替代 retained 的重建视图）、
`Subscribe`/`Unsubscribe`（终端多路复用）、`Resume`（断线续传）、`Info`（能力/项目摘要）、
`Notify`（审批/提问/回合完成）、`Envelope.timeout_ms`（执行预算 + 网关超时分级）。
其余类型在 M5/M7 按需补 `.proto` 消息（新增消息向后兼容，无需改帧格式）。

## 3.5 终端多路复用与快照所需的字段（M5）

终端面一条连接可订阅多个节点（小程序 `wx.connectSocket` 最多 5 条），所以下行帧必须能
**归属到具体节点**；而快照要能原样替代从前那份 retained info。为此新增三个字段
（proto3 只增不改，旧客户端自动忽略，既有向量字节不变）：

| 消息 | 字段 | 谁填 | 为什么 |
| --- | --- | --- | --- |
| `Event` | `string node_id = 7` | **网关**按连接绑定填入（节点上行留空） | 多路复用下分辨事件来自哪台节点 |
| `Notify` | `string node_id = 7` | 同上 | 审批/提问必须能指出属于哪个节点 |
| `NodeState` | `bytes detail = 7` | 网关转发放大节点的 `Info.detail` | 订阅后一次拿到项目/统计，替代 retained info |

> `NodeState.detail` **只在 `SNAPSHOT` 里填**：`STATUS` 是高频扇出路径，每次状态变化都带上
> 整段 info JSON 会白白放大流量。网关侧的两条路径分别由 `to_proto_snapshot()` 与
> `to_proto()` 产出。

字段号选择遵守 §8 的纪律：`Event`/`Notify`/`NodeState` 的既有字段是 1..6，新字段一律取 7。

## 3.2 上行两条通道：EVENT 与 NOTIFY（M2c）

| | `EVENT` | `NOTIFY` |
| --- | --- | --- |
| 语义 | 高频实时进度 | 低频但必须让终端看到（审批请求 / 提问 / 回合完成 / 错误） |
| 丢失容忍 | 可容忍，靠 `resume` 补 | **不应丢失** |
| 游标 | 网关分配 `seq` | 同一游标空间（与 EVENT 混排、递增） |
| 缓冲淘汰 | **优先淘汰** | **优先保留**（缓冲满时先淘汰最老的 EVENT） |

两者共用同一个环形缓冲，因此一次 `resume(since)` 就能把事件与通知一并补齐——
审批请求不会因为之后的事件风暴而被挤掉（网关侧有 `notifies_survive_event_storm`
测试覆盖该行为）。

## 3.1 指令路由语义（M2b）

```
终端 --CMD(Envelope)--> 网关 --CMD--> 节点
终端 <--ACK(Ack)-------- 网关 <--ACK-- 节点
```

- **每节点串行**：同一节点的指令按到达顺序逐个下发，前一条回执到达前不发下一条
  （并发下发会压满节点事件循环、导致它错过保活——这是原 Hub 代理时期的实测结论）。
- **按 `req_id` 关联**：不再需要 `ack/{clientId}` 定向——回执按 `req_id` 找到发起连接。
- **未命中即丢弃**：迟到/重复回执找不到等待方直接丢弃，因此节点侧重发是幂等的。
- **订阅约束**：终端只能对自己**已订阅**的节点下发指令，否则回 `ok=false`（`未订阅该节点`）。
- **队满快速失败**：超出每节点队列深度立即回 `node_busy`，不做无界堆积。
- **快照时序**：连接建立时网关会先推一个「按当前订阅为空」的初始快照；`SUBSCRIBE` 之后
  再推第二个（含订阅范围）。客户端**必须按序消费**，不能只取第一个。

指令相关状态与丢弃均可观测：`/metrics` 暴露
`zqagent_gateway_pending_commands`、`commands_dispatched_total`、`commands_timed_out_total`、
`commands_rejected_offline_total`、`orphan_acks_total`、`dropped_frames_total`、
`slow_evicted_total`。

## 3.3 背压与慢消费者（M2c）

三道保护，从轻到重：

1. **有界发送队列**（`GATEWAY_SEND_QUEUE`，默认 64）：队列满即丢帧、不阻塞扇出。
   `dropped_frames_total` 计数。
2. **写超时**（`GATEWAY_WRITE_TIMEOUT_SECS`，默认 10s）：TCP 阻塞（对端不读）超过时限即断开，
   防止一个卡死的客户端把网关内存拖住。
3. **慢消费者逐出**（`GATEWAY_MAX_CONSECUTIVE_DROPS`，默认 500；`GATEWAY_REAPER_INTERVAL_SECS`，默认 5s）：
   巡检发现「**连续**丢弃超阈值」的终端，主动断开并清掉其订阅。
   连续丢弃用「成功投递即清零」的原子计数表达，因此健康连接偶发一次丢弃不会被误杀。

> **快照不能丢**：扇出路径可以丢帧，但初始快照与 `SUBSCRIBE` 后的快照是 retained 的替代物，
> 必须送到——实现上选择「等待空位 + 超时兜底」而不是 `try_send`（否则队列瞬时满会让终端
> 拿到一个空视图且无从察觉）。

## 3.4 TLS 终结

两种部署形态，都支持：

| 形态 | 配置 | 适用 |
| --- | --- | --- |
| 入口层终结 | 不设 TLS 变量，`/ws` 明文（仅内网） | k8s Ingress / nginx 已做 TLS |
| 网关自终结 | `GATEWAY_TLS_CERT` + `GATEWAY_TLS_KEY`（PEM） | 直接对公网暴露，**小程序必须 wss** |

**只配一半会启动失败**（返回非 0）而不是静默降级为明文——这是最容易出错的部署状态。
HTTP 可观测端点（`/healthz`、`/metrics`）与 `/ws` 共用同一端口，因此也一并走 TLS。

## 4. 为什么不用 MQTT 机件

| MQTT 机件 | 替代 |
| --- | --- |
| topic 通配符匹配 | 网关持 `nodeId → shard → conn` 路由表 |
| retained | 网关持权威 `states`，连接建立即推 `SNAPSHOT` |
| LWT 遗嘱 | socket 关闭 + 心跳超时（比 LWT 可靠） |
| QoS1 PUBACK / 会话重投 | 应用层 `seq` + `ack` + 服务端重放缓冲 |
| ACL | 连接级握手认证 + 路由天然收敛（每条连接只触达自己的 `node_id`） |

## 5. 编码确定性（跨语言一致的前提）

三方实现必须遵守 proto3 线格式的**默认值省略**规则，否则字节不一致、签名校验失败：

| 类型 | 省略条件 |
| --- | --- |
| 数值（含 `uint64`） | 值为 `0` |
| `bool` | 值为 `false` |
| `string` | 空串 `""` |
| `bytes` | 长度 `0` |

字段按**字段号升序**编码。`string` 必须是合法 UTF-8（严格校验，非法即判错）。

## 6. 边界与拒绝规则

| 情况 | 处理 |
| --- | --- |
| `magic` 不符 / `ver` 不支持 | 判错，断开 |
| `type` 不在已定义集合 | 判错，断开 |
| `len > MAX_FRAME_BYTES` | 判错，断开（不分配缓冲区） |
| `len` 与剩余字节不符 / 可变长字段越界 | 判错，断开 |
| 未知字段号（未来版本新增） | **跳过**（按 wire type 消费），不判错——保证前向兼容 |
| 非法 wire type（3/4 组等） | 判错 |

握手层的额外规则（终端面）：

| 情况 | 处理 |
| --- | --- |
| `kind` 不是 `terminal` | 拒绝（`KindMismatch`） |
| `client` 不在白名单（`web`/`miniapp`/`app`/`hub`，含空串） | 拒绝（`UnknownClient`，fail closed） |
| `scope` 为空 | 拒绝（`EmptyScope`，fail closed） |
| `expires` 已过期 | 拒绝（`Expired`；终端令牌跳过 ±60s 窗口） |

`client` 在签名字节内，修改它必然导致 `BadToken`；白名单只用于「签发方签了什么」这一层，
两处常量（网关 `gateway/src/auth.rs`、控制面 `packages/hub/src/terminalCreds.ts`）必须同步。
`hub` 表示控制面自身的告警订阅连接。

## 7. 实现与交叉验证

| 实现 | 位置 | 说明 |
| --- | --- | --- |
| JS/TS（Node + 浏览器 + 小程序） | `packages/shared/src/wire/` | 可移植：`Uint8Array`/`DataView`，**不依赖任何 Node API** |
| Node 签名 | `packages/shared/src/wire/node.ts` | `node:crypto`，仅 Node 侧使用（不进浏览器包） |
| Rust 网关（不在本仓库） | crate `zqagent-gateway` | `prost` + 手写帧编解码；模块划分为 `frame/stream/auth/registry/eventbuf` |
| 连接层（不在本仓库） | 网关 `main` | wss 终结、握手、心跳、快照、扇出、`/healthz`、`/metrics` |

**交叉向量**：[`proto/fixtures/wire-vectors.json`](../proto/fixtures/wire-vectors.json)（提交入库）保存
规范输入与其期望字节。Node 与 Rust 两侧都必须能**编码出完全相同的字节**并**解码回相同语义**。

> 说明：原方案写的是「三份 codec」。实现时发现 Node 与浏览器可共用同一份可移植实现
> （`Buffer` 是 `Uint8Array` 子类，编解码本身不需要平台 API），因此收敛为
> **JS 一份 + Rust 一份**，仅签名按平台拆分。减少一份重复实现即减少一处字节不一致的风险。

重新生成向量（改协议后必须执行）：

```bash
cd packages/core && npx tsx scripts/gen_wire_vectors.ts
```

## 8. 版本演进

- 帧头 `ver` 与 protobuf 字段号**双重**表达兼容性：字段级新增走 protobuf（不需改 `ver`）；
  帧语义变更才递增 `ver`。
- 网关在过渡期可同时接受多版本（按 `ver` 分派解析器）。
