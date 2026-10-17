/**
 * usage — 节点级「用量账本 + 增量汇总」
 *
 * 设计：
 *   - 账本（append-only，按月切分）：data/usage/ledger-YYYY-MM.jsonl，一行一条 LLM 调用用量；
 *   - 汇总：data/usage/rollup.json（小文件，tmp+rename 原子写；可由账本 rebuild）；
 *   - 价格：data/usage/pricing.json（USD/百万 token，内置默认 + 可覆盖；rate 支持换算展示）；
 *   - 一致性：账本为准，汇总可重建；每条记录带 costUsd 快照（改价不影响历史）。
 *   - 保留：明细与按天趋势保留 12 个月；总量 / 按模型 / 按项目长期保留。
 *
 * 时区：ts 存 ISO(UTC)，byDay 以 UTC 日期为键。
 */
import * as fs from "fs";
import * as path from "path";
import type { TenantConfig } from "./types.js";

export const LEDGER_RETENTION_MONTHS = 12;
export const USAGE_SCHEMA = 1;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageRecord extends TokenCounts {
  id: string;
  ts: string;
  projectId: string;
  sessionId: string;
  vendor: string;
  model: string;
  providerId?: string;
  /** USD 成本快照；未配置价格时为 null */
  costUsd: number | null;
  priced: boolean;
  ok: boolean;
}

export interface UsageAgg extends TokenCounts {
  calls: number;
  costUsd: number;
  /** 有价格缺失的调用次数（审计用） */
  unpriced: number;
}

export interface UsageRollup {
  schema: number;
  /** 账本起始时间（ISO） */
  since: string;
  /** 历史基线（迁移自既有消息 usage；仅聚合、无明细） */
  legacy?: UsageAgg & { throughTs: string };
  total: UsageAgg;
  byDay: Record<string, UsageAgg>;
  byModel: Record<string, UsageAgg>;
  byProject: Record<string, UsageAgg>;
}

export interface PriceEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface Pricing {
  schema: number;
  base: string;
  /** 1 USD = rate[X] X；用于展示换算 */
  rate: Record<string, number>;
  /** vendor(type) → (model 或 model 通配) → 单价（USD / 百万 token） */
  vendors: Record<string, Record<string, PriceEntry>>;
  fallback: PriceEntry;
}

/** 内置默认价格（USD / 百万 token；近似值，可在 pricing.json 覆盖） */
const DEFAULT_PRICING: Pricing = {
  schema: USAGE_SCHEMA,
  base: "USD",
  rate: { CNY: 7.2 },
  vendors: {
    openai: {
      "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
      "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
      "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
    },
    deepseek: {
      "deepseek-flash": {
        input: 0.27,
        output: 1.1,
        cacheRead: 0.027,
        cacheWrite: 0.27,
      },
      "deepseek-reasoner": {
        input: 0.55,
        output: 2.19,
        cacheRead: 0.055,
        cacheWrite: 0.55,
      },
      "deepseek-*": {
        input: 0.27,
        output: 1.1,
        cacheRead: 0.027,
        cacheWrite: 0.27,
      },
    },
    qwen: {
      "qwen-plus": { input: 0.4, output: 1.2 },
      "qwen-turbo": { input: 0.05, output: 0.2 },
    },
    zhipu: { "glm-4-plus": { input: 0.7, output: 0.7 } },
    moonshot: { "moonshot-v1-8k": { input: 1.68, output: 1.68 } },
    xiaomi: {},
    custom: {},
    env: {},
  },
  fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function zeroAgg(): UsageAgg {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    unpriced: 0,
  };
}

