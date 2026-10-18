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

信号来源（`_compactionDue`，`TurnEngine.ts:686-690`）：

- **优先**：上一次 LLM 调用 API 返回的精确 `usage` token 数（`_lastContextTokens`，
  在 `TurnEngine.ts:409-411` 更新）；
- **兜底**：`estimateTokens`（`JSON.stringify` 总字符数 ÷ 4，对齐 Python 版）。

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

## 4. 压缩流程（`_compactNow`，`TurnEngine.ts:699-745`）

```
保留预算 keep = KEEP_RECENT_FRACTION × triggerTokens = 0.25 × 102,400 = 25,600 tokens
                        │
                        ▼
            ┌─── 尝试 LLM 摘要 buildState()（最多 2 次）───┐
            │            成功                              │ 失败
            ▼                                             ▼
    应用 CompactionState                       trimState() 裁剪降级
    （"上下文已压缩"）                    （丢弃最旧 ~10%，"上下文已裁剪"）
                        │
                        ▼
     _lastContextTokens = null（旧计数已过时，下次走估算）
```

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

### 4.2 LLM 摘要 `summarizeSpan`（`compaction.ts:317-333`）

- 渲染跨度 `renderSpan`：跳过 system/notice；tool 结果截断至 400 字符、tool_calls 参数
  截断至 200 字符、总预算 400,000 字符（超出部分裁掉最旧轮次）。
- 若存在上一次压缩（`priorSummary`），将其折叠进本次摘要（`"[previous compaction summary
  — fold its still-relevant content into the new summary]"`）。
- 系统提示词 `SUMMARY_SYSTEM_PROMPT` 要求按 8 个固定章节输出：主要请求和意图、关键概念和
  决策、工件和文件、错误和修复、所有用户消息、待处理任务、当前工作、下一步。
- 返回空摘要视为失败（抛错），触发重试或降级。

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
| `DEFAULT_THRESHOLD_PCT` | 0.8 | compaction.ts:16 | 触发阈值占窗口比例 |
| `DEFAULT_CAP_TOKENS` | 250,000 | compaction.ts:17 | 触发阈值上限 |
| `DEFAULT_CONTEXT_WINDOW` | 128,000 | compaction.ts:20 | 未知模型的默认窗口 |
| `KEEP_RECENT_FRACTION` | 0.25 | compaction.ts:23 | 保留最近消息比例 |
| `SUMMARY_MAX_TOKENS` | 3,000 | compaction.ts:26 | 摘要器 max_tokens |
| `SPAN_TOOL_RESULT_CLIP` | 400 | compaction.ts:29 | tool 结果截断字符数 |
| `SPAN_BUDGET_CHARS` | 400,000 | compaction.ts:30 | 摘要器输入总预算 |
| `USER_MESSAGE_CLIP` | 600 | compaction.ts:33 | 用户消息截断字符数 |
| `USER_MESSAGES_MAX` | 40 | compaction.ts:34 | 用户消息保留上限 |
| `TRIM_FRACTION` | 0.1 | compaction.ts:37 | 裁剪降级丢弃比例 |

## 7. 代码地图

| 文件 | 行号 | 内容 |
| --- | --- | --- |
| `packages/core/src/engine/compaction.ts` | 56-66 | `estimateTokens` 估算 |
| | 106-131 | `pickBoundary` 边界选择 |
| | 138-197 | `extractWorkingState` 机械提取 |
| | 223-241 | `extractUserMessages` 用户消息 |
| | 245-264 | `SUMMARY_SYSTEM_PROMPT` / `CONTINUATION_CONTRACT` |
| | 317-333 | `summarizeSpan` 摘要器调用 |
| | 338-371 | `buildState` 完整构建 |
| | 376-423 | `trimState` 裁剪降级 |
| | 428-469 | `compactedBlock` / `applyToOutbound` |
| | 473-489 | `isContextOverflow` 溢出检测 |
| `packages/core/src/engine/TurnEngine.ts` | 288-300 | 预防性压缩检查 |
| | 339-356 | 溢出恢复 + 自动重试 |
| | 686-696 | `_compactionDue` / `_getContextWindow` |
| | 699-745 | `_compactNow` 压缩主流程 |
| `packages/core/src/engine/events.ts` | — | `COMPACTING` / `COMPACTED` 事件 |
| `packages/core/src/engine/CompositeHook.ts` | — | `onCompacting` / `onCompacted` hook 透传 |

## 8. 改进与优化空间

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
