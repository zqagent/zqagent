/**
 * 运行形态与自更新能力判定。
 *
 * 只有「SEA 单文件 + 由 systemd/launchd 托管 + 配置了公钥」三者同时满足，
 * 才允许自动替换可执行文件并重启——否则退出后没人把它拉起来。
 */
import * as path from "node:path";
import { createRequire } from "node:module";

/**
 * 当前版本：构建期注入（SEA/tsup define）优先，其次读包内 package.json，
 * 最后回退 "dev"。后两条让源码运行（tsx）也能显示真实版本。
 */
export function currentVersion(): string {
  const injected = process.env.ZQAGENT_VERSION?.trim();
  if (injected) return injected;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    if (pkg?.version) return pkg.version;
  } catch {
    // SEA 内取不到包信息，忽略
  }
  return "dev";
}

/**
 * 是否为 SEA 单文件运行。
 *
 * 判据优先取 execPath 的文件名：SEA 产物是 `zqagent`，经 node 运行的则是 `node`。
 * 构建期还会注入 `ZQAGENT_SEA=1`（见 tsup.sea.config.ts）作为权威标记。
 */
export function isSeaRuntime(): boolean {
  if (process.env.ZQAGENT_SEA === "1") return true;
  const base = path.basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  return base !== "node" && base !== "nodejs";
}

export type ServiceManager = "systemd" | "launchd";

/** 由 deploy/service/install.sh 渲染注入；缺失说明是前台/nohup 运行 */
export function serviceManager(): ServiceManager | null {
  const v = process.env.ZQAGENT_SERVICE_MANAGER?.trim().toLowerCase();
  return v === "systemd" || v === "launchd" ? v : null;
}

export function autoUpdateDisabled(): boolean {
  return process.env.ZQAGENT_AUTO_UPDATE?.trim() === "0";
}

export interface Capability {
  ok: boolean;
  /** 不满足时的可读原因（用于日志/`update --status`） */
  reason?: string;
}

/**
 * 自更新能力判定。`hasPublicKey` 由调用方传入（公钥只在验签时解析一次）。
 */
export function selfUpdateCapability(hasPublicKey: boolean): Capability {
  if (!isSeaRuntime()) {
    return {
      ok: false,
      reason: "当前不是单文件（SEA）形态：请用 npm 升级（npm i -g @zqagent/core@latest）",
    };
  }
  if (!serviceManager()) {
    return {
      ok: false,
      reason: "未被 systemd/launchd 托管：请用 deploy/service/install.sh 安装，或手动升级",
    };
  }
  if (!hasPublicKey) {
    return { ok: false, reason: "未配置 ZQAGENT_UPDATE_PUBKEY，无法验签，已禁用自动更新" };
  }
  return { ok: true };
}
