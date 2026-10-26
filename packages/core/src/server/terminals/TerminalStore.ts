/**
 * 终端历史与元信息的落盘层
 *
 * 目录结构（`{DATA_DIR}/terminals/`）：
 *
 *   index.json            终端元信息（id / 标签 / 项目 / cwd / 时间 / 状态）
 *   settings.json         { retentionDays }（默认 30，范围 1–365）
 *   {terminalId}.jsonl    逐条记录：cmd（命令）/ out（输出）/ exit（退出）
 *
 * ## 两条硬约束（都是为了让「历史记录」不拖垮节点）
 *
 * 1. **落盘限速**：每终端每秒最多写 `historyBytesPerSec` 字节，超出丢弃并写一条
 *    `[输出过快，已截断]`。`yes` / `tail -f` 这类刷屏输出若不限速，几秒钟就能把
 *    磁盘写满、把事件循环拖住。**实时流不受影响**，限速只作用于历史。
 * 2. **保留期**：默认 30 天（用户可在控制台改），启动时 + 每 6h 清理一次。
 *    清理按 `lastActiveAt` 判断，不依赖文件 mtime（拷贝/恢复后 mtime 不可信）。
 *
 * 写索引走「临时文件 + rename」，避免进程被 kill 时留下半个 JSON。
 */
import * as fsp from "fs/promises";
import * as fs from "fs";
import * as path from "path";

/** 终端元信息（`index.json` 的一项） */
export interface TerminalMeta {
  id: string;
  label: string;
  projectId: string;
  /** 启动时的 cwd（绝对路径） */
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  /** running = 进程还活着；exited = 已退出（节点重启后遗留的也算 exited） */
  status: "running" | "exited";
  /** 退出码；仍在运行时为 null */
  exitCode?: number | null;
  /** 实际使用的 shell 可执行文件（诊断用） */
  shell?: string;
  /**
   * 最近一次上报的终端尺寸。
   *
   * 当前没有 PTY，尺寸只作记录（供历史展示与将来接 PTY 时初始化 winsize 用）；
   * 不参与渲染——前端 xterm 自己按容器大小绘制。
   */
  cols?: number;
  rows?: number;
}

/** 节点级终端设置 */
export interface TerminalSettings {
  /** 历史保留天数（1–365，默认 30） */
  retentionDays: number;
}

/** 历史记录的一行 */
export interface TerminalRecord {
  /** cmd = 用户敲的一整行命令；out = 输出片段；exit = 进程退出 */
  t: "cmd" | "out" | "exit";
  ts: string;
  /** t=cmd：命令行原文 */
  cmd?: string;
  /** t=out：输出文本（已按 UTF-8 解码；可能被限速截断） */
  data?: string;
  /** t=exit：退出码 / 信号 / 运行时长 */
  code?: number | null;
  signal?: string | null;
  durationMs?: number;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
/** 单次清理间隔 */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 历史读取上限（防止一次拉回一个 8MB 文件） */
const DEFAULT_HISTORY_LIMIT = 500;

/** 写日志句柄（每终端一个惰性创建的流） */
interface LogHandle {
  stream: fs.WriteStream;
  /** 已写字节数（达到上限后停止落盘） */
  bytes: number;
  /** 限速窗口 */
  windowStart: number;
  windowBytes: number;
  /** 本窗口内因限速丢弃的字节数（>0 时下个窗口补一条截断标记） */
  dropped: number;
  /** 补写截断标记的定时器（输出停止后也要写，见 `scheduleTruncationMark`） */
  markTimer?: ReturnType<typeof setTimeout>;
  /** 已达单文件上限：只写一条提示后彻底停止 */
  capped: boolean;
}

export class TerminalStore {
  private readonly logHandles = new Map<string, LogHandle>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** 索引写入链：并发 saveIndex 按调用顺序串行，避免互相覆盖 */
  private indexChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly opts: { historyBytesPerSec?: number; maxLogBytes?: number } = {},
  ) {}

  private get rateBytes(): number {
    return this.opts.historyBytesPerSec ?? 4 * 1024;
  }

  private get maxBytes(): number {
    return this.opts.maxLogBytes ?? 8 * 1024 * 1024;
  }

  private indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  private settingsPath(): string {
    return path.join(this.dir, "settings.json");
  }

  private logPath(terminalId: string): string {
    return path.join(this.dir, `${terminalId}.jsonl`);
  }

  /** 确保目录存在 */
  async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  // ===================== 索引 =====================

