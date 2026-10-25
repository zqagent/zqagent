/**
 * VcsHook — 把引擎生命周期接到变更追踪
 *
 * 只在 turn 结束时记一次快照，不在每次工具调用时记：一轮里模型可能改十几个
 * 文件、又反复调整，逐个记会产生大量无意义提交，也让「回滚到某一轮」变得难选。
 *
 * EngineHook 的回调是同步签名，而 git 操作是异步的。这里用内部队列
 * 串行接住（不阻塞主流程），并提供 `flush()` 在退出/查询前等待落盘。
 * 快照失败不抛异常——追踪是旁路能力，不能因为它让对话失败。
 */
import type { EngineHook } from "../engine/events.js";
import type { TurnCommit } from "./plan.js";
import type { SessionVcs } from "./session.js";

export class VcsHook implements EngineHook {
  /** 最近一次失败原因（供 /vcs 展示，避免静默失效） */
  lastError: string | null = null;
  /** 最近一次成功提交 */
  lastCommit: TurnCommit | null = null;

  constructor(readonly vcs: SessionVcs) {}

  onTurnStart(): void {
    // 在工具执行前落基线：否则首个快照会把工作区里已有的文件
    // 全算成「本会话的改动」（多会话共享工作区时尤其误导）
    if (!this.vcs.enabled) return;
    void this.vcs.beginTurn().catch((err: unknown) => {
      this.lastError = String((err as Error)?.message ?? err);
    });
  }

  onTurnEnd(status: string): void {
    if (!this.vcs.enabled) return;
    void this.vcs
      .commitTurn(status)
      .then((commit) => {
        if (commit) this.lastCommit = commit;
        this.lastError = null;
      })
      .catch((err: unknown) => {
        this.lastError = String((err as Error)?.message ?? err);
      });
  }

  /** 等待排队中的快照全部落盘 */
  async flush(): Promise<void> {
    await this.vcs.flush();
  }
}
