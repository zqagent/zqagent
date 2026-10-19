# 上下文压缩机制 (Context Compaction)

**简体中文** · [English](en/context-compaction.md)

> 对齐 Python 版 zqagent 的 `compaction.py`，实现在 `packages/core/src/engine/compaction.ts`，
> 由 `packages/core/src/engine/TurnEngine.ts` 驱动。

## 1. 概述

AI Agent 在长时间会话中会积累大量消息历史。当历史接近 LLM 上下文窗口上限时，上下文压缩
将**早期轮次**转换为：

1. **LLM 生成的摘要** —— 保留意图、决策、工件、错误修复等关键信息；
2. **机械提取的工作状态** —— 从工具调用记录中提取文件、命令、工具列表（零幻觉风险）；
3. **用户消息清单** —— 按时间顺序保留（至多 40 条，每条截断至 600 字符）。

最近的 `keep` 条消息保持原样，供模型在当前上下文中继续操作。

## 2. 核心设计原则

- **持久化历史永不被修改**：压缩只影响"发送给模型的内容"（outbound 视图），引擎自身的
  `messages` 数组原样保留。`SavedState` 中同样保存原始历史，恢复会话后压缩状态可重建。
- **双保险策略**：LLM 摘要为主，机械提取为辅；两者都失败时退化为**裁剪降级**（丢弃最旧消息）。
- **摘要器是独立的一次 LLM 调用**：使用非流式 `provider.stream`，`max_tokens` 默认 3,000。

## 3. 触发机制

### 3.1 预防性检查（每轮迭代开始）

在每一轮 LLM 调用之前（`TurnEngine.ts:288-300`）：

```ts
if (this._compactionDue()) {
  this._emitHook((h) => h.onCompacting?.());
  yield { type: EventType.COMPACTING, data: {} };
  compactionNotice = await this._compactNow();
  // 成功 → 追加 notice、onCompacted hook、COMPACTED 事件
}
```

信号来源（`_compactionTokens`）：

- **精确值**：上一次 LLM 调用 API 返回的 `usage.input`（`_lastContextTokens`）；
- **视图估算**：`estimateTokens`（`JSON.stringify` 总字符数 ÷ 4）对**当前 outbound
  视图**（已应用压缩与淘汰）的估算。

两者取较大者：精确值反映"上一次请求"，工具结果与淘汰都会让它过时；视图估算反映
"现在发送会有多大"。宁可早压，也不要漏判导致溢出。

判断条件：`signal >= triggerTokens`，其中

```
triggerTokens = min(threshold_pct × context_window, cap_tokens)
              = min(0.8 × 128,000, 250,000)
              = 102,400  tokens   (默认值)
```

### 3.2 溢出恢复（LLM 调用失败）

如果预防性检查未触发但 LLM 调用仍然报上下文溢出，`isContextOverflow()` 按错误文本关键字匹配
（`context_length_exceeded`、`maximum context length`、`prompt is too long` 等 8 个标记），
命中后**强制压缩并自动重试**，不对外报错（`TurnEngine.ts:339-356`）：

```ts
const overflow = compaction.isContextOverflow(exc);
if (overflow && !this._cancel) {
  yield { type: EventType.COMPACTING, data: {} };
  const notice = await this._compactNow(true);
  if (notice) { /* 追加 notice → continue 重新调用 LLM */ }
}
```

注意：溢出恢复**不计入重试次数**，且已流式输出的部分会被保留回写为 assistant 消息，
避免上下文丢失。

### 3.3 软阈值：淘汰旧工具结果（零 LLM 成本）

硬阈值（默认 80% 窗口）之前还有一道**软阈值**（默认 60% 窗口）。达到软阈值时，
只把**最旧的工具结果**替换成占位符，不调用任何 LLM：

```
旧: [tool result] <5000 行 diff>          →  [old tool result elided: git_diff, 182340 chars;
                                               re-run the tool if its content is still needed]
```

- 保留预算 = 硬阈值 × 15% × 4 字符/token，从最新往前累计；最近的结果完整保留。
- 豁免：`explore`（子代理唯一产出）、`ask_user` / `propose_plan` / `request_directory`
  （用户回答与授权）、`todo_write`（共享进度）永不淘汰。
- 已落盘的结果（P0 工具结果预算）在占位符里保留文件路径，模型可直接按路径重读。
- 只作用于 outbound 视图，`messages` 与 `SavedState` 保持完整；纯函数、无状态，
  会话恢复后按同一规则重算。
