/**
 * 项目操作单测：终端命令执行 + Git 状态（只读）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runProjectCommand, projectGitStatus } from "../src/server/projectOps.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "projops-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runProjectCommand", () => {
  it("执行命令并捕获 stdout / 退出码", async () => {
    const r = await runProjectCommand(dir, "echo hello-projops");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello-projops");
    expect(r.cwd).toBe(path.resolve(dir));
  });

  it("捕获非零退出码", async () => {
    const r = await runProjectCommand(dir, "exit 3");
    expect(r.exitCode).toBe(3);
  });

  it("空命令报错", async () => {
    await expect(runProjectCommand(dir, "   ")).rejects.toThrow();
  });
});

describe("projectGitStatus", () => {
  it("非 git 仓库返回 error（不抛异常）", async () => {
    const r = await projectGitStatus(dir);
    expect(typeof r).toBe("object");
    expect(r.error).toBeTruthy();
  });
});
