/**
 * QqAdapter — QQ 机器人业务编排
 *
 * 接收归一化后的 QQ 消息 → 解析命令 → 路由到 SessionManager，
 * 并把 SessionManager 的通知（审批/提问/完成/错误）回发到对应 QQ 会话。
 * 多租户映射由 QqBindingsStore 维护，配对码由 PairingCodeStore 下发。
 */
import { Store } from "../store.js";
import { SessionManager, ApiError } from "../session.js";
import {
  approvalInputFromData,
  approvalToMarkdownTable,
} from "../../engine/approvalView.js";
import type { NotifyEvent, TenantConfig } from "../types.js";
import type { QqClient, QqMessage, QqTarget } from "./types.js";
import { QqBindingsStore, conversationKey, targetFromKey } from "./bindings.js";
import { PairingCodeStore } from "./pairingCodes.js";
import { parseCommand, parseDecision, HELP_TEXT } from "./commands.js";

/** 会话状态中文标签 */
function statusLabel(status: string): string {
  switch (status) {
    case "idle":
      return "空闲";
    case "running":
      return "运行中";
    case "waiting_approval":
      return "等待审批";
    case "waiting_question":
      return "等待回答";
    case "completed":
      return "已完成";
    case "stopped":
      return "已停止（达迭代上限）";
    case "error":
      return "出错";
    case "interrupted":
      return "已中断";
    default:
      return status;
  }
}

/** 通知事件 → QQ 文本 */
export function notifyToQqText(ev: NotifyEvent): string {
  const d = ev.data;
  switch (ev.kind) {
    case "approval_request": {
      const table = approvalToMarkdownTable(approvalInputFromData(d), {
        title: "🔒 需要审批",
      });
      return `${table}\n回复：同意(仅本次) / 全部同意(总是允许) / 拒绝`;
    }
    case "question_asked":
      return `需要回答：${String(d["question"] ?? "")}\n回复 /answer <内容> 或直接发消息`;
    case "turn_completed": {
      const summary = typeof d["summary"] === "string" ? d["summary"].trim() : "";
      return summary ? `任务完成 ✅\n\n${summary}` : `任务完成 ✅（状态 ${String(d["status"] ?? "")}）`;
    }
    case "turn_stopped":
      return `任务达到迭代上限（未完成），可 /new 或继续发消息补充`;
    case "error":
      return `任务出错：${String(d["error"] ?? "未知错误")}`;
    default:
      return "";
  }
}

export interface QqAdapterOptions {
  client: QqClient;
  store: Store;
  manager: SessionManager;
  bindings: QqBindingsStore;
  pairingCodes: PairingCodeStore;
}

export class QqAdapter {
  constructor(private readonly opts: QqAdapterOptions) {}

  start(): void {
    this.opts.client.onMessage((msg) => this.handleMessage(msg));
    void this.opts.client.start();
  }

  stop(): void {
    this.opts.client.stop();
  }

  /** 处理一条 QQ 消息（命令路由） */
  async handleMessage(msg: QqMessage): Promise<void> {
    try {
      await this._dispatch(msg);
    } catch (e) {
      const text =
        e instanceof ApiError
          ? `操作失败：${e.message}`
          : e instanceof Error
            ? `内部错误：${e.message}`
            : "内部错误";
      await this._reply(msg.target, text, msg.msgId);
    }
  }

  /** 通知回发：按租户+会话反查 QQ 会话并发送（主动消息） */
  async onNotify(tenantId: string, ev: NotifyEvent): Promise<void> {
    const key = this.opts.bindings.findByTenantSession(tenantId, ev.sessionId);
    if (!key) return;
    const target = targetFromKey(key);
    if (!target) return;
    const text = notifyToQqText(ev);
    if (!text) return;
    console.log(`[qq] 通知回发 ${ev.kind} → ${key}:\n${text}`);
    await this._reply(target, text);
  }

  // ===================== 内部 =====================

  private async _dispatch(msg: QqMessage): Promise<void> {
    const key = conversationKey(msg.target);
    const cmd = parseCommand(msg.content);

    switch (cmd.kind) {
      case "bind":
        return this._bind(key, msg.target, msg.msgId, cmd.code);
      case "unbind":
        this.opts.bindings.delete(key);
        return this._reply(msg.target, "已解除绑定", msg.msgId);
      case "new":
        return this._newSession(key, msg.target, msg.msgId);
      case "status":
        return this._status(key, msg.target, msg.msgId);
      case "list":
        return this._list(key, msg.target, msg.msgId);
      case "stop":
        return this._stop(key, msg.target, msg.msgId);
      case "approve":
        return this._approve(key, msg.target, msg.msgId, cmd.decision);
      case "answer":
        return this._answer(key, msg.target, msg.msgId, cmd.text);
      case "task":
        return this._task(key, msg.target, msg.msgId, cmd.text);
      case "help":
        return this._reply(msg.target, HELP_TEXT, msg.msgId);
      case "unknown":
        return this._reply(msg.target, `未知命令：${cmd.raw}\n\n${HELP_TEXT}`, msg.msgId);
    }
  }