- `COMPACTION_ELIDE=0` 可关闭；`COMPACTION_SOFT_THRESHOLD_PCT` 可覆盖软阈值比例。

效果：大部分长任务在水位到 60% 时就被压回去，80% 的 LLM 摘要只在真正需要时触发。

### 3.4 重复读取去重（默认开启，与阈值无关）

模型经常重复读取同一文件（确认改动、回到原文）。这些旧结果对后续推理没有增量
价值，因此在 outbound 构建时直接替换成一行占位符——**不依赖水位、不调用 LLM**：

```
旧: {"path":"src/a.ts","start_line":1,"end_line":400,"content":"…400 行…"}
    →  [superseded by a later read_file of src/a.ts (lines 1-400)]
```

判定条件（三者同时满足）：

1. **同一路径**：路径做轻量归一（统一分隔符、去掉 `./` 前缀与重复斜杠）；
2. **区间被完整覆盖**：后续读取的行区间（多次分段读会先合并）覆盖旧区间。
   分段读取同一文件的不同区段不会被误伤；
3. **中间没有写操作**：`write_file` / `replace_in_file` / `apply_patch` /
   `apply_unified_diff` / `run_shell` 都视为潜在写操作。改动前后的两次读取是
   不同版本，丢掉「改动前」的内容会损失信息，此时不去重。

- 扫描方向为**倒序**：先登记较新的读取，旧读取若被覆盖才淘汰——保留最新内容。
- 只改 outbound 视图，`messages` 与 `SavedState` 保持完整；纯函数、无状态。
- `COMPACTION_DEDUP=0` 可关闭。

### 3.5 软阈值内的淘汰顺序：先 `git_diff`，后通用

软阈值命中后按两级淘汰，把保留预算优先让给「还会被回看」的内容：

```
① 一次性结果（当前仅 git_diff）
   只保留最近 1 条，更早的全部替换为占位符
        │ 仍高于软阈值
        ▼
② 通用淘汰
   从最旧开始，直到剩余工具结果 ≤ 硬阈值 × 15% × 4 字符
```

`git_diff` 反映的是某一时刻的工作区差异，模型读完据此得出结论后，原文几乎不再被
回看；而 `read_file` 的内容可能被反复引用。先淘汰旧 diff，能避免在通用淘汰里
把 `read_file` 这类高复用结果挤掉。

- 保留条数由 `ONE_SHOT_KEEP_RECENT` 控制（默认 1）；工具集合为 `ONE_SHOT_TOOLS`。
- 已是占位符的结果不重复计数；占位符保留落盘路径（若有）。
- 一级淘汰后若已回到软阈值以下，直接返回，不再动其他结果。

## 4. 压缩流程（`_compactNow`）

压缩必须**收敛**：一次压缩后如果水位仍在阈值之上，就继续压（最多 4 轮），
直到回到目标水位或确实无可再压，避免「每轮迭代都重新进入压缩」。

```
保留预算 keep = KEEP_RECENT_FRACTION × triggerTokens = 0.25 × 102,400 = 25,600 tokens
目标水位 target = 阈值 × 0.9（常规）/ × 0.5（溢出强制）
                        │
          ┌─────────────┴─────────────┐
          │  循环（最多 MAX_COMPACT_ROUNDS）│
          ▼                             │
 ┌─── 尝试 LLM 摘要 buildState()（最多 2 次）───┐
 │            成功                              │ 失败
 ▼                                             ▼
 应用 CompactionState                       trimState() 裁剪降级
 （"上下文已压缩"）              （常规丢 25% / 溢出丢 50%，"上下文已裁剪"）
                        │
                        ▼
        估算水位 ≤ target ？ ── 是 ──▶ 收敛，退出
                        │否
                        ▼
              keep 减半，继续下一轮
                        │
            ┌───────────┴───────────┐
            │ 仍超阈值（压不动了）      │ 已回到阈值以下
            ▼                       ▼
  设置冷却 _compactStalledAt     清除冷却
  （新增 20 条消息后才再试）
```

冷却只针对「压过但没降下来」的情况；若历史尚短、边界还没形成（`buildState`
返回 null），不设冷却——消息继续增长后下一轮自然可压。真溢出仍由 overflow
路径强制压缩兜底。

### 4.1 边界选择 `pickBoundary`（`compaction.ts:106-131`）

