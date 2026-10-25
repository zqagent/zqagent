/**
 * 控制台页签按需挂载（console-ui `NodeConsole`）
 *
 * 背景：打开着的页签刷新页面时，若所有页签一次性挂载，每个 FileViewer 都会发
 * readFile、每个 ChatPanel 都会拉状态，瞬间打满网关的每节点串行队列，用户看到
 * 的就是「节点繁忙，请稍后重试」。修复方式是只挂载当前页签，切换过的页签常驻。
 *
 * 这里锁住结构（无 DOM 测试环境），避免后续重构无意中改回「全部挂载」。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = fs.readFileSync(
  path.join(ROOT, "packages/console-ui/src/components/NodeConsole.tsx"),
  "utf8",
);

describe("页签按需挂载", () => {
  it("记录已激活页签，并在 activeId 变化时累积", () => {
    expect(SRC).toContain("const [seenTabs, setSeenTabs] = useState<Set<string>>");
    expect(SRC).toMatch(/setSeenTabs\(\(prev\) => \(prev\.has\(activeId\) \? prev :/);
  });

  it("未激活且未看过的页签不渲染内容（当前页签总是挂载）", () => {
    // 关键表达式：不能用 seenTabs.has 单条件，否则首帧 activeId 尚未累积会白屏
    expect(SRC).toContain("{active || seenTabs.has(t.id) ? content : null}");
  });

  it("seenTabs 参与内容 useMemo 依赖（否则挂载后不会重渲染）", () => {
    const depBlock = SRC.slice(SRC.indexOf("  }, [\n    offline,"));
    expect(depBlock.slice(0, 600)).toContain("seenTabs,");
  });
});
