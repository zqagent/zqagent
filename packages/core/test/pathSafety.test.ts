/**
 * 路径安全（pathSafety）单元测试
 *
 * 覆盖符号链接防逃逸、目标不存在时的祖先回溯、返回真实路径供调用方复用，
 * 以及工作区根等于文件系统根（等同全盘放行）时的兜底拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isWithinRoot,
  resolveEntryWithinRoot,
  resolveWithinRoot,
} from "../src/tools/pathSafety.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ow-ps-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ow-out-")));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("工作区内路径返回解析后的真实路径", () => {
    const resolved = resolveWithinRoot(workspace, "sub/a.txt");
    expect(resolved).not.toBeNull();
    expect(resolved!.root).toBe(workspace);
    expect(resolved!.real).toBe(path.join(workspace, "sub", "a.txt"));
  });

  it("目标尚不存在时回溯祖先解析（新建文件场景）", () => {
    expect(resolveWithinRoot(workspace, "deep/er/new.txt")!.real).toBe(
      path.join(workspace, "deep", "er", "new.txt"),
    );
  });

  it("拒绝 ../ 逃逸", () => {
    expect(resolveWithinRoot(workspace, "../x")).toBeNull();
    expect(isWithinRoot(workspace, "../x")).toBe(false);
  });

  it("工作区内的符号链接指向外部时拒绝", () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));
    expect(resolveWithinRoot(workspace, "link/secret.txt")).toBeNull();
    expect(isWithinRoot(workspace, "link")).toBe(false);
  });

  it("工作区内的符号链接指向内部时允许，且返回链接目标的真实路径", () => {
    fs.mkdirSync(path.join(workspace, "real"));
    fs.symlinkSync(path.join(workspace, "real"), path.join(workspace, "alias"));
    expect(resolveWithinRoot(workspace, "alias/f.txt")!.real).toBe(
      path.join(workspace, "real", "f.txt"),
    );
  });

  it("悬空符号链接一律拒绝", () => {
    fs.symlinkSync(path.join(outside, "nope"), path.join(workspace, "dangling"));
    expect(isWithinRoot(workspace, "dangling")).toBe(false);
    expect(isWithinRoot(workspace, "dangling/f.txt")).toBe(false);
  });

  it("工作区根为文件系统根时一律拒绝（避免全盘放行）", () => {
    const fsRoot = path.parse(os.tmpdir()).root; // POSIX 为 "/"，Windows 为盘根
    expect(resolveWithinRoot(fsRoot, "etc/hosts")).toBeNull();
    expect(isWithinRoot(fsRoot, "etc/hosts")).toBe(false);
  });
});

describe("resolveEntryWithinRoot", () => {
  it("不解析最后一段：返回到符号链接本身，删除它不影响链接目标", () => {
    fs.writeFileSync(path.join(outside, "target.txt"), "keep");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(workspace, "link.txt"));

    const entry = resolveEntryWithinRoot(workspace, "link.txt");
    expect(entry).not.toBeNull();
    expect(entry!.real).toBe(path.join(workspace, "link.txt"));

    fs.unlinkSync(entry!.real);
    expect(fs.existsSync(path.join(workspace, "link.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "target.txt"), "utf-8")).toBe("keep");
  });

  it("父目录逃逸时返回 null", () => {
    expect(resolveEntryWithinRoot(workspace, "../x.txt")).toBeNull();
  });
});
