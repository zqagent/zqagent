/**
 * FleetNodeBridge — 节点侧与云端控制面的唯一链路（二进制 WSS 直连 Rust 网关）
 *
 * 职责：把节点（Agent Server）的业务事件与指令执行接到网关上——
 *   - 上行：`status`（在线态）/ `info`（能力、项目、用量快照）/ `event` / `notify` / `ack`；
 *   - 下行：网关按 `nodeId` 路由过来的 `cmd`，校验后交给 `dispatchFleetCommand`；
 *   - 调度：只读查询并发池、写操作串行链、只读结果短 TTL 复用（见下）。
 *
 * 传输只有 WSS 一种：「去 EMQX」删掉了 MQTT 分支（含连接守护子进程）。连接、握手、
 * 心跳、重连退避与指令签名校验都在 `WssLink` 里——本类**不碰 socket**，只做业务调度。
 *
 * 出站统一走 `_send`：所有上行汇聚到一个漏斗，「链路是否就绪」的判定只有一处。
 */
import * as os from "os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  type FleetCmdEnvelope,
  type FleetStatus,
  type FleetAckPayload,
  type FleetBatchResult,
  type FleetBatchSubCmd,
} from "@zqagent/shared/fleet";
import { dispatchFleetCommand, type FleetDeps } from "./FleetCommands.js";
import { encodeOutbound, fromWireCommand, type FleetOutbound } from "./fleetWire.js";
import { WssLink } from "./wssLink.js";
import { dbgMark, dbgMs, dbgNow } from "../dbgTrace.js"; // [dbg] 临时调试，定位后可删
import { allProjectSummaries, ensureNodeId, lastUserMessage } from "../projects.js";
import type { EventEntry, NotifyEvent } from "../types.js";
import {
  approvalInputFromData,
  approvalToMarkdownTable,
} from "../../engine/approvalView.js";

/**
 * 只读查询指令：控制台页签恢复会并发重复调用，节点侧做并发去重 + 短 TTL 结果复用，
 * 避免同一批查询被反复实算（长时间占满事件循环会错过心跳与回执）。
 * 白名单仅含无副作用的查询；写操作（submit_turn/approval_answer/…）始终逐条执行。
 */
const READONLY_CMD_TYPES = new Set<string>([
  "ping",
  "get_node_info",
  "get_node_host",
  "get_node_llm",
  "list_node_llm_models",
  "get_usage_summary",
  "get_usage_records",
  "get_usage_pricing",
  "list_projects",
  "list_sessions",
  "get_session_states",
  "get_state",
  "get_events",
  "get_config",
  "list_models",
  "list_dirs",
  "search_dirs",
  "list_files",
  "read_file",
  "search_files",
  "list_tools",
  "list_mcp",
  "project_stats",
  "git_repos",
  "git_status",
  "git_diff",
  "git_branches",
  "git_refs",
  "git_log",
  "git_show",
]);

/** 只读结果复用窗口（毫秒） */
const CMD_CACHE_TTL_MS = 1500;

/**
 * 只读查询并发上限。
 *
 * 原实现把所有指令挂在一条串行链上：一个慢查询（大历史 `get_events` 回执 512KB 等）
 * 会把它之后的**全部**指令一起堵住（实测：卡住期间 80 个 ping 中 65 个无响应），
 * 控制台表现为整台节点失联。只读查询彼此无副作用，放开有限并发即可消除该放大效应；
 * 写操作仍严格串行，保证顺序语义。
 */
const READONLY_CONCURRENCY = 4;

/** 批量指令：单批最多子指令数 / 单条子指令执行上限 / 整批截止（须在网关超时内） */
const BATCH_MAX_SUBS = 64;
const BATCH_SUB_TIMEOUT_MS = 7000;
const BATCH_TOTAL_TIMEOUT_MS = 8500;

/** 事件发布批量合并：窗口 / 单包上限（条数、字节） */
const EVENT_FLUSH_MS = 60;
const EVENT_FLUSH_MAX_EVENTS = 60;
const EVENT_FLUSH_MAX_BYTES = 200 * 1024;

