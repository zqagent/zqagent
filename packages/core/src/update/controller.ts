/**
 * 自动更新调度器。
 *
 * 生命周期：`start()` 后按「启动延迟 + 固定间隔」拉清单；发现新版本即静默下载并自检，
 * 之后**等到节点空闲**（连续 60s 没有 running / waiting 会话）才替换可执行文件并退出，
 * 由 systemd/launchd 拉起新版本。
 *
 * 所有重活都在后台进行，任何失败只记日志，不影响节点服务。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fetchManifest, downloadBinary, selfCheck } from "./downloader.js";
import { platformKey } from "./manifest.js";
import { compareVersions, parseVersion } from "./version.js";
import { currentVersion as currentVersionOf, isSeaRuntime, serviceEnvValue, serviceManager, selfUpdateCapability } from "./platform.js";
import { parsePublicKey } from "./signature.js";
import { installStaged, rollback as rollbackExecutable } from "./installer.js";
import { loadState, patchState, updatesDir, type UpdateState } from "./state.js";

const DEFAULT_BASE = "https://agent.cd-zq.com/downloads/zqagent";

export interface UpdaterOptions {
  dataDir: string;
  /** 是否空闲（无 running / waiting 会话） */
  isIdle: () => boolean;
  /** 替换前关闭服务（落盘账本、断连） */
  prepareExit?: () => void;
  log?: (msg: string) => void;
  /** 清单地址覆盖（测试/内网） */
  url?: string;
}

export interface UpdaterStatus {
  enabled: boolean;
  reason?: string;
  currentVersion: string;
  channel: string;
  manifestUrl: string;
  serviceManager: string | null;
  lastCheckAt?: string;
  stagedVersion?: string;
  pendingVersion?: string;
  previousVersion?: string;
  backupVersion?: string;
  lastError?: string;
}

/** 版本检查结果（`self_update --action check` 用；不下载、不写状态） */
export interface UpdateInspect {
  currentVersion: string;
  channel: string;
  manifestUrl: string;
  /** 清单里是否有比当前更新的版本 */
  updateAvailable: boolean;
  /** 清单里的最新版本（拉不到清单时缺省） */
  latestVersion?: string;
  notes?: string;
  /** 不可更新的原因（已是最新 / 未启用 / 需手动升级…） */
  reason?: string;
  /** 低于清单要求的最低版本时给出该下限 */
  manualUpgradeRequired?: string;
}

/** 远端触发安装的回执（ack 先回，安装本身在后台跑） */
export interface UpdateInstallStart {
  /** 是否已受理（false 表示无需更新或不可更新） */
  accepted: boolean;
  fromVersion: string;
  toVersion?: string;
  message: string;
}

/**
 * 读取更新配置：进程环境优先，缺失时回落到 systemd unit 注入的变量。
 *
 * 后台服务天然带全部变量；运维在交互 shell 里执行 `zqagent update` 时
 * 只有回落这一条路，否则公钥/通道/清单地址都会被判成「未配置」。
 */
function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  if (v) return v;
  const fromService = serviceEnvValue(key)?.trim();
  return fromService ? fromService : undefined;
}

