/**
 * Server 运行时装配（可复用于独立入口与 CLI `serve`）
 *
 * `startServer()` 完成 Store / SessionManager / MQTT / 节点管理桥 / QQ / 路由 的组装与监听，
 * 返回句柄。独立入口（`src/server/index.ts`）与 CLI `zqagent serve` 共用同一实现，
 * 保证"桌面 / docker / 裸机 / CLI"四种载体的行为一致。
 *
 * 注意：本模块**顶层无副作用**（不监听、不改全局），以便被 CLI 进程安全 import。
 */
import * as fs from "fs";
import * as path from "path";
import type { Server } from "http";
import { Store, generateApiKey } from "./store.js";
import { SessionManager } from "./session.js";
import { createApp } from "./routes.js";
import { UsageLedger } from "./usage.js";
import type { NotificationChannelConfig, TenantConfig } from "./types.js";
import { SecretBox } from "../crypto/secrets.js";
import { FleetNodeBridge } from "./fleet/FleetNodeBridge.js";
import { ensureNodeId } from "./projects.js";
import {
  resolveFleetConfig,
  type FleetController,
  type FleetEnrollInput,
  type FleetRenameResult,
  type FleetStatusView,
} from "./fleet-config.js";
import { DEFAULT_DATA_DIR } from "../paths.js";
import { defaultNodeLabel } from "../node-name.js";
import {
  createNotificationHub,
  decryptNotifications,
  saveNotifications,
} from "./notify/index.js";
import { QqManager, QqBindingsStore, PairingCodeStore } from "./qq/index.js";
import {
  hubEnrollByAccount,
  hubEnrollByCode,
  hubEnrollByToken,
  hubUpdateNodeLabelSelf,
} from "@zqagent/shared/hub-api";
import type { FleetCredential } from "@zqagent/shared/fleet";
import { UpdateController } from "../update/controller.js";
import {
  scheduleBuiltinProvider,
  adoptBuiltinModelForTenants,
  dropLegacyDefaultModels,
} from "./builtinLlm.js";
import { defaultTenantModel, nodeDefaultProvider } from "./nodeLlm.js";

function env(key: string): string | undefined {
  return process.env[key];
}

