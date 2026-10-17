/**
 * 共享类型：通知事件与渠道配置
 *
 * 从 server/types.ts 抽出，供 core（节点）与 hub（控制面）共用的通知模块引用。
 */

/** 通知种类 */
export type NotifyKind =
  | "approval_request" // 需要审批（data: approvalId / toolName / arguments / reason）
  | "question_asked" // 需要回答提问（data: questionId / kind / question / options / ...）
  | "turn_completed" // 一轮 Turn 正常完成（data: status / iterations / produced_files）
  | "turn_stopped" // 达到最大迭代次数等提前终止
  | "error" // 出错（data: error / retriable）
  /**
   * 会话状态变化（data: status）。
   *
   * 只承载状态机取值，不含消息/模型/token 等明细——跨节点总览只靠它同步，
   * 明细仍去会话详情页拉。与上面几种「需要人处理」的通知不同，它**不面向
   * 第三方渠道**（见 `channelWants`），也不弹提醒。
   */
  | "session_status";

/**
 * 通知事件：SessionManager 在审批挂起 / 提问挂起 / 完成 / 出错等关键点产出，
 * 交给通知中枢（NotificationHub / 节点桥）广播到多设备或第三方渠道。
 */
export interface NotifyEvent {
  kind: NotifyKind;
  sessionId: string;
  ts: string;
  data: Record<string, unknown>;
}

/** 通知渠道类型 */
export type NotificationChannelType =
  | "mqtt"
  | "telegram"
  | "wecom"
  | "dingtalk"
  | "feishu"
  | "serverchan"
  | "pushplus"
  | "bark"
  | "email"
  | "sms"
  | "qq"
  | "webpush"
  | "webhook";

/** 通知渠道配置（敏感字段如 token / password 以密文存储） */
export interface NotificationChannelConfig {
  id: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, string>;
  events: {
    approval: boolean;
    question: boolean;
    completed: boolean;
    error: boolean;
  };
}