/** 事件循环阻塞告警阈值（毫秒） */
const LOOP_LAG_WARN_MS = 2000;

/** Promise 限时（超时抛错，由批量结果捕获为单项失败） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子指令超时（${ms}ms）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 主 IP：优先首个非回环 IPv4；否则首个非回环 IPv6（跳过 fe80 链路本地） */
function primaryIp(): string | undefined {
  let v6: string | undefined;
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === "IPv4") return info.address;
      if (info.family === "IPv6" && !v6 && !info.address.toLowerCase().startsWith("fe80")) {
        v6 = info.address;
      }
    }
  }
  return v6;
}

export interface FleetNodeBridgeOptions {
  /**
   * 网关地址（如 `wss://gw.example.com/ws`）。
   *
   * 「去 EMQX」后这是**唯一**的传输；未提供时 `connect()` 只告警不建链
   * （配置缺失不该让节点起不来，见 runtime）。
   */
  gatewayUrl?: string;
  /** 节点管理命名空间 token（仅用于日志与审计，网关鉴权用 fleetSecret） */
  fleetToken: string;
  /** 节点管理签名密钥（HMAC-SHA256；与网关 GATEWAY_FLEET_SECRET 一致） */
  fleetSecret: string;
  /** 节点 ID（缺省取 store 的 node.json） */
  nodeId?: string;
  /** 客户端标识（仅上报，便于现场排查） */
  clientId?: string;
  /** mTLS（可选）：客户端证书 / 私钥 / CA（Buffer 或 PEM 字符串） */
  ca?: Buffer | string;
  cert?: Buffer | string;
  key?: Buffer | string;
  /** 指令分发依赖（store + SessionManager） */
  deps: FleetDeps;
  onStatus?: (connected: boolean) => void;
}

export class FleetNodeBridge {
  /** 是否成功连接过（区分「一直连不上」与「连上后断线」） */
  private everConnected = false;
  /** 最近一次错误（供 CLI / admin 状态展示） */
  private lastError: string | null = null;
  /** 断连起点（计算恢复耗时） */
  private downSince: number | null = null;
  /** 连续失败次数（连上后清零） */
  private errCount = 0;
  private readonly nodeId: string;
  /** 运行统计（info 上报；进程启动后累计） */
  private readonly statsSince = new Date().toISOString();
  private readonly stats = { turns: 0, toolCalls: 0, errors: 0, tokensIn: 0, tokensOut: 0 };
  /** 只读指令结果缓存/在途（控制台并发重复查询去重；键=type|project|session|payload） */
  private readonly cmdResultCache = new Map<string, { at: number; ack: FleetAckPayload }>();
  private readonly cmdInflight = new Map<string, Promise<FleetAckPayload>>();
  /**
   * 写操作代次：写完成后自增。
   *
   * 只读结果缓存（`CMD_CACHE_TTL_MS`）不感知写入，曾导致「新建项目后立刻刷新列表」
   * 在 1.5s 内看到旧数据（实地灰度 S4b 确认）。清缓存能解决绝大多数情况，但**跨写操作
   * 的只读查询**仍会把它开始时的旧结果写回缓存；用代次比对即可让这类结果不再入缓存。
   */
  private writeEpoch = 0;
  /** 指令串行链：写操作串行（防多来源并发压垮事件循环） */
  private cmdChain: Promise<void> = Promise.resolve();
  /** 只读查询：并发执行中的数量 + 超出上限时的等待队列 */
  private roActive = 0;
  private readonly roWaiters: Array<() => void> = [];
  /** 事件批量合并缓冲（JSON 字符串，flush 时直接拼接，不重复序列化） */
  private pendingEvents: string[] = [];
  private pendingEventBytes = 0;
  private eventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 用量/信息定期上报（含用量，便于控制面账户级聚合） */
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  /** 状态心跳（定期刷新 lastSeen，让控制面任何瞬时误判可自愈） */
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastInfoTs = 0;
  /** 事件循环延迟监控（诊断：忙碌导致的心跳/回执延迟） */
  private lagMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  /** close() 后的退出标记（不自动重连） */
  private closing = false;
  /** WSS 链路（唯一传输）；非空表示已启用 */
  private wssLink: WssLink | null = null;

