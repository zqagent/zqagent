/**
 * 交互式终端管理（控制台「终端」面板的节点侧）
 *
 * ## 为什么不用 node-pty
 *
 * `node-pty` 是原生模块，会同时打破两条发布通道：SEA 单文件可执行程序与多架构
 * Docker 镜像（见 README「发布通道」）。因此这里用 `child_process.spawn` + 管道，
 * 代价与补偿都说清楚：
 *
 *   - **没有 PTY**：`vim` / `top` / `htop` 等全屏 TUI 不可用；`ssh` 需要 `-T`。
 *   - **没有终端回显**：非 TTY 下 shell 不会回显按键（回显是终端驱动做的）。
 *     因此**由前端本地回显**（`TerminalView` 的 onData 先写本地再发送），
 *     这与「无 PTY 终端」的通行做法一致。
 *   - 普通命令、`npm`/`git`/`python`/数据库 CLI、长任务、交互式问答**都能正常用**。
 *
 * ## 与 Agent 的 run_shell 的关系
 *
 * 完全独立：`tools/shell.ts` 是 turn 绑定的工具（受权限引擎审批、结果进对话），
 * 这里是用户在控制台手敲的会话（不经审批、落盘即审计）。两者共用 shell 解析
 * 思路，但不共享状态——Agent 的 `cd` 不会影响用户的终端，反之亦然。
 *
 * ## 与网关的关系
 *
 * 输出**不**走事件流：由 `onOutput` 注入的上行函数发 `FrameType.TERMINAL`，
 * 网关用独立队列扇出（见 proto 的 `TerminalData`）。本地节点则走 SSE。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as os from "os";
import { randomBytes } from "crypto";
import {
  TerminalStore,
  type TerminalMeta,
  type TerminalRecord,
  type TerminalSettings,
} from "./TerminalStore.js";

/** 输出/状态事件（本地 SSE 与网关上行共用同一形态） */
export interface TerminalOutputEvent {
  projectId: string;
  terminalId: string;
  /** opened = 已启动；data = 输出；exited = 进程退出；error = 控制面错误 */
  kind: "opened" | "data" | "exited" | "error";
  /** kind=data 时为输出字节；error 为 UTF-8 错误文案 */
  data?: Uint8Array;
  /** 终端内局部序号（单调递增，用于前端发现丢帧） */
  seq: number;
  ts: string;
}

export interface TerminalManagerOptions {
  /** 终端数据根目录（`{DATA_DIR}/terminals`） */
  dir: string;
  /** 解析项目工作区根；返回 null 时回退用户主目录 */
  resolveWorkspace: (projectId: string) => string | null;
  /** 输出上行（网关 WSS）。未接入云端时为空，本地 SSE 仍可用 */
  onOutput?: (ev: TerminalOutputEvent) => void;
  /** 空闲回收：超过该时长无输入输出即关闭（默认 24h） */
  idleTimeoutMs?: number;
  /** 落盘限速与单文件上限（透传 TerminalStore） */
  historyBytesPerSec?: number;
  maxLogBytes?: number;
}

/** 回放缓冲上限（重连时补最近这么多字符，而不是整段历史） */
const REPLAY_BUFFER_BYTES = 200 * 1024;
/** SIGTERM 后等这么久仍未退出则 SIGKILL */
const KILL_GRACE_MS = 2_000;
/** 索引落盘防抖（运行中的 lastActiveAt 变化很频繁） */
const INDEX_FLUSH_DEBOUNCE_MS = 5_000;
/** 关闭终端的计时器扫描间隔 */
const IDLE_SCAN_MS = 5 * 60 * 1000;

interface TerminalRuntime {
  meta: TerminalMeta;
  child: ChildProcessWithoutNullStreams;
  /** 输出回放缓冲（按片段追加，超出上限从头部丢） */
  ring: string[];
  ringBytes: number;
  /** 输出序号（仅该终端内有效） */
  seq: number;
  startedAt: number;
  /** 当前未结束的输入行（用于把一行命令记进历史） */
  lineBuf: string;
  sinks: Set<(ev: TerminalOutputEvent) => void>;
  decoder: TextDecoder;
  /** 最近一次交互时间（空闲回收用） */
  lastTouchAt: number;
  closed: boolean;
}

