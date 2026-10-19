/**
 * 工具结果预算测试
 *
 * 覆盖：短结果原样透传、超长字符串头尾截断 + 落盘、超长 JSON 字段级裁剪
 * 后仍可解析且保留关键元信息。
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyToolResultBudget,
  toolResultDir,
} from "../src/engine/toolResultBudget.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-tool-budget-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("applyToolResultBudget 工具结果预算", () => {
  it("未超预算时原样返回，不落盘", () => {
    const res = applyToolResultBudget("read_file", "hello", {
      maxChars: 100,
      dir: tempDir(),
    });
    expect(res.truncated).toBe(false);
    expect(res.content).toBe("hello");
    expect(res.savedPath).toBeUndefined();
  });

  it("超长字符串保留头尾，并把完整内容写入文件", () => {
    const raw = "HEAD" + "x".repeat(1000) + "TAIL";
    const dir = tempDir();
    const res = applyToolResultBudget("read_file", raw, {
      maxChars: 200,
      dir,
    });

    expect(res.truncated).toBe(true);
    expect(res.content).toContain("HEAD");
    expect(res.content).toContain("TAIL");
    expect(res.content).toContain("characters omitted");
    expect(res.content.length).toBeLessThan(raw.length);

    expect(res.savedPath).toBeTruthy();
    expect(fs.readFileSync(res.savedPath!, "utf-8")).toBe(raw);
    expect(path.dirname(res.savedPath!)).toBe(dir);
  });

  it("超长对象按字段裁剪，JSON 仍可解析且元信息完整", () => {
    const result = {
      exit_code: 0,
      stdout: "o".repeat(5000),
      stderr: "",
      duration_ms: 42,
    };
    const res = applyToolResultBudget("run_shell", result, {
      maxChars: 500,
      dir: tempDir(),
    });

    expect(res.truncated).toBe(true);
    // 去掉落盘提示行后，剩余内容应是合法 JSON
    const body = res.content.replace(/^\[tool output truncated:[^\n]*\]\n\n/, "");
    const parsed = JSON.parse(body);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.duration_ms).toBe(42);
    expect(parsed.stdout.length).toBeLessThan(5000);
    expect(res.savedPath).toBeTruthy();
  });

  it("落盘目录可由 TOOL_RESULT_DIR 覆盖", () => {
    const dir = tempDir();
    const prev = process.env.TOOL_RESULT_DIR;
    process.env.TOOL_RESULT_DIR = dir;
    try {
      expect(toolResultDir()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.TOOL_RESULT_DIR;
      else process.env.TOOL_RESULT_DIR = prev;
    }
  });
});
