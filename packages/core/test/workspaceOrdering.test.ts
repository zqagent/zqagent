/**
 * 工作台排序口径：节点 / 项目 / 任务统一按「最后一次任务请求的开始时间」倒序
 *
 * 为什么不能用 lastCompletedAt：长任务运行中时，完成时间还是**上一轮**的，
 * 按它排会把正在干活的会话排到后面——用户找的恰恰是「最近在跑什么」。
 *
 * 这里锁住三件事：
 *   1. 排序键优先 lastStartedAt，旧数据回退 lastCompletedAt；
 *   2. 运行中但开始更早的任务按开始时间诚实排在后面（不按状态插队）；
 *   3. 从未跑过任务的条目落在最后，且顺序稳定（不随刷新跳动）。
 */
import { describe, it, expect } from "vitest";
import { activityKey, compareByActivity } from "../../shared/src/hub-api.js";

type Row = { name: string; lastStartedAt?: string | null; lastCompletedAt?: string | null };

const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 3, min)).toISOString();

describe("activityKey（排序键）", () => {
  it("优先任务请求开始时间", () => {
    expect(activityKey({ lastStartedAt: at(10), lastCompletedAt: at(20) })).toBe(at(10));
  });

  it("旧数据没有 lastStartedAt 时回退完成时间", () => {
    expect(activityKey({ lastCompletedAt: at(20) })).toBe(at(20));
  });

  it("两者都没有时返回空串（倒序时自然排最后）", () => {
    expect(activityKey({})).toBe("");
    expect(activityKey({ lastStartedAt: null, lastCompletedAt: null })).toBe("");
  });
});

describe("compareByActivity（倒序）", () => {
  it("最近开始任务的排最前", () => {
    const rows: Row[] = [
      { name: "早", lastStartedAt: at(1) },
      { name: "最新", lastStartedAt: at(30) },
      { name: "中间", lastStartedAt: at(15) },
    ];
    expect(rows.slice().sort(compareByActivity).map((r) => r.name)).toEqual([
      "最新",
      "中间",
      "早",
    ]);
  });

  it("运行中的长任务不会因为「完成时间更早」被插队：按开始时间诚实排序", () => {
    // A: 30 分钟前开始，至今运行中（完成时间还是上一轮，很旧）
    // B: 1 分钟前才开始，刚完成
    const rows: Row[] = [
      { name: "A长任务", lastStartedAt: at(0), lastCompletedAt: at(0) },
      { name: "B新任务", lastStartedAt: at(29), lastCompletedAt: at(30) },
    ];
    expect(rows.slice().sort(compareByActivity).map((r) => r.name)).toEqual([
      "B新任务",
      "A长任务",
    ]);
  });

  it("旧数据（只有完成时间）与新数据混排时口径一致", () => {
    const rows: Row[] = [
      { name: "旧-晚", lastCompletedAt: at(40) },
      { name: "新-早", lastStartedAt: at(10) },
      { name: "新-更晚", lastStartedAt: at(50) },
    ];
    expect(rows.slice().sort(compareByActivity).map((r) => r.name)).toEqual([
      "新-更晚",
      "旧-晚",
      "新-早",
    ]);
  });

  it("从未跑过任务的排最后", () => {
    const rows: Row[] = [
      { name: "没跑过" },
      { name: "跑过", lastStartedAt: at(1) },
      { name: "也没有" },
    ];
    expect(rows.slice().sort(compareByActivity).map((r) => r.name)).toEqual([
      "跑过",
      "没跑过",
      "也没有",
    ]);
  });

  it("时间相同时用 tieBreak 保证顺序稳定", () => {
    const rows: Row[] = [
      { name: "b", lastStartedAt: at(5) },
      { name: "a", lastStartedAt: at(5) },
      { name: "c", lastStartedAt: at(5) },
    ];
    const sorted = rows
      .slice()
      .sort((x, y) => compareByActivity(x, y, (p, q) => p.name.localeCompare(q.name)));
    expect(sorted.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});