  constructor(private readonly opts: FleetNodeBridgeOptions) {
    this.nodeId = opts.nodeId ?? ensureNodeId(opts.deps.store);
  }

  getNodeId(): string {
    return this.nodeId;
  }

  /** 节点当前是否可被管控 */
  isConnected(): boolean {
    return this.wssLink?.isReady() ?? false;
  }

  /** 用账本汇总初始化累计统计（生命周期口径；重启不清零） */
  private _seedStats(): void {
    const ledger = this.opts.deps.manager.usageLedger();
    if (!ledger) return;
    try {
      const t = ledger.getRollup().total;
      this.stats.tokensIn = t.input;
      this.stats.tokensOut = t.output;
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 建立与网关的连接（幂等）。
   *
   * 缺 `gatewayUrl` 只告警不抛错：启动路径上的配置错误不该让节点起不来
   * （本地功能仍然可用，只是不受云端管控）。
   */
  connect(): void {
    if (this.wssLink || this.closing) return;
    const url = this.opts.gatewayUrl;
    if (!url) {
      console.warn(
        `[fleet] 节点 ${this.nodeId} 未配置网关地址（gatewayUrl / FLEET_GATEWAY_URL），跳过云端接入`,
      );
      return;
    }
    this._seedStats();
    this._startDiagnostics();

    const link = new WssLink({
      url,
      nodeId: this.nodeId,
      fleetSecret: this.opts.fleetSecret,
      client: this.opts.clientId,
      ca: this.opts.ca,
      cert: this.opts.cert,
      key: this.opts.key,
      onReady: () => this._onUp(),
      onDown: (reason) => this._noteDown(reason),
      onCommand: (env) => this._handleWireCommand(env),
      onReject: (reason) => {
        // 与旧行为一致：签名/nonce 校验失败只留痕，不打断链路
        dbgMark("reject", reason);
      },
    });
    this.wssLink = link;
    link.start();
  }

  /**
   * 诊断定时器：事件循环延迟监控 + 周期上报。
   *
   * 延迟监控是排障的第一线索：阻塞时长远超 CPU 消耗 ⇒ 进程没被调度（系统挂起），
   * 两者排查方向完全不同，所以告警里直接给出判据。
   */
  private _startDiagnostics(): void {
    if (!this.lagMonitor) {
      this.lagMonitor = monitorEventLoopDelay({ resolution: 20 });
      this.lagMonitor.enable();
      let lastCpu = process.cpuUsage();
      this.lagTimer = setInterval(() => {
        const maxMs = (this.lagMonitor?.max ?? 0) / 1e6;
        const cpu = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        if (maxMs > LOOP_LAG_WARN_MS) {
          const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
          const looksSuspended = cpuMs * 4 < maxMs;
          console.warn(
            `[fleet] 节点 ${this.nodeId} 事件循环阻塞 ${Math.round(maxMs)}ms（本周期 CPU ${cpuMs}ms）：` +
              (looksSuspended
                ? "CPU 未同步增长 → 疑似进程被系统挂起，非计算阻塞"
                : "CPU 同步增长 → 疑为同步计算/IO 阻塞"),
          );
        }
        // [dbg] 周期心跳：日志若出现大空档 → 进程整体未被调度（挂起）；否则看 lag/cpu 判据
        dbgMark(
          "hb",
          `lag=${Math.round(maxMs)}ms cpu=${Math.round((cpu.user + cpu.system) / 1000)}ms ` +
            `conn=${this.isConnected()} roActive=${this.roActive} roQueue=${this.roWaiters.length}`,
        );
        this.lagMonitor?.reset();
      }, 15_000);
      this.lagTimer.unref?.();
    }
    if (!this.usageTimer) {
      this.usageTimer = setInterval(() => this._publishInfo(), 5 * 60 * 1000);
      this.usageTimer.unref?.();
    }
    // 状态心跳（60s）：刷新 lastSeen，并让控制面侧任何瞬时误判可自愈
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => {
        if (!this.isConnected()) return;
        this._send({ kind: "status", status: this._status(true) });
      }, 60_000);
      this.statusTimer.unref?.();
    }
  }

