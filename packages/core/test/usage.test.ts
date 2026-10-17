/**
 * 用量账本单测
 *
 * 覆盖：记账（账本 + 汇总）、价格匹配（精确/通配/未命中）、成本计算（含缓存）、
 * 明细查询/导出、历史基线、rebuild 幂等、12 个月清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageLedger, LEDGER_RETENTION_MONTHS } from "../src/server/usage.js";

let dir: string;
let ledger: UsageLedger;

const tokens = { input: 1000, output: 200, cacheRead: 400, cacheWrite: 0 };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  ledger = new UsageLedger(dir);
  ledger.init();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("UsageLedger", () => {
  it("记账写入账本与汇总", () => {
    const rec = ledger.record({
      ts: "2026-10-14T01:00:00.000Z",
      projectId: "p1",
      sessionId: "s1",
      vendor: "deepseek",
      model: "deepseek-flash",
      ...tokens,
      ok: true,
    });
    expect(rec.priced).toBe(true);
    expect(rec.costUsd).toBeGreaterThan(0);

    const rollup = ledger.getRollup();
    expect(rollup.total.calls).toBe(1);
    expect(rollup.total.input).toBe(1000);
    expect(rollup.byDay["2026-10-14"]?.calls).toBe(1);
    expect(rollup.byModel["deepseek/deepseek-flash"]?.calls).toBe(1);
    expect(rollup.byProject["p1"]?.calls).toBe(1);

    // 账本文件按月落盘
    expect(fs.existsSync(path.join(dir, "usage", "ledger-2026-10.jsonl"))).toBe(
      true,
    );
  });

  it("价格匹配：精确 / 通配 / 未配置", () => {
    // deepseek-flash 精确
    expect(ledger.costOf("deepseek", "deepseek-flash", tokens)).toBeGreaterThan(
      0,
    );
    // deepseek-* 通配（如 deepseek-v4-flash）
    expect(ledger.costOf("env", "deepseek-v4-flash", tokens)).toBeGreaterThan(
      0,
    );
    // 未配置 → null
    expect(ledger.costOf("unknown", "no-such-model-xyz", tokens)).toBeNull();
  });

  it("成本计入缓存折扣（cacheRead 不计全价）", () => {
    const noCache = ledger.costOf("deepseek", "deepseek-flash", {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })!;
    const withCache = ledger.costOf("deepseek", "deepseek-flash", {
      input: 1000,
      output: 0,
      cacheRead: 1000,
      cacheWrite: 0,
    })!;
    expect(withCache).toBeLessThan(noCache);
  });

  it("明细查询与 CSV 导出", () => {
    ledger.record({
      ts: "2026-10-14T01:00:00.000Z",
      projectId: "p1",
      sessionId: "s1",
      vendor: "deepseek",
      model: "deepseek-flash",
      ...tokens,
      ok: true,
    });
    ledger.record({
      ts: "2026-10-15T02:00:00.000Z",
      projectId: "p2",
      sessionId: "s2",
      vendor: "deepseek",
      model: "deepseek-flash",
      ...tokens,
      ok: true,
    });

    expect(ledger.records({}).total).toBe(2);
    expect(ledger.records({ projectId: "p1" }).total).toBe(1);
    expect(ledger.records({ from: "2026-10-15", to: "2026-10-15" }).total).toBe(
      1,
    );

    const csv = ledger.exportCsv({});
    expect(csv.split("\n")[0]).toContain("cost(USD)");
    expect(csv).toContain("p1");
    expect(csv).toContain("p2");
  });

  it("带项目过滤的汇总只统计该项目（账本窗口）", () => {
    ledger.record({
      ts: "2026-10-14T01:00:00.000Z",
      projectId: "p1",
      sessionId: "s1",
      vendor: "deepseek",
      model: "deepseek-flash",
      ...tokens,
      ok: true,
    });
    ledger.record({
      ts: "2026-10-14T01:05:00.000Z",
      projectId: "p2",
      sessionId: "s2",
      vendor: "deepseek",
      model: "deepseek-flash",
      ...tokens,
      ok: true,
    });
    const s = ledger.summary({ projectId: "p1", groupBy: "day" });
    expect(s.total.calls).toBe(1);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]?.key).toBe("2026-10-14");
  });

  it("历史基线一次性写入并计入总量", () => {
    ledger.seedLegacy(
      {
        calls: 3,
        input: 300,
        output: 60,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.001,
        unpriced: 0,
      },
      "2026-10-13T00:00:00.000Z",
    );
    const r = ledger.getRollup();
    expect(r.legacy?.calls).toBe(3);
    expect(r.total.calls).toBe(3);
    // 再次写入不覆盖
    ledger.seedLegacy(
      {
        calls: 9,
        input: 9,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        unpriced: 0,
      },
      "2026-10-13T00:00:00.000Z",
    );
    expect(ledger.getRollup().legacy?.calls).toBe(3);
  });

  it("rebuild 与 verify：账本为准、幂等", () => {
    for (let i = 0; i < 3; i += 1) {
      ledger.record({
        ts: `2026-10-1${4 + i}T01:00:00.000Z`,
        projectId: "p1",
        sessionId: "s1",
        vendor: "deepseek",
        model: "deepseek-flash",
        ...tokens,
        ok: true,
      });
    }
    const rebuilt = ledger.rebuild();
    expect(rebuilt.total.calls).toBe(3);
    expect(ledger.rebuild().total.calls).toBe(3); // 幂等

    const v = ledger.verify();
    expect(v.ok).toBe(true);
    expect(v.ledgerTotal.calls).toBe(3);
  });

  it("12 个月清理：过期账本文件被删除", () => {
    const oldMonth = new Date();
    oldMonth.setUTCMonth(
      oldMonth.getUTCMonth() - (LEDGER_RETENTION_MONTHS + 2),
    );
    const oldKey = oldMonth.toISOString().slice(0, 7);
    fs.writeFileSync(path.join(dir, "usage", `ledger-${oldKey}.jsonl`), "{}\n");

    const fresh = new UsageLedger(dir);
    fresh.init();
    expect(
      fs.existsSync(path.join(dir, "usage", `ledger-${oldKey}.jsonl`)),
    ).toBe(false);
  });

  it("汇率换算", () => {
    const price = ledger.getPricing();
    expect(price.rate.CNY).toBeGreaterThan(1);
    expect(ledger.convert(1, "CNY")).toBeCloseTo(price.rate.CNY!, 5);
    expect(ledger.convert(1, "USD")).toBe(1);
  });
});
