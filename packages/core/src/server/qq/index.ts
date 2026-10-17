/**
 * QQ 机器人模块聚合导出（供 server/index.ts 装配）
 */
export type {
  QqClient,
  QqMessage,
  QqMessageHandler,
  QqStatusHandler,
  QqTarget,
} from "./types.js";
export { OfficialBotClient } from "./OfficialBotClient.js";
export type { OfficialBotOptions } from "./OfficialBotClient.js";
export { QqAdapter } from "./QqAdapter.js";
export type { QqAdapterOptions } from "./QqAdapter.js";
export { QqManager } from "./QqManager.js";
export type { QqManagerOptions, QqConfig } from "./QqManager.js";
export {
  QqBindingsStore,
  conversationKey,
  targetFromKey,
} from "./bindings.js";
export type { ConversationBinding, QqBindings } from "./bindings.js";
export { PairingCodeStore } from "./pairingCodes.js";
export { parseCommand, parseDecision, HELP_TEXT } from "./commands.js";
export type { ParsedCommand } from "./commands.js";