  async loadIndex(): Promise<TerminalMeta[]> {
    try {
      const raw = await fsp.readFile(this.indexPath(), "utf-8");
      const parsed = JSON.parse(raw) as { terminals?: unknown };
      if (!Array.isArray(parsed.terminals)) return [];
      return parsed.terminals.filter(isMeta);
    } catch {
      // 不存在 / 损坏：当作空索引（不抛错，终端功能不能因为索引坏了就用不了）
      return [];
    }
  }

  async saveIndex(list: TerminalMeta[]): Promise<void> {
    const run = async (): Promise<void> => {
      await this.ensureDir();
      const tmp = `${this.indexPath()}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify({ terminals: list }, null, 2)}\n`, "utf-8");
      await fsp.rename(tmp, this.indexPath());
    };
    this.indexChain = this.indexChain.then(run, run);
    return this.indexChain;
  }

  // ===================== 设置 =====================

  async loadSettings(): Promise<TerminalSettings> {
    try {
      const raw = await fsp.readFile(this.settingsPath(), "utf-8");
      const parsed = JSON.parse(raw) as { retentionDays?: unknown };
      return { retentionDays: clampRetention(parsed.retentionDays) };
    } catch {
      return { retentionDays: DEFAULT_RETENTION_DAYS };
    }
  }

  async saveSettings(next: TerminalSettings): Promise<TerminalSettings> {
    const value: TerminalSettings = { retentionDays: clampRetention(next.retentionDays) };
    await this.ensureDir();
    const tmp = `${this.settingsPath()}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await fsp.rename(tmp, this.settingsPath());
    return value;
  }

  // ===================== 历史记录 =====================

  /**
   * 追加一条记录（**同步返回、异步落盘**）。
   *
   * 之所以不返回 Promise：调用点在数据事件回调里，高频输出下每帧一个 Promise
   * 会制造大量微任务。内部用 WriteStream 排队，写失败只打日志。
   */
  append(terminalId: string, rec: TerminalRecord): void {
    const handle = this.logHandle(terminalId);
    if (!handle) return;

    const line = `${JSON.stringify(rec)}\n`;
    const size = Buffer.byteLength(line);

    if (handle.capped) return;

    const now = Date.now();
    if (now - handle.windowStart >= 1000) {
      handle.windowStart = now;
      handle.windowBytes = 0;
      if (handle.dropped > 0) {
        handle.dropped = 0;
        this.writeLine(handle, {
          t: "out",
          ts: new Date().toISOString(),
          data: "\n[输出过快，已截断]\n",
        });
      }
    }

    // 命令与退出记录永远写（体积极小、审计价值高），只有输出受两层限流
    if (rec.t === "out") {
      if (handle.windowBytes + size > this.rateBytes) {
        /*
         * 单块就超过配额时（`yes` 的一个 read 通常是 64KB，远大于 4KB/s），
         * 若直接整块丢弃，历史里会一条输出都没有——用户回看时无法判断
         * 「命令到底跑没跑」。这里截一段样本写下去，保证历史有上下文。
         */
        const remaining = Math.max(0, this.rateBytes - handle.windowBytes);
        const text = rec.data ?? "";
        if (remaining > 200 && text) {
          const sample = text.slice(0, Math.max(0, remaining - 100));
          if (sample) {
            this.writeLine(handle, { ...rec, data: sample });
            handle.windowBytes += Buffer.byteLength(sample);
          }
        }
        handle.dropped += size;
        this.scheduleTruncationMark(terminalId, handle);
        return;
      }
      if (handle.bytes + size > this.maxBytes) {
        handle.capped = true;
        this.writeLine(handle, {
          t: "out",
          ts: new Date().toISOString(),
          data: "\n[本终端日志已达上限，后续输出不再保存；实时输出不受影响]\n",
        });
        return;
      }
    }

    handle.windowBytes += size;
    this.writeLine(handle, rec);
  }

  /**
   * 补写「输出过快，已截断」标记。
   *
   * 为什么不能只在「下个写入窗口」补：`yes` / `cat 大文件` 的输出是一口气喷完的，
   * 之后不再有任何 append 调用——若只在下次 append 时才写标记，这条标记永远不出现，
   * 用户翻历史会以为命令没有任何输出。
   */
  private scheduleTruncationMark(terminalId: string, handle: LogHandle): void {
    if (handle.markTimer) return;
    handle.markTimer = setTimeout(() => {
      handle.markTimer = undefined;
      if (handle.dropped <= 0 || handle.capped) return;
      handle.dropped = 0;
      this.writeLine(handle, {
        t: "out",
        ts: new Date().toISOString(),
        data: "\n[输出过快，已截断]\n",
      });
    }, 1200);
    handle.markTimer.unref?.();
    void terminalId;
  }

  private writeLine(handle: LogHandle, rec: TerminalRecord): void {
    const line = `${JSON.stringify(rec)}\n`;
    handle.bytes += Buffer.byteLength(line);
    try {
      handle.stream.write(line);
    } catch {
      // 写失败（磁盘满等）：停掉这个句柄，避免反复报错刷日志
      handle.capped = true;
    }
  }

  private logHandle(terminalId: string): LogHandle | null {
    const existing = this.logHandles.get(terminalId);
    if (existing) return existing;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const stream = fs.createWriteStream(this.logPath(terminalId), { flags: "a" });
      // 未被引用的错误监听会让 EPIPE/ENOSPC 变成未捕获异常，直接拖垮进程
      stream.on("error", () => {
        const h = this.logHandles.get(terminalId);
        if (h) h.capped = true;
      });
      const handle: LogHandle = {
        stream,
        bytes: 0,
        windowStart: Date.now(),
        windowBytes: 0,
        dropped: 0,
        capped: false,
      };
      this.logHandles.set(terminalId, handle);
      return handle;
    } catch {
      return null;
    }
  }

  /** 关闭某终端的日志流（终端关闭时调用；历史文件保留） */
  closeLog(terminalId: string): void {
    const handle = this.logHandles.get(terminalId);
    if (!handle) return;
    this.logHandles.delete(terminalId);
    // 关闭前补写截断标记：否则「最后一个窗口被限速」这件事在历史里完全看不出来
    if (handle.dropped > 0 && !handle.capped) {
      handle.dropped = 0;
      this.writeLine(handle, {
        t: "out",
        ts: new Date().toISOString(),
        data: "\n[输出过快，已截断]\n",
      });
    }
    if (handle.markTimer) {
      clearTimeout(handle.markTimer);
      handle.markTimer = undefined;
    }
    try {
      handle.stream.end();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 读取历史（新→旧截取最近 `limit` 条后按时间正序返回）。
   *
   * 逐行解析而不是整体 JSON.parse：文件是 JSONL，且可能因进程被 kill 留下
   * 最后一行不完整——跳过坏行，不让整个历史读不出来。
   */
  async readHistory(
    terminalId: string,
    opts: { limit?: number; since?: string } = {},
  ): Promise<TerminalRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_HISTORY_LIMIT, 1), 5000);
    let raw: string;
    try {
      raw = await fsp.readFile(this.logPath(terminalId), "utf-8");
    } catch {
      return [];
    }
    const records: TerminalRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as TerminalRecord;
        if (rec && (rec.t === "cmd" || rec.t === "out" || rec.t === "exit")) records.push(rec);
      } catch {
        /* 坏行（如被截断的最后一行）跳过 */
      }
    }
    const filtered = opts.since
      ? records.filter((r) => typeof r.ts === "string" && r.ts >= opts.since!)
      : records;
    return filtered.slice(-limit);
  }

  /** 删除某终端的历史文件（删除终端时用） */
  async removeLog(terminalId: string): Promise<void> {
    this.closeLog(terminalId);
    try {
      await fsp.unlink(this.logPath(terminalId));
    } catch {
      /* 不存在即视为已删除 */
    }
  }

  // ===================== 保留期清理 =====================

  /**
   * 按保留期清理：删掉 `lastActiveAt` 早于截止时间的日志文件。
   *
   * 返回被清理的终端数与**保留下来的**元信息（调用方据此重写索引）。
   */
  async purgeExpired(
    metaList: TerminalMeta[],
    retentionDays: number,
  ): Promise<{ kept: TerminalMeta[]; removed: string[] }> {
    const days = clampRetention(retentionDays);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept: TerminalMeta[] = [];
    const removed: string[] = [];
    for (const meta of metaList) {
      const at = Date.parse(meta.lastActiveAt);
      // 时间解析不了就保留：宁可多留，不能误删用户的历史
      if (Number.isFinite(at) && at < cutoff) {
        await this.removeLog(meta.id);
        removed.push(meta.id);
      } else {
        kept.push(meta);
      }
    }
    return { kept, removed };
  }

  /** 启动定时清理（unref：不阻止进程退出） */
  startPurgeTimer(fn: () => void, intervalMs = PURGE_INTERVAL_MS): void {
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(fn, intervalMs);
    this.purgeTimer.unref?.();
  }

  stopPurgeTimer(): void {
    if (!this.purgeTimer) return;
    clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  dispose(): void {
    this.stopPurgeTimer();
    for (const id of [...this.logHandles.keys()]) this.closeLog(id);
  }
}

function clampRetention(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

function isMeta(v: unknown): v is TerminalMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.projectId === "string" &&
    typeof m.cwd === "string" &&
    (m.status === "running" || m.status === "exited")
  );
}