  /**
   * 链路就绪后的公共动作。
   *
   * 顺序有意义：上报 status → 上报 info → 通知上层。漏掉任何一步都会表现为
   * 「连上了但控制台看不到」。
   */
  private _onUp(): void {
    const downMs = this.downSince ? Date.now() - this.downSince : 0;
    if (this.everConnected) {
      // 断连不一定伴随 error 事件，故恢复日志无条件打印：否则「静默断连 → 重连」
      // 在现场只剩心跳里的 conn=false，无法统计频率与断连时长。
      const detail = [
        this.errCount > 0 ? `先前失败 ${this.errCount} 次` : "",
        downMs > 0 ? `断连约 ${Math.round(downMs / 1000)}s` : "",
      ]
        .filter(Boolean)
        .join("，");
      console.log(`[fleet] 节点 ${this.nodeId} 与网关的连接已恢复${detail ? `（${detail}）` : ""}`);
    }
    this.everConnected = true;
    this.errCount = 0;
    this.lastError = null;
    this.downSince = null;
    this._send({ kind: "status", status: this._status(true) });
    this._publishInfo();
    this.opts.onStatus?.(true);
  }

  /** 网关指令：签名/目标节点/nonce 已在 WssLink 校验，这里只做调度 */
  private _handleWireCommand(env: import("@zqagent/shared/wire").Envelope): void {
    this._dispatchEnvelope(fromWireCommand(env));
  }

  /**
   * 指令调度。
   *
   * 只读查询走并发池、写操作走串行链——这个接缝是既有测试
   * （`fleetReadonlyConcurrency.test.ts` 覆写 `_dispatch`）依赖的，故原样保留。
   */
  private _dispatchEnvelope(env: FleetCmdEnvelope): void {
    const run = (): Promise<void> => this._dispatch(env);
    dbgMark(`recv:${env.type}`, `reqId=${env.reqId}`); // [dbg] 记录入队时刻，用于区分排队等待 vs 执行耗时
    // 只读查询（含「全为只读子指令」的 batch）：有限并发，慢查询不再阻塞轻量指令。
    // 写操作：严格串行，上一条执行完（含回执发布）再执行下一条。
    if (READONLY_CMD_TYPES.has(env.type) || this._isReadonlyBatch(env)) {
      this._runReadonly(run);
      return;
    }
    // 写操作：严格串行；**完成后**让只读结果缓存失效——必须在写之后，
    // 因为在写之前清会被「写执行期间完成的只读查询」重新填回旧数据。
    this.cmdChain = this.cmdChain
      .then(run, run)
      .then(() => this._invalidateReadonlyCache())
      .catch(() => undefined);
  }

  /**
   * 让只读结果缓存失效。
   *
   * 写操作会改变只读查询的结果（如 `create_project` 之于 `list_projects`），
   * 而缓存只看 TTL，于是写入后 TTL 内仍返回旧数据。除清空外还要自增代次，
   * 使「跨越该写操作的只读查询」的结果不再入缓存（见 `writeEpoch`）。
   */
  private _invalidateReadonlyCache(): void {
    this.writeEpoch += 1;
    this.cmdResultCache.clear();
  }

  close(): void {
    this.closing = true;
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
    this.lagMonitor?.disable();
    this.lagMonitor = null;
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    this.roWaiters.length = 0; // 丢弃排队的只读查询（已断连，回执也无处可发）
    this.wssLink?.stop();
    this.wssLink = null;
  }