目标：找到索引 `boundary`，使 `messages.slice(boundary)` 的估算 token 数 ≤ `keep`，
即"最近 keep 条完整消息"的起点。候选索引（`turnStarts`）仅允许 **user 或 assistant 消息**，
保证 tool 消息与发起它的 assistant 消息在压缩块内/外保持一致，不破坏 API 消息配对。

优先级：

1. **user 索引**（turn 开始，首选）：遍历所有 user 消息，取第一个满足预算的；
2. 若没有 user 满足，则取最后一个 user 之后的 **assistant 索引**（迭代开始）；
3. 极端情况兜底到最后一个 assistant 或最后一个 user；
4. `boundary <= start`（system 消息位置）时放弃压缩。

system 消息永远保留在压缩块之外（outbound 的 head）。

### 4.2 LLM 摘要 `summarizeSpan`（`compaction.ts`）

- 渲染跨度 `renderSpan`：跳过 system/notice；tool 结果截断至 200 字符、tool_calls 参数
  截断至 200 字符、总预算 80,000 字符（超出部分裁掉最旧轮次）。早期轮次本就是将被
  遗忘的内容，过大只会让压缩本身变慢、变贵。
- 若存在上一次压缩（`priorSummary`），将其折叠进本次摘要（`"[previous compaction summary
  — fold its still-relevant content into the new summary]"`），并在提示词中要求只保留
  仍然有效的结论、不要整段复述。
- 摘要器默认使用主模型，可用 `COMPACTION_MODEL` 指定更便宜的小模型；推理强度默认
  `low`（`COMPACTION_REASONING_EFFORT` 可覆盖），并用 `max_tokens` 限制输出长度。
- 系统提示词 `SUMMARY_SYSTEM_PROMPT` 要求按 8 个固定章节输出：主要请求和意图、关键概念和
  决策、工件和文件、错误和修复、所有用户消息、待处理任务、当前工作、下一步。
- 返回空摘要视为失败（抛错），触发重试或降级。

### 4.2.1 工具结果预算（`toolResultBudget.ts`）

压缩只能在 user / assistant 边界切分，切不动挂在尾部的一条巨大 tool 消息。
因此工具结果在**进入历史之前**先做预算：超过 `TOOL_RESULT_MAX_CHARS`（默认 24,000
字符）时，完整内容落盘到 `TOOL_RESULT_DIR`（默认 `~/.local/state/zqagent/tool-results`），
上下文中保留头 60% / 尾 40% 与文件路径。对象结果按字段裁剪，保证 JSON 仍可解析、
`exit_code` 等元信息不丢。

### 4.3 机械提取 `extractWorkingState`（`compaction.ts:138-197`）

从工具调用记录中无 LLM 参与地提取：

- **Files written/edited**：名称含 write/edit/append/save/create/patch 的写类工具参数中的
  `path` / `file_path`（去重，最多 20 个，最近的优先）；
- **Recent shell commands**：`run_shell` 的参数（压缩空白、截断 160 字符），并附带执行状态
  （`ok` / `exit N` / `error`，通过解析 tool 结果判断），最多 10 条；
- **Tools used**：跨度内出现过的工具名集合。

### 4.4 用户消息保留 `extractUserMessages`（`compaction.ts:223-241`）

按时间顺序保留所有 user 消息文本（图片占位 `[image]`），空白折叠、每条截断 600 字符；
与前次压缩的存量合并后**最多保留 40 条**，超出部分丢弃并累计 `userMessagesDropped` 计数
（丢弃数量会写入压缩块，向模型透明）。

### 4.5 裁剪降级 `trimState`（`compaction.ts:376-423`）

LLM 摘要连续失败时，丢弃最旧 `~10%` 消息（`TRIM_FRACTION`），边界同样只选 user/assistant。
摘要文本替换为固定说明（"Older turns were trimmed…"），`trimmed: true` 标记降级发生。
这是**最后防线**——不调用 LLM，代价是信息永久丢失。

## 5. 压缩块与 Outbound 视图

`compactedBlock(state)`（`compaction.ts:428-450`）生成注入文本：

```
<compacted-history>
Earlier turns of this session were compacted. The summary below is your memory of them.

[摘要]

## Working state (extracted mechanically from tool records)   ← 如有
## User messages in the compacted span (verbatim, chronological)  ← 如有
- ...
(N earlier user messages omitted — their intent is covered by the summary above)

从你之前中断的地方继续：完全按照描述接续当前工作和下一步。…（CONTINUATION_CONTRACT）
</compacted-history>
```