  /**
   * 加载绑定中的租户。
   * 单租户场景：未绑定时自动绑定到唯一租户，无需用户操作；
   * 多租户场景：未绑定返回 null 并提示绑定。
   */
  private _bound(
    key: string,
    target: QqTarget,
    msgId: string,
  ): { tenant: TenantConfig; sessionId: string | null } | null {
    const binding = this.opts.bindings.get(key);
    if (!binding) {
      const single = this._singleTenantId();
      if (single) {
        const tenant = this.opts.store.loadTenant(single);
        if (!tenant) {
          void this._reply(target, `租户 ${single} 不存在`, msgId);
          return null;
        }
        this.opts.bindings.set(key, { tenantId: single, sessionId: null });
        return { tenant, sessionId: null };
      }
      void this._reply(
        target,
        "尚未绑定租户，请发送 /bind <配对码>（配对码在服务端生成）",
        msgId,
      );
      return null;
    }
    const tenant = this.opts.store.loadTenant(binding.tenantId);
    if (!tenant) {
      void this._reply(target, `绑定的租户 ${binding.tenantId} 不存在`, msgId);
      return null;
    }
    return { tenant, sessionId: binding.sessionId };
  }

  /** 系统仅有一个租户时返回其 id，否则 null */
  private _singleTenantId(): string | null {
    const ids = this.opts.store.listTenants();
    return ids.length === 1 ? ids[0]! : null;
  }

  /** 确保存在会话（无则创建并落绑定） */
  private _ensureSession(
    key: string,
    tenant: TenantConfig,
    sessionId: string | null,
  ): string {
    if (sessionId) return sessionId;
    const rec = this.opts.manager.createSession(tenant, {});
    this.opts.bindings.set(key, { tenantId: tenant.id, sessionId: rec.sessionId });
    return rec.sessionId;
  }

  private async _bind(
    key: string,
    target: QqTarget,
    msgId: string,
    code: string,
  ): Promise<void> {
    // 空码：单租户时自动绑定，无需配对码
    if (!code) {
      const single = this._singleTenantId();
      if (!single) {
        return this._reply(
          target,
          "系统存在多个租户，请发送 /bind <配对码>（配对码在服务端生成）",
          msgId,
        );
      }
      const tenant = this.opts.store.loadTenant(single);
      if (!tenant) {
        return this._reply(target, `租户 ${single} 不存在`, msgId);
      }
      this.opts.bindings.set(key, { tenantId: single, sessionId: null });
      return this._reply(
        target,
        `绑定成功 ✅ 租户：${single}。现在直接发消息即可开始任务。`,
        msgId,
      );
    }
    // 有配对码：校验并绑定
    const tenantId = this.opts.pairingCodes.consume(code);
    if (!tenantId) {
      return this._reply(target, "配对码无效或已过期，请重新生成", msgId);
    }
    const tenant = this.opts.store.loadTenant(tenantId);
    if (!tenant) {
      return this._reply(target, `租户 ${tenantId} 不存在`, msgId);
    }
    this.opts.bindings.set(key, { tenantId, sessionId: null });
    return this._reply(
      target,
      `绑定成功 ✅ 租户：${tenantId}。现在直接发消息即可开始任务。`,
      msgId,
    );
  }

