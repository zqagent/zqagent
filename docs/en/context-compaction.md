# Context Compaction

[简体中文](../context-compaction.md) · **English**

> Mirrors `compaction.py` from the Python implementation. Implemented in
> `packages/core/src/engine/compaction.ts` and driven by
> `packages/core/src/engine/TurnEngine.ts`.

## 1. Overview

During long sessions an agent accumulates a large message history. When that history approaches
the model's context window, compaction turns **earlier turns** into:

1. **An LLM-generated summary** — preserving intent, decisions, artifacts, and error fixes;
2. **Mechanically extracted working state** — files, commands, and tools pulled from tool-call
   records (zero hallucination risk);
3. **A list of user messages** — kept in chronological order (at most 40, each truncated to 600 characters).

The most recent `keep` messages are left untouched so the model can continue working in the
current context.

## 2. Core design principles

- **Persisted history is never modified**: compaction only affects "what is sent to the model"
  (the outbound view). The engine's own `messages` array is preserved as-is, and `SavedState`
  keeps the original history too, so the compaction state can be rebuilt after resuming a session.
- **Two-layer fallback**: the LLM summary is primary and mechanical extraction is secondary;
  if both fail, compaction degrades to **trimming** (dropping the oldest messages).
- **The summarizer is a separate LLM call**: non-streaming, `max_tokens` defaults to 3,000.

## 3. Triggering

### 3.1 Preventive check (start of every iteration)

Before each model call (`TurnEngine.ts:288-300`):

```ts
if (this._compactionDue()) {
  this._emitHook((h) => h.onCompacting?.());
  yield { type: EventType.COMPACTING, data: {} };
  compactionNotice = await this._compactNow();
  // on success → append notice, onCompacted hook, COMPACTED event
}
```

Signals (`_compactionDue`, `TurnEngine.ts:686-690`):

- **Primary**: the precise `usage` token count returned by the previous API call
  (`_lastContextTokens`, updated at `TurnEngine.ts:409-411`);
- **Fallback**: `estimateTokens` (`JSON.stringify` total characters ÷ 4, matching the Python version).

Condition: `signal >= triggerTokens`, where

```
triggerTokens = min(threshold_pct × context_window, cap_tokens)
              = min(0.8 × 128,000, 250,000)
              = 102,400  tokens   (defaults)
```

### 3.2 Overflow recovery (model call fails)

If the preventive check did not fire but the model call still reports a context overflow,
`isContextOverflow()` matches on eight error-text markers (`context_length_exceeded`,
`maximum context length`, `prompt is too long`, etc.). On a match, compaction is **forced and the
call retried automatically** without surfacing an error (`TurnEngine.ts:339-356`):

```ts
const overflow = compaction.isContextOverflow(exc);
if (overflow && !this._cancel) {
  yield { type: EventType.COMPACTING, data: {} };
  const notice = await this._compactNow(true);
  if (notice) { /* append notice → continue, retry the model call */ }
}
```

Note: overflow recovery **does not count against the retry budget**, and any partial streamed
output is preserved by writing it back as an assistant message so no context is lost.

## 4. Compaction flow (`_compactNow`, `TurnEngine.ts:699-745`)

```
keep budget keep = KEEP_RECENT_FRACTION × triggerTokens = 0.25 × 102,400 = 25,600 tokens
                        │
                        ▼
            ┌─── try LLM summary buildState() (up to 2 attempts) ───┐
            │            success                                    │ failure
            ▼                                                       ▼
    apply CompactionState                              trimState() trimming fallback
    ("context compacted")                        (drop oldest ~10%, "context trimmed")
                        │
                        ▼
     _lastContextTokens = null (count is stale; estimate on next round)
```

### 4.1 Boundary selection `pickBoundary` (`compaction.ts:106-131`)

Goal: find the index `boundary` such that the estimated tokens of `messages.slice(boundary)` fit
within `keep` — that is, the start of "the most recent complete messages". Candidate indices
(`turnStarts`) are restricted to **user or assistant messages**, so that a tool message and the
assistant message that issued it stay on the same side of the boundary, preserving API message pairing.

Priority:

1. **user index** (turn start, preferred): scan user messages and take the first one that fits the budget;
2. if no user message fits, take the **assistant index** after the last user message (iteration start);
3. in extreme cases fall back to the last assistant or last user message;
4. if `boundary <= start` (the system message position), skip compaction entirely.

The system message always stays outside the compacted block, at the head of the outbound view.

### 4.2 LLM summary `summarizeSpan` (`compaction.ts:317-333`)

