/**
 * apply_patch / apply_unified_diff 单元测试
 *
 * 重点覆盖尾随换行与 CRLF：旧实现用 `patch.split("\n")` 后取最后一项判断
 * `*** End Patch`，结尾的换行会让最后一项变成空串而误报。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerDiffTools } from "../src/index.js";

let workspace: string;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-diff-"));
  registry = new ToolRegistry();
  registerDiffTools(registry, workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function run(args: Record<string, unknown>): Record<string, unknown> {
  return registry.execute("apply_patch", args) as Record<string, unknown>;
}

describe("apply_patch 尾随换行 / CRLF", () => {
  it("*** End Patch 后带一个换行也能成功", () => {
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n";
    const result = run({ patch });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("hello\n");
  });

  it("结尾多个空行也能成功", () => {
    const patch = "*** Begin Patch\n*** Add File: b.txt\n+hi\n*** End Patch\n\n\n";
    const result = run({ patch });
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, "b.txt"))).toBe(true);
  });

  it("CRLF 补丁可正常解析", () => {
    const patch = "*** Begin Patch\r\n*** Add File: c.txt\r\n+crlf\r\n*** End Patch\r\n";
    const result = run({ patch });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "c.txt"), "utf-8")).toBe("crlf\n");
  });

  it("确实缺少 *** End Patch 时仍报错", () => {
    const result = run({ patch: "*** Begin Patch\n*** Add File: d.txt\n+x" });
    expect(result.error).toContain("End Patch");
  });
});

describe("apply_patch Update", () => {
  it("按上下文替换内容", () => {
    fs.writeFileSync(path.join(workspace, "e.txt"), "one\ntwo\nthree\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: e.txt",
      "@@",
      " one",
      "-two",
      "+TWO",
      " three",
      "*** End Patch",
      "",
    ].join("\n");
    const result = run({ patch });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "e.txt"), "utf-8")).toBe("one\nTWO\nthree\n");
  });
});

describe("apply_patch Delete", () => {
  it("删除工作区内的符号链接时删链接本身，不动目标文件", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-diff-out-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "target.txt"), "keep");
      fs.symlinkSync(path.join(outsideDir, "target.txt"), path.join(workspace, "link.txt"));

      const result = run({
        patch: "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch\n",
      });
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, "link.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(outsideDir, "target.txt"), "utf-8")).toBe("keep");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("指向工作区外的链接本身属于工作区条目，可被删除", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-diff-out-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "target.txt"), "keep");
      fs.symlinkSync(outsideDir, path.join(workspace, "outlink"));

      const result = run({
        patch: "*** Begin Patch\n*** Delete File: outlink\n*** End Patch\n",
      });
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, "outlink"))).toBe(false);
      expect(fs.existsSync(outsideDir)).toBe(true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("删除仍拒绝越界路径", () => {
    const result = run({
      patch: "*** Begin Patch\n*** Delete File: ../evil.txt\n*** End Patch\n",
    });
    expect(result.error).toContain("工作区之外");
  });
});