  /** 通知广播（SessionManager 注入的 notify 回调） */
  notify(tenantId: string, ev: NotifyEvent): void {
    const payload =
      ev.kind === "approval_request"
        ? {
            ...ev,
            projectId: tenantId,
            data: {
              ...ev.data,
              table: approvalToMarkdownTable(approvalInputFromData(ev.data)),
            },
          }
        : { ...ev, projectId: tenantId };
    this._send({ kind: "notify", json: JSON.stringify(payload) });
  }

  /** 事件桥接（SessionManager 注入的 onEvent 回调）；发布按窗口批量合并 */
  onEvent(tenantId: string, sessionId: string, entry: EventEntry): void {
    // 运行统计（轻量计数，随 info 上报）
    if (entry.type === "turn_end") this.stats.turns += 1;
    else if (entry.type === "tool_finished") this.stats.toolCalls += 1;
    else if (entry.type === "error") this.stats.errors += 1;
    if (entry.type === "assistant_message") {
      const usage = entry.data.usage as { input?: unknown; output?: unknown } | undefined;
      if (usage) {
        this.stats.tokensIn += Number(usage.input ?? 0) || 0;
        this.stats.tokensOut += Number(usage.output ?? 0) || 0;
        // 节流上报（≥30s 一次），让控制面用量及时更新
        const now = Date.now();
        if (now - this.lastInfoTs > 30_000) {
          this.lastInfoTs = now;
          this._publishInfo();
        }
      }
    }
    this._queueEvent(JSON.stringify({ ...entry, projectId: tenantId, sessionId }));
  }

  /**
   * 事件发布批量合并：把窗口内的多条事件合并为一条消息（`{zqBatch:[...]}`），
   * 单条时保持原格式。流式 deltas 从每秒几十条降到每秒几条，
   * 大幅减少帧编码/序列化开销（事件循环占用）。
   */
  private _queueEvent(json: string): void {
    this.pendingEvents.push(json);
    this.pendingEventBytes += json.length + 1;
    if (
      this.pendingEvents.length >= EVENT_FLUSH_MAX_EVENTS ||
      this.pendingEventBytes >= EVENT_FLUSH_MAX_BYTES
    ) {
      this._flushEvents();
      return;
    }
    if (!this.eventFlushTimer) {
      this.eventFlushTimer = setTimeout(() => this._flushEvents(), EVENT_FLUSH_MS);
      this.eventFlushTimer.unref?.();
    }
  }

  private _flushEvents(): void {
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
    if (this.pendingEvents.length === 0) return;
    const items = this.pendingEvents;
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    const payload = items.length === 1 ? items[0]! : `{"zqBatch":[${items.join(",")}]}`;
    this._send({ kind: "event", json: payload });
  }

  /** 最近一次连接错误，未出错时为 null */
  getLastError(): string | null {
    return this.lastError;
  }

  /** 连续连接失败次数（连上后清零） */
  getErrorCount(): number {
    return this.errCount;
  }

  /**
   * 记录一次链路断开。
   *
   * 只在**首次断开**时通知上层（WssLink 内部会持续重连），并给出断开原因——
   * 否则控制台会收到一串无信息的离线通知。
   */
  private _noteDown(reason: string): void {
    this.errCount += 1;
    this.lastError = reason;
    if (this.downSince === null) this.downSince = Date.now();
    if (!this.everConnected) {
      // 首连就没成功过：告警一次即可，重连由 WssLink 负责
      console.warn(`[fleet] 节点 ${this.nodeId} 未能接入网关（${reason}）`);
      return;
    }
    this.opts.onStatus?.(false);
    console.log(`[fleet] 节点 ${this.nodeId} 与网关的连接断开（${reason}）`);
  }

  /** 项目列表变化后刷新 info（控制台据此更新节点视图） */
  refreshInfo(): void {
    this._publishInfo();
  }

  // ===================== 内部 =====================