- Renders the span with `renderSpan`: skips system/notice messages; tool results are clipped to
  400 characters, tool-call arguments to 200 characters, with a total budget of 400,000
  characters (excess is cut from the oldest turns).
- If a previous compaction exists (`priorSummary`), it is folded into the new summary
  (`"[previous compaction summary — fold its still-relevant content into the new summary]"`).
- `SUMMARY_SYSTEM_PROMPT` requires eight fixed sections: primary requests and intent, key
  concepts and decisions, artifacts and files, errors and fixes, all user messages, pending
  tasks, current work, next step.
- An empty summary counts as failure (throws), triggering a retry or the fallback.

### 4.3 Mechanical extraction `extractWorkingState` (`compaction.ts:138-197`)

Extracted from tool-call records with no LLM involvement:

- **Files written/edited**: the `path` / `file_path` arguments of write-type tools whose names
  contain write/edit/append/save/create/patch (deduplicated, at most 20, most recent first);
- **Recent shell commands**: `run_shell` arguments (whitespace collapsed, clipped to 160
  characters) with execution status (`ok` / `exit N` / `error`, derived from the tool result),
  at most 10;
- **Tools used**: the set of tool names appearing in the span.

### 4.4 User message retention `extractUserMessages` (`compaction.ts:223-241`)

All user message texts are kept in chronological order (images become the placeholder `[image]`),
with whitespace collapsed and each clipped to 600 characters; after merging with the carry-over
from the previous compaction, **at most 40** are kept. The excess is dropped and counted in
`userMessagesDropped` (the count is written into the compacted block, so the model knows).

### 4.5 Trimming fallback `trimState` (`compaction.ts:376-423`)

When the LLM summary fails repeatedly, the oldest `~10%` of messages are dropped
(`TRIM_FRACTION`), again choosing a boundary only at user/assistant messages. The summary text is
replaced with a fixed note ("Older turns were trimmed…") and `trimmed: true` marks the
degradation. This is the **last line of defense** — no LLM call, but information is lost permanently.

## 5. Compacted block and outbound view

`compactedBlock(state)` (`compaction.ts:428-450`) generates the injected text:

```
<compacted-history>
Earlier turns of this session were compacted. The summary below is your memory of them.

[summary]

## Working state (extracted mechanically from tool records)   ← if any
## User messages in the compacted span (verbatim, chronological)  ← if any
- ...
(N earlier user messages omitted — their intent is covered by the summary above)

从你之前中断的地方继续：完全按照描述接续当前工作和下一步。…（CONTINUATION_CONTRACT）
</compacted-history>
```

`applyToOutbound(messages, state)` (`compaction.ts:453-469`) builds the view sent to the model:

```
[system] + [user: <compacted-history> block] + messages.slice(boundary) full messages
```

**Persisted history is not modified** — the engine's `this.messages` always remains the original,
complete history.

## 6. Key constants

| Constant | Value | Location | Meaning |
| --- | --- | --- | --- |
| `DEFAULT_THRESHOLD_PCT` | 0.8 | compaction.ts:16 | Trigger threshold as a fraction of the window |
| `DEFAULT_CAP_TOKENS` | 250,000 | compaction.ts:17 | Upper bound for the trigger threshold |
| `DEFAULT_CONTEXT_WINDOW` | 128,000 | compaction.ts:20 | Default window for unknown models |
| `KEEP_RECENT_FRACTION` | 0.25 | compaction.ts:23 | Fraction of recent messages to keep |
| `SUMMARY_MAX_TOKENS` | 3,000 | compaction.ts:26 | Summarizer `max_tokens` |
| `SPAN_TOOL_RESULT_CLIP` | 400 | compaction.ts:29 | Tool result clip, in characters |
| `SPAN_BUDGET_CHARS` | 400,000 | compaction.ts:30 | Total summarizer input budget |
| `USER_MESSAGE_CLIP` | 600 | compaction.ts:33 | User message clip, in characters |
| `USER_MESSAGES_MAX` | 40 | compaction.ts:34 | Maximum user messages retained |
| `TRIM_FRACTION` | 0.1 | compaction.ts:37 | Fraction dropped by the trimming fallback |

## 7. Code map