export class TerminalManager {
  private readonly store: TerminalStore;
  private readonly runtimes = new Map<string, TerminalRuntime>();
  /** 元信息内存副本（含已退出但未删除的终端） */
  private metas = new Map<string, TerminalMeta>();
  /** 项目级订阅者：一条 SSE 连接订阅该项目下**所有**终端（含之后新建的） */
  private readonly projectSinks = new Map<string, Set<(ev: TerminalOutputEvent) => void>>();
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.store = new TerminalStore(opts.dir, {
      historyBytesPerSec: opts.historyBytesPerSec,
      maxLogBytes: opts.maxLogBytes,
    });
  }

  /** 启动时：载入索引、把上一次进程遗留的 running 标记为 exited、跑一次保留期清理 */
  async init(): Promise<void> {
    await this.store.ensureDir();
    const list = await this.store.loadIndex();
    for (const meta of list) {
      // 进程不会跨节点重启存活，磁盘上写 running 的一定是遗留状态
      this.metas.set(meta.id, meta.status === "running" ? { ...meta, status: "exited" } : meta);
    }
    await this.saveIndex();
    await this.purgeExpired();
    this.store.startPurgeTimer(() => {
      void this.purgeExpired();
    });
    this.idleTimer = setInterval(() => this.sweepIdle(), IDLE_SCAN_MS);
    this.idleTimer.unref?.();
  }

  // ===================== 查询 =====================

  /** 列出终端（按创建时间倒序）；projectId 为空表示全部项目 */
  list(projectId?: string): TerminalMeta[] {
    const all = [...this.metas.values()];
    const filtered = projectId ? all.filter((m) => m.projectId === projectId) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(terminalId: string): TerminalMeta | null {
    return this.metas.get(terminalId) ?? null;
  }

  /** 是否仍有活跃进程 */
  isRunning(terminalId: string): boolean {
    return this.runtimes.has(terminalId);
  }

  /** 回放缓冲（重连时补最近输出；已关闭的终端返回空串） */
  replayOutput(terminalId: string): string {
    const rt = this.runtimes.get(terminalId);
    return rt ? rt.ring.join("") : "";
  }

  // ===================== 生命周期 =====================

  /** 新建终端（多终端并行：每次调用一个新进程） */
  async create(input: {
    projectId: string;
    label?: string;
    shell?: string;
  }): Promise<TerminalMeta> {
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) throw new Error("缺少 projectId");
    const workspace = this.opts.resolveWorkspace(projectId);
    const cwd = workspace && workspace.trim() ? workspace : os.homedir();
    const { file, args } = resolveShell(input.shell);
    const id = `t_${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();

    const meta: TerminalMeta = {
      id,
      label: input.label?.trim() || this.nextDefaultLabel(projectId),
      projectId,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      status: "running",
      exitCode: null,
      shell: file,
    };

    const child = spawn(file, args, {
      cwd,
      env: {
        ...process.env,
        // 让带颜色的 CLI 正常输出 ANSI（xterm 能渲染）；TUI 仍需 PTY，故不承诺
        TERM: process.env.TERM || "xterm-256color",
        COLORTERM: process.env.COLORTERM || "truecolor",
        // 交互式 git 会卡在凭据输入上；终端里用户可显式去掉这个变量
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
      },
      stdio: "pipe",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    const rt: TerminalRuntime = {
      meta,
      child,
      ring: [],
      ringBytes: 0,
      seq: 0,
      startedAt: Date.now(),
      lineBuf: "",
      sinks: new Set(),
      decoder: new TextDecoder("utf-8"),
      lastTouchAt: Date.now(),
      closed: false,
    };
    this.runtimes.set(id, rt);
    this.metas.set(id, meta);

    child.stdout.on("data", (chunk: Buffer) => this._onOutput(rt, chunk));
    child.stderr.on("data", (chunk: Buffer) => this._onOutput(rt, chunk));
    child.on("error", (err) => {
      this.store.append(id, {
        t: "exit",
        ts: new Date().toISOString(),
        code: null,
        signal: null,
      });
      this._emit(rt, "error", new TextEncoder().encode(`终端启动失败：${err.message}`));
      this._finalize(rt, null, null);
    });
    child.on("exit", (code, signal) => this._finalize(rt, code, signal));
    // stdin 关闭（进程退出后写会 EPIPE）：吞掉错误，避免未捕获异常
    child.stdin.on("error", () => {
      /* 忽略：进程已退出时写入必然失败 */
    });

    // 新建是低频操作，直接落盘：用户刷新页面应立刻看到这个终端
    await this.saveIndex();
    this._emit(rt, "opened", undefined);
    return meta;
  }

  /**
   * 写入用户输入。
   *
   * 返回 false 表示终端不存在或进程已退出（前端据此提示重开）。
   * 同时把「一整行命令」记进历史：行边界按 `\r` / `\n` 切，空行不记。
   */
  write(terminalId: string, data: string): boolean {
    const rt = this.runtimes.get(terminalId);
    if (!rt || rt.closed) return false;
    const text = String(data ?? "");
    if (!text) return true;
    rt.lastTouchAt = Date.now();
    this._touch(rt);
    this._recordCommands(rt, text);
    try {
      rt.child.stdin.write(text);
      return true;
    } catch {
      return false;
    }
  }

  /** 记录尺寸（无 PTY，仅用于历史展示与将来的 PTY 实现） */
  resize(terminalId: string, cols: number, rows: number): boolean {
    const rt = this.runtimes.get(terminalId);
    if (!rt || rt.closed) return false;
    rt.meta.cols = Math.max(1, Math.floor(cols));
    rt.meta.rows = Math.max(1, Math.floor(rows));
    rt.lastTouchAt = Date.now();
    return true;
  }

  /** 关闭进程（SIGTERM → 2s → SIGKILL）。历史与元信息保留 */
  async close(terminalId: string): Promise<TerminalMeta | null> {
    const rt = this.runtimes.get(terminalId);
    if (!rt) {
      const meta = this.metas.get(terminalId);
      return meta ?? null;
    }
    this._terminate(rt);
    await waitExit(rt);
    return this.metas.get(terminalId) ?? null;
  }

  /** 删除终端（关闭进程 + 删历史 + 移出索引） */
  async remove(terminalId: string): Promise<boolean> {
    const rt = this.runtimes.get(terminalId);
    if (rt) {
      this._terminate(rt);
      await waitExit(rt);
    }
    const existed = this.metas.delete(terminalId);
    await this.store.removeLog(terminalId);
    await this.saveIndex();
    return existed;
  }

  /** 重命名（只改展示名，不影响进程） */
  async rename(terminalId: string, label: string): Promise<TerminalMeta | null> {
    const name = label.trim();
    if (!name) return null;
    const meta = this.metas.get(terminalId);
    if (!meta) return null;
    const next = { ...meta, label: name.slice(0, 80) };
    this.metas.set(terminalId, next);
    const rt = this.runtimes.get(terminalId);
    if (rt) rt.meta = next;
    await this.saveIndex();
    return next;
  }

  // ===================== 历史 / 设置 =====================

  history(terminalId: string, opts: { limit?: number } = {}): Promise<TerminalRecord[]> {
    return this.store.readHistory(terminalId, opts);
  }

  settings(): Promise<TerminalSettings> {
    return this.store.loadSettings();
  }

  /** 更新保留天数；返回实际生效值（已夹取到 1–365） */
  async updateSettings(patch: Partial<TerminalSettings>): Promise<TerminalSettings> {
    const current = await this.store.loadSettings();
    const next = await this.store.saveSettings({
      retentionDays: patch.retentionDays ?? current.retentionDays,
    });
    await this.purgeExpired();
    return next;
  }

  /** 按当前保留期清理（返回被清理的终端数） */
  async purgeExpired(): Promise<number> {
    const settings = await this.store.loadSettings();
    const list = [...this.metas.values()];
    const { kept, removed } = await this.store.purgeExpired(list, settings.retentionDays);
    if (removed.length === 0) return 0;
    const alive = new Set(kept.map((m) => m.id));
    for (const id of removed) {
      // 正在运行的终端不删元信息（正在用，删了反而让用户困惑）
      if (this.runtimes.has(id)) continue;
      if (!alive.has(id)) this.metas.delete(id);
    }
    await this.saveIndex();
    return removed.length;
  }

  // ===================== 订阅 =====================

  /** 订阅某个终端的输出；返回取消函数 */
  attach(terminalId: string, sink: (ev: TerminalOutputEvent) => void): () => void {
    const rt = this.runtimes.get(terminalId);
    if (!rt) return () => undefined;
    rt.sinks.add(sink);
    return () => {
      rt.sinks.delete(sink);
    };
  }

  /**
   * 按项目订阅（控制台一条 SSE 连接收全部终端）。
   *
   * 与 `attach` 的区别：新建的终端**自动**纳入，不需要重连——否则用户新建终端后
   * 必须先刷新页面才有输出，体验上等同于"新建失败"。
   */
  subscribeProject(projectId: string, sink: (ev: TerminalOutputEvent) => void): () => void {
    let set = this.projectSinks.get(projectId);
    if (!set) {
      set = new Set();
      this.projectSinks.set(projectId, set);
    }
    set.add(sink);
    return () => {
      const current = this.projectSinks.get(projectId);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) this.projectSinks.delete(projectId);
    };
  }

  // ===================== 内部 =====================

  private _onOutput(rt: TerminalRuntime, chunk: Buffer): void {
    let text: string;
    try {
      // 流式解码：跨 chunk 的多字节字符会被正确拼接
      text = rt.decoder.decode(chunk, { stream: true });
    } catch {
      text = chunk.toString("utf-8");
    }
    if (!text) return;
    rt.lastTouchAt = Date.now();
    this._pushRing(rt, text);
    this.store.append(rt.meta.id, { t: "out", ts: new Date().toISOString(), data: text });
    this._emit(rt, "data", chunk);
  }

  private _pushRing(rt: TerminalRuntime, text: string): void {
    rt.ring.push(text);
    rt.ringBytes += Buffer.byteLength(text);
    while (rt.ringBytes > REPLAY_BUFFER_BYTES && rt.ring.length > 1) {
      const dropped = rt.ring.shift()!;
      rt.ringBytes -= Buffer.byteLength(dropped);
    }
  }

  /** 把输入里完整的命令行记进历史（空行跳过，最多保留 4KB 防超长粘贴） */
  private _recordCommands(rt: TerminalRuntime, text: string): void {
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        const line = rt.lineBuf.trim();
        rt.lineBuf = "";
        if (!line) continue;
        this.store.append(rt.meta.id, {
          t: "cmd",
          ts: new Date().toISOString(),
          cmd: line.slice(0, 4096),
        });
        continue;
      }
      rt.lineBuf += ch;
      if (rt.lineBuf.length > 4096) rt.lineBuf = rt.lineBuf.slice(-4096);
    }
  }

  private _emit(rt: TerminalRuntime, kind: TerminalOutputEvent["kind"], data?: Uint8Array): void {
    const seq = kind === "opened" ? 0 : ++rt.seq;
    const ev: TerminalOutputEvent = {
      projectId: rt.meta.projectId,
      terminalId: rt.meta.id,
      kind,
      ...(data ? { data } : {}),
      seq,
      ts: new Date().toISOString(),
    };
    for (const sink of rt.sinks) {
      try {
        sink(ev);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
    const projectSinks = this.projectSinks.get(rt.meta.projectId);
    if (projectSinks) {
      for (const sink of projectSinks) {
        try {
          sink(ev);
        } catch {
          /* 同上 */
        }
      }
    }
    try {
      this.opts.onOutput?.(ev);
    } catch {
      /* 上行失败（链路断开）不影响本地会话 */
    }
  }

  private _finalize(
    rt: TerminalRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (rt.closed) return;
    rt.closed = true;
    this.runtimes.delete(rt.meta.id);
    const now = new Date().toISOString();
    const meta: TerminalMeta = {
      ...rt.meta,
      status: "exited",
      exitCode: code,
      lastActiveAt: now,
    };
    rt.meta = meta;
    this.metas.set(meta.id, meta);
    this.store.append(meta.id, {
      t: "exit",
      ts: now,
      code,
      signal,
      durationMs: Date.now() - rt.startedAt,
    });
    // 未以换行结尾的半行也记一条，避免历史里丢掉最后输入的命令
    const tail = rt.lineBuf.trim();
    rt.lineBuf = "";
    if (tail) {
      this.store.append(meta.id, { t: "cmd", ts: now, cmd: tail.slice(0, 4096) });
    }
    this._emit(rt, "exited", undefined);
    rt.sinks.clear();
    this.saveIndexSoon();
  }

  private _terminate(rt: TerminalRuntime): void {
    if (rt.closed) return;
    try {
      rt.child.kill("SIGTERM");
    } catch {
      /* 进程可能已退出 */
    }
    const timer = setTimeout(() => {
      try {
        if (!rt.closed) rt.child.kill("SIGKILL");
      } catch {
        /* 忽略 */
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  private _touch(rt: TerminalRuntime): void {
    rt.meta.lastActiveAt = new Date().toISOString();
    this.metas.set(rt.meta.id, rt.meta);
    this.saveIndexSoon();
  }

  /** 空闲回收：长时间无交互的终端自动关闭（避免忘记关的进程一直占资源） */
  private sweepIdle(): void {
    const limit = this.opts.idleTimeoutMs ?? 24 * 60 * 60 * 1000;
    if (limit <= 0) return;
    const now = Date.now();
    for (const rt of [...this.runtimes.values()]) {
      if (now - rt.lastTouchAt < limit) continue;
      this._terminate(rt);
    }
  }

  private nextDefaultLabel(projectId: string): string {
    const n = this.list(projectId).length + 1;
    return `终端 ${n}`;
  }

  /**
   * 防抖落盘（**fire-and-forget**）。
   *
   * 刻意不返回 Promise：运行中的 `lastActiveAt` 每秒都在变，这里只是攒批写盘；
   * 若返回 Promise 并被 await，新建终端就要等满防抖窗口（曾经的 5s 卡顿）。
   */
  private saveIndexSoon(): void {
    if (this.indexTimer || this.disposed) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.saveIndex();
    }, INDEX_FLUSH_DEBOUNCE_MS);
    this.indexTimer.unref?.();
  }

  private saveIndex(): Promise<void> {
    // 已 dispose：不再写盘（进程要退了，各操作此前已即时落盘）
    if (this.disposed) return Promise.resolve();
    // 索引写失败不能中断业务：终端进程本身比「列表是否落盘」重要得多。
    // （测试里临时目录会在 dispose 后被删，生产里也可能遇到磁盘满/权限问题）
    return this.store.saveIndex([...this.metas.values()]).catch((e: unknown) => {
      console.warn(
        `[terminal] 索引落盘失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const rt of [...this.runtimes.values()]) {
      try {
        rt.child.kill("SIGKILL");
      } catch {
        /* 忽略 */
      }
    }
    this.runtimes.clear();
    this.store.dispose();
    void this.saveIndex();
  }
}

/**
 * 交互式 shell 选择。
 *
 * **刻意不加 `-i`**：非 TTY 下 `bash -i` / `zsh -i` 会打印
 * 「cannot set terminal process group / no job control」噪音，且依然没有行编辑与
 * 回显（那是终端驱动的职责）。既然回显必须由前端做，就不要这些噪音。
 */
/** 等进程真正退出（已退出则立即返回）；超时兜底避免永久悬挂 */
function waitExit(rt: TerminalRuntime): Promise<void> {
  if (rt.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, KILL_GRACE_MS + 1000);
    timer.unref?.();
    rt.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function resolveShell(override?: string): { file: string; args: string[] } {
  const custom = (override ?? "").trim();
  if (custom) return { file: custom, args: [] };
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    return { file: comspec, args: [] };
  }
  const sh = (process.env.SHELL ?? "").trim();
  return { file: sh || "/bin/sh", args: [] };
}