function num(key: string, fallback: number): number {
  const n = Number(env(key));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function updaterChannel(): string {
  return env("ZQAGENT_UPDATE_CHANNEL") ?? "stable";
}

export function updaterUrl(channel = updaterChannel()): string {
  return env("ZQAGENT_UPDATE_URL") ?? `${DEFAULT_BASE}/${channel}.json`;
}

/** 更新间隔：默认 6h，±15% 抖动，避免整批节点同时打同一台静态服务器 */
function nextIntervalMs(): number {
  const base = num("ZQAGENT_UPDATE_INTERVAL_MS", 6 * 60 * 60 * 1000);
  const jitter = base * 0.15 * (Math.random() * 2 - 1);
  return Math.max(60_000, Math.round(base + jitter));
}

/**
 * 清单 → 检查结论（纯函数，便于单测）。
 *
 * 只有「清单版本更高、且当前版本满足 minimumVersion」才算可更新；
 * 其余情况都要给出 `reason`，让远端 UI 能直接展示原因而不是靠猜。
 */
export function evaluateManifest(
  base: { currentVersion: string; channel: string; manifestUrl: string },
  manifest: { version: string; minimumVersion?: string; notes?: string },
): UpdateInspect {
  if (!parseVersion(base.currentVersion) ||
      compareVersions(manifest.version, base.currentVersion) <= 0) {
    return {
      ...base,
      updateAvailable: false,
      latestVersion: manifest.version,
      reason: `已是最新版本（v${base.currentVersion}）`,
    };
  }
  if (manifest.minimumVersion &&
      compareVersions(base.currentVersion, manifest.minimumVersion) < 0) {
    return {
      ...base,
      updateAvailable: false,
      latestVersion: manifest.version,
      manualUpgradeRequired: manifest.minimumVersion,
      reason: `当前版本过低，需手动升级到 >= ${manifest.minimumVersion}`,
    };
  }
  return {
    ...base,
    updateAvailable: true,
    latestVersion: manifest.version,
    ...(manifest.notes ? { notes: manifest.notes } : {}),
  };
}

export class UpdateController {
  private readonly log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private checking = false;
  private installing = false;
  private startedAt = Date.now();
  private lastCheckAt?: string;

  constructor(
    private readonly opts: UpdaterOptions,
    private readonly currentVersion = currentVersionOf(),
  ) {
    this.log = opts.log ?? ((msg) => console.log(`[update] ${msg}`));
  }

  /** 公钥（未配置时禁用自更新：无法验签就不能替换可执行文件） */
  private get publicKey() {
    return parsePublicKey(env("ZQAGENT_UPDATE_PUBKEY") ?? "");
  }

  private get autoUpdateOff(): boolean {
    return env("ZQAGENT_AUTO_UPDATE") === "0";
  }

  get enabled(): boolean {
    return !this.autoUpdateOff && selfUpdateCapability(Boolean(this.publicKey)).ok;
  }

  private manifestUrl(): string {
    return this.opts.url ?? updaterUrl();
  }

  /** 启动调度并核对上次更新结果 */
  start(): void {
    this.reconcile();
    if (this.autoUpdateOff) {
      this.log("自动更新已关闭（ZQAGENT_AUTO_UPDATE=0）");
      return;
    }
    const cap = selfUpdateCapability(Boolean(this.publicKey));
    if (!cap.ok) {
      this.log(`自动更新未启用：${cap.reason}`);
      return;
    }
    this.log(
      `自动更新已启用（v${this.currentVersion}，通道 ${updaterChannel()}，` +
        `由 ${serviceManager()} 托管）`,
    );
    this.schedule(num("ZQAGENT_UPDATE_INITIAL_DELAY_MS", 5 * 60 * 1000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 启动时对账：确认上次更新是否成功、清理失效的暂存/备份状态 */
  private reconcile(): void {
    const state = loadState(this.opts.dataDir);
    const current = this.currentVersion;

    if (state.stagedPath && !fs.existsSync(state.stagedPath)) {
      patchState(this.opts.dataDir, { stagedVersion: undefined, stagedPath: undefined });
    }

    const patch: Partial<UpdateState> = { runningVersion: current };
    if (state.pendingVersion && state.pendingVersion === current) {
      patch.pendingVersion = undefined;
      this.log(`已更新到 v${current}（此前 v${state.previousVersion ?? "?"}）`);
    } else if (state.pendingVersion) {
      // 新版本没能起来（被回滚或被服务管理器恢复）：保留备份信息，仅提示
      this.log(
        `注意：上次安装 v${state.pendingVersion} 未生效，当前仍为 v${current}` +
          (state.backupPath ? "；可执行 update --rollback 恢复备份" : ""),
      );
      patch.pendingVersion = undefined;
    }
    patchState(this.opts.dataDir, patch);

    // Windows：清理上次替换留下的 .old
    if (process.platform === "win32") {
      fs.rmSync(`${process.execPath}.old`, { force: true });
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      this.log(`检查更新失败：${(err as Error).message}`);
    }
    this.schedule(nextIntervalMs());
  }

  /**
   * 只读检查：拉清单比对版本，不下载、不改 state。
   *
   * 供远端 `self_update --action check` 与 UI 展示用；与定时器 `check()` 不同，
   * 这里不加 `checking` 锁、不写 `lastCheckAt`，因此不会干扰自动更新流程。
   */
  async inspect(): Promise<UpdateInspect> {
    const base = {
      currentVersion: this.currentVersion,
      channel: updaterChannel(),
      manifestUrl: this.manifestUrl(),
    };
    const key = this.publicKey;
    const cap = selfUpdateCapability(Boolean(key));
    if (!cap.ok) {
      return { ...base, updateAvailable: false, reason: `自更新不可用：${cap.reason}` };
    }
    const res = await fetchManifest(base.manifestUrl, key!, {
      allowInsecureUrl: env("ZQAGENT_UPDATE_INSECURE") === "1",
    });
    if (!res.manifest) {
      return {
        ...base,
        updateAvailable: false,
        reason: `更新检查失败：${res.error ?? "清单校验失败"}`,
      };
    }
    return evaluateManifest(base, res.manifest);
  }

  /**
   * 远端触发安装：先同步给出结论（受理/无需更新），安装本身在后台跑。
   *
   * 必须「先回执、后安装」：安装成功后进程会 `exit(70)` 交给 systemd 拉起新版本，
   * 如果等到安装完成再回执，回执永远发不出去（表现为网关超时）。
   *
   * 复用定时器同一条 `check()` 路径：验签、下载、自检、失败计数、安装后自检与
   * 回滚保护全都一致，只是把 `installMode` 设为 `force` 时不等待空闲。
   */
  async requestInstall(force = false): Promise<UpdateInstallStart> {
    const fromVersion = this.currentVersion;
    const cap = selfUpdateCapability(Boolean(this.publicKey));
    if (!cap.ok) {
      return { accepted: false, fromVersion, message: `自更新不可用：${cap.reason}` };
    }

    const info = await this.inspect();
    if (!info.updateAvailable) {
      return {
        accepted: false,
        fromVersion,
        ...(info.latestVersion ? { toVersion: info.latestVersion } : {}),
        message: info.reason ?? "已是最新版本",
      };
    }

    // 定时器可能刚起来一轮检查/安装：沿用它的进度，不重复下载
    if (this.checking || this.installing) {
      return {
        accepted: true,
        fromVersion,
        toVersion: info.latestVersion,
        message: `已有更新任务在进行中（目标 v${info.latestVersion}），可在稍后用 status 查看结果`,
      };
    }

    // 后台执行（ignoreSkip=true：用户显式触发，可越过「已回滚版本跳过」）
    void this.check(force, false, true).catch((err) => {
      this.recordFailure(info.latestVersion, `安装失败：${(err as Error).message}`);
    });
    return {
      accepted: true,
      fromVersion,
      toVersion: info.latestVersion,
      message: force
        ? `开始安装 v${info.latestVersion}（立即重启）`
        : `开始安装 v${info.latestVersion}（等待节点空闲后重启）`,
    };
  }

  /**
   * 检查并准备更新；`installMode` 为 true 时下载后立即安装（不再等空闲）。
   * 返回可读结论，供 CLI `update --check` 使用。
   */
  async check(installMode = false, dryRun = false, ignoreSkip = false): Promise<string> {
    const key = this.publicKey;
    const cap = selfUpdateCapability(Boolean(key));
    if (!cap.ok) return `未启用自动更新：${cap.reason}`;
    if (this.checking) return "已有检查在进行中";
    this.checking = true;

    try {
      const current = this.currentVersion;
      const url = this.manifestUrl();
      this.log(`检查更新：${url}`);
      const res = await fetchManifest(url, key!, {
        allowInsecureUrl: env("ZQAGENT_UPDATE_INSECURE") === "1",
      });
      if (!res.manifest) {
        this.recordFailure(undefined, res.error ?? "清单校验失败");
        return `更新检查失败：${res.error}`;
      }

      const manifest = res.manifest;
      this.lastCheckAt = new Date().toISOString();
      patchState(this.opts.dataDir, { lastCheckAt: this.lastCheckAt });

      if (!parseVersion(current) || compareVersions(manifest.version, current) <= 0) {
        patchState(this.opts.dataDir, {
          stagedVersion: undefined,
          stagedPath: undefined,
          lastError: undefined,
        });
        this.log(`已是最新版本（v${current}）`);
        return `已是最新版本（v${current}）`;
      }

      if (manifest.minimumVersion && compareVersions(current, manifest.minimumVersion) < 0) {
        this.recordFailure(manifest.version, `当前版本过低，需手动升级到 >= ${manifest.minimumVersion}`);
        return `需要手动升级：当前 v${current} 低于最低要求 v${manifest.minimumVersion}`;
      }

      // 只检查不下载：`update --check` 用，避免为看版本号拉一个 100MB 的包
      if (dryRun) {
        const notes = manifest.notes ? `：${manifest.notes}` : "";
        return `发现新版本 v${manifest.version}（当前 v${current}）${notes}`;
      }

      const state = loadState(this.opts.dataDir);

      // 用户回滚过这个版本：自动更新跳过，直到发布更新的版本
      if (!ignoreSkip && state.skippedVersion === manifest.version) {
        const msg = `v${manifest.version} 已被回滚，自动更新跳过（手动 update --now 可强制安装）`;
        this.log(msg);
        return msg;
      }
      if (state.skippedVersion && compareVersions(manifest.version, state.skippedVersion) > 0) {
        // 出现更新的版本，解除跳过
        patchState(this.opts.dataDir, { skippedVersion: undefined });
      }

      const maxFailures = num("ZQAGENT_UPDATE_MAX_FAILURES", 3);
      if (state.failedVersion === manifest.version && (state.failureCount ?? 0) >= maxFailures) {
        return `v${manifest.version} 已连续失败 ${state.failureCount} 次，跳过（等待下一版本）`;
      }

      const bin = manifest.binaries[platformKey()];
      if (!bin) return `清单没有当前平台（${platformKey()}）的产物`;

      // 已暂存同一版本且文件有效 → 直接进入安装
      let stagedPath = state.stagedPath;
      if (!(state.stagedVersion === manifest.version && stagedPath && fs.existsSync(stagedPath))) {
        stagedPath = path.join(
          updatesDir(this.opts.dataDir),
          "staged",
          `zqagent-${manifest.version}${process.platform === "win32" ? ".exe" : ""}`,
        );
        const dl = await downloadBinary(bin, stagedPath, this.log);
        if (dl.error) {
          this.recordFailure(manifest.version, dl.error);
          return `下载失败：${dl.error}`;
        }

        const selfTest = selfCheck(stagedPath, manifest.version);
        if (!selfTest.ok) {
          fs.rmSync(stagedPath, { force: true });
          this.recordFailure(manifest.version, selfTest.error ?? "自检失败");
          return `安装包自检失败：${selfTest.error}`;
        }

        patchState(this.opts.dataDir, {
          stagedVersion: manifest.version,
          stagedPath,
          lastError: undefined,
          failureCount: 0,
          failedVersion: undefined,
        });
      }

      this.log(
        `v${manifest.version} 已就绪${manifest.notes ? `：${manifest.notes}` : ""}`,
      );
      await this.installWhenIdle(manifest.version, stagedPath, installMode);
      return `v${manifest.version} 已就绪`;
    } finally {
      this.checking = false;
    }
  }

  private recordFailure(version: string | undefined, error: string): void {
    const state = loadState(this.opts.dataDir);
    const sameVersion = version !== undefined && state.failedVersion === version;
    patchState(this.opts.dataDir, {
      lastError: error,
      failedVersion: version ?? state.failedVersion,
      failureCount: sameVersion ? (state.failureCount ?? 0) + 1 : 1,
    });
    this.log(error);
  }

  /** 等待节点连续空闲后安装；`installMode` 立即安装 */
  private async installWhenIdle(
    version: string,
    stagedPath: string,
    installMode: boolean,
  ): Promise<void> {
    if (this.installing) return;
    this.installing = true;

    try {
      if (!installMode) {
        const idleMs = num("ZQAGENT_UPDATE_IDLE_MS", 60 * 1000);
        this.log(`等待空闲后安装 v${version}（需连续空闲 ${Math.round(idleMs / 1000)}s）`);
        const ok = await this.waitForIdle();
        if (!ok) {
          this.installing = false;
          return;
        }
      }
      this.applyUpdate(version, stagedPath);
    } catch (err) {
      this.installing = false;
      this.recordFailure(version, `安装失败：${(err as Error).message}`);
    }
  }

  private waitForIdle(): Promise<boolean> {
    const minUptime = num("ZQAGENT_UPDATE_MIN_UPTIME_MS", 10 * 60 * 1000);
    const idleMs = num("ZQAGENT_UPDATE_IDLE_MS", 60 * 1000);
    let idleSince: number | null = null;

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.stopped) {
          clearInterval(timer);
          resolve(false);
          return;
        }
        if (Date.now() - this.startedAt < minUptime || !this.opts.isIdle()) {
          idleSince = null;
          return;
        }
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= idleMs) {
          clearInterval(timer);
          resolve(true);
        }
      }, 1000);
      timer.unref();
    });
  }

  private applyUpdate(version: string, stagedPath: string): void {
    this.opts.prepareExit?.();
    const execPath = process.execPath;
    installStaged({
      dataDir: this.opts.dataDir,
      execPath,
      stagedPath,
      version,
      log: this.log,
    });

    // 在真实目标路径上再验一次：staged 能跑不代表替换后能跑（SELinux 上下文、
    // noexec 挂载等都会让 systemd 侧 execve 失败并陷入 203/EXEC 重启循环）。
    // 验不过就立刻用备份回滚，保持节点可用。
    const verify = selfCheck(execPath, version);
    if (!verify.ok) {
      const restored = rollbackExecutable(this.opts.dataDir, execPath, this.log);
      // 回滚时 currentVersion() 还是旧版本，显式记下坏版本，避免下一轮又装回来
      patchState(this.opts.dataDir, { skippedVersion: version });
      this.recordFailure(
        version,
        `安装后自检失败（${verify.error ?? "未知错误"}）` +
          (restored ? `，已回滚到 v${restored}` : "，回滚失败，需人工处理"),
      );
      process.exit(1);
    }

    this.log(`已安装 v${version}，正在重启…`);
    // 非零退出：launchd 的 KeepAlive{SuccessfulExit=false} 只在非正常退出时拉起进程，
    // 用 0 退出会导致新版本不被启动（systemd 的 Restart=always 两者都重启）。
    process.exit(70);
  }

  /**
   * 用备份回滚；返回恢复到的版本。
   *
   * 目标路径优先取上次安装记录的路径：`zqagent update --rollback` 可能由 node 进程执行
   * （如 install.sh 内），此时 `process.execPath` 是 node 本身，绝不能拿它做替换。
   */
  rollbackNow(): string | null {
    const state = loadState(this.opts.dataDir);
    const target = state.installedExecPath ?? (isSeaRuntime() ? process.execPath : null);
    if (!target) {
      this.log("无法确定节点可执行文件位置（缺少安装记录）；请用 deploy/service/install.sh rollback");
      return null;
    }
    return rollbackExecutable(this.opts.dataDir, target, this.log);
  }

  status(): UpdaterStatus {
    const state = loadState(this.opts.dataDir);
    const cap = selfUpdateCapability(Boolean(this.publicKey));
    return {
      enabled: !this.autoUpdateOff && cap.ok,
      reason: cap.reason,
      currentVersion: this.currentVersion,
      channel: updaterChannel(),
      manifestUrl: this.manifestUrl(),
      serviceManager: serviceManager(),
      lastCheckAt: this.lastCheckAt ?? state.lastCheckAt,
      stagedVersion: state.stagedVersion,
      pendingVersion: state.pendingVersion,
      previousVersion: state.previousVersion,
      backupVersion: state.backupVersion,
      lastError: state.lastError,
    };
  }
}
