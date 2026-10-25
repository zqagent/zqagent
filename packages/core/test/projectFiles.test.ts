/**
 * 项目工作区文件浏览 / 读取单测
 *
 * 覆盖：目录列举（目录优先）、子目录与父路径、文件读取、
 * 路径越界拒绝、未配置 workspaceRoot 报错。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listProjectFiles,
  readProjectFile,
  downloadProjectFile,
  writeProjectFile,
  writeProjectFileBase64,
  createProjectDir,
  createProjectFile,
  searchProjectFiles,
  renameProjectPath,
  moveProjectPaths,
  zipProjectPaths,
} from "../src/server/projectFiles.js";

/**
 * 顺序读本地文件头拿到归档内条目名。
 *
 * 顺便验证了归档布局的自洽性：csize / namelen / extralen 只要有一处写错，
 * 下一段起点就会错位、读不到下一个 `0x04034b50` 签名。
 */
function zipEntryNames(z: { base64: string }): string[] {
  const buf = Buffer.from(z.base64, "base64");
  const out: string[] = [];
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const csize = buf.readUInt32LE(at + 18);
    const namelen = buf.readUInt16LE(at + 26);
    const extralen = buf.readUInt16LE(at + 28);
    out.push(buf.subarray(at + 30, at + 30 + namelen).toString("utf-8"));
    at += 30 + namelen + extralen + csize;
  }
  return out;
}

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "projfiles-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "README.md"), "# hi");
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("projectFiles", () => {
  it("列出根目录：目录优先，含文件", () => {
    const l = listProjectFiles(dir, "");
    expect(l.path).toBe("");
    expect(l.parent).toBeNull();
    expect(l.entries[0]!.type).toBe("dir");
    expect(l.entries[0]!.name).toBe("src");
    expect(l.entries.some((e) => e.name === "README.md")).toBe(true);
  });

  it("列出子目录并给出父路径", () => {
    const l = listProjectFiles(dir, "src");
    expect(l.path).toBe("src");
    expect(l.parent).toBe("");
    expect(l.entries[0]!.name).toBe("a.ts");
    expect(l.entries[0]!.type).toBe("file");
  });

  it("读取文件内容", () => {
    const f = readProjectFile(dir, "src/a.ts");
    expect(f.binary).toBe(false);
    expect(f.path).toBe("src/a.ts");
    expect(f.content).toContain("export const a = 1;");
  });

  it("拒绝路径越界", () => {
    expect(() => readProjectFile(dir, "../outside.txt")).toThrow();
    expect(() => listProjectFiles(dir, "../..")).toThrow();
  });

  it("未配置 workspaceRoot 时报错", () => {
    expect(() => listProjectFiles(null, "")).toThrow();
    expect(() => readProjectFile(undefined, "x")).toThrow();
  });

  it("写入并回读文件", () => {
    const r = writeProjectFile(dir, "src/new.txt", "hello");
    expect(r.path).toBe("src/new.txt");
    expect(readProjectFile(dir, "src/new.txt").content).toBe("hello");
  });

  it("写入拒绝路径越界", () => {
    expect(() => writeProjectFile(dir, "../evil.txt", "x")).toThrow();
    expect(() => writeProjectFile(null, "a.txt", "x")).toThrow();
  });

  it("下载文件：base64 原始字节与文件名", () => {
    const d = downloadProjectFile(dir, "src/a.ts");
    expect(d.path).toBe("src/a.ts");
    expect(d.name).toBe("a.ts");
    expect(d.size).toBe(Buffer.byteLength("export const a = 1;"));
    expect(Buffer.from(d.base64, "base64").toString("utf-8")).toBe("export const a = 1;");
  });

  it("下载文件：二进制文件同样可取回原始字节", () => {
    const d = downloadProjectFile(dir, "bin.dat");
    expect(d.name).toBe("bin.dat");
    expect([...Buffer.from(d.base64, "base64")]).toEqual([0, 1, 2, 3, 255]);
  });

  it("下载文件：拒绝越界 / 目录 / 不存在的路径", () => {
    expect(() => downloadProjectFile(dir, "../outside.txt")).toThrow();
    expect(() => downloadProjectFile(dir, "src")).toThrow();
    expect(() => downloadProjectFile(dir, "missing.bin")).toThrow();
    expect(() => downloadProjectFile(null, "bin.dat")).toThrow();
  });

  it("新建目录 / 新建文件 / 搜索", () => {
    expect(createProjectDir(dir, "pkg/sub").path).toBe("pkg/sub");
    expect(createProjectFile(dir, "pkg/sub/a.txt", "x").path).toBe("pkg/sub/a.txt");
    // 不覆盖已存在文件
    expect(() => createProjectFile(dir, "pkg/sub/a.txt")).toThrow();
    // 搜索命中
    const hits = searchProjectFiles(dir, "a.txt");
    expect(hits.some((h) => h.path === "pkg/sub/a.txt" && h.type === "file")).toBe(true);
    // 越界拒绝
    expect(() => createProjectDir(dir, "../evil")).toThrow();
    expect(() => createProjectFile(dir, "../evil.txt")).toThrow();
  });

  it("按 base64 写入二进制并回读", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const r = writeProjectFileBase64(dir, "img/logo.png", bytes.toString("base64"));
    expect(r.path).toBe("img/logo.png");
    expect(r.size).toBe(bytes.length);
    expect([...fs.readFileSync(path.join(dir, "img", "logo.png"))]).toEqual([...bytes]);
    // 覆盖写
    writeProjectFileBase64(dir, "img/logo.png", Buffer.from([1, 2]).toString("base64"));
    expect([...fs.readFileSync(path.join(dir, "img", "logo.png"))]).toEqual([1, 2]);
  });

  it("按 base64 写入：拒绝非法内容 / 越界 / 未配置工作区", () => {
    expect(() => writeProjectFileBase64(dir, "a.bin", "")).toThrow();
    expect(() => writeProjectFileBase64(dir, "a.bin", "not base64!!")).toThrow();
    expect(() => writeProjectFileBase64(dir, "../evil.bin", "AA==")).toThrow();
    expect(() => writeProjectFileBase64(null, "a.bin", "AA==")).toThrow();
  });

  it("按 base64 写入：超过上限时在解码前拒绝", () => {
    // 4MB 的 base64 ≈ 3MB 原始字节，超过 2.5MB 上限
    const huge = "A".repeat(4 * 1024 * 1024);
    expect(() => writeProjectFileBase64(dir, "big.png", huge)).toThrow(/上限/);
  });

  it("改名：同目录改名、拒绝冲突 / 跨目录 / 非法名", () => {
    createProjectFile(dir, "rename/x.txt", "hi");
    const r = renameProjectPath(dir, "rename/x.txt", "y.txt");
    expect(r.from).toBe("rename/x.txt");
    expect(r.path).toBe("rename/y.txt");
    expect(fs.existsSync(path.join(dir, "rename/y.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "rename/x.txt"))).toBe(false);

    // 目标已存在
    createProjectFile(dir, "rename/z.txt", "z");
    expect(() => renameProjectPath(dir, "rename/y.txt", "z.txt")).toThrow(/已存在/);
    // 不允许借改名做跨目录移动
    expect(() => renameProjectPath(dir, "rename/y.txt", "../escape.txt")).toThrow();
    // 非法名 / 根目录
    expect(() => renameProjectPath(dir, "rename/y.txt", "  ")).toThrow(/不能为空/);
    expect(() => renameProjectPath(dir, "", "n")).toThrow(/根目录/);
    expect(() => renameProjectPath(dir, "../outside", "n")).toThrow();
  });

  it("移动：跨目录移动文件 / 目录，逐条失败不影响其余", () => {
    createProjectFile(dir, "mv/a.txt", "a");
    createProjectDir(dir, "mv/sub");
    createProjectFile(dir, "mv/sub/inner.txt", "i");
    createProjectDir(dir, "mv/dest");

    // 文件移动到另一个目录
    const one = moveProjectPaths(dir, ["mv/a.txt"], "mv/dest");
    expect(one.failed).toEqual([]);
    expect(one.moved[0]).toEqual({ from: "mv/a.txt", path: "mv/dest/a.txt" });
    expect(fs.existsSync(path.join(dir, "mv/dest/a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mv/a.txt"))).toBe(false);

    // 目录（连同内容）移动
    const two = moveProjectPaths(dir, ["mv/sub"], "mv/dest");
    expect(two.moved[0]).toEqual({ from: "mv/sub", path: "mv/dest/sub" });
    expect(fs.readFileSync(path.join(dir, "mv/dest/sub/inner.txt"), "utf-8")).toBe("i");

    // 目标已存在同名：整条失败且不覆盖
    createProjectFile(dir, "mv/dest/b.txt", "keep");
    createProjectFile(dir, "mv/b.txt", "b");
    const conflict = moveProjectPaths(dir, ["mv/b.txt"], "mv/dest");
    expect(conflict.moved).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "mv/dest/b.txt"), "utf-8")).toBe("keep");

    // 目录不能移动到自身 / 自身子目录
    const self = moveProjectPaths(dir, ["mv/dest"], "mv/dest/sub");
    expect(self.moved).toEqual([]);
    expect(self.failed[0]?.error).toMatch(/自己内部/);

    // 已在目标目录：视为成功且路径不变
    const same = moveProjectPaths(dir, ["mv/dest/sub"], "mv/dest");
    expect(same.failed).toEqual([]);
    expect(same.moved[0]).toEqual({ from: "mv/dest/sub", path: "mv/dest/sub" });

    // 多选：一个冲突、一个成功
    createProjectFile(dir, "mv/c.txt", "c");
    createProjectDir(dir, "mv/other");
    createProjectFile(dir, "mv/other/b.txt", "keep");
    const mixed = moveProjectPaths(dir, ["mv/b.txt", "mv/c.txt"], "mv/other");
    expect(mixed.moved.map((m) => m.path)).toEqual(["mv/other/c.txt"]);
    expect(mixed.failed.map((f) => f.path)).toEqual(["mv/b.txt"]);
  });

  it("移动：目标目录必须存在且在工作区内", () => {
    createProjectFile(dir, "mv2/x.txt", "x");
    expect(() => moveProjectPaths(dir, ["mv2/x.txt"], "mv2/nope")).toThrow(/目标目录不存在/);
    expect(() => moveProjectPaths(dir, ["mv2/x.txt"], "../outside")).toThrow();
    expect(() => moveProjectPaths(dir, ["../outside"], "mv2")).not.toThrow();
    // 文件移到根目录
    const r = moveProjectPaths(dir, ["mv2/x.txt"], "");
    expect(r.moved[0]).toEqual({ from: "mv2/x.txt", path: "x.txt" });
  });

  it("压缩下载：单目录 / 单文件 / 多选 / 空目录", () => {
    createProjectDir(dir, "zip/inner");
    createProjectFile(dir, "zip/a.txt", "aaaa");
    createProjectFile(dir, "zip/inner/b.md", "# b");

    // 单目录：以其自身为根（没有 zip/ 这一层）
    const one = zipProjectPaths(dir, ["zip"]);
    expect(one.name).toBe("zip.zip");
    expect(one.total).toBe(4 + 3);
    const names = zipEntryNames(one);
    expect(names).toContain("a.txt");
    expect(names).toContain("inner/b.md");
    expect(names.some((n) => n.startsWith("zip/"))).toBe(false);

    // 单文件：保留扩展名并加 .zip
    const file = zipProjectPaths(dir, ["README.md"]);
    expect(file.name).toBe("README.md.zip");
    expect(zipEntryNames(file)).toEqual(["README.md"]);

    // 多选：保留各自相对工作区的路径
    const multi = zipProjectPaths(dir, ["zip/a.txt", "README.md"]);
    expect(multi.name).toBe("archive.zip");
    expect(zipEntryNames(multi).sort()).toEqual(["README.md", "zip/a.txt"]);

    // 空目录也要留下目录项
    createProjectDir(dir, "emptydir");
    expect(zipEntryNames(zipProjectPaths(dir, ["emptydir"]))).toEqual(["emptydir/"]);
  });

  it("压缩下载：总大小超上限时拒绝，且不产生归档", () => {
    createProjectFile(dir, "big/a.txt", "x".repeat(5000));
    expect(() => zipProjectPaths(dir, ["big"], { maxBytes: 4096 })).toThrow(/不支持压缩下载/);
    // 边界内可通过
    expect(zipProjectPaths(dir, ["big"], { maxBytes: 5000 }).total).toBe(5000);
    // 空选择 / 根目录
    expect(() => zipProjectPaths(dir, [])).toThrow();
    expect(() => zipProjectPaths(dir, [""])).toThrow();
  });
});
