/**
 * 云端交互 handler
 *
 * ask/plan/directories 的 handler 在引擎层是模块级单例（CLI 注入
 * readline 交互）。云端注入「分派器」：通过 AsyncLocalStorage 找到
 * 当前运行的会话，把问题落盘为 QuestionRecord 并挂起等待；用户经
 * REST API 回答后由 SessionManager resolve，或在任务已回收时通过
 * engine.resume() 重放取回答案。
 *
 * 多会话并发安全：sessionContext 由 SessionManager._drive 在每个
 * run 任务内设置，explore 子代理在同一 await 链内，分派一致。
 */
import { setQuestionHandler } from "../tools/ask.js";
import { setPlanHandler } from "../tools/plan.js";
import { setDirectoryHandler } from "../tools/directories.js";
import { sessionContext, type SessionManager } from "./session.js";

/** 注入云端 handler（进程启动时调用一次） */
export function setupServerHandlers(manager: SessionManager): void {
  setQuestionHandler(async (question, options, allowText, multi) => {
    const sessionId = sessionContext.getStore();
    if (!sessionId) return JSON.stringify({ error: "当前环境不支持用户问答" });
    return manager.suspendQuestion(sessionId, "ask", { question, options, allowText, multi });
  });

  setPlanHandler(async (plan) => {
    const sessionId = sessionContext.getStore();
    if (!sessionId) return { approved: false, feedback: "当前环境不支持计划提案" };
    const answer = await manager.suspendQuestion(sessionId, "plan", {
      question: plan,
      options: ["approve", "reject"],
    });
    const rec = manager.getAnsweredQuestion(sessionId);
    const parsed = rec?.parsed ?? { approved: false, feedback: answer };
    return {
      approved: parsed.approved ?? false,
      feedback: parsed.feedback,
      // 补充要求（修订）与拒绝要区分开：前者要合并后重新提案，不是放弃方案
      ...(parsed.revised ? { revised: true } : {}),
    };
  });

  setDirectoryHandler(async (reason, suggestedPath, writable) => {
    const sessionId = sessionContext.getStore();
    if (!sessionId) return { granted: false };
    const answer = await manager.suspendQuestion(sessionId, "directory", {
      question: reason,
      options: ["yes", "no"],
      suggestedPath,
      writable,
    });
    const rec = manager.getAnsweredQuestion(sessionId);
    const parsed = rec?.parsed ?? { granted: false, path: undefined };
    return { granted: parsed.granted ?? false, path: parsed.path };
  });
}
