/**
 * grep 工具单元测试
 *
 * 优先使用 ripgrep、fallback 到 grep，输出格式均为 "文件:行号:内容"。
 * 注意：文件路径由工具输出（相对路径，如 ./a.txt），断言用后缀匹配；
 * 覆盖：命中解析、无匹配（空结果而非错误）、空模式报错、搜索路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerSearchTool } from "../src/index.js";
import { nodeGrep } from "../src/tools/nodeGrep.js";
import { resetRipgrepCache } from "../src/tools/ripgrep.js";

let workspace: string;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-search-"));
  registry = new ToolRegistry();
  registerSearchTool(registry, workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "line one\nneedle here\nline three\n");
  fs.writeFileSync(path.join(workspace, "b.txt"), "no match\n");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  resetRipgrepCache();
});

async function run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await registry.execute("grep", args)) as Record<string, unknown>;
}

describe("grep 搜索", () => {
  it("命中时返回文件、行号与内容", async () => {
    const result = await run({ pattern: "needle" });
    expect(result.count).toBe(1);
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].text).toBe("needle here");
    // 文件路径以 a.txt 结尾（rg/grep 输出相对路径）
    expect(result.matches[0].file).toMatch(/a\.txt$/);
  });

  it("无匹配时返回空列表而非错误", async () => {
    const result = await run({ pattern: "zzz-no-match" });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("空模式报错", async () => {
    const result = await run({ pattern: "  " });
    expect(result.error).toContain("不能为空");
  });

  it("可指定搜索路径", async () => {
    const result = await run({ pattern: "needle", path: "." });
    expect(result.count).toBe(1);
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].file).toMatch(/a\.txt$/);
  });

  it("path 指向单个文件时字段不错位（rg 单文件模式不输出文件名）", async () => {
    const result = await run({ pattern: "needle", path: "a.txt" });
    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.matches[0].file).toMatch(/a\.txt$/);
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].text).toBe("needle here");
  });
});

describe("grep 纯 Node 回退（rg 不可用）", () => {
  let oldPath: string | undefined;

  beforeEach(() => {
    oldPath = process.env.PATH;
    process.env.PATH = ""; // 让 findExecutable 找不到 rg
    resetRipgrepCache();
  });

  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    resetRipgrepCache();
  });

  it("支持 \\d 等完整正则", async () => {
    fs.writeFileSync(path.join(workspace, "num.txt"), "abc 123\ndef\n");
    const result = await run({ pattern: "\\d+" });
    expect(result.engine).toBe("node");
    expect(result.count).toBe(1);
    expect(result.matches[0].file).toMatch(/num\.txt$/);
    expect(result.matches[0].line).toBe(1);
  });

  it("无匹配返回空列表而非错误", async () => {
    const result = await run({ pattern: "zzz-nope" });
    expect(result.count).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("路径不存在时报错（区别于 0 匹配）", async () => {
    const result = await run({ pattern: "x", path: "no-such-dir" });
    expect(String(result.error)).toContain("不存在");
  });
});

describe("nodeGrep 直接调用", () => {
  it("跳过 node_modules 与二进制文件", async () => {
    fs.mkdirSync(path.join(workspace, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "node_modules/x/hit.txt"), "needle\n");
    fs.writeFileSync(path.join(workspace, "bin.dat"), Buffer.from([0, 1, 2, 0x6e]));
    const matches = nodeGrep({ pattern: "needle", target: ".", workspace });
    // node_modules 被跳过，只剩 a.txt 的 needle
    expect(matches.every((m) => !m.file.includes("node_modules"))).toBe(true);
    expect(matches.some((m) => m.file.endsWith("a.txt"))).toBe(true);
  });

  it("无效正则会抛错", async () => {
    expect(() => nodeGrep({ pattern: "(", target: ".", workspace })).toThrow();
  });
});
