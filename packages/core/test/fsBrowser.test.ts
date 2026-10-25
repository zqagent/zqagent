/**
 * 目录浏览 / 搜索 / 新建目录单测（项目工作目录选择）
 *
 * 覆盖：列出目录（目录优先、大小/修改时间、根位置）、用户主目录回退、新建目录（含多级）、
 * 越界与非法名保护、同名文件冲突，以及目录内文件名模糊搜索
 * （子串/大小写/子序列、命中排序、limit 截断 + total、超大目录不逐个 stat）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listDirs, searchDirs, fuzzyScore, makeDirIn } from "../src/server/fsBrowser.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsbrowse-"));
  fs.mkdirSync(path.join(dir, "a-sub"));
  fs.writeFileSync(path.join(dir, "b.txt"), "x");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listDirs", () => {
  it("列出目录：目录优先，返回父目录", () => {
    const r = listDirs(dir);
    expect(r.path).toBe(dir);
    expect(r.parent).toBe(path.dirname(dir));
    expect(r.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:a-sub", "file:b.txt"]);
  });

  it("条目带大小与修改时间；目录大小统一为 0", () => {
    fs.writeFileSync(path.join(dir, "big.log"), "12345");
    const r = listDirs(dir);
    const sub = r.entries.find((e) => e.name === "a-sub")!;
    const file = r.entries.find((e) => e.name === "big.log")!;
    expect(sub.size).toBe(0);
    expect(Number.isNaN(Date.parse(sub.mtime))).toBe(false);
    expect(file.size).toBe(5);
    expect(Number.isNaN(Date.parse(file.mtime))).toBe(false);
  });

  it("返回可切换的根位置（非 Windows 为 /）", () => {
    const r = listDirs(dir);
    expect(r.roots).toEqual(process.platform === "win32" ? expect.any(Array) : ["/"]);
  });

  it("路径不存在时抛出可读错误", () => {
    expect(() => listDirs(path.join(dir, "nope"))).toThrow(/路径不存在/);
  });

  it("传入文件路径时提示不是目录", () => {
    expect(() => listDirs(path.join(dir, "b.txt"))).toThrow(/不是目录/);
  });

  it("空路径回退到用户主目录", () => {
    const r = listDirs("");
    expect(r.path).toBe(path.resolve(os.homedir()));
  });
});

describe("makeDirIn", () => {
  it("在指定目录下新建目录", () => {
    const created = makeDirIn(dir, "new-one");
    expect(created.type).toBe("dir");
    expect(created.path).toBe(path.join(dir, "new-one"));
    expect(created.size).toBe(0);
    expect(Number.isNaN(Date.parse(created.mtime))).toBe(false);
    expect(fs.statSync(created.path).isDirectory()).toBe(true);
  });

  it("支持多级相对路径（递归创建）", () => {
    const created = makeDirIn(dir, "x/y/z");
    expect(created.path).toBe(path.join(dir, "x/y/z"));
    expect(fs.statSync(path.join(dir, "x/y/z")).isDirectory()).toBe(true);
  });

  it("目录名为空 / 非法 时报错", () => {
    expect(() => makeDirIn(dir, "   ")).toThrow(/不能为空/);
    expect(() => makeDirIn(dir, "..")).toThrow(/非法/);
  });

  it("越出当前目录时报错且不创建", () => {
    expect(() => makeDirIn(dir, "../escape")).toThrow(/不能越出/);
    expect(fs.existsSync(path.join(path.dirname(dir), "escape"))).toBe(false);
  });

  it("名字以 .. 开头的目录是合法的，不算越界", () => {
    const created = makeDirIn(dir, "..foo");
    expect(created.path).toBe(path.join(dir, "..foo"));
    expect(fs.statSync(created.path).isDirectory()).toBe(true);
  });

  it("同名文件冲突时报错", () => {
    expect(() => makeDirIn(dir, "b.txt")).toThrow(/同名文件/);
  });
});

describe("fuzzyScore", () => {
  it("前缀命中优于子串命中，子串优于子序列", () => {
    const prefix = fuzzyScore("abc.txt", "abc")!;
    const substr = fuzzyScore("x-abc.txt", "abc")!;
    const subseq = fuzzyScore("a_b_c.txt", "abc")!;
    expect(prefix).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(subseq);
  });

  it("不区分大小写；不命中返回 null", () => {
    expect(fuzzyScore("README.md", "readme")).not.toBeNull();
    expect(fuzzyScore("readme.md", "README")).not.toBeNull();
    expect(fuzzyScore("abc.txt", "zzz")).toBeNull();
    // 子序列要求字符顺序一致
    expect(fuzzyScore("cba.txt", "abc")).toBeNull();
  });

  it("关键字越靠前、名字越短得分越高", () => {
    expect(fuzzyScore("src", "src")!).toBeGreaterThan(fuzzyScore("a-src", "src")!);
    expect(fuzzyScore("src", "src")!).toBeGreaterThan(fuzzyScore("src-long-name", "src")!);
  });
});

describe("searchDirs", () => {
  it("按关键字过滤并只返回命中项", async () => {
    fs.mkdirSync(path.join(dir, "src-assets"));
    fs.writeFileSync(path.join(dir, "src-index.ts"), "x");
    fs.writeFileSync(path.join(dir, "other.md"), "x");

    const r = await searchDirs(dir, "src");
    expect(r.path).toBe(dir);
    expect(r.query).toBe("src");
    expect(r.entries.map((e) => e.name).sort()).toEqual(["src-assets", "src-index.ts"]);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("大小写不敏感，且目录与文件都参与匹配", async () => {
    const r = await searchDirs(dir, "A-SUB");
    expect(r.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:a-sub"]);
  });

  it("支持子序列模糊匹配，命中带绝对路径", async () => {
    fs.writeFileSync(path.join(dir, "node_exporter_proxy.txt"), "x");
    const r = await searchDirs(dir, "npx");
    const hit = r.entries.find((e) => e.name === "node_exporter_proxy.txt");
    expect(hit).toBeTruthy();
    expect(hit!.path).toBe(path.join(dir, "node_exporter_proxy.txt"));
    expect(hit!.size).toBe(1);
    expect(Number.isNaN(Date.parse(hit!.mtime))).toBe(false);
  });

  it("limit 截断但 total 反映全部命中数", async () => {
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(dir, `f-${String(i).padStart(2, "0")}.log`), "x");
    }
    const r = await searchDirs(dir, "f-", 5);
    expect(r.entries.length).toBe(5);
    expect(r.total).toBe(20);
    expect(r.truncated).toBe(true);
  });

  it("无匹配时返回空列表（不抛错）", async () => {
    const r = await searchDirs(dir, "zzz-nothing");
    expect(r.entries).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("空关键字等价于列出目录", async () => {
    const r = await searchDirs(dir, "");
    expect(r.entries.map((e) => e.name)).toEqual(["a-sub", "b.txt"]);
  });

  it("路径不存在 / 不是目录时报错", async () => {
    await expect(searchDirs(path.join(dir, "nope"), "a")).rejects.toThrow(/路径不存在/);
    await expect(searchDirs(path.join(dir, "b.txt"), "a")).rejects.toThrow(/不是目录/);
  });

  it("重复搜索（命中缓存）结果一致", async () => {
    const first = await searchDirs(dir, "a");
    const second = await searchDirs(dir, "a");
    expect(second.entries).toEqual(first.entries);
    expect(second.total).toBe(first.total);
  });

  it("新建目录后立刻搜索能命中（缓存失效）", async () => {
    await searchDirs(dir, "fresh"); // 先填充该目录的条目缓存
    makeDirIn(dir, "fresh-dir");
    const r = await searchDirs(dir, "fresh");
    expect(r.entries.some((e) => e.name === "fresh-dir")).toBe(true);
  });
});