| File | Lines | Contents |
| --- | --- | --- |
| `packages/core/src/engine/compaction.ts` | 56-66 | `estimateTokens` |
| | 106-131 | `pickBoundary` |
| | 138-197 | `extractWorkingState` |
| | 223-241 | `extractUserMessages` |
| | 245-264 | `SUMMARY_SYSTEM_PROMPT` / `CONTINUATION_CONTRACT` |
| | 317-333 | `summarizeSpan` |
| | 338-371 | `buildState` |
| | 376-423 | `trimState` |
| | 428-469 | `compactedBlock` / `applyToOutbound` |
| | 473-489 | `isContextOverflow` |
| `packages/core/src/engine/TurnEngine.ts` | 288-300 | Preventive compaction check |
| | 339-356 | Overflow recovery + automatic retry |
| | 686-696 | `_compactionDue` / `_getContextWindow` |
| | 699-745 | `_compactNow` |
| `packages/core/src/engine/events.ts` | — | `COMPACTING` / `COMPACTED` events |
| `packages/core/src/engine/CompositeHook.ts` | — | `onCompacting` / `onCompacted` hook plumbing |

## 8. Known gaps and possible improvements

### P0 — correctness / robustness

1. **Hard-coded context window** (`TurnEngine.ts:694-695`): `_getContextWindow()` returns a
   default of 128K for every model. Real windows vary widely (gpt-4 8K/32K, gpt-4o 128K,
   the o1 series 200K). Overestimating means small-window models rely on overflow recovery;
   underestimating means compacting too early and summarizing too often. Consider a model → window
   table (the Python version has a model matrix) or reading provider metadata.

2. **Large token-estimate error** (`compaction.ts:56-66`): `JSON.stringify` characters ÷ 4 badly
   overestimates multi-byte text such as Chinese. The precise `usage` from the API is the primary
   signal, but `_lastContextTokens` is only updated when a stream ends normally, and the estimate
   is also used for `pickBoundary`'s budget, so the error directly affects compaction quality.
   Consider tiktoken (or an injectable token-counting function).

3. **Inconsistent boundary between `applyToOutbound` and `buildState`**: `pickBoundary` can in
   theory produce `boundary == messages.length` (an empty slice estimates to 0), but
   `applyToOutbound` returns the messages unchanged when `boundary >= messages.length`
   (`compaction.ts:460`) — the compaction state is replaced but the view does not take effect.
   Hard to trigger under the current thresholds, but it is a defensive gap; unify the boundary check.

### P1 — observability / robustness

4. **No compaction metrics**: nothing records tokens saved, time taken, trigger count, or
   degradation rate. The `onCompacted` hook only receives a text notice, so callers cannot
   quantify the effect. Consider extending it to a structured `CompactionInfo` (similar to the
   `EngineErrorInfo` introduced for ERROR events).

5. **No timeout or cancellation for the summarizer call**: `summarizeSpan` awaits the provider
   stream directly; a hung provider blocks the whole run loop (compaction happens before the model
   call). Add a timeout.

6. **No backoff between summary retries**: `_compactNow` retries twice immediately
   (`TurnEngine.ts:711`), wasting time while the provider is failing. Consider exponential backoff
   or a circuit breaker.

7. **No unit tests**: `test/` has no tests for `compaction.ts`. `pickBoundary`,
   `extractWorkingState`, `applyToOutbound`, and `trimState` are pure functions; consider adding
   `test/compaction.test.ts` covering boundary-selection priority, tool-message pairing
   integrity, and the degradation path.

### P2 — quality

8. **No summary validation**: summary output is trusted verbatim. Consider requiring a structured
   format (e.g. JSON) for parsing and validation, or spot-checking that key elements (user
   constraints, paths, commands) survived compaction.

9. **User-message truncation can lose constraints**: `USER_MESSAGE_CLIP = 600` cuts long
   instructions (approval requirements, detailed constraints) outright. Consider exempting or
   extending "constraint-like" messages.

10. **Boundary selection ignores message importance**: it is purely token-budget driven, so
    error-fix turns and user-feedback turns are compacted with the same probability as ordinary
    turns. Consider weighting (e.g. retaining by notice type or tool type).

11. **Compounding loss across multiple compactions**: `priorSummary` is folded into each new
    summary, so after N compactions early detail is lost exponentially (every fold is lossy).
    Consider keeping the last 1-2 summaries verbatim as references.

12. **No circuit breaker for repeated overflow**: if the compacted block plus recent messages
    still exceeds the window, it overflows again → forces compaction again (`buildState` returns
    null) → aborts with an error. There is already guidance to "consider clearing the session",
    but no breaker counter or clearer alert.

### P3 — architectural evolution

13. **`CompactionState` has no version field**: there is no compatibility strategy if the
    structure evolves after persistence. Consider `schemaVersion`.

14. **History grows without bound in memory**: compaction only affects the view, while the
    `messages` array grows indefinitely. For very long sessions, consider archiving raw messages
    before the compacted block to disk and keeping only the view.
