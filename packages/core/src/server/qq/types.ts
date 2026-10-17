/**
 * QQ 机器人模块 — 核心类型
 *
 * 定义消息目标（单聊/群聊/频道）、消息事件、以及可注入的客户端抽象，
 * 供 OfficialBotClient 实现、QqAdapter 消费、测试 mock 复用。
 */

/** 消息目标：决定发送消息时走哪条 API */
export type QqTarget =
  | { kind: "c2c"; openid: string } // 单聊
  | { kind: "group"; groupOpenid: string } // 群聊
  | { kind: "channel"; channelId: string } // 频道 @机器人
  | { kind: "guild_direct"; guildId: string }; // 频道私信

/** 归一化后的消息事件（已从平台事件 d 中提取） */
export interface QqMessage {
  /** 平台事件/消息 id，用于去重 */
  eventId: string;
  /** 消息文本内容 */
  content: string;
  /** 来源（亦为回复目标） */
  target: QqTarget;
  /** 消息 id（被动回复时回填，5 分钟窗口内有效） */
  msgId: string;
  /** 发送者标识（openid，用于日志/权限） */
  senderId: string;
}

/** 消息回调 */
export type QqMessageHandler = (msg: QqMessage) => void | Promise<void>;

/** 连接状态回调 */
export type QqStatusHandler = (connected: boolean) => void;

/**
 * QQ 客户端抽象。OfficialBotClient 实现；测试用 fake 实现。
 */
export interface QqClient {
  /** 建立网关连接（幂等） */
  start(): Promise<void>;
  /** 断开连接（幂等） */
  stop(): void;
  /** 发送文本消息；msgId 存在时走被动回复（优先） */
  send(target: QqTarget, content: string, msgId?: string): Promise<void>;
  /** 注册消息回调 */
  onMessage(handler: QqMessageHandler): void;
  /** 注册状态回调 */
  onStatus(handler: QqStatusHandler): void;
}