`applyToOutbound(messages, state)`（`compaction.ts:453-469`）构建发送给模型的视图：

```
[system] + [user: <compacted-history> 压缩块] + messages.slice(boundary) 完整消息
```

**不修改持久化历史** —— 引擎 `this.messages` 始终是原始完整历史。

## 6. 关键常量表

| 常量 | 值 | 位置 | 含义 |
| --- | --- | --- | --- |
| `DEFAULT_THRESHOLD_PCT` | 0.8 | compaction.ts | 触发阈值占窗口比例 |
| `DEFAULT_CONTEXT_WINDOW` | 128,000 | compaction.ts | 未知模型的默认窗口（capTokens 缺省时不截断） |
| `KEEP_RECENT_FRACTION` | 0.25 | compaction.ts | 保留最近消息比例 |
| `SOFT_THRESHOLD_RATIO` | 0.75 | compaction.ts | 软阈值相对硬阈值的比例（默认 60% 窗口） |
| `ELIDE_KEEP_FRACTION` | 0.15 | compaction.ts | 淘汰后保留的最近工具结果预算（相对硬阈值 token 数） |
| `MUTATING_TOOLS` | — | compaction.ts | 去重时视为「可能改文件」的工具集合 |
| `ONE_SHOT_TOOLS` | `git_diff` | compaction.ts | 软阈值时优先淘汰的一次性结果 |
| `ONE_SHOT_KEEP_RECENT` | 1 | compaction.ts | 一次性结果保留的最近条数 |
| `SUMMARY_MAX_TOKENS` | 3,000 | compaction.ts | 摘要器 max_tokens（已生效） |
| `SPAN_TOOL_RESULT_CLIP` | 200 | compaction.ts | tool 结果截断字符数 |
| `SPAN_BUDGET_CHARS` | 80,000 | compaction.ts | 摘要器输入总预算 |
| `USER_MESSAGE_CLIP` | 600 | compaction.ts | 用户消息截断字符数 |
| `USER_MESSAGES_MAX` | 40 | compaction.ts | 用户消息保留上限 |
| `TRIM_FRACTION` | 0.1 | compaction.ts | 裁剪降级丢弃比例（溢出时用 0.5） |
| `MAX_COMPACT_ROUNDS` | 4 | TurnEngine.ts | 单次压缩最多连续轮数 |
| `COMPACT_STALL_RETRY_DELTA` | 20 | TurnEngine.ts | 压缩无进展后，新增多少条消息再试 |
| `TOOL_RESULT_MAX_CHARS` | 24,000 | toolResultBudget.ts | 单条工具结果进入上下文的最大字符数 |