/** 读取 PEM 文件（mTLS 用）；未设置或读不到返回 undefined */
function pemFile(key: string): Buffer | undefined {
  const p = env(key);
  if (!p) return undefined;
  try {
    return fs.readFileSync(p);
  } catch (e) {
    console.warn(`[tls] 读取 ${key}=${p} 失败: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** 密钥脱敏展示：保留首 6 + 末 4 */
function maskKey(key: string): string {
  return key.length <= 12 ? "****" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** 启动时若无任何租户，创建一个演示租户便于开箱即用（密钥随机生成，见下） */
function seedDemoTenant(store: Store): TenantConfig | null {
  if (store.listTenants().length > 0) return null;
  const workspace = env("WORKSPACE");
  const demo: TenantConfig = {
    id: env("TENANT_ID") ?? "demo",
    // 未显式指定时随机生成：固定默认密钥一旦随 HOST=0.0.0.0 暴露到公网，等于公开凭据。
    // 只在首次创建时生成并落盘，后续启动沿用磁盘上的值（启动日志会打印完整密钥）。
    apiKey: env("TENANT_API_KEY") ?? generateApiKey(),
    // 不再硬编码具体厂商型号：志前 API 只认 deepseek-flash，写死 deepseek-v4-flash
    // 会让新装节点的第一次请求 404。默认值统一走 defaultTenantModel（见 nodeLlm.ts）。
    model: defaultTenantModel(store),
    provider: {
      apiKey: env("OPENAI_API_KEY"),
      baseURL: env("OPENAI_BASE_URL"),
    },
    workspaceRoot: workspace ? path.resolve(workspace) : undefined,
    allowedCommands: [],
  };
  store.saveTenant(demo);
  return demo;
}

/**
 * 从环境变量读取邮件配置，为所有租户自动配置 email 通知通道。
 * 由 configure-server.sh 写入 .env 的 EMAIL_* 变量驱动；任务完成时发邮件。
 */
function applyEmailFromEnv(store: Store, secretBox: SecretBox | null): void {
  const host = env("EMAIL_HOST");
  const to = env("EMAIL_TO");
  if (!host || !to) return;
  const secure = env("EMAIL_SECURE") ?? "true";
  const channel: NotificationChannelConfig = {
    id: "email-env",
    type: "email",
    enabled: true,
    config: {
      host,
      port: env("EMAIL_PORT") ?? (secure === "true" ? "465" : "587"),
      secure,
      user: env("EMAIL_USER") ?? "",
      pass: env("EMAIL_PASS") ?? "",
      from: env("EMAIL_FROM") || env("EMAIL_USER") || "",
      to,
    },
    events: { approval: false, question: false, completed: true, error: true },
  };
  for (const id of store.listTenants()) {
    const tenant = store.loadTenant(id);
    if (!tenant) continue;
    const list = decryptNotifications(tenant, secretBox);
    const idx = list.findIndex((c) => c.id === "email-env");
    if (idx >= 0) list[idx] = channel;
    else list.push(channel);
    saveNotifications(tenant, secretBox, list);
    store.saveTenant(tenant);
  }
  console.log(`[notify] 已从环境变量配置邮件通知 (${host} → ${to})`);
}

/** 启动时将环境变量中的 model / provider 配置同步到已有租户配置 */
function syncTenantModels(store: Store): void {
  const model = env("MODEL") ?? env("OPENAI_MODEL");
  const workspace = env("WORKSPACE");
  const apiKey = env("OPENAI_API_KEY");
  const baseURL = env("OPENAI_BASE_URL");
  if (!model && !workspace && !apiKey && !baseURL) return;
  for (const id of store.listTenants()) {
    const tenant = store.loadTenant(id);
    if (!tenant) continue;
    tenant.provider = tenant.provider ?? {}; // 防御手工配置缺 provider 字段
    let changed = false;
    if (model && tenant.model !== model) {
      console.log(`[sync] 租户 ${id} model 已同步: ${tenant.model} → ${model}`);
      tenant.model = model;
      changed = true;
    }
    if (workspace && tenant.workspaceRoot !== path.resolve(workspace)) {
      console.log(`[sync] 租户 ${id} workspaceRoot 已同步: ${tenant.workspaceRoot ?? "(沙箱)"} → ${path.resolve(workspace)}`);
      tenant.workspaceRoot = path.resolve(workspace);
      changed = true;
    }
    if (apiKey && tenant.provider.apiKey !== apiKey) {
      console.log(`[sync] 租户 ${id} provider.apiKey 已同步`);
      tenant.provider.apiKey = apiKey;
      changed = true;
    }
    if (baseURL && tenant.provider.baseURL !== baseURL) {
      console.log(`[sync] 租户 ${id} provider.baseURL 已同步: ${tenant.provider.baseURL ?? "(默认)"} → ${baseURL}`);
      tenant.provider.baseURL = baseURL;
      changed = true;
    }
    if (changed) store.saveTenant(tenant);
  }
}

/**
 * 桌面外壳场景（ZQAGENT_EXIT_WITH_PARENT=1）：父进程退出时（含 SIGKILL/崩溃等
 * 外壳的优雅清理覆盖不到的情形），轮询父 PID，死亡即退出，避免孤儿 sidecar。
 */
function exitWhenOrphaned(): void {
  if (process.env.ZQAGENT_EXIT_WITH_PARENT !== "1") return;
  const parent = Number(process.env.ZQAGENT_PARENT_PID || 0) || process.ppid;
  const originalPpid = process.ppid;
  const timer = setInterval(() => {
    let alive = true;
    try {
      process.kill(parent, 0);
    } catch {
      alive = false;
    }
    if (!alive || process.ppid !== originalPpid) process.exit(0);
  }, 1500);
  timer.unref();
}

// ===================== 节点管理控制器（类型见 fleet-config.ts） =====================

export interface StartServerOptions {
  /** 状态/租户根目录（默认 env DATA_DIR ?? "./.zqagent_data"） */
  dataDir?: string;
  /** 监听端口（默认 env PORT ?? 8787） */
  port?: number;
  /** 监听地址（默认 env HOST ?? 127.0.0.1） */
  host?: string;
  /**
   * 启动时自动接入（一次性注册码或 Hub 账号）。仅当本地尚未接入（fleet.json 不存在）时生效；
   * enroll 失败只告警、不阻塞启动。
   */
  autoEnroll?: FleetEnrollInput | null;
  /**
   * 启用自动更新（默认关闭；`zqagent serve` 与 `src/server/index.ts` 显式开启）。
   * 仅当「SEA 单文件 + 服务管理器托管 + 配置了验签公钥」时才会真正生效。
   */
  autoUpdate?: boolean;
  /** 监听就绪回调（默认打印启动信息） */
  onReady?: (info: ServerReadyInfo) => void;
}

export interface ServerReadyInfo {
  host: string;
  port: number;
  dataDir: string;
  adminKey: string;
  fleetNodeId?: string;
  fleetGatewayUrl?: string;
  demo?: TenantConfig | null;
}

export interface ServerHandle {
  store: Store;
  manager: SessionManager;
  http: Server;
  adminKey: string;
  fleet: FleetController;
  ready: Promise<ServerReadyInfo>;
  close: () => void;
}

/** 端口自动递增的上限（8787 起最多试到 8807） */
const PORT_FALLBACK_LIMIT = 20;

/**
 * 监听端口；被占用时依次尝试下一个，直到成功或用尽次数。
 *
 * 默认的 8787 在开发机上常被别的服务占用。此前 `server.listen` 没有 error 处理，
 * EADDRINUSE 会变成未捕获异常，进程直接崩溃；装成 launchd/systemd 服务后表现为
 * 无限重启、日志里刷同样的堆栈，用户只看到「服务 · 未运行」。
 *
 * 实际监听端口会写入 `{dataDir}/server-port`：plist/unit 里写的是初始端口，
 * 自动递增后安装脚本与 `zqagent update --status` 要读这个文件才知道真实地址。
 *
 * 导出仅为测试（limit 用于缩小重试范围）。
 */
export function listenWithPortFallback(
  server: Server,
  startPort: number,
  host: string,
  dataDir: string,
  limit: number = PORT_FALLBACK_LIMIT,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tryListen = (port: number): void => {
      // 上一次失败的 listen 会遗留一个 'listening' 回调（Node 不清理它），
      // 再次 listen 成功时两个回调都会触发，先执行的那个还带着旧端口号。
      // 这里每次尝试前清掉，保证只收到本次的回调。
      server.removeAllListeners("listening");
      const onError = (err: NodeJS.ErrnoException): void => {
        // 只对「端口被占」递增；EACCES（<1024 需特权）等应直接失败
        if (err.code === "EADDRINUSE" && attempts < limit) {
          attempts += 1;
          const next = port + 1;
          console.warn(`[server] 端口 ${port} 已被占用（EADDRINUSE），尝试 ${next} …`);
          tryListen(next);
          return;
        }
        server.removeListener("error", onError);
        console.error(
          `[server] 无法监听 ${host}:${port}：${err.message}` +
            (err.code === "EADDRINUSE"
              ? `（已尝试 ${attempts + 1} 个端口均被占用）`
              : ""),
        );
        reject(err);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        // 以实际绑定结果为准，而不是闭包里的 port
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        if (actualPort !== startPort) {
          console.warn(`[server] 已改用端口 ${actualPort}（原定 ${startPort} 被占用）`);
        }
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(path.join(dataDir, "server-port"), `${actualPort}\n`);
        } catch {
          // 仅用于安装脚本探测，写不了不影响服务本身
        }
        resolve(actualPort);
      });
    };

    tryListen(startPort);
  });
}

/** 启动 Server（组装 + 监听）。返回句柄；调用方负责在退出时 close()。 */
export function startServer(opts: StartServerOptions = {}): ServerHandle {
  const dataDir = path.resolve(opts.dataDir ?? env("DATA_DIR") ?? DEFAULT_DATA_DIR);
  const port = opts.port ?? Number(env("PORT") ?? 8787);
  const host = opts.host ?? env("HOST") ?? "127.0.0.1";

  exitWhenOrphaned();

  const store = new Store(dataDir);
  const demo = seedDemoTenant(store);
  syncTenantModels(store);
  // 老节点升级：内置项可能早已落盘，但演示租户的型号还停在旧默认值
  //（deepseek-v4-flash）。这里先无条件迁移一次——不依赖 Hub 是否可达，
  // 否则离线节点永远修不好。内置项后续刷新时会再对齐一次。
  const nodeModel = nodeDefaultProvider(store)?.model;
  if (nodeModel) adoptBuiltinModelForTenants(store, nodeModel);
  // 没有可迁移的型号（离线且未配任何供应商）：至少别让旧版写进去的
  // gpt-4o / deepseek-v4-flash 继续冒充「系统默认模型」
  else dropLegacyDefaultModels(store);
  const usageLedger = new UsageLedger(dataDir);
  usageLedger.init();
  const manager = new SessionManager(store, undefined, { usage: usageLedger });
  // 历史基线（一次性）：把既有会话的 token 汇总进账本基线；账本明细自今天起
  try {
    const seeded = manager.seedUsageBaseline();
    if (seeded.seeded) console.log(`[usage] 历史基线已写入（${seeded.calls} 次调用）`);
  } catch (e) {
    console.error(`[usage] 历史基线失败: ${String(e)}`);
  }

  /** 管理员密钥：ADMIN_API_KEY env > {DATA_DIR}/admin.json > 首次自动生成并落盘 */
  function ensureAdminKey(): string {
    const envKey = env("ADMIN_API_KEY");
    if (envKey) {
      if (store.loadAdminKey() !== envKey) store.saveAdminKey(envKey);
      return envKey;
    }
    const existing = store.loadAdminKey();
    if (existing) return existing;
    const key = generateApiKey();
    store.saveAdminKey(key);
    return key;
  }
  const adminKey = ensureAdminKey();

  // ===================== 凭据加密盒 =====================
  const secretKey = env("SECRET_KEY");
  const secretBox: SecretBox | null = secretKey
    ? SecretBox.fromHex(secretKey)
    : SecretBox.fromFile(path.join(dataDir, "secret.key"));
  if (secretKey && !secretBox) {
    console.warn("[crypto] SECRET_KEY 非法（需 64 位 hex），通知凭据将退化为明文");
  }

  applyEmailFromEnv(store, secretBox);
  const notificationHub = createNotificationHub();

  // ===================== 云端接入（WSS 直连 Rust 网关；可运行时热接入） =====================
  let fleet: FleetNodeBridge | null = null;
  let fleetCred: FleetCredential | null = null;
  /**
   * 自更新控制器。**始终创建**（`self_update` 指令与 UI 的手动更新要用），
   * 只有 `opts.autoUpdate` 时才启动定时调度。
   */
  let updater: UpdateController | null = null;

  function connectFleet(cred: FleetCredential): void {
    // 采用凭据中的 nodeId（控制面纳管标识）：新接入节点的本地 node.json 可能尚未生成，
    // 若各用各的随机 id，控制面看到的节点与本地会话数据就会对不上。
    const localId = ensureNodeId(store);
    const nodeId = (cred.nodeId ?? "").trim() || localId;
    if (nodeId !== localId) store.saveNodeId(nodeId);
    fleet?.close();
    // 网关地址：控制面配对时下发的优先（「去 EMQX」后的默认传输），环境变量仅作覆盖。
    const gatewayUrl = cred.gatewayUrl ?? env("FLEET_GATEWAY_URL");
    fleet = new FleetNodeBridge({
      gatewayUrl,
      fleetToken: cred.fleetToken,
      fleetSecret: cred.fleetSecret,
      nodeId,
      ca: pemFile("FLEET_GATEWAY_CA_FILE"),
      cert: pemFile("FLEET_GATEWAY_CERT_FILE"),
      key: pemFile("FLEET_GATEWAY_KEY_FILE"),
      deps: {
        store,
        manager,
        // 闭包推迟求值：桥先于 UpdateController 创建，指令到达时 updater 已就绪
        getUpdater: () => updater,
        applyFleetCred: async (cred) => {
          store.saveFleetCredential(cred);
          // 延后重连：先让当前 ack 回执发出（旧连接仍在用），再切换连接
          setTimeout(() => connectFleet(cred), 300);
        },
      },
    });
    fleet.connect();
    fleetCred = cred;
  }

  function fleetStatus(): FleetStatusView {
    return {
      linked: fleet !== null,
      nodeId: ensureNodeId(store),
      hubUrl: fleetCred?.hubUrl,
      gatewayUrl: fleetCred?.gatewayUrl ?? env("FLEET_GATEWAY_URL"),
      online: fleet?.isConnected() ?? false,
      label: fleetCred?.label ?? store.loadNodeLabel() ?? undefined,
      lastError: fleet?.getLastError() ?? undefined,
      reconnectCount: fleet?.getErrorCount() ?? 0,
    };
  }

  const fleetController: FleetController = {
    status: fleetStatus,
    async enroll(input) {
      const nodeId = ensureNodeId(store);
      // 未显式指定名称时取主机名：Hub 界面显示可读的机器名，而不是 nodeId
      const label = input.label?.trim() || defaultNodeLabel();
      const cred = input.hubToken
        ? await hubEnrollByToken(input.hubUrl, input.hubToken, { nodeId, label })
        : input.account
          ? await hubEnrollByAccount(input.hubUrl, {
              email: input.account.email,
              phone: input.account.phone,
              password: input.account.password,
              code: input.account.smsCode,
              nodeId,
              label,
            })
          : await hubEnrollByCode(input.hubUrl, {
              code: input.code!,
              nodeId,
              label,
            });
      const full: FleetCredential = {
        ...cred,
        label,
        enrolledAt: new Date().toISOString(),
      };
      store.saveFleetCredential(full);
      // 上报的 label 取自 node.json：与 Hub 记录同源，控制台各视图才不会显示两套名字
      store.saveNodeLabel(label);
      connectFleet(full);
      return fleetStatus();
    },
    async rename(label): Promise<FleetRenameResult> {
      const name = label.trim();
      store.saveNodeLabel(name);
      if (fleetCred) {
        fleetCred = { ...fleetCred, label: name };
        store.saveFleetCredential(fleetCred);
      }
      fleet?.republishLabel();
      // Hub 界面读的是控制面里的 node.label，不写它就只是本地改名
      let hubSynced = false;
      let hubError: string | undefined;
      const cred = fleetCred;
      if (cred?.hubUrl && cred.fleetToken) {
        try {
          await hubUpdateNodeLabelSelf(cred.hubUrl, cred.fleetToken, {
            nodeId: ensureNodeId(store),
            label: name,
          });
          hubSynced = true;
        } catch (e) {
          hubError = e instanceof Error ? e.message : String(e);
        }
      }
      return { ...fleetStatus(), hubSynced, hubError };
    },
    unlink() {
      fleet?.close();
      fleet = null;
      fleetCred = null;
      store.clearFleetCredential();
    },
    pairing() {
      if (!fleetCred) return null;
      return {
        gatewayUrl: fleetCred.gatewayUrl ?? env("FLEET_GATEWAY_URL"),
        fleetToken: fleetCred.fleetToken,
        fleetSecret: fleetCred.fleetSecret,
        nodeId: ensureNodeId(store),
      };
    },
  };

  // 启动时接入：fleet.json 优先，其次 env 回退
  const initialCred = resolveFleetConfig(store);
  if (initialCred) {
    connectFleet(initialCred);
  } else if (opts.autoEnroll) {
    // 首次启动带注册码：异步接入，不阻塞监听
    void fleetController
      .enroll(opts.autoEnroll)
      .then((st) => {
        console.log(`[fleet] 已自动接入，节点 ${st.nodeId}（${st.gatewayUrl}）`);
        // 接入后立刻补配内置模型（接入响应里已带快照，这里只是兜底落盘）
        scheduleBuiltinProvider(store, (m) => console.log(m));
      })
      .catch((e) => console.warn(`[fleet] 自动接入失败（可稍后 /link 重试）: ${e instanceof Error ? e.message : e}`));
  }

  /*
   * 平台内置大模型补配：已接入 Hub 但本地没有内置项的节点（升级上来的老节点）
   * 在这里自动补一次。异步、失败静默——未登录的用户本来就「没有内置模型」，
   * 自己配其它模型即可，不能因此影响启动。
   */
  if (initialCred) scheduleBuiltinProvider(store, (m) => console.log(m));

  // ===================== QQ 官方机器人（可选，支持热配置） =====================
  const pairingCodes = new PairingCodeStore();
  const qq = new QqManager({
    store,
    manager,
    bindings: QqBindingsStore.in(dataDir),
    pairingCodes,
    dataDir,
  });
  qq.start();

  // info 刷新用「尾沿节流」：立即刷新 + 窗口内最后一次变化到达后补一次，
  // 保证控制面统计最终一致且不风暴（事件与会话状态都走这里）
  let lastFleetInfoAt = 0;
  let fleetInfoTimer: NodeJS.Timeout | null = null;
  const INFO_REFRESH_MS = 3000;
  const INFO_REFRESH_EVENTS = new Set([
    "turn_start",
    "turn_end",
    "permission_required",
    "ask_user_question",
    "plan_proposed",
    "directory_requested",
    "error",
    "interrupted",
  ]);
  const scheduleFleetInfoRefresh = () => {
    if (!fleet) return;
    const now = Date.now();
    const elapsed = now - lastFleetInfoAt;
    if (elapsed > INFO_REFRESH_MS) {
      lastFleetInfoAt = now;
      fleet.refreshInfo();
      return;
    }
    if (!fleetInfoTimer) {
      fleetInfoTimer = setTimeout(() => {
        fleetInfoTimer = null;
        lastFleetInfoAt = Date.now();
        fleet?.refreshInfo();
      }, INFO_REFRESH_MS - elapsed + 50);
      fleetInfoTimer.unref?.();
    }
  };

  // 通知回调：云端 notify（WSS）+ QQ 回发 + 第三方渠道分发（尽力而为）
  manager.setNotifyHandler((tenantId, ev) => {
    fleet?.notify(tenantId, ev);
    qq.onNotify(tenantId, ev);
    const tenant = store.loadTenant(tenantId);
    if (tenant) {
      tenant.notifications = decryptNotifications(tenant, secretBox);
      void notificationHub.dispatch(tenant.notifications ?? [], ev);
    }
    // 会话状态变化（含新建）→ 刷新 info：让 `detail.sessions` 快照与增量
    // 通知保持一致，页面重开也不会漏掉刚创建的会话。
    if (ev.kind === "session_status") scheduleFleetInfoRefresh();
  });

  // 事件桥接：广播实时事件流（info 刷新同上）
  manager.setEventHandler((tenantId, sessionId, entry) => {
    fleet?.onEvent(tenantId, sessionId, entry);
    if (INFO_REFRESH_EVENTS.has(entry.type)) {
      scheduleFleetInfoRefresh();
    }
  });

  // 自更新控制器：**始终创建**（远端 `self_update` 指令与 UI 手动更新要用），
  // 只有 `opts.autoUpdate` 时才启动后台调度（见监听成功处）。
  updater = new UpdateController({
    dataDir,
    isIdle: () => manager.isIdle(),
    prepareExit: closeServer,
  });

  const server = createApp(store, manager, {
    secretBox,
    notificationHub,
    qq,
    adminKey,
    fleet: fleetController,
    host,
    updater,
  });

  /**
   * 纯关闭（供嵌入方调用，不退出进程）：落盘账本、断云端与机器人连接、关掉 HTTP。
   * SSE 长连接会让 server.close() 一直等下去（server.timeout = 0），这里不做强制断开，
   * 由调用方决定何时退出；信号路径见下面的 shutdown()。
   */
  let closed = false;
  function closeServer(): void {
    if (closed) return;
    closed = true;
    updater?.stop();
    try {
      usageLedger.saveRollupNow();
      fleet?.close();
      qq.stop();
    } catch {
      // 忽略：清理失败不应阻塞退出
    }
    try {
      server.close();
    } catch {
      // 忽略
    }
  }

  /**
   * 收到 SIGINT/SIGTERM 时退出：
   * 服务管理器（systemd/launchd/pm2）的 stop/restart 依赖进程真的退出，只 close 不走会
   * 一直挂到被 SIGKILL。因此先主动断开 SSE/keep-alive 连接，再在宽限期后强制退出；
   * 连按两次 Ctrl+C 立即退出。
   */
  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，正在退出…`);
    closeServer();

    const graceMs = Number(env("ZQAGENT_SHUTDOWN_GRACE_MS") ?? 3000) || 3000;
    const forceExit = setTimeout(() => process.exit(0), graceMs);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
    // Node ≥18.2：主动断开残留连接，否则 server.close() 的回调永远不会触发
    server.closeAllConnections?.();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 自动更新：静默下载，空闲时替换自身并退出（由 systemd/launchd 拉起新版本）。
  // 控制器已在上面创建（远端 self_update / 手动更新共用）；这里只决定是否启动调度，
  // 避免嵌入方/测试意外触发后台下载。

  // SSE 长连接不应被服务器空闲超时断开
  server.timeout = 0;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const ready = new Promise<ServerReadyInfo>((resolve, reject) => {
    listenWithPortFallback(server, port, host, dataDir).then((actualPort) => {
      const info: ServerReadyInfo = {
        host,
        port: actualPort,
        dataDir,
        adminKey,
        fleetNodeId: fleet ? fleet.getNodeId() : undefined,
        fleetGatewayUrl: fleetCred?.gatewayUrl ?? env("FLEET_GATEWAY_URL"),
        demo,
      };
      if (opts.onReady) {
        opts.onReady(info);
      } else {
        printReady(info, qq);
      }
      // 监听成功后再启动更新调度，避免端口占用失败时留下定时器
      if (opts.autoUpdate) updater?.start();
      resolve(info);
    }, reject);
  });

  return {
    store,
    manager,
    http: server,
    adminKey,
    fleet: fleetController,
    ready,
    close: closeServer,
  };
}

/** 默认启动信息打印 */
function printReady(info: ServerReadyInfo, qq: QqManager): void {
  const lines = [
    `zqagent server 监听 http://${info.host}:${info.port}`,
    `数据目录: ${info.dataDir}`,
    `审批挂起超时: ${env("APPROVAL_TIMEOUT_SECONDS") ?? 900}s（超时后回收内存任务，可经 resume 恢复）`,
    env("ZQAGENT_LOG_ADMIN_KEY") === "0"
      ? `管理员密钥: ${maskKey(info.adminKey)}（已脱敏，完整值见 ${path.join(info.dataDir, "admin.json")}）`
      : `管理员密钥: ${info.adminKey}（控制台多项目入口：/api/v1/projects；项目级接口加 X-Project-Id 头）`,
  ];
  if (info.fleetNodeId) {
    lines.push(
      `云端接入: ${info.fleetGatewayUrl ?? "（未配置网关地址）"}（节点 ${info.fleetNodeId}；配对 GET /api/v1/fleet/pairing）`,
    );
  }
  if (qq.isRunning()) {
    lines.push(`QQ 机器人: 已启用（sandbox=${qq.getConfig()?.sandbox === true}）`);
  }
  if (info.demo) {
    lines.push(
      `已创建演示租户: id=${info.demo.id} apiKey=${info.demo.apiKey} model=${info.demo.model}`,
      `  例: curl -H "Authorization: Bearer ${info.demo.apiKey}" http://localhost:${info.port}/api/v1/sessions`,
    );
  }
  for (const l of lines) console.log(l);
}
