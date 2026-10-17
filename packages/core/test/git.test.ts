/**
 * Git 工具单元测试
 *
 * 覆盖：status 首条前导空格的解析（旧实现整体 trim 会吃掉路径首字符）、
 * 非 ASCII 文件名不被转义（core.quotepath=false），以及 path 指向子目录里的
 * 另一个仓库时自动定位仓库根。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerGitTools } from "../src/index.js";

let workspace: string;
let registry: ToolRegistry;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-git-"));
  registry = new ToolRegistry();
  registerGitTools(registry, workspace);
  git(workspace, ["init", "-q"]);
  git(workspace, ["config", "user.email", "t@t.t"]);
  git(workspace, ["config", "user.name", "tester"]);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function status(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await registry.execute("git_status", args)) as Record<string, unknown>;
}

type Entry = { status: string; file: string };
type StatusResult = { entries?: Entry[]; repo?: string; error?: string };

describe("git_status", () => {
  it("首个条目带前导空格时路径首字符不丢失", async () => {
    fs.writeFileSync(path.join(workspace, "aaa.txt"), "one\n");
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "-qm", "init"]);
    // 修改后 porcelain 首行为 " M aaa.txt"（前导空格）
    fs.writeFileSync(path.join(workspace, "aaa.txt"), "two\n");

    const r = (await status()) as StatusResult;
    const entry = (r.entries ?? []).find((e) => e.file === "aaa.txt");
    expect(entry).toBeTruthy();
    expect(entry!.status).toBe("M");
  });

  it("非 ASCII 文件名不被转义为八进制", async () => {
    fs.writeFileSync(path.join(workspace, "新建文本文档.txt"), "x\n");
    const r = (await status()) as StatusResult;
    expect((r.entries ?? []).some((e) => e.file === "新建文本文档.txt")).toBe(true);
  });

  it("path 指向子目录里的另一个仓库时定位其根", async () => {
    const nested = path.join(workspace, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    fs.writeFileSync(path.join(nested, "n.txt"), "y\n");

    const r = (await status({ path: "nested" })) as StatusResult;
    expect(r.repo && fs.realpathSync(r.repo)).toBe(fs.realpathSync(nested));
  });

  it("git_log 同样能定位嵌套仓库并返回其提交", async () => {
    const nested = path.join(workspace, "nested-log");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.email", "t@t.t"]);
    git(nested, ["config", "user.name", "tester"]);
    fs.writeFileSync(path.join(nested, "n.txt"), "y\n");
    git(nested, ["add", "."]);
    git(nested, ["commit", "-qm", "nested root"]);

    const r = (await registry.execute("git_log", { path: "nested-log" })) as {
      repo?: string;
      count?: number;
      commits?: Array<{ subject: string }>;
      error?: string;
    };
    expect(r.error).toBeUndefined();
    expect(r.repo && fs.realpathSync(r.repo)).toBe(fs.realpathSync(nested));
    expect(r.count).toBe(1);
    expect(r.commits?.[0]?.subject).toBe("nested root");
  });
});

describe("git_status 非仓库", () => {
  it("工作区非 git 仓库时报错清晰", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ow-nogit-"));
    try {
      const reg = new ToolRegistry();
      registerGitTools(reg, plain);
      const r = (await reg.execute("git_status", {})) as StatusResult;
      expect(r.error).toContain("不是 git 仓库");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