function addAgg(
  into: UsageAgg,
  tokens: TokenCounts,
  costUsd: number | null,
): void {
  into.calls += 1;
  into.input += tokens.input;
  into.output += tokens.output;
  into.cacheRead += tokens.cacheRead;
  into.cacheWrite += tokens.cacheWrite;
  if (costUsd == null) into.unpriced += 1;
  else into.costUsd += costUsd;
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** 当前及之后 11 个月（共 12 个账本文件）视为保留范围内 */
function retainedMonths(now = new Date()): Set<string> {
  const out = new Set<string>();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < LEDGER_RETENTION_MONTHS; i += 1) {
    out.add(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

export class UsageLedger {
  private readonly dir: string;
  private rollup!: UsageRollup;
  private pricing!: Pricing;
  private rollupDirty = false;
  private rollupTimer: NodeJS.Timeout | null = null;
  private inited = false;

  constructor(private readonly root: string) {
    this.dir = path.join(root, "usage");
  }

  private get ledgerDir(): string {
    return this.dir;
  }

  private ledgerFile(month: string): string {
    return path.join(this.ledgerDir, `ledger-${month}.jsonl`);
  }

  private get rollupFile(): string {
    return path.join(this.ledgerDir, "rollup.json");
  }

  private get pricingFile(): string {
    return path.join(this.ledgerDir, "pricing.json");
  }

  // ===================== 初始化 =====================

  init(now = new Date()): void {
    if (this.inited) return;
    fs.mkdirSync(this.ledgerDir, { recursive: true });
    this.pricing = this.loadPricing();
    this.rollup = this.loadRollup(now);
    this.pruneLedgers(now);
    this.inited = true;
  }

  private loadPricing(): Pricing {
    try {
      const raw = fs.readFileSync(this.pricingFile, "utf-8");
      const parsed = JSON.parse(raw) as Partial<Pricing>;
      const vendors: Pricing["vendors"] = {};
      for (const v of new Set([
        ...Object.keys(DEFAULT_PRICING.vendors),
        ...Object.keys(parsed.vendors ?? {}),
      ])) {
        vendors[v] = {
          ...(DEFAULT_PRICING.vendors[v] ?? {}),
          ...((parsed.vendors ?? {})[v] ?? {}),
        };
      }
      return {
        schema: USAGE_SCHEMA,
        base: "USD",
        rate: { ...DEFAULT_PRICING.rate, ...(parsed.rate ?? {}) },
        vendors,
        fallback: { ...DEFAULT_PRICING.fallback, ...(parsed.fallback ?? {}) },
      };
    } catch {
      // 首次：落盘默认价格表，便于用户直接改
      try {
        atomicWrite(this.pricingFile, JSON.stringify(DEFAULT_PRICING, null, 2));
      } catch {
        /* 忽略 */
      }
      return JSON.parse(JSON.stringify(DEFAULT_PRICING)) as Pricing;
    }
  }

  private loadRollup(now: Date): UsageRollup {
    try {
      const raw = fs.readFileSync(this.rollupFile, "utf-8");
      const parsed = JSON.parse(raw) as UsageRollup;
      return {
        schema: USAGE_SCHEMA,
        since: parsed.since ?? now.toISOString(),
        legacy: parsed.legacy,
        total: { ...zeroAgg(), ...parsed.total },
        byDay: parsed.byDay ?? {},
        byModel: parsed.byModel ?? {},
        byProject: parsed.byProject ?? {},
      };
    } catch {
      return {
        schema: USAGE_SCHEMA,
        since: now.toISOString(),
        total: zeroAgg(),
        byDay: {},
        byModel: {},
        byProject: {},
      };
    }
  }

  /** 删除超出保留期的账本文件，并裁剪 byDay */
  private pruneLedgers(now: Date): void {
    const keep = retainedMonths(now);
    let changed = false;
    try {
      for (const f of fs.readdirSync(this.ledgerDir)) {
        const m = /^ledger-(\d{4}-\d{2})\.jsonl$/.exec(f);
        if (m && !keep.has(m[1]!)) {
          fs.unlinkSync(path.join(this.ledgerDir, f));
        }
      }
    } catch {
      /* 忽略 */
    }
    for (const day of Object.keys(this.rollup.byDay)) {
      if (!keep.has(day.slice(0, 7))) {
        delete this.rollup.byDay[day];
        changed = true;
      }
    }
    if (changed) this.saveRollupNow();
  }

  // ===================== 价格 =====================

  getPricing(): Pricing {
    return this.pricing;
  }

  /** 更新价格/汇率（整表覆盖式合并） */
  updatePricing(
    patch: Partial<Pricing> & { rate?: Record<string, number> },
  ): Pricing {
    this.pricing = {
      schema: USAGE_SCHEMA,
      base: "USD",
      rate: { ...this.pricing.rate, ...(patch.rate ?? {}) },
      vendors: { ...this.pricing.vendors, ...(patch.vendors ?? {}) },
      fallback: { ...this.pricing.fallback, ...(patch.fallback ?? {}) },
    };
    atomicWrite(this.pricingFile, JSON.stringify(this.pricing, null, 2));
    return this.pricing;
  }

  private priceFor(vendor: string, model: string): PriceEntry | null {
    const table = this.pricing.vendors[vendor];
    if (table) {
      if (table[model]) return table[model]!;
      // 前缀通配：deepseek-* / gpt-*
      for (const key of Object.keys(table)) {
        if (key.endsWith("*") && model.startsWith(key.slice(0, -1)))
          return table[key]!;
      }
    }
    // 跨供应商兜底匹配：先精确，再通配（模型名自带厂商标识时很有用，如 deepseek-*）
    for (const v of Object.values(this.pricing.vendors)) {
      if (v[model]) return v[model]!;
    }
    for (const v of Object.values(this.pricing.vendors)) {
      for (const key of Object.keys(v)) {
        if (key.endsWith("*") && model.startsWith(key.slice(0, -1)))
          return v[key]!;
      }
    }
    return null;
  }

  /** 成本（USD）：input 已含 cacheRead，故按非缓存部分计价 */
  costOf(vendor: string, model: string, t: TokenCounts): number | null {
    const p = this.priceFor(vendor, model);
    if (!p) return null;
    const cached = Math.min(t.cacheRead, t.input);
    const fresh = Math.max(0, t.input - cached);
    const M = 1_000_000;
    const cost =
      (fresh * p.input +
        cached * (p.cacheRead ?? p.input) +
        t.output * p.output +
        t.cacheWrite * (p.cacheWrite ?? 0)) /
      M;
    return Number.isFinite(cost) ? cost : null;
  }

  convert(usd: number, currency: string): number {
    if (!currency || currency === "USD") return usd;
    const r = this.pricing.rate[currency];
    return typeof r === "number" && r > 0 ? usd * r : usd;
  }

  // ===================== 记账 =====================

  /** 追加一条用量（串行 + appendFileSync；同步返回，便于在事件回调里调用） */
  record(
    input: Omit<UsageRecord, "id" | "costUsd" | "priced"> & { id?: string },
  ): UsageRecord {
    this.ensureInit();
    const costUsd = this.costOf(input.vendor, input.model, input);
    const rec: UsageRecord = {
      ...input,
      id:
        input.id ??
        `${input.sessionId}:${input.ts}:${Math.random().toString(36).slice(2, 8)}`,
      costUsd,
      priced: costUsd != null,
    };
    const line = JSON.stringify(rec) + "\n";
    // 同步追加：保证「先落账本、再更汇总」的可审计顺序（行级写入，进程内串行）
    try {
      fs.appendFileSync(this.ledgerFile(monthOf(rec.ts)), line);
    } catch (e) {
      console.error(`[usage] 写账本失败: ${String(e)}`);
    }
    // 汇总（内存即时，落盘节流）
    addAgg(this.rollup.total, rec, costUsd);
    const day =
      this.rollup.byDay[utcDay(rec.ts)] ??
      (this.rollup.byDay[utcDay(rec.ts)] = zeroAgg());
    addAgg(day, rec, costUsd);
    const mk = `${rec.vendor}/${rec.model}`;
    const bm = this.rollup.byModel[mk] ?? (this.rollup.byModel[mk] = zeroAgg());
    addAgg(bm, rec, costUsd);
    const bp =
      this.rollup.byProject[rec.projectId] ??
      (this.rollup.byProject[rec.projectId] = zeroAgg());
    addAgg(bp, rec, costUsd);
    this.scheduleRollupSave();
    return rec;
  }

  /** 写入历史基线（仅一次；迁移自既有消息 usage） */
  seedLegacy(agg: UsageAgg, throughTs: string): void {
    this.ensureInit();
    if (this.rollup.legacy) return;
    this.rollup.legacy = { ...agg, throughTs };
    if (throughTs < this.rollup.since) this.rollup.since = throughTs;
    // 基线同样并入总量/模型/项目维度（便于连续展示）
    this.rollup.total.calls += agg.calls;
    this.rollup.total.input += agg.input;
    this.rollup.total.output += agg.output;
    this.rollup.total.cacheRead += agg.cacheRead;
    this.rollup.total.cacheWrite += agg.cacheWrite;
    this.rollup.total.costUsd += agg.costUsd;
    this.rollup.total.unpriced += agg.unpriced;
    this.saveRollupNow();
  }

  private ensureInit(): void {
    if (!this.inited) this.init();
  }

  private scheduleRollupSave(): void {
    this.rollupDirty = true;
    if (this.rollupTimer) return;
    this.rollupTimer = setTimeout(() => {
      this.rollupTimer = null;
      if (this.rollupDirty) this.saveRollupNow();
    }, 1500);
    this.rollupTimer.unref?.();
  }

  saveRollupNow(): void {
    this.rollupDirty = false;
    try {
      atomicWrite(this.rollupFile, JSON.stringify(this.rollup, null, 2));
    } catch (e) {
      console.error(`[usage] 写汇总失败: ${String(e)}`);
    }
  }

  /** 读汇总（含历史基线；总量口径） */
  getRollup(): UsageRollup {
    this.ensureInit();
    return this.rollup;
  }

  // ===================== 查询 =====================

  /** 把一批记录聚合为 {total, byDay, byModel, byProject}（用于带 project/session 过滤的查询） */
  private aggregate(rows: UsageRecord[]): {
    total: UsageAgg;
    byDay: Record<string, UsageAgg>;
    byModel: Record<string, UsageAgg>;
    byProject: Record<string, UsageAgg>;
  } {
    const total = zeroAgg();
    const byDay: Record<string, UsageAgg> = {};
    const byModel: Record<string, UsageAgg> = {};
    const byProject: Record<string, UsageAgg> = {};
    for (const rec of rows) {
      addAgg(total, rec, rec.costUsd);
      const d = byDay[utcDay(rec.ts)] ?? (byDay[utcDay(rec.ts)] = zeroAgg());
      addAgg(d, rec, rec.costUsd);
      const mk = `${rec.vendor}/${rec.model}`;
      const bm = byModel[mk] ?? (byModel[mk] = zeroAgg());
      addAgg(bm, rec, rec.costUsd);
      const bp =
        byProject[rec.projectId] ?? (byProject[rec.projectId] = zeroAgg());
      addAgg(bp, rec, rec.costUsd);
    }
    return { total, byDay, byModel, byProject };
  }

  /** 取范围内全部明细（内部分页拉全，供过滤聚合/导出使用） */
  allRecords(opts: {
    from?: string;
    to?: string;
    projectId?: string;
    sessionId?: string;
  }): UsageRecord[] {
    const all: UsageRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.records({ ...opts, limit: 1000, offset });
      all.push(...page.rows);
      offset += 1000;
      if (offset >= page.total) break;
    }
    return all;
  }

  summary(opts: {
    from?: string;
    to?: string;
    groupBy?: "day" | "model" | "project";
    currency?: string;
    /** 限定项目（走账本过滤；legacy 基线仅在未过滤时返回） */
    projectId?: string;
    sessionId?: string;
  }): {
    currency: string;
    rate: number;
    since: string;
    total: UsageAgg;
    legacy?: UsageAgg & { throughTs: string };
    groups: { key: string; agg: UsageAgg }[];
  } {
    this.ensureInit();
    const currency = (opts.currency ?? "USD").toUpperCase();
    const rate = this.convert(1, currency);
    const from = opts.from ?? "";
    const to = opts.to ?? "";
    const groupBy = opts.groupBy;

    // 带 project/session 过滤：从账本聚合（限定 12 个月窗口；legacy 不参与）
    if (opts.projectId || opts.sessionId) {
      const rows = this.allRecords({
        from: opts.from,
        to: opts.to,
        projectId: opts.projectId,
        sessionId: opts.sessionId,
      });
      const agg = this.aggregate(rows);
      const groups: { key: string; agg: UsageAgg }[] = [];
      if (groupBy === "day") {
        for (const [k, v] of Object.entries(agg.byDay).sort((a, b) =>
          a[0].localeCompare(b[0]),
        ))
          groups.push({ key: k, agg: v });
      } else if (groupBy === "model") {
        for (const [k, v] of Object.entries(agg.byModel))
          groups.push({ key: k, agg: v });
        groups.sort(
          (a, b) => b.agg.costUsd - a.agg.costUsd || b.agg.input - a.agg.input,
        );
      } else if (groupBy === "project") {
        for (const [k, v] of Object.entries(agg.byProject))
          groups.push({ key: k, agg: v });
      }
      return {
        currency,
        rate,
        since: this.rollup.since,
        total: agg.total,
        groups,
      };
    }

    // day 维度可裁剪范围；其它维度为累计
    const groups: { key: string; agg: UsageAgg }[] = [];
    let total = { ...this.rollup.total };
    if (groupBy === "day") {
      const picked = Object.entries(this.rollup.byDay)
        .filter(([k]) => (!from || k >= from) && (!to || k <= to))
        .sort((a, b) => a[0].localeCompare(b[0]));
      const agg = zeroAgg();
      for (const [k, v] of picked) {
        groups.push({ key: k, agg: v });
        agg.calls += v.calls;
        agg.input += v.input;
        agg.output += v.output;
        agg.cacheRead += v.cacheRead;
        agg.cacheWrite += v.cacheWrite;
        agg.costUsd += v.costUsd;
        agg.unpriced += v.unpriced;
      }
      total = agg;
    } else if (groupBy === "model") {
      for (const [k, v] of Object.entries(this.rollup.byModel))
        groups.push({ key: k, agg: v });
      groups.sort(
        (a, b) => b.agg.costUsd - a.agg.costUsd || b.agg.input - a.agg.input,
      );
    } else if (groupBy === "project") {
      for (const [k, v] of Object.entries(this.rollup.byProject))
        groups.push({ key: k, agg: v });
      groups.sort(
        (a, b) => b.agg.costUsd - a.agg.costUsd || b.agg.input - a.agg.input,
      );
    }

    return {
      currency,
      rate,
      since: this.rollup.since,
      total,
      legacy: this.rollup.legacy,
      groups,
    };
  }

  /** 明细（流式读取范围内月份的账本文件） */
  records(opts: {
    from?: string;
    to?: string;
    sessionId?: string;
    model?: string;
    projectId?: string;
    limit?: number;
    offset?: number;
  }): { rows: UsageRecord[]; total: number } {
    this.ensureInit();
    const from = opts.from ?? "";
    const to = opts.to ?? "";
    const months = this.monthsInRange(from, to);
    const rows: UsageRecord[] = [];
    for (const month of months) {
      const file = this.ledgerFile(month);
      if (!fs.existsSync(file)) continue;
      let content = "";
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let rec: UsageRecord;
        try {
          rec = JSON.parse(line) as UsageRecord;
        } catch {
          continue;
        }
        const day = utcDay(rec.ts);
        if (from && day < from) continue;
        if (to && day > to) continue;
        if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
        if (opts.projectId && rec.projectId !== opts.projectId) continue;
        if (opts.model && rec.model !== opts.model) continue;
        rows.push(rec);
      }
    }
    rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const total = rows.length;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    return { rows: rows.slice(offset, offset + limit), total };
  }

  /** 导出 CSV（范围同 records） */
  exportCsv(opts: { from?: string; to?: string; currency?: string }): string {
    const { rows } = this.records({
      from: opts.from,
      to: opts.to,
      limit: 1000,
      offset: 0,
    });
    // 大范围导出：循环取全部
    const all: UsageRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.records({
        from: opts.from,
        to: opts.to,
        limit: 1000,
        offset,
      });
      all.push(...page.rows);
      offset += 1000;
      if (offset >= page.total) break;
    }
    void rows;
    const currency = (opts.currency ?? "USD").toUpperCase();
    const header = `ts,projectId,sessionId,vendor,model,input,output,cacheRead,cacheWrite,cost(${currency}),priced,ok\n`;
    const lines = all.map((r) =>
      [
        r.ts,
        r.projectId,
        r.sessionId,
        r.vendor,
        r.model,
        r.input,
        r.output,
        r.cacheRead,
        r.cacheWrite,
        r.costUsd == null ? "" : this.convert(r.costUsd, currency).toFixed(6),
        r.priced ? "1" : "0",
        r.ok ? "1" : "0",
      ].join(","),
    );
    return header + lines.join("\n") + (lines.length ? "\n" : "");
  }

  private monthsInRange(from: string, to: string): string[] {
    const now = new Date();
    if (!from && !to) return Array.from(retainedMonths(now)).sort();
    const start = from ? new Date(`${from.slice(0, 7)}-01T00:00:00Z`) : null;
    const end = to ? new Date(`${to.slice(0, 7)}-01T00:00:00Z`) : null;
    const months: string[] = [];
    const cur =
      start ??
      new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() - LEDGER_RETENTION_MONTHS + 1,
          1,
        ),
      );
    const last =
      end ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    while (cur <= last) {
      months.push(cur.toISOString().slice(0, 7));
      cur.setUTCMonth(cur.getUTCMonth() + 1);
      if (months.length > 240) break;
    }
    return months;
  }

  // ===================== 重建 / 对账 =====================

  /** 从账本重建汇总（保留 legacy 基线与 since） */
  rebuild(): UsageRollup {
    this.ensureInit();
    const legacy = this.rollup.legacy;
    const since = this.rollup.since;
    const fresh: UsageRollup = {
      schema: USAGE_SCHEMA,
      since,
      legacy,
      total: zeroAgg(),
      byDay: {},
      byModel: {},
      byProject: {},
    };
    const seen = new Set<string>();
    for (const month of this.monthsInRange("", "")) {
      const file = this.ledgerFile(month);
      if (!fs.existsSync(file)) continue;
      let content = "";
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let rec: UsageRecord;
        try {
          rec = JSON.parse(line) as UsageRecord;
        } catch {
          continue;
        }
        if (seen.has(rec.id)) continue; // 幂等：按 id 去重
        seen.add(rec.id);
        addAgg(fresh.total, rec, rec.costUsd);
        const day =
          fresh.byDay[utcDay(rec.ts)] ??
          (fresh.byDay[utcDay(rec.ts)] = zeroAgg());
        addAgg(day, rec, rec.costUsd);
        const mk = `${rec.vendor}/${rec.model}`;
        const bm = fresh.byModel[mk] ?? (fresh.byModel[mk] = zeroAgg());
        addAgg(bm, rec, rec.costUsd);
        const bp =
          fresh.byProject[rec.projectId] ??
          (fresh.byProject[rec.projectId] = zeroAgg());
        addAgg(bp, rec, rec.costUsd);
      }
    }
    // total 为「生命周期」口径：账本 + 历史基线（基线无明细，故不进入 byDay/byModel）
    if (legacy) {
      fresh.total.calls += legacy.calls;
      fresh.total.input += legacy.input;
      fresh.total.output += legacy.output;
      fresh.total.cacheRead += legacy.cacheRead;
      fresh.total.cacheWrite += legacy.cacheWrite;
      fresh.total.costUsd += legacy.costUsd;
      fresh.total.unpriced += legacy.unpriced;
    }
    this.rollup = fresh;
    this.saveRollupNow();
    return this.rollup;
  }

  /** 对账：账本重算 vs 当前汇总（排除 legacy 基线），检测漂移 */
  verify(): { ok: boolean; ledgerTotal: UsageAgg; rollupTotal: UsageAgg } {
    this.ensureInit();
    const legacy = this.rollup.legacy;
    const before = { ...this.rollup.total };
    const rollupOnly: UsageAgg = { ...before };
    if (legacy) {
      rollupOnly.calls -= legacy.calls;
      rollupOnly.input -= legacy.input;
      rollupOnly.output -= legacy.output;
      rollupOnly.cacheRead -= legacy.cacheRead;
      rollupOnly.cacheWrite -= legacy.cacheWrite;
      rollupOnly.costUsd -= legacy.costUsd;
      rollupOnly.unpriced -= legacy.unpriced;
    }
    const rebuilt = this.rebuild(); // 以账本为准重建（并写盘）
    const ok =
      rebuilt.total.calls === rollupOnly.calls &&
      rebuilt.total.input === rollupOnly.input &&
      rebuilt.total.output === rollupOnly.output &&
      Math.abs(rebuilt.total.costUsd - rollupOnly.costUsd) < 1e-9;
    return { ok, ledgerTotal: rebuilt.total, rollupTotal: rollupOnly };
  }
}

/** 解析会话实际使用的供应商（用于成本归属）：项目当前供应商 → 节点默认 → env */
export function resolveVendor(
  tenant: TenantConfig | null,
  nodeLlm: {
    providers: { id: string; type?: string }[];
    defaultProviderId?: string;
  } | null,
  sessionProviderId?: string | null,
): { vendor: string; providerId?: string } {
  // 会话级指定优先（控制台输入区选择的 LLM 配置）
  if (sessionProviderId) {
    const picked = nodeLlm?.providers.find((p) => p.id === sessionProviderId);
    if (picked)
      return { vendor: picked.type || "custom", providerId: picked.id };
    if (sessionProviderId === "__env__")
      return { vendor: "env", providerId: "__env__" };
  }
  const active =
    tenant?.llmProviders?.find((p) => p.id === tenant.activeProviderId) ??
    tenant?.llmProviders?.[0];
  if (active) return { vendor: active.type || "custom", providerId: active.id };
  const def =
    nodeLlm?.providers.find((p) => p.id === nodeLlm.defaultProviderId) ??
    nodeLlm?.providers?.[0];
  if (def) return { vendor: def.type || "custom", providerId: def.id };
  return { vendor: "env" };
}
