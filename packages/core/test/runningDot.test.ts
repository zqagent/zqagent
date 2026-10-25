/**
 * 「运行中」气泡点的展示位（portal 节点卡片 / 统计卡 / 项目列表 / 任务列表，
 * 以及节点控制台主页的统计色块）
 *
 * 需求：只要有任务在跑（运行数 > 0），就在「运行中 N」旁挂统一的脉动状态点，
 * 让各处一眼看出哪里在干活。这里只锁结构与配色钩子（无 DOM 测试环境），
 * 防止后续重构把点丢掉。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("运行中气泡点", () => {
  it("节点卡片：有运行中任务时在「运行中 N」里挂状态点", () => {
    const src = read("packages/portal/src/components/NodeCard.tsx");
    expect(src).toContain('<StatusDot status="running" />');
    expect(src).toMatch(/running > 0 \?[^;]*StatusDot/);
    expect(src).toContain("ws-mini-live");
  });

  it("工作台统计卡：全局运行中数字同样带点", () => {
    const src = read("packages/portal/src/pages/Workspace.tsx");
    expect(src).toMatch(/key: "running"[\s\S]*?live: counts\.running > 0/);
    expect(src).toContain("ws-stat-value-live");
    expect(src).toContain('<StatusDot status="running" />');
  });

  it("工作台项目列表：行内与详情弹窗的「运行中 N」带点", () => {
    const src = read("packages/portal/src/components/WorkspaceProjects.tsx");
    // 两处（列表行 / 详情弹窗）都按 running > 0 渲染
    const hits = src.match(/running > 0 \? <StatusDot status="running" \/> : null/g) ?? [];
    expect(hits).toHaveLength(2);
    expect(src).toContain("ws-mini-live");
    expect(src).toContain("detail.running > 0");
  });

  it("工作台任务列表：筛选条「运行中 N」带点", () => {
    const src = read("packages/portal/src/pages/Workspace.tsx");
    expect(src).toMatch(/key: "running"[\s\S]*?live: counts\.running > 0/);
    expect(src).toContain("ws-task-filter-live");
    expect(src).toMatch(/f\.live \? <StatusDot status="running" \/> : null/);
  });

  it("节点控制台主页：统计色块的运行中数字带点", () => {
    const src = read("packages/console-ui/src/components/ProjectHome.tsx");
    expect(src).toMatch(/key: "running"[\s\S]*?live: counts\.running > 0/);
    expect(src).toContain("cq-hstat-value-live");
    expect(src).toMatch(/s\.live \? <StatusDot status="running" \/> : null/);
  });

  it("样式：点与波纹颜色跟随所在徽标 / 卡片的语义色", () => {
    const css = read("packages/portal/src/styles.css");
    expect(css).toMatch(/\.ws-mini-live \.cq-status-dot-running\s*\{[^}]*currentColor/);
    expect(css).toMatch(/\.ws-mini-live \.cq-status-dot-running::after\s*\{[^}]*currentColor/);
    expect(css).toMatch(/\.ws-task-filter-live \.cq-status-dot-running\s*\{[^}]*currentColor/);
    expect(css).toMatch(/\.ws-stat-value-live \.cq-status-dot-running\s*\{[^}]*--accent-c/);
    expect(css).toMatch(/\.ws-stat-value-live \.cq-status-dot-running::after\s*\{[^}]*--accent-c/);

    const cqCss = read("packages/console-ui/src/styles.css");
    expect(cqCss).toMatch(/\.cq-hstat-value-live \.cq-status-dot-running\s*\{[^}]*--accent-c/);
    expect(cqCss).toMatch(/\.cq-hstat-value-live \.cq-status-dot-running::after\s*\{[^}]*--accent-c/);
  });
});
