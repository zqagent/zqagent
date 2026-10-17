/**
 * CompositeHook — 将多个 EngineHook 组合为一个
 *
 * 代理所有方法到子 hook 列表中，调用方可以同时注入
 * ConsoleHook + FileLogHook + WsBroadcastHook 等任意组合。
 */
import type {
  EngineHook,
  EngineErrorInfo,
  EventType,
  CompactionStartInfo,
  CompactionDoneInfo,
} from "./events.js";
import type { TokenUsage } from "./types.js";

export class CompositeHook implements EngineHook {
  constructor(private hooks: EngineHook[]) {}

  onTurnStart(input: string): void {
    for (const h of this.hooks) h.onTurnStart?.(input);
  }
  onTurnEnd(status: string, iterations: number, producedFiles: string[]): void {
    for (const h of this.hooks) h.onTurnEnd?.(status, iterations, producedFiles);
  }
  onAssistantDelta(text: string): void {
    for (const h of this.hooks) h.onAssistantDelta?.(text);
  }
  onReasoningDelta(text: string): void {
    for (const h of this.hooks) h.onReasoningDelta?.(text);
  }
  onAssistantMessage(text: string | null, toolCalls: string[], usage?: TokenUsage): void {
    for (const h of this.hooks) h.onAssistantMessage?.(text, toolCalls, usage);
  }
  onToolProposed(name: string, args: Record<string, unknown>): void {
    for (const h of this.hooks) h.onToolProposed?.(name, args);
  }
  onToolStarted(name: string): void {
    for (const h of this.hooks) h.onToolStarted?.(name);
  }
  onToolFinished(name: string, status: string, resultPreview: string): void {
    for (const h of this.hooks) h.onToolFinished?.(name, status, resultPreview);
  }
  onPermissionRequired(name: string, reason: string): void {
    for (const h of this.hooks) h.onPermissionRequired?.(name, reason);
  }
  onIterationEnd(iteration: number): void {
    for (const h of this.hooks) h.onIterationEnd?.(iteration);
  }
  onCompacting(info?: CompactionStartInfo): void {
    for (const h of this.hooks) h.onCompacting?.(info);
  }
  onCompacted(text: string, info?: CompactionDoneInfo): void {
    for (const h of this.hooks) h.onCompacted?.(text, info);
  }
  onError(error: string, errorType: string, info?: EngineErrorInfo): void {
    for (const h of this.hooks) h.onError?.(error, errorType, info);
  }
  onRetry(attempt: number, max: number, reason: string): void {
    for (const h of this.hooks) h.onRetry?.(attempt, max, reason);
  }
  onInterrupted(iterations: number): void {
    for (const h of this.hooks) h.onInterrupted?.(iterations);
  }
  onEvent(type: EventType, data: Record<string, unknown>): void {
    for (const h of this.hooks) h.onEvent?.(type, data);
  }
}
