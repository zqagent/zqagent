/**
 * 文件存储层
 *
 * 目录结构（与 CLI 的 FileLogHook 风格一致）：
 *
 *   {root}/tenants/{tenantId}/
 *     config.json                 # 租户配置（模型/Provider/API Key）
 *     workspaces/{sessionId}/     # 会话工作区沙箱（工具写操作限定于此）
 *     sessions/{sessionId}/
 *       session.json              # 会话物化状态（SavedState 超集）
 *       events.jsonl              # 事件日志（审计 / 重放）
 *       turns.ndjson              # 轮次索引（派生：会话详情的逐轮列表，可由 events.jsonl 重建）
 *
 * 写操作使用异步 (fs.promises) 以避免阻塞事件循环导致 SSE 心跳断开。
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";
import type { FleetCredential } from "@zqagent/shared/fleet";
import { BUILTIN_PROVIDER_ID } from "./llmIds.js";
import type {
  EventEntry,
  LlmProviderEntry,
  SessionRecord,
  SessionTurnIndexEntry,
  TenantConfig,
} from "./types.js";
import { dbgMs, dbgNow } from "./dbgTrace.js"; // [dbg] 临时调试，定位后可删
import {
  decryptKey,
  encryptKey,
  llmConfigFile,
  readLlmConfig,
  writeLlmConfig,
  type LlmProviderEntry as LlmProviderEntryStored,
} from "../llmConfig.js";

/** 生成唯一 ID（会话 / 审批 / 提问共用） */
export function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

/** 生成高熵 API Key（项目 / 管理员密钥） */
export function generateApiKey(): string {
  return `zk_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`.slice(0, 44);
}

export interface StoreOptions {
  /**
   * LLM 统一配置文件路径（默认 `llmConfigFile()`，即 `~/.config/zqagent/connections.json`）。
   * 测试可注入隔离路径，避免污染开发者本机配置。
   */
  llmConfigFile?: string;
}

export class Store {
  constructor(
    private readonly root: string,
    private readonly opts: StoreOptions = {},
  ) {}

  /** 本实例使用的 LLM 配置文件路径 */
  private llmFile(): string {
    return this.opts.llmConfigFile ?? llmConfigFile();
  }

  /**
   * 每文件写入链：同文件的异步写按调用顺序串行落盘。
   * 否则「后调用的保存」可能因异步 rename 乱序被「先调用的旧快照」覆盖，
   * 导致磁盘状态停留在旧值（如 completed 被 running 覆盖）。
   */
  private readonly writeChains = new Map<string, Promise<void>>();
  /** session.json 解析缓存（键=文件路径，值含 mtime+size 指纹） */
  private readonly sessionCache = new Map<string, { key: string; rec: SessionRecord }>();

  // ===================== 租户 =====================

  tenantDir(tenantId: string): string {
    return path.join(this.root, "tenants", tenantId);
  }