  private _status(online: boolean): FleetStatus {
    return {
      nodeId: this.nodeId,
      online,
      ts: new Date().toISOString(),
      label: this.opts.deps.store.loadNodeLabel() ?? undefined,
      platform: process.platform,
      mode: process.env.NODE_MODE ?? "standalone",
      version: process.env.ZQAGENT_VERSION ?? "dev",
      ip: primaryIp(),
    };
  }

  /** 用量汇总（供控制面账户级聚合）：总量 + 最近 40 天按天 */
  private _usagePayload(): Record<string, unknown> | undefined {
    const ledger = this.opts.deps.manager.usageLedger();
    if (!ledger) return undefined;
    const r = ledger.getRollup();
    const days: Record<string, unknown> = {};
    const keys = Object.keys(r.byDay).sort().slice(-40);
    for (const k of keys) days[k] = r.byDay[k];
    return {
      since: r.since,
      total: r.total,
      legacy: r.legacy ?? null,
      byDay: days,
    };
  }

  private _publishInfo(): void {
    // 聚合每个项目的会话计数（运行中 / 待审批待回答），供控制台总览。
    const totals = { projects: 0, sessions: 0, running: 0, waiting: 0 };
    /**
     * 会话状态快照：带标识（projectId / sessionId / name）、status 与最近一条
     * 用户消息（截断）。
     *
     * 跨节点总览（工作台、节点首页）打开时靠这份快照建立初始状态，之后由
     * `session_status` 通知增量更新；模型/token/完整消息等明细一律不进这里。
     * 复用下面已有的 `listSessions` 循环，不额外读盘。
     */
    const sessions: Array<{
      projectId: string;
      sessionId: string;
      name: string | null;
      status: string;
      lastUserMessage: string | null;
      lastCompletedAt: string | null;
    }> = [];
    const projects = allProjectSummaries(this.opts.deps.store).map((p) => {
      let running = 0;
      let waiting = 0;
      try {
        for (const s of this.opts.deps.manager.listSessions(p.id)) {
          if (s.status === "running") running += 1;
          else if (s.status === "waiting_approval" || s.status === "waiting_question") waiting += 1;
          sessions.push({
            projectId: p.id,
            sessionId: s.sessionId,
            name: s.name ?? null,
            status: s.status,
            lastUserMessage: lastUserMessage(s),
            // 控制面的聚合邮件靠它判断「这台机器最近有没有在干活」；
            // 状态跃迁可能被 info 节流跳过，完成时间不会。
            lastCompletedAt: s.lastCompletedAt ?? null,
          });
        }
      } catch {
        // 忽略
      }
      totals.projects += 1;
      totals.sessions += p.sessionCount;
      totals.running += running;
      totals.waiting += waiting;
      return { id: p.id, name: p.name, sessionCount: p.sessionCount, running, waiting };
    });
    this._send({
      kind: "info",
      blob: JSON.stringify({
        nodeId: this.nodeId,
        label: this.opts.deps.store.loadNodeLabel() ?? undefined,
        platform: process.platform,
        mode: process.env.NODE_MODE ?? "standalone",
        version: process.env.ZQAGENT_VERSION ?? "dev",
        ip: primaryIp(),
        projects,
        totals,
        sessions,
        stats: {
          ...this.stats,
          since: this.statsSince,
          /** 上次上报以来事件循环最大阻塞（ms；诊断用） */
          lagMs: Math.round((this.lagMonitor?.max ?? 0) / 1e6),
        },
        usage: this._usagePayload(),
        ts: new Date().toISOString(),
      }),
    });
  }

  /**
   * 只读查询并发执行（上限 `READONLY_CONCURRENCY`，超出排队）。
   * 与写操作的串行链相互独立：慢查询不会阻塞写入，写入也不会被查询堵住。
   */
  private _runReadonly(run: () => Promise<void>): void {
    const exec = (): void => {
      this.roActive += 1;
      void run()
        .catch(() => undefined)
        .then(() => {
          this.roActive -= 1;
          this.roWaiters.shift()?.();
        });
    };
    if (this.roActive < READONLY_CONCURRENCY) exec();
    else this.roWaiters.push(exec);
  }

