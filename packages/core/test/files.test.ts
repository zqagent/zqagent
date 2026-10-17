/**
 * 文件工具（read_file / write_file / list_files）单元测试
 *
 * 使用操作系统临时目录作为工作区，覆盖：写入与读取往返、
 * 窗口化阅读（start_line/max_lines）、路径越界拒绝、
 * overwrite 语义、隐藏文件过滤、超长行截断。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerFileTools } from "../src/index.js";

let workspace: string;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-files-"));
  registry = new ToolRegistry();
  registerFileTools(registry, workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 通过注册表执行工具并取回结果对象 */
function run(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return registry.execute(tool, args) as Record<string, unknown>;
}

describe("write_file + read_file 往返", () => {
  it("写入后能原样读回", () => {
    const written = run("write_file", { path: "a.txt", content: "line1\nline2" });
    expect(written).toBe("a.txt");

    const read = run("read_file", { path: "a.txt" });
    // 行号 padStart(6)：5 个空格 + 数字
    expect(read.content).toBe("     1\tline1\n     2\tline2");
    expect(read.total_lines).toBe(2);
  });

  it("自动创建父目录", () => {
    const written = run("write_file", { path: "deep/nested/file.txt", content: "x" });
    expect(written).toBe(path.join("deep", "nested", "file.txt"));
    expect(fs.existsSync(path.join(workspace, "deep", "nested", "file.txt"))).toBe(true);
  });

  it("overwrite=false 时拒绝覆盖已有文件", () => {
    run("write_file", { path: "a.txt", content: "v1" });
    const result = run("write_file", { path: "a.txt", content: "v2", overwrite: false });
    expect(result.error).toContain("已存在");
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("v1");
  });

  it("overwrite=true（默认）覆盖已有文件", () => {
    run("write_file", { path: "a.txt", content: "v1" });
    run("write_file", { path: "a.txt", content: "v2" });
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf-8")).toBe("v2");
  });
});

describe("read_file 窗口化阅读", () => {
  beforeEach(() => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    run("write_file", { path: "big.txt", content: lines.join("\n") });
  });

  it("start_line 从指定行开始", () => {
    const read = run("read_file", { path: "big.txt", start_line: 3, max_lines: 2 });
    expect(read.content).toBe("     3\tline3\n     4\tline4");
    expect(read.start_line).toBe(3);
    expect(read.end_line).toBe(4);
  });

  it("未读完时返回 note 提示继续阅读", () => {
    const read = run("read_file", { path: "big.txt", start_line: 1, max_lines: 3 });
    expect(read.note).toContain("继续阅读");
    expect(String(read.note)).toContain("start_line=4");
  });

  it("读完整个文件时无 note", () => {
    const read = run("read_file", { path: "big.txt" });
    expect(read.note).toBeUndefined();
  });

  it("max_lines 有上限（2000）", () => {
    const read = run("read_file", { path: "big.txt", max_lines: 99999 });
    expect(read.content!.split("\n")).toHaveLength(10);
  });
});

describe("路径越界与错误路径", () => {
  it("read_file 拒绝工作区之外的路径", () => {
    const result = run("read_file", { path: "../outside.txt" });
    expect(result.error).toContain("工作区之外");
  });

  it("write_file 拒绝工作区之外的路径", () => {
    const result = run("write_file", { path: "../outside.txt", content: "x" });
    expect(result.error).toContain("工作区之外");
  });

  it("read_file 对不存在的文件报错", () => {
    const result = run("read_file", { path: "missing.txt" });
    expect(result.error).toContain("不是文件");
  });

  it("write_file 目标为目录时报错", () => {
    fs.mkdirSync(path.join(workspace, "dir"));
    const result = run("write_file", { path: "dir", content: "x" });
    expect(result.error).toContain("是目录");
  });

  it("前缀同名的兄弟目录逃逸被拒绝（../<root前缀>-evil/...）", () => {
    // 工作区形如 /tmp/ow-files-XXX；../ow-files-XXX-evil/evil.txt
    // 规范化后为前缀匹配逃逸路径，必须被拒绝
    const evil = path.join(
      path.dirname(workspace),
      path.basename(workspace) + "-evil",
      "evil.txt",
    );
    const rel = path.relative(workspace, evil);
    expect(rel.startsWith("..")).toBe(true);

    const writeResult = run("write_file", { path: rel, content: "x" });
    expect(writeResult.error).toContain("工作区之外");
    expect(fs.existsSync(evil)).toBe(false);

    const readResult = run("read_file", { path: rel });
    expect(readResult.error).toContain("工作区之外");

    const listResult = run("list_files", { path: rel });
    expect(listResult.error).toContain("工作区之外");
  });

  it("名字以 .. 开头的合法条目不被误拒", () => {
    // 逃逸只可能是 ".." 或以 "../" 开头；旧实现用 rel.startsWith("..")
    // 判断，会把工作区内名为 "..foo" 的合法文件当成逃逸路径拒绝。
    expect(run("write_file", { path: "..foo", content: "ok" })).toBe("..foo");
    expect(fs.readFileSync(path.join(workspace, "..foo"), "utf-8")).toBe("ok");
    expect(run("read_file", { path: "..foo" }).error).toBeUndefined();

    // 真正逃逸到父目录的 "..foo" 仍必须拒绝
    expect(run("read_file", { path: "../..foo" }).error).toContain("工作区之外");
  });
});

describe("list_files", () => {
  beforeEach(() => {
    run("write_file", { path: "a.txt", content: "" });
    run("write_file", { path: "b.txt", content: "" });
    fs.mkdirSync(path.join(workspace, "sub"));
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, ".hidden"), "");
  });

  it("列出文件与目录，目录带 / 后缀", () => {
    const result = run("list_files", {});
    expect(result.entries).toEqual(["a.txt", "b.txt", "sub/"]);
  });

  it("跳过隐藏文件与 node_modules", () => {
    const result = run("list_files", {});
    expect(result.entries).not.toContain(".hidden");
    expect(result.entries).not.toContain("node_modules/");
  });

  it("越界路径报错", () => {
    const result = run("list_files", { path: ".." });
    expect(result.error).toContain("工作区之外");
  });
});

describe("read_file 超长行截断", () => {
  it("超过 500 字符的行被截断并标注", () => {
    run("write_file", { path: "long.txt", content: "x".repeat(600) });
    const read = run("read_file", { path: "long.txt" });
    expect(read.content).toContain("… (line truncated)");
  });
});
