/**
 * 写冲突检测（ConflictGuard）单元测试
 *
 * 复现的问题：多个会话共享工作区时，写工具是「读 → 改 → 写」，
 * 会话 B 基于旧内容再写一次，会话 A 的改动被静默覆盖，无报错无痕迹。
 *
 * 这里锁住语义：
 *   1. 本会话读过 → 别人改过 → 拒绝写入，且磁盘内容保持不变；
 *   2. 本会话自己连续写 → 不误报；
 *   3. 没读过 → 不校验（保持既有行为，避免回归）；
 *   4. 文件被别人删除 → 也算冲突；
 *   5. 三个写工具（write_file / replace_in_file / apply_patch）都生效。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, ConflictGuard, registerFileTools, registerDiffTools } from "../src/index.js";

let workspace: string;

/** 建一个带独立 guard 的注册表，模拟「一个会话」 */
function makeSession(): ToolRegistry {
  const reg = new ToolRegistry();
  const guard = new ConflictGuard();
  registerFileTools(reg, workspace, guard);
  registerDiffTools(reg, workspace, guard);
  return reg;
}

async function call(
  reg: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await reg.execute(name, args)) as Record<string, unknown>;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-conflict-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("write_file 冲突", () => {
  it("读过之后被别人改动 → 拒绝覆盖，磁盘保持别人写的版本", async () => {
    const file = path.join(workspace, "a.txt");
    fs.writeFileSync(file, "v1");

    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "a.txt" });

    // 另一个会话直接改掉（模拟 B 的写入已落盘）
    fs.writeFileSync(file, "v2-by-b");

    const result = await call(sessionA, "write_file", { path: "a.txt", content: "v3-by-a" });
    expect(String(result.error)).toContain("已被其他会话");
    expect(fs.readFileSync(file, "utf-8")).toBe("v2-by-b");
  });

  it("冲突后重新读取即可继续写", async () => {
    const file = path.join(workspace, "a.txt");
    fs.writeFileSync(file, "v1");
    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "a.txt" });
    fs.writeFileSync(file, "v2-by-b");

    expect((await call(sessionA, "write_file", { path: "a.txt", content: "x" })).error).toBeTruthy();

    // 重新读 → 基准更新 → 可以写
    await call(sessionA, "read_file", { path: "a.txt" });
    const ok = await call(sessionA, "write_file", { path: "a.txt", content: "v3-by-a" });
    expect(ok.error).toBeUndefined();
    expect(fs.readFileSync(file, "utf-8")).toBe("v3-by-a");
  });

  it("本会话连续写不误报", async () => {
    const sessionA = makeSession();
    await call(sessionA, "write_file", { path: "new.txt", content: "1" });
    await call(sessionA, "read_file", { path: "new.txt" });
    const second = await call(sessionA, "write_file", { path: "new.txt", content: "2" });
    expect(second.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "new.txt"), "utf-8")).toBe("2");
  });

  it("没读过就写不校验（保持既有行为，不引入回归）", async () => {
    const file = path.join(workspace, "b.txt");
    fs.writeFileSync(file, "old");
    const sessionA = makeSession();
    const result = await call(sessionA, "write_file", { path: "b.txt", content: "new" });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(file, "utf-8")).toBe("new");
  });

  it("文件被别人删除也算冲突", async () => {
    const file = path.join(workspace, "c.txt");
    fs.writeFileSync(file, "v1");
    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "c.txt" });
    fs.rmSync(file);

    const result = await call(sessionA, "write_file", { path: "c.txt", content: "v2" });
    expect(String(result.error)).toContain("已被删除");
  });
});

describe("replace_in_file 冲突", () => {
  it("别人改过之后拒绝替换", async () => {
    const file = path.join(workspace, "d.txt");
    fs.writeFileSync(file, "hello world");
    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "d.txt" });

    fs.writeFileSync(file, "hello world (touched by b)");

    const result = await call(sessionA, "replace_in_file", {
      path: "d.txt",
      old: "world",
      new: "there",
    });
    expect(String(result.error)).toContain("已被其他会话");
    expect(fs.readFileSync(file, "utf-8")).toBe("hello world (touched by b)");
  });

  it("未被改动时正常替换", async () => {
    fs.writeFileSync(path.join(workspace, "e.txt"), "foo bar");
    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "e.txt" });
    const result = await call(sessionA, "replace_in_file", {
      path: "e.txt",
      old: "bar",
      new: "baz",
    });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "e.txt"), "utf-8")).toBe("foo baz");
  });
});

describe("apply_patch 冲突", () => {
  it("别人改过之后拒绝应用补丁", async () => {
    const file = path.join(workspace, "f.txt");
    fs.writeFileSync(file, "line1\nline2\n");
    const sessionA = makeSession();
    await call(sessionA, "read_file", { path: "f.txt" });

    fs.writeFileSync(file, "line1\nline2 changed by b\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " line1",
      "-line2",
      "+line2 by a",
      "*** End Patch",
    ].join("\n");
    const result = await call(sessionA, "apply_patch", { patch });
    expect(String(result.error)).toContain("已被其他会话");
    expect(fs.readFileSync(file, "utf-8")).toBe("line1\nline2 changed by b\n");
  });
});

describe("ConflictGuard 单元语义", () => {
  it("digest 对相同内容稳定、对不同内容不同", () => {
    const g = new ConflictGuard();
    const file = path.join(workspace, "g.txt");
    fs.writeFileSync(file, "same");
    g.noteRead(file, "same");
    expect(g.checkWrite(file, "g.txt")).toBeNull();
    fs.writeFileSync(file, "different");
    expect(g.checkWrite(file, "g.txt")).not.toBeNull();
  });

  it("reset 后不再校验", async () => {
    const file = path.join(workspace, "h.txt");
    fs.writeFileSync(file, "v1");
    const guard = new ConflictGuard();
    guard.noteRead(file, "v1");
    fs.writeFileSync(file, "v2");
    expect(guard.checkWrite(file, "h.txt")).not.toBeNull();
    guard.reset();
    expect(guard.checkWrite(file, "h.txt")).toBeNull();
  });
});