  listTenants(): string[] {
    const dir = path.join(this.root, "tenants");
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  loadTenant(tenantId: string): TenantConfig | null {
    return this._readJson<TenantConfig>(path.join(this.tenantDir(tenantId), "config.json"));
  }

  saveTenant(config: TenantConfig): void {
    const dir = this.tenantDir(config.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  }

  deleteTenant(tenantId: string): void {
    fs.rmSync(this.tenantDir(tenantId), { recursive: true, force: true });
  }

  // ===================== 会话 =====================

  workspaceDir(tenantId: string, sessionId: string): string {
    return path.join(this.tenantDir(tenantId), "workspaces", sessionId);
  }

  /** 创建（或复用）会话工作区沙箱目录 */
  ensureWorkspace(tenantId: string, sessionId: string): string {
    const dir = this.workspaceDir(tenantId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  sessionDir(tenantId: string, sessionId: string): string {
    return path.join(this.tenantDir(tenantId), "sessions", sessionId);
  }

  listSessions(tenantId: string): string[] {
    const dir = path.join(this.tenantDir(tenantId), "sessions");
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  loadSession(tenantId: string, sessionId: string): SessionRecord | null {
    const p = path.join(this.sessionDir(tenantId, sessionId), "session.json");
    try {
      // 解析缓存（按 mtime+size 失效）：控制台高频查询（get_state/project_stats/
      // list_sessions）会反复读取较大的 session.json，重复 JSON.parse 会长时间
      // 占用事件循环（曾导致节点错过 MQTT 保活而反复断连）。
      const st = fs.statSync(p);
      const key = `${st.mtimeMs}:${st.size}`;
      const hit = this.sessionCache.get(p);
      if (hit && hit.key === key) return hit.rec;
      const __t0 = dbgNow(); // [dbg]
      const rec = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionRecord;
      dbgMs("store.loadSession(解析)", __t0, `bytes=${st.size}`); // [dbg]
      this.sessionCache.set(p, { key, rec });
      if (this.sessionCache.size > 300) {
        const keys = [...this.sessionCache.keys()];
        for (const k of keys.slice(0, keys.length - 150)) this.sessionCache.delete(k);
      }
      return rec;
    } catch {
      this.sessionCache.delete(p);
      return null;
    }
  }

  saveSession(record: SessionRecord): Promise<void> {
    record.savedAt = new Date().toISOString();
    const dir = this.sessionDir(record.tenantId, record.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "session.json");
    // 调用时同步序列化快照，保证写入链按调用顺序落盘（最后一次调用最终获胜）
    const snapshot = JSON.stringify(record, null, 2);
    const tmp = `${file}.${randomUUID()}.tmp`;
    const prev = this.writeChains.get(file) ?? Promise.resolve();
    const next = prev
      .then(() => fsp.writeFile(tmp, snapshot, "utf-8"))
      .then(() => fsp.rename(tmp, file))
      .catch((err) => {
        // 写入失败不影响核心逻辑，仅记录
        console.error(`[store] saveSession 失败 ${record.sessionId}: ${String(err)}`);
        void fsp.rm(tmp, { force: true });
      });
    this.writeChains.set(file, next);
    return next;
  }

  /** 同步保存（仅用于必须立即落盘的路径，如 createSession 后马上提交 turn） */
  saveSessionSync(record: SessionRecord): void {
    record.savedAt = new Date().toISOString();
    const dir = this.sessionDir(record.tenantId, record.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
  }

  deleteSession(tenantId: string, sessionId: string): void {
    this.sessionCache.delete(path.join(this.sessionDir(tenantId, sessionId), "session.json"));
    fs.rmSync(this.sessionDir(tenantId, sessionId), { recursive: true, force: true });
    fs.rmSync(this.workspaceDir(tenantId, sessionId), { recursive: true, force: true });
  }

  // ===================== 事件日志 =====================

  appendEvent(tenantId: string, sessionId: string, entry: EventEntry): Promise<void> {
    const dir = this.sessionDir(tenantId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return fsp
      .appendFile(
        path.join(dir, "events.jsonl"),
        JSON.stringify(entry) + "\n",
        "utf-8",
      )
      .catch(() => {
        // 日志写入失败不影响核心逻辑
      });
  }

  loadEvents(tenantId: string, sessionId: string): EventEntry[] {
    const p = path.join(this.sessionDir(tenantId, sessionId), "events.jsonl");
    const __t0 = dbgNow(); // [dbg]
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const out = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as EventEntry);
      dbgMs("store.loadEvents(整文件)", __t0, `bytes=${raw.length} evts=${out.length}`); // [dbg]
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 读取 events.jsonl 的尾部完整记录（最多约 maxBytes 字节）。
   *
   * 事件按 seq 递增追加，历史可无限增大；控制台回放/运行时物化只关心最近事件，
   * 这里从文件末尾读固定窗口，避免整文件 readFileSync + 逐行 JSON.parse 长时间
   * 阻塞事件循环（曾导致节点错过 MQTT 保活/回执而反复断连）。
   * 返回数组保持原顺序；无法解析的行（窗口首行截断）跳过；
   * 窗口内一条完整记录都没有时回退为整文件读取。
   */
  loadEventsTail(tenantId: string, sessionId: string, maxBytes = 1024 * 1024): EventEntry[] {
    const p = path.join(this.sessionDir(tenantId, sessionId), "events.jsonl");
    const __t0 = dbgNow(); // [dbg]
    let fd: number | null = null;
    try {
      const size = fs.statSync(p).size;
      if (size <= maxBytes) return this.loadEvents(tenantId, sessionId);
      fd = fs.openSync(p, "r");
      const buf = Buffer.allocUnsafe(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      let text = buf.subarray(0, read).toString("utf-8");
      const nl = text.indexOf("\n");
      if (nl < 0) return this.loadEvents(tenantId, sessionId);
      text = text.slice(nl + 1);
      const out: EventEntry[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as EventEntry);
        } catch {
          // 窗口首行/写入中的截断行：跳过
        }
      }
      dbgMs("store.loadEventsTail", __t0, // [dbg]
        `size=${size} read=${read} out=${out.length}${out.length === 0 ? " →将回退整文件" : ""}`);
      return out.length > 0 ? out : this.loadEvents(tenantId, sessionId);
    } catch {
      return this.loadEvents(tenantId, sessionId);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 忽略
        }
      }
    }
  }

  /**
   * 读取事件「一页」：从文件末尾向前，按字节预算取最近的事件。
   *
   * - `before` 省略：取最新的 maxBytes 字节
   * - `before` 指定：只取 seq < before 的事件（向前翻页）
   *
   * 为什么不能复用 loadEventsTail：后者只能从文件末尾读固定窗口，
   * 无法「向前翻页」，而控制台需要滚到顶部继续加载更早的对话。
   * 这里按块从后往前扫，读到预算或文件头即停；翻了多页之后每次
   * before 都紧邻上一页，实际只需读 1~2 块。
   *
   * 返回按 seq 升序；`hasMore` 表示本页最早一条之前还有更早的事件。
   */
  loadEventPage(
    tenantId: string,
    sessionId: string,
    opts: { before?: number; maxBytes: number },
  ): { events: EventEntry[]; hasMore: boolean } {
    const p = path.join(this.sessionDir(tenantId, sessionId), "events.jsonl");
    const { before, maxBytes } = opts;
    const __t0 = dbgNow(); // [dbg]
    let fd: number | null = null;
    try {
      const size = fs.statSync(p).size;
      if (size === 0) return { events: [], hasMore: false };
      fd = fs.openSync(p, "r");
      const CHUNK = 256 * 1024;
      let pos = size;
      /** 已收下的事件（时间升序） */
      const kept: EventEntry[] = [];
      let bytes = 0;
      let hasMore = false;
      let done = false;

      while (pos > 0 && !done) {
        const start = Math.max(0, pos - CHUNK);
        const len = pos - start;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, start);
        const rows = buf.subarray(0, read).toString("utf-8").split("\n");
        // 块首行可能从中间开始（其行头在 start 之前），丢弃；start===0 时是完整行
        if (start > 0) rows.shift();

        for (let i = rows.length - 1; i >= 0; i--) {
          const line = rows[i];
          if (!line) continue;
          let entry: EventEntry;
          try {
            entry = JSON.parse(line) as EventEntry;
          } catch {
            continue; // 正在写入的尾行 / 损坏行
          }
          if (!Number.isFinite(Number(entry.seq))) continue;
          if (before !== undefined && Number(entry.seq) >= before) continue;
          const sz = Buffer.byteLength(line, "utf-8") + 1;
          // 至少保留一条，保证翻页总能推进
          if (bytes > 0 && bytes + sz > maxBytes) {
            hasMore = true;
            done = true;
            break;
          }
          bytes += sz;
          kept.unshift(entry);
        }
        pos = start;
      }
      dbgMs("store.loadEventPage", __t0, // [dbg]
        `size=${size} before=${before ?? "-"} out=${kept.length} bytes≈${bytes} more=${hasMore}`);
      return { events: kept, hasMore };
    } catch {
      return { events: [], hasMore: false };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 忽略
        }
      }
    }
  }

  // ===================== 轮次索引 =====================

  /** 轮次索引文件路径 */
  private turnsFile(tenantId: string, sessionId: string): string {
    return path.join(this.sessionDir(tenantId, sessionId), "turns.ndjson");
  }

  /**
   * 追加一轮的最新快照（同一 startSeq 后写者胜出）。
   *
   * 走与 session.json 相同的每文件写链：索引按「开轮 → 补充消息 → 收轮」
   * 顺序追加，乱序会让列表读到旧的 running 版本。
   */
  appendTurnIndex(
    tenantId: string,
    sessionId: string,
    entry: SessionTurnIndexEntry,
  ): Promise<void> {
    const dir = this.sessionDir(tenantId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.turnsFile(tenantId, sessionId);
    const line = JSON.stringify(entry) + "\n";
    const prev = this.writeChains.get(file) ?? Promise.resolve();
    const next = prev
      .then(() => fsp.appendFile(file, line, "utf-8"))
      .catch((err) => {
        // 索引是派生数据：写失败不影响会话本身，下次读时会重建
        console.error(`[store] appendTurnIndex 失败 ${sessionId}: ${String(err)}`);
      });
    this.writeChains.set(file, next);
    return next;
  }

  /**
   * 读取轮次索引（已按 startSeq 去重取最后一版，升序）。
   *
   * 文件很小（一轮约 0.5KB，1000 轮 ≈ 500KB），同步读即可，
   * 会话详情打开路径不会因历史长度变慢。
   */
  loadTurnIndex(tenantId: string, sessionId: string): SessionTurnIndexEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.turnsFile(tenantId, sessionId), "utf-8");
    } catch {
      return [];
    }
    const byStart = new Map<number, SessionTurnIndexEntry>();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as SessionTurnIndexEntry;
        if (!Number.isFinite(Number(e?.startSeq))) continue;
        byStart.set(Number(e.startSeq), e);
      } catch {
        // 正在写入的尾行 / 损坏行：跳过
      }
    }
    return [...byStart.values()].sort((a, b) => a.startSeq - b.startSeq);
  }

  /** 整文件替换轮次索引（重建用，tmp + rename 原子写） */
  saveTurnIndex(
    tenantId: string,
    sessionId: string,
    entries: SessionTurnIndexEntry[],
  ): Promise<void> {
    const dir = this.sessionDir(tenantId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.turnsFile(tenantId, sessionId);
    const snapshot = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    const tmp = `${file}.${randomUUID()}.tmp`;
    const prev = this.writeChains.get(file) ?? Promise.resolve();
    const next = prev
      .then(() => fsp.writeFile(tmp, snapshot, "utf-8"))
      .then(() => fsp.rename(tmp, file))
      .catch((err) => {
        console.error(`[store] saveTurnIndex 失败 ${sessionId}: ${String(err)}`);
        void fsp.rm(tmp, { force: true });
      });
    this.writeChains.set(file, next);
    return next;
  }

  /**
   * 流式读取整份事件日志（重建索引用）。
   *
   * 不能用 loadEvents（readFileSync + 逐行 JSON.parse）：大会话几十 MB，
   * 会长时间阻塞事件循环，导致 SSE 心跳 / MQTT 保活断开。
   */
  async readEventsAsync(tenantId: string, sessionId: string): Promise<EventEntry[]> {
    const p = path.join(this.sessionDir(tenantId, sessionId), "events.jsonl");
    const out: EventEntry[] = [];
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(p, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as EventEntry);
        } catch {
          // 损坏行跳过
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  // ===================== 节点身份 & 管理员密钥 =====================

  /** 节点稳定标识：{root}/node.json（首次启动生成后长期固定） */
  loadNodeId(): string | null {
    const v = this._readJson<{ id?: string }>(path.join(this.root, "node.json"));
    return v?.id && typeof v.id === "string" ? v.id : null;
  }

  saveNodeId(id: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, "node.json");
    // 保留既有 label（改名不因重建 id 丢失）
    const cur = this._readJson<Record<string, unknown>>(file) ?? {};
    fs.writeFileSync(file, JSON.stringify({ ...cur, id }, null, 2), "utf-8");
  }

  /** 节点展示名：{root}/node.json 的 label（Hub 下发或本地设置） */
  loadNodeLabel(): string | null {
    const v = this._readJson<{ label?: string }>(path.join(this.root, "node.json"));
    return v?.label && typeof v.label === "string" ? v.label : null;
  }

  /** 写入/更新节点展示名（保留 id 等既有字段） */
  saveNodeLabel(label: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, "node.json");
    const cur = this._readJson<Record<string, unknown>>(file) ?? {};
    fs.writeFileSync(file, JSON.stringify({ ...cur, label }, null, 2), "utf-8");
  }

  /**
   * 节点级 LLM 配置：统一存放于本机 `~/.config/zqagent/connections.json`
   * （与 CLI `/connect` 共用同一份，见 `../llmConfig.ts`）。
   * 首次读取时会自动合并旧的 `{root}/node-llm.json`。
   */
  loadNodeLlm(): { providers: LlmProviderEntry[]; defaultProviderId?: string } {
    const file = this.llmFile();
    const cfg = readLlmConfig({
      file,
      legacyFiles: [path.join(this.root, "node-llm.json")],
    });
    return {
      providers: cfg.providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        baseURL: p.baseURL,
        model: p.model,
        apiKey: decryptKey(p.apiKeyEnc, file) ?? undefined,
        reasoningEffort: p.reasoningEffort,
        ...(p.models ? { models: p.models } : {}),
        ...(p.nonChat ? { nonChat: p.nonChat } : {}),
        ...(p.modelMeta ? { modelMeta: p.modelMeta } : {}),
      })),
      defaultProviderId: cfg.activeId ?? undefined,
    };
  }

  saveNodeLlm(cfg: { providers: LlmProviderEntry[]; defaultProviderId?: string }): void {
    const file = this.llmFile();
    const cur = readLlmConfig({
      file,
      legacyFiles: [path.join(this.root, "node-llm.json")],
    });
    const old = new Map(cur.providers.map((p) => [p.id, p]));
    /*
     * 内置项兜底：调用方传进来的列表可能不含 `__zqai__`（CLI 删除、老前端、
     * 或直接改 json 后触发保存）。这里按**已落盘的旧值**补回，确保托管凭据
     * 不会因为一次保存就消失。真正该移除它的只有「解绑 Hub」，走的是
     * 清空凭据的路径，不经过这里。
     */
    const src = [...cfg.providers];
    const prevBuiltin = cur.providers.find((p) => p.id === BUILTIN_PROVIDER_ID);
    if (prevBuiltin && !src.some((p) => p.id === BUILTIN_PROVIDER_ID)) {
      src.unshift({
        id: prevBuiltin.id,
        name: prevBuiltin.name,
        type: prevBuiltin.type,
        baseURL: prevBuiltin.baseURL,
        model: prevBuiltin.model,
        apiKey: decryptKey(prevBuiltin.apiKeyEnc, file) ?? undefined,
        reasoningEffort: prevBuiltin.reasoningEffort ?? null,
        ...(prevBuiltin.models ? { models: prevBuiltin.models } : {}),
        ...(prevBuiltin.nonChat ? { nonChat: prevBuiltin.nonChat } : {}),
        ...(prevBuiltin.modelMeta ? { modelMeta: prevBuiltin.modelMeta } : {}),
      });
    }
    const providers: LlmProviderEntryStored[] = src.map((p) => {
      const prev = old.get(p.id);
      // apiKey 为空表示「沿用旧值」（applyNodeLlmPatch 已保证语义）
      const apiKeyEnc = p.apiKey ? encryptKey(p.apiKey, file) : (prev?.apiKeyEnc ?? "");
      return {
        id: p.id,
        name: p.name,
        type: p.type ?? prev?.type ?? "custom",
        baseURL: p.baseURL,
        model: p.model,
        reasoningEffort: p.reasoningEffort ?? prev?.reasoningEffort ?? null,
        apiKeyEnc,
        ...(p.models ? { models: p.models } : prev?.models ? { models: prev.models } : {}),
        ...(p.nonChat ? { nonChat: p.nonChat } : prev?.nonChat ? { nonChat: prev.nonChat } : {}),
        // 元数据（含上下文长度）同 models/nonChat：本次未刷新则沿用上次结果
        ...(p.modelMeta
          ? { modelMeta: p.modelMeta }
          : prev?.modelMeta
            ? { modelMeta: prev.modelMeta }
            : {}),
      };
    });
    writeLlmConfig(
      {
        version: 3,
        activeId: cfg.defaultProviderId || null,
        providers,
        ...(cur.migratedFrom ? { migratedFrom: cur.migratedFrom } : {}),
      },
      file,
    );
  }

  /** 管理员密钥：{root}/admin.json（可跨项目操作；桌面外壳注入） */
  loadAdminKey(): string | null {
    const v = this._readJson<{ apiKey?: string }>(path.join(this.root, "admin.json"));
    return v?.apiKey && typeof v.apiKey === "string" ? v.apiKey : null;
  }

  saveAdminKey(apiKey: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(
      path.join(this.root, "admin.json"),
      JSON.stringify({ apiKey }, null, 2),
      "utf-8",
    );
  }

  /**
   * 节点管理接入凭据：{root}/fleet.json（含 fleetSecret，落盘权限 0600）。
   * 节点凭注册码接入后写入；启动时优先于环境变量读取。
   */
  loadFleetCredential(): FleetCredential | null {
    return this._readJson<FleetCredential>(path.join(this.root, "fleet.json"));
  }

  saveFleetCredential(cred: FleetCredential): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(
      path.join(this.root, "fleet.json"),
      JSON.stringify(cred, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  clearFleetCredential(): void {
    fs.rmSync(path.join(this.root, "fleet.json"), { force: true });
  }

  /** 数据根目录（只读；节点管理配置等辅助文件定位用） */
  get rootDir(): string {
    return this.root;
  }

  // ===================== 工具 =====================

  private _readJson<T>(p: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
    } catch {
      return null;
    }
  }
}