  /** batch 是否只含只读子指令（据此决定走并发池还是串行链） */
  private _isReadonlyBatch(env: FleetCmdEnvelope): boolean {
    if (env.type !== "batch") return false;
    const cmds = env.payload?.commands;
    if (!Array.isArray(cmds) || cmds.length === 0) return false;
    return cmds.every((c) => {
      const t = (c as { type?: unknown } | null)?.type;
      return typeof t === "string" && t !== "batch" && READONLY_CMD_TYPES.has(t);
    });
  }

  private async _dispatch(env: FleetCmdEnvelope): Promise<void> {
    const __t0 = dbgNow(); // [dbg]
    if (env.type === "batch") {
      await this._dispatchBatch(env);
      dbgMs("dispatch:batch", __t0, `reqId=${env.reqId}`); // [dbg]
      return;
    }
    const ack = await this._execute(env);
    const __t1 = dbgNow(); // [dbg]
    // 写操作：在发回执**之前**失效只读缓存。
    //
    // 控制台收到回执后常立刻查询状态（如提交消息后刷新会话 `get_state`）。若此刻缓存
    // 仍有效（1.5s TTL），它读到的是写之前的值 —— 表现为「刚发完消息，状态还是 idle」。
    // 放在 `_publishAck` 之前，客户端拿到回执时缓存已经失效。
    if (!READONLY_CMD_TYPES.has(env.type)) this._invalidateReadonlyCache();
    this._publishAck(env, ack);
    dbgMs(
      `dispatch:${env.type}`,
      __t0, // [dbg]
      `reqId=${env.reqId} exec=${__t1 - __t0}ms ok=${ack.ok}`,
    );
    // 项目增删会改变节点视图 → 刷新 info
    if (
      ack.ok &&
      (env.type === "create_project" || env.type === "delete_project" || env.type === "update_config")
    ) {
      this._publishInfo();
    }
    // 改名：status（含 label）与 info 均需重发
    if (ack.ok && env.type === "set_node_label") {
      this._send({ kind: "status", status: this._status(this.isConnected()) });
      this._publishInfo();
    }
  }

