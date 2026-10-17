/**
 * FileLogHook — 将引擎事件以 JSONL 格式持久化到文件
 *
 * 同时维护一个引擎状态快照（检查点），用于 Durable Resume。
 * 恢复时可通过 loadState() 读取消息历史和压缩状态。
 */
import * as fs from "fs";
import * as path from "path";
import type {
  EngineHook,
  EventType,
  CompactionStartInfo,
  CompactionDoneInfo,
} from "./events.js";
import type { TokenUsage, Message } from "./types.js";
import type { CompactionState } from "./compaction.js";
import type { TurnEngine } from "./TurnEngine.js";

/** 保存的引擎状态（用于恢复） */
export interface SavedState {
  sessionId: string;
  model: string;
  messages: Message[];
  compaction: Record<string, unknown> | null;
  savedAt: string;
  /** 会话名称（AI 自动生成或用户指定） */
  name?: string;
  /** 名称来源：auto=自动生成（可被后续自动生成覆盖）；user=用户手动指定（不再自动生成） */
  nameSource?: "auto" | "user";
  /** 已成功完成的任务数（用于第 1/3/5 次自动命名） */
  taskCount?: number;
}

/** 会话命名相关的元数据（由 CLI 维护，随 state 快照持久化） */
export interface SessionNameMeta {
  name?: string;
  nameSource?: "auto" | "user";
  taskCount?: number;
}

export class FileLogHook implements EngineHook {
  private _logPath: string;
  private _statePath: string;

  constructor(
    private sessionId: string,
    stateDir: string,
  ) {
    fs.mkdirSync(stateDir, { recursive: true });
    this._logPath = path.join(stateDir, `${sessionId}.jsonl`);
    this._statePath = path.join(stateDir, `${sessionId}_state.json`);
  }

  onTurnStart(input: string): void {
    this._append({ type: "turn_start", input });
  }
  onTurnEnd(status: string, iterations: number, producedFiles: string[]): void {
    this._append({
      type: "turn_end",
      status,
      iterations,
      produced_files: producedFiles,
    });
  }
  onAssistantDelta(_text: string): void {
    // 逐 token 太频繁，不在日志中记录
  }
  onReasoningDelta(_text: string): void {
    // 逐 token 太频繁，不在日志中记录
  }
  onAssistantMessage(
    text: string | null,
    toolCalls: string[],
    usage?: TokenUsage,
  ): void {
    this._append({
      type: "assistant_message",
      text,
      tool_calls: toolCalls,
      usage,
    });
  }
  onToolProposed(name: string, args: Record<string, unknown>): void {
    this._append({ type: "tool_proposed", name, args });
  }
  onToolStarted(name: string): void {
    this._append({ type: "tool_started", name });
  }
  onToolFinished(name: string, status: string, resultPreview: string): void {
    this._append({
      type: "tool_finished",
      name,
      status,
      result_preview: resultPreview,
    });
  }
  onPermissionRequired(name: string, reason: string): void {
    this._append({ type: "permission_required", name, reason });
  }
  onIterationEnd(iteration: number): void {
    // 每个检查点保存引擎状态
    this._append({ type: "iteration_end", iteration });
  }
  onCompacting(info?: CompactionStartInfo): void {
    this._append({ type: "compacting", ...(info ?? {}) });
  }
  onCompacted(text: string, info?: CompactionDoneInfo): void {
    this._append({ type: "compacted", text, ...(info ?? {}) });
  }
  onError(error: string, errorType: string): void {
    this._append({ type: "error", error, error_type: errorType });
  }
  onRetry(attempt: number, max: number, reason: string): void {
    this._append({ type: "llm_retry", attempt, max, reason });
  }

  onInterrupted(iterations: number): void {
    this._append({ type: "interrupted", iterations });
  }
  onPaused(iteration: number, at: string): void {
    this._append({ type: "turn_paused", iteration, at });
  }
  onResumed(iteration: number): void {
    this._append({ type: "turn_resumed", iteration });
  }
  onEvent(type: EventType, data: Record<string, unknown>): void {
    this._append({ type, ...data });
  }

  /** 保存完整引擎状态快照（检查点） */
  saveState(engine: TurnEngine, meta?: SessionNameMeta): void {
    const state: SavedState = {
      sessionId: this.sessionId,
      model: engine.model,
      messages: engine.messages,
      compaction: engine.compactionState
        ? {
            boundaryIndex: engine.compactionState.boundaryIndex,
            summaryText: engine.compactionState.summaryText,
            workingState: engine.compactionState.workingState,
            userMessages: engine.compactionState.userMessages,
            userMessagesDropped: engine.compactionState.userMessagesDropped,
            createdAt: engine.compactionState.createdAt,
            modelUsed: engine.compactionState.modelUsed,
            trimmed: engine.compactionState.trimmed,
          }
        : null,
      savedAt: new Date().toISOString(),
      // 会话命名元数据（可选，向后兼容旧调用）
      ...(meta?.name !== undefined ? { name: meta.name } : {}),
      ...(meta?.nameSource !== undefined
        ? { nameSource: meta.nameSource }
        : {}),
      ...(meta?.taskCount !== undefined ? { taskCount: meta.taskCount } : {}),
    };
    fs.writeFileSync(this._statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /** 读取保存的引擎状态 */
  static loadState(sessionId: string, stateDir: string): SavedState | null {
    const p = path.join(stateDir, `${sessionId}_state.json`);
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw) as SavedState;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  /** 读取事件日志 */
  static loadEvents(
    sessionId: string,
    stateDir: string,
  ): Record<string, unknown>[] {
    const p = path.join(stateDir, `${sessionId}.jsonl`);
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (e) {
      console.error(e);
      return [];
    }
  }

  /** 追加一行 JSON 事件 */
  private _append(entry: Record<string, unknown>): void {
    entry["ts"] = new Date().toISOString();
    try {
      fs.appendFileSync(this._logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) {
      // 持久化失败不影响核心逻辑
      console.error(e);
    }
  }
}
