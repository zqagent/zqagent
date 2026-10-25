/**
 * 删除项目工作区文件 / 目录
 *
 * 这是本轮新增的破坏性能力，安全约束必须逐条锁住：
 *   - 不能删项目根（否则一次误操作清空整个工作区）；
 *   - 不能越界（`../` 与 symlink 逃逸）；
 *   - 目录递归删除；
 *   - 多选里个别失败时，其余项仍要删掉并如实回报。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteProjectPaths } from "../../core/src/server/projectFiles.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-del-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = "x"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("正常删除", () => {
  it("删除单个文件", () => {
    write("a.txt");
    const r = deleteProjectPaths(root, ["a.txt"]);
    expect(r.deleted).toEqual(["a.txt"]);
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("目录递归删除（含子目录与文件）", () => {
    write("dir/a.txt");
    write("dir/sub/b.txt");
    const r = deleteProjectPaths(root, ["dir"]);
    expect(r.deleted).toEqual(["dir"]);
    expect(fs.existsSync(path.join(root, "dir"))).toBe(false);
  });

  it("一次删多个", () => {
    write("a.txt");
    write("b/c.txt");
    const r = deleteProjectPaths(root, ["a.txt", "b"]);
    expect(r.deleted.sort()).toEqual(["a.txt", "b"]);
    expect(r.failed).toEqual([]);
  });

  it("重复路径只删一次（不会因第二次找不到而报错）", () => {
    write("a.txt");
    const r = deleteProjectPaths(root, ["a.txt", "a.txt"]);
    expect(r.deleted).toEqual(["a.txt"]);
    expect(r.failed).toEqual([]);
  });

  it("前导斜杠按根相对路径处理（/a.txt 等价 a.txt）", () => {
    write("a.txt");
    const r = deleteProjectPaths(root, ["/a.txt"]);
    expect(r.deleted).toEqual(["a.txt"]);
  });
});

describe("安全约束", () => {
  it("拒绝删除项目根（空路径）", () => {
    write("a.txt");
    const r = deleteProjectPaths(root, [""]);
    expect(r.deleted).toEqual([]);
    expect(r.failed[0]!.error).toMatch(/不能删除项目根目录/);
    // 工作区必须完好
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
  });

  it("拒绝删除项目根（/ 或 . 这类等价写法）", () => {
    write("keep.txt");
    const r = deleteProjectPaths(root, ["/", "."]);
    expect(r.deleted).toEqual([]);
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true);
  });

  it("拒绝 .. 越界，且不误删上级目录里的文件", () => {
    const outside = path.join(root, "..", `${path.basename(root)}-outside.txt`);
    fs.writeFileSync(outside, "重要");
    try {
      const r = deleteProjectPaths(root, ["../" + path.basename(outside)]);
      expect(r.deleted).toEqual([]);
      expect(r.failed[0]!.error).toMatch(/越界/);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("拒绝通过符号链接逃逸（链接指向工作区外）", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "重要");
    try {
      fs.symlinkSync(outsideDir, path.join(root, "link"));
      const r = deleteProjectPaths(root, ["link/secret.txt"]);
      expect(r.deleted).toEqual([]);
      expect(fs.existsSync(path.join(outsideDir, "secret.txt"))).toBe(true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("部分失败", () => {
  it("不存在的文件记为失败，其余项照常删除", () => {
    write("a.txt");
    const r = deleteProjectPaths(root, ["nope.txt", "a.txt"]);
    expect(r.deleted).toEqual(["a.txt"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.path).toBe("nope.txt");
    expect(r.failed[0]!.error).toMatch(/不存在/);
  });

  it("空数组不发请求也无失败", () => {
    expect(deleteProjectPaths(root, [])).toEqual({ deleted: [], failed: [] });
  });

  it("未配置工作区目录时抛错（与其它文件接口一致）", () => {
    expect(() => deleteProjectPaths(null, ["a.txt"])).toThrowError(/工作区目录/);
  });
});