  /**
   * 批量指令：一次往返执行多条子指令（前端把页面加载的并发调用合并为一批）。
   * 子指令**顺序执行**（上一条完成后才执行下一条），整批有截止时间，
   * 避免任何一条慢指令或并发执行压垮事件循环。
   */
  private async _dispatchBatch(env: FleetCmdEnvelope): Promise<void> {
    const raw = env.payload?.commands;
    const subs = Array.isArray(raw) ? (raw as FleetBatchSubCmd[]) : [];
    const deadline = Date.now() + BATCH_TOTAL_TIMEOUT_MS;
    const results: FleetBatchResult[] = [];
    for (const sub of subs.slice(0, BATCH_MAX_SUBS)) {
      const type = String(sub?.type ?? "");
      if (!type || type === "batch") {
        results.push({ type, ok: false, error: "无效的子指令类型" });
        continue;
      }
      const remain = deadline - Date.now();
      if (remain <= 0) {
        results.push({ type, ok: false, error: "批量超时（未执行）" });
        continue;
      }
      const subEnv: FleetCmdEnvelope = {
        ...env,
        type: type as FleetCmdEnvelope["type"],
        projectId: typeof sub.projectId === "string" ? sub.projectId : undefined,
        sessionId: typeof sub.sessionId === "string" ? sub.sessionId : undefined,
        payload: (sub.payload ?? {}) as Record<string, unknown>,
      };
      try {
        const __t0 = dbgNow(); // [dbg]
        const ack = await withTimeout(
          this._execute(subEnv),
          Math.min(BATCH_SUB_TIMEOUT_MS, remain),
        );
        dbgMs(`batch.sub:${type}`, __t0, `ok=${ack.ok}`); // [dbg]
        results.push({ type, ok: ack.ok, data: ack.data, error: ack.error });
      } catch (e) {
        results.push({ type, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this._publishAck(env, { reqId: env.reqId, type: "batch", ok: true, data: { results } });
  }

  /**
   * 执行单条指令（含只读查询的并发去重 + 短 TTL 结果复用）。
   * 控制台页签恢复/多端同时打开会在一两秒内并发发出几十条重复查询
   * （get_node_llm/list_models/get_events/project_stats…），全部实算会长时间
   * 占满事件循环、错过心跳与回执；同键请求共享一次执行结果即可。
   */
  private async _execute(env: FleetCmdEnvelope): Promise<FleetAckPayload> {
    const dedupeKey = READONLY_CMD_TYPES.has(env.type)
      ? `${env.type}|${env.projectId ?? ""}|${env.sessionId ?? ""}|${JSON.stringify(env.payload ?? {})}`
      : null;
    const stamp = (ack: FleetAckPayload): FleetAckPayload => ({
      ...ack,
      reqId: env.reqId,
      type: env.type,
    });
    if (!dedupeKey) {
      return dispatchFleetCommand({ ...this.opts.deps, nodeId: this.nodeId }, env);
    }
    const now = Date.now();
    // 记下开始时的写代次：若执行期间发生过写操作，本结果可能已过期，不再入缓存
    const epoch = this.writeEpoch;
    const cached = this.cmdResultCache.get(dedupeKey);
    if (cached && now - cached.at < CMD_CACHE_TTL_MS) return stamp(cached.ack);
    let task = this.cmdInflight.get(dedupeKey);
    if (!task) {
      task = dispatchFleetCommand({ ...this.opts.deps, nodeId: this.nodeId }, env);
      this.cmdInflight.set(dedupeKey, task);
      try {
        const result = await task;
        if (result.ok && this.writeEpoch === epoch) {
          this.cmdResultCache.set(dedupeKey, { at: Date.now(), ack: result });
        }
        if (this.cmdResultCache.size > 300) {
          for (const [k, v] of this.cmdResultCache) {
            if (now - v.at > CMD_CACHE_TTL_MS) this.cmdResultCache.delete(k);
          }
        }
        return stamp(result);
      } finally {
        this.cmdInflight.delete(dedupeKey);
      }
    }
    return stamp(await task);
  }

  /**
   * 发布回执。
   *
   * 早期用 QoS 0 是为了避免未确认回执跨重连重放，但代价是**丢一次回执就让控制面
   * 把整节点判定为「无响应」一段时间**。现在网关按 `reqId` 查表后立即删除 pending，
   * 重放的回执找不到等待方会被直接丢弃，因此重发是幂等且无害的。
   * 命中缓存的结果会改写为当前 reqId/type。
   */
  private _publishAck(env: FleetCmdEnvelope, ack: FleetAckPayload): void {
    const __t0 = dbgNow(); // [dbg]
    const stamped = { ...ack, reqId: env.reqId, type: env.type };
    const json = JSON.stringify(stamped);
    const __t1 = dbgNow(); // [dbg]
    this._send({ kind: "ack", clientId: env.clientId, ack: stamped });
    dbgMs(
      "publishAck",
      __t0, // [dbg]
      `type=${env.type} bytes=${json.length} stringify=${__t1 - __t0}ms`,
    );
  }

  /**
   * 出站统一入口。
   *
   * 所有上行都汇聚到这里，好处是「链路是否就绪」的判定只有一处——原先散落在
   * 多处 publish 前的检查很容易漏掉某条路径。未就绪时静默丢弃（重连后由上层刷新）。
   */
  private _send(out: FleetOutbound): void {
    const link = this.wssLink;
    if (!link || !link.isReady()) return;
    const frame = encodeOutbound(out, this.nodeId);
    if (!frame) {
      console.warn(`[fleet] 节点 ${this.nodeId} 上行消息无法编码为帧（${out.kind}），已跳过`);
      return;
    }
    link.send(frame);
  }
}
