/**
 * QqManager — QQ 机器人的配置持久化 + 热更新编排
 *
 * 相比直接创建 QqAdapter，QqManager 额外承担：
 *   - QQ 全局配置（appId/appSecret/sandbox）的持久化到 {DATA_DIR}/qq/config.json
 *   - 热更新：运行时改配置后重建 client + 重连，无需重启 server
 *   - 配置来源优先级：环境变量 > 配置文件（首次无文件时 env 生效）
 *
 * 这样「AI 通过 tools 配置 QQ」成为可能：调 POST /api/v1/qq/config 即可立即生效，
 * 且重启后（只要 env 未设置）继续沿用文件中的配置。
 */
import * as fs from "fs";
import * as path from "path";
import { Store } from "../store.js";
import { SessionManager } from "../session.js";
import type { NotifyEvent } from "../types.js";
import { OfficialBotClient } from "./OfficialBotClient.js";
import { QqAdapter } from "./QqAdapter.js";
import { QqBindingsStore } from "./bindings.js";
import { PairingCodeStore } from "./pairingCodes.js";

/** QQ 全局配置 */
export interface QqConfig {
  appId: string;
  appSecret: string;
  sandbox: boolean;
}

export interface QqManagerOptions {
  store: Store;
  manager: SessionManager;
  bindings: QqBindingsStore;
  pairingCodes: PairingCodeStore;
  /** 配置文件目录（通常为 DATA_DIR） */
  dataDir: string;
}

export class QqManager {
  private adapter: QqAdapter | null = null;
  private config: QqConfig | null = null;

  constructor(private readonly opts: QqManagerOptions) {}

  private get configFile(): string {
    return path.join(this.opts.dataDir, "qq", "config.json");
  }

  /** 启动：读配置（env 优先，其次文件），有则建连接 */
  start(): void {
    const cfg = this._loadConfig();
    if (cfg) {
      this._applyConfig(cfg);
      console.log(`[qq] 已启用 (appId=${cfg.appId} sandbox=${cfg.sandbox})`);
    }
  }

  /** 停止并断开 */
  stop(): void {
    this.adapter?.stop();
    this.adapter = null;
    this.config = null;
  }

  /** 当前生效配置（脱敏，不返回 secret） */
  getConfig(): { appId: string; sandbox: boolean } | null {
    if (!this.config) return null;
    return { appId: this.config.appId, sandbox: this.config.sandbox };
  }

  /** 是否已建立连接 */
  isRunning(): boolean {
    return this.adapter !== null;
  }

  /** 生成配对码（委托给 PairingCodeStore） */
  issuePairingCode(tenantId: string): { code: string; expiresIn: number } {
    return this.opts.pairingCodes.issue(tenantId);
  }

  /** 热更新配置：持久化 + 立即重建连接（无需重启） */
  updateConfig(cfg: QqConfig): void {
    this._persistConfig(cfg);
    this._applyConfig(cfg);
    console.log(`[qq] 配置已热更新 (appId=${cfg.appId} sandbox=${cfg.sandbox})`);
  }

  /** 清空配置：删除文件 + 断开 */
  clearConfig(): void {
    try {
      fs.rmSync(this.configFile, { force: true });
    } catch {
      // 忽略
    }
    this.stop();
  }

  /** 通知回发（桥接 SessionManager 的通知） */
  onNotify(tenantId: string, ev: NotifyEvent): void {
    void this.adapter?.onNotify(tenantId, ev);
  }

  // ===================== 内部 =====================

  private _applyConfig(cfg: QqConfig): void {
    this.stop();
    const client = new OfficialBotClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      sandbox: cfg.sandbox,
    });
    this.adapter = new QqAdapter({
      client,
      store: this.opts.store,
      manager: this.opts.manager,
      bindings: this.opts.bindings,
      pairingCodes: this.opts.pairingCodes,
    });
    this.adapter.start();
    this.config = cfg;
  }

  /** 配置来源：env 优先，其次配置文件 */
  private _loadConfig(): QqConfig | null {
    const envId = process.env.QQ_BOT_APP_ID;
    const envSecret = process.env.QQ_BOT_APP_SECRET;
    if (envId && envSecret) {
      return {
        appId: envId,
        appSecret: envSecret,
        sandbox: process.env.QQ_BOT_SANDBOX === "1",
      };
    }
    return this._readConfigFile();
  }

  private _readConfigFile(): QqConfig | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, "utf-8")) as Partial<QqConfig>;
      if (raw.appId && raw.appSecret) {
        return {
          appId: raw.appId,
          appSecret: raw.appSecret,
          sandbox: raw.sandbox === true,
        };
      }
    } catch {
      // 无文件或损坏
    }
    return null;
  }

  private _persistConfig(cfg: QqConfig): void {
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), "utf-8");
  }
}
