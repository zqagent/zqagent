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
  createProjectDir,
  createProjectFile,
  searchProjectFiles,
} from "../src/server/projectFiles.js";

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
});