## 7. 代码地图

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/engine/compaction.ts` | `estimateTokens`、`pickBoundary`、`extractWorkingState`、`extractUserMessages`、`SUMMARY_SYSTEM_PROMPT` / `CONTINUATION_CONTRACT`、`summarizeSpan`、`buildState`、`trimState`、`compactedBlock` / `applyToOutbound`、`applyToolResultElision`、`applyOneShotElision`、`applyReadFileDedup` / `parseReadFileSpan`、`softTriggerTokens` / `elisionKeepChars`、`isContextOverflow`、`summarizerReasoningEffort` |
| `packages/core/src/engine/toolResultBudget.ts` | `applyToolResultBudget` 工具结果预算与落盘 |
| `packages/core/src/engine/TurnEngine.ts` | 预防性压缩检查、溢出恢复 + 自动重试、`_compactionDue` / `_getContextWindow`、`_compactNow` 压缩主流程 |
| `packages/core/src/engine/events.ts` | `COMPACTING` / `COMPACTED` 事件 |
| `packages/core/src/engine/CompositeHook.ts` | `onCompacting` / `onCompacted` hook 透传 |

## 8. 改进与优化空间

> **2026-10 压缩优化已处理**：模型窗口映射表已内置（`lookupContextWindow`）；
> 压缩改为收敛循环（最多 4 轮）+ 无进展冷却，连续溢出已有熔断语义；
> 工具结果在入历史前统一预算（超限落盘），尾部巨型 tool 消息不再导致切不动；
> 摘要 span 预算收紧到 80K 字符、推理强度默认 low、`max_tokens` 已生效。
> 另已加入 60% 软阈值：只淘汰旧工具结果、不调 LLM，摘要调用次数显著下降。
> 同一路径被后续读取完整覆盖的旧结果会被直接去重（写入前后不误判）。
> 软阈值内先淘汰旧 `git_diff`（一次性消费），再走通用淘汰，避免挤掉高复用内容。
> 以下条目保留作为后续演进参考，已解决项不再重复施工。

### P0 — 正确性 / 健壮性

1. **模型上下文窗口硬编码**（`TurnEngine.ts:694-695`）：`_getContextWindow()` 对所有模型
   返回默认 128K。实际不同模型窗口差异巨大（gpt-4 8K/32K、gpt-4o 128K、o1 系列 200K）。
   窗口高估 → 小窗口模型只能靠溢出恢复兜底；窗口低估 → 过早压缩、摘要更频繁。
   建议维护模型 → 窗口映射表（Python 版有 model matrix），或从 provider 元数据获取。

2. **token 估算偏差大**（`compaction.ts:56-66`）：`JSON.stringify` 字符数 ÷ 4 对中文等
   多字节文本严重高估。虽然 API 返回的精确 `usage` 是主信号，但 `_lastContextTokens` 只在
   流正常结束时更新，且估算还用于 `pickBoundary` 的预算判断，偏差会直接影响压缩质量。
   建议引入 tiktoken（或可注入的 token 计数函数）。

3. **`applyToOutbound` 与 `buildState` 边界不一致**：`pickBoundary` 理论上可产出
   `boundary == messages.length` 的状态（空 slice 估算为 0），但 `applyToOutbound` 对
   `boundary >= messages.length` 直接返回原消息（`compaction.ts:460`）——压缩状态被替换
   但视图未生效。当前阈值设计下难以触发，但属防御性缺陷，建议统一边界判定。

### P1 — 可观测性 / 健壮性

4. **无压缩统计指标**：未记录每次压缩节省的 token 数、耗时、触发次数、降级率。
   `onCompacted` hook 只收到文本通知，调用方无法量化压缩效果。建议扩展为结构化
   `CompactionInfo`（类似上轮优化为 ERROR 事件引入的 `EngineErrorInfo`）。

5. **摘要器调用无超时/取消**：`summarizeSpan` 直接 await provider 流，Provider 挂起会
   阻塞整个 run 循环（压缩发生在 LLM 调用之前）。建议给摘要器调用加超时。

6. **摘要重试无退避**：`_compactNow` 内 2 次重试立即执行（`TurnEngine.ts:711`），
   Provider 持续故障时浪费时间。建议指数退避或计数熔断。

7. **缺单元测试**：`test/` 中没有针对 `compaction.ts` 的测试。`pickBoundary`、
   `extractWorkingState`、`applyToOutbound`、`trimState` 均为纯函数，建议补充
   `test/compaction.test.ts`，覆盖边界选择优先级、tool 消息配对完整性、降级路径。

### P2 — 效果优化

8. **摘要质量无校验**：摘要输出直接信纳。建议要求摘要器输出结构化格式（如 JSON）以便
   解析校验，或压缩后抽查关键要素（用户约束、路径、命令）是否保留。

9. **用户消息截断可能丢失约束**：`USER_MESSAGE_CLIP = 600` 字符对长指令（审批要求、
   详细约束）直接截断。建议对"约束类"消息豁免或延长。

10. **边界选择不考虑消息重要性**：只按 token 预算，错误修复轮次、用户反馈轮次可能与
    普通轮次同概率被压缩。可引入加权（如按 notice 类型、工具类型加权保留）。

11. **多次压缩累积误差**：`priorSummary` 每次被折叠进新摘要，N 次压缩后早期细节
    指数级丢失（每次折叠都是有损压缩）。可考虑保留最近 1-2 次摘要原文作为参照。

12. **连续溢出无熔断**：强制压缩后若压缩块 + 最近消息仍超窗口，会再次溢出 → 再次强制
    压缩（`buildState` 返回 null 时）→ 报错终止。已有"建议清理会话"的提示语境，但缺少
    熔断计数与更明确的告警。

### P3 — 架构演进

13. **`CompactionState` 无版本字段**：持久化恢复后结构演进（新增字段）无兼容策略。
    建议加 `schemaVersion`。

14. **历史内存无限增长**：压缩只影响视图，`messages` 数组随会话无限增长（内存占用）。
    超长会话可考虑将压缩块之前的原始消息落盘/归档，仅保留视图。