  private async _newSession(
    key: string,
    target: QqTarget,
    msgId: string,
  ): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    const rec = this.opts.manager.createSession(bound.tenant, {});
    this.opts.bindings.set(key, {
      tenantId: bound.tenant.id,
      sessionId: rec.sessionId,
    });
    return this._reply(target, `已新建会话 ${rec.sessionId}`, msgId);
  }

  private async _status(
    key: string,
    target: QqTarget,
    msgId: string,
  ): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    if (!bound.sessionId) {
      return this._reply(target, "尚未创建会话，直接发消息即可开始", msgId);
    }
    const rec = this.opts.manager.getSession(bound.tenant.id, bound.sessionId);
    if (!rec) {
      return this._reply(target, "会话不存在，请 /new 新建", msgId);
    }
    const pendingApproval = rec.approvals.filter((a) => a.status === "pending").length;
    const pendingQuestion = rec.questions.filter((q) => q.status === "pending").length;
    return this._reply(
      target,
      `会话：${rec.sessionId}\n状态：${statusLabel(rec.status)}\n` +
        (pendingApproval ? `待审批：${pendingApproval} 项\n` : "") +
        (pendingQuestion ? `待回答：${pendingQuestion} 项\n` : "") +
        `消息数：${(rec.messages as unknown[]).length}`,
      msgId,
    );
  }

  private async _list(key: string, target: QqTarget, msgId: string): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    const sessions = this.opts.manager.listSessions(bound.tenant.id);
    if (sessions.length === 0) {
      return this._reply(target, "暂无会话", msgId);
    }
    const lines = sessions.map(
      (s) => `- ${s.sessionId} [${statusLabel(s.status)}]`,
    );
    return this._reply(target, `会话列表（${sessions.length}）：\n${lines.join("\n")}`, msgId);
  }

  private async _stop(key: string, target: QqTarget, msgId: string): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    if (!bound.sessionId) return this._reply(target, "当前无会话", msgId);
    this.opts.manager.interrupt(bound.tenant, bound.sessionId);
    return this._reply(target, "已请求中断", msgId);
  }

  private async _approve(
    key: string,
    target: QqTarget,
    msgId: string,
    decision: import("../../engine/events.js").ApprovalOutcome,
  ): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    if (!bound.sessionId) return this._reply(target, "当前无会话", msgId);
    const rec = this.opts.manager.getSession(bound.tenant.id, bound.sessionId);
    const pending = rec?.approvals.find((a) => a.status === "pending");
    if (!rec || !pending) {
      return this._reply(target, "当前没有待审批项", msgId);
    }
    this.opts.manager.answerApproval(bound.tenant, bound.sessionId, pending.id, decision);
    return this._reply(target, "已提交审批结果", msgId);
  }

  private async _answer(
    key: string,
    target: QqTarget,
    msgId: string,
    text: string,
  ): Promise<void> {
    const bound = this._bound(key, target, msgId);
    if (!bound) return;
    if (!bound.sessionId) return this._reply(target, "当前无会话", msgId);
    if (!text) return this._reply(target, "用法：/answer <内容>", msgId);
    const rec = this.opts.manager.getSession(bound.tenant.id, bound.sessionId);
    const pending = rec?.questions.find((q) => q.status === "pending");
    if (!rec || !pending) {
      return this._reply(target, "当前没有待回答的问题", msgId);
    }
    this.opts.manager.answerQuestion(bound.tenant, bound.sessionId, pending.id, text);
    return this._reply(target, "已提交回答", msgId);
  }

  private async _task(
    key: string,
    target: QqTarget,
    msgId: string,
    text: string,
  ): Promise<void> {
    if (!text.trim()) return;
    const bound = this._bound(key, target, msgId);
    if (!bound) return;

    const sessionId = this._ensureSession(key, bound.tenant, bound.sessionId);

    // 若存在待回答的提问，普通文本优先作为答案
    const rec = this.opts.manager.getSession(bound.tenant.id, sessionId);
    const pendingQuestion = rec?.questions.find((q) => q.status === "pending");
    if (rec && pendingQuestion) {
      this.opts.manager.answerQuestion(bound.tenant, sessionId, pendingQuestion.id, text);
      return this._reply(target, "已作为答案提交", msgId);
    }

    // 若存在待审批，普通文本若是决策词（同意/拒绝等）则作为审批结果
    const pendingApproval = rec?.approvals.find((a) => a.status === "pending");
    if (rec && pendingApproval) {
      const decision = parseDecision(text);
      if (decision) {
        this.opts.manager.answerApproval(bound.tenant, sessionId, pendingApproval.id, decision);
        return this._reply(target, "已提交审批结果", msgId);
      }
      return this._reply(
        target,
        "当前有任务等待审批，请回复：同意(仅本次) / 全部同意(总是允许) / 拒绝",
        msgId,
      );
    }

    const result = this.opts.manager.submitOrSteer(bound.tenant, sessionId, text);
    return this._reply(
      target,
      result === "steered"
        ? "已作为补充信息注入当前任务，将在下一迭代生效"
        : "任务已提交，执行中…",
      msgId,
    );
  }

  /** 尽力而为发送，异常仅记录 */
  private async _reply(target: QqTarget, content: string, msgId?: string): Promise<void> {
    try {
      await this.opts.client.send(target, content, msgId);
    } catch (e) {
      console.log(
        `[qq] 回复失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
