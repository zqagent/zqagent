/**
 * 节点节点管理配置解析
 *
 * 优先级：`{DATA_DIR}/fleet.json`（应用内接入、落盘）→ 环境变量回退（旧部署兼容）。
 *
 * 节点 ID 以 `{DATA_DIR}/node.json`（`ensureNodeId`）为权威：首次生成后长期固定，
 * 注册码接入 / 节点管理连接都使用它，避免被其他节点管理重复纳管（防抢注）。
 */
import type { FleetCredential } from "@zqagent/shared/fleet";
import { Store } from "./store.js";
import { ensureNodeId } from "./projects.js";

/** 节点管理状态视图（供 CLI / 桌面 / admin 接口展示；不含密钥） */
export interface FleetStatusView {
  /** 是否已接入云端（连接已建立/正在连接） */
  linked: boolean;
  nodeId: string;
  hubUrl?: string;
  /** Rust 网关地址（云端接入的唯一传输；见 FLEET_GATEWAY_URL） */
  gatewayUrl?: string;
  online: boolean;
  label?: string;
  /** 最近一次连接错误；无错误时缺省 */
  lastError?: string;
  /** 连续连接失败次数（连接成功后清零） */
  reconnectCount?: number;
}

/** 运行时云端接入控制器：查询 / 凭码接入 / 解绑（热接入，免重启） */
export interface FleetController {
  status(): FleetStatusView;
  enroll(input: { hubUrl: string; code: string; label?: string }): Promise<FleetStatusView>;
  unlink(): void;
  /** 当前配对凭据（供 GET /api/v1/fleet/pairing；未接入时 null） */
  pairing(): {
    gatewayUrl?: string;
    fleetToken: string;
    fleetSecret: string;
    nodeId: string;
  } | null;
}

/** 环境变量回退：FLEET_TOKEN + FLEET_SECRET（两者齐备才生效；网关地址另由 FLEET_GATEWAY_URL 给） */
export function fleetConfigFromEnv(store: Store): FleetCredential | null {
  const fleetToken = process.env.FLEET_TOKEN;
  const fleetSecret = process.env.FLEET_SECRET;
  if (!fleetToken || !fleetSecret) return null;
  return {
    hubUrl: process.env.HUB_URL,
    fleetToken,
    fleetSecret,
    nodeId: ensureNodeId(store),
    gatewayUrl: process.env.FLEET_GATEWAY_URL,
  };
}

/**
 * 解析本节点应使用的节点管理配置。
 * fleet.json 优先（本地已接入），否则回退环境变量；都没有则返回 null（纯本地节点）。
 */
export function resolveFleetConfig(store: Store): FleetCredential | null {
  const saved = store.loadFleetCredential();
  if (saved?.fleetToken && saved.fleetSecret) {
    return { ...saved, nodeId: saved.nodeId || ensureNodeId(store) };
  }
  return fleetConfigFromEnv(store);
}
