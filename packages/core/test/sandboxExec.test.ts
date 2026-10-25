/**
 * 沙箱执行的集成测试（真机）
 *
 * 只在沙箱真正可用时运行：探测不到后端（CI 常如此）就跳过。
 * 验证两件事：工作区内可写；工作区外的写入被系统拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry, registerShellTool, resolveSandbox } from "../src/index.js";

let workspace: string;
let registry: ToolRegistry;
let enforced = false;
/** 工作区外的目标文件：与工作区同级的临时目录（必然越界） */
let outsideDir: string;
/** 必然越界的写入目标：当前项目目录（沙箱只放行工作区与系统临时目录） */
let outsideFile: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sbx-ws-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sbx-out-"));
  outsideFile = path.join(process.cwd(), `.sandbox-leak-${process.pid}.txt`);
  const plan = resolveSandbox({ workspace, extraWritable: [] });
  enforced = plan.enforced;
  registry = new ToolRegistry();
  registerShellTool(registry, workspace, null, plan);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(outsideFile, { force: true });
});

describe.skipIf(process.platform === "win32")("沙箱文件系统边界", () => {
  it("工作区内可写", async (ctx) => {
    if (!enforced) return ctx.skip();
    const result = (await registry.execute("run_shell", {
      command: "echo hello > inside.txt && cat inside.txt",
    })) as Record<string, unknown>;
    expect(result.exit_code).toBe(0);
    expect(String(result.stdout)).toContain("hello");
    expect(fs.existsSync(path.join(workspace, "inside.txt"))).toBe(true);
  });

  it("工作区外的写入被拒绝", async (ctx) => {
    if (!enforced) return ctx.skip();
    const result = (await registry.execute("run_shell", {
      command: `echo leaked > ${outsideFile}`,
    })) as Record<string, unknown>;
    expect(result.exit_code).not.toBe(0);
    expect(fs.existsSync(outsideFile)).toBe(false);
  });

  it("工作区外仍可读取（只收窄写权限，不影响工具链）", async (ctx) => {
    if (!enforced) return ctx.skip();
    const source = path.join(outsideDir, "readable.txt");
    fs.writeFileSync(source, "ok");
    const result = (await registry.execute("run_shell", {
      command: `cat ${source}`,
    })) as Record<string, unknown>;
    expect(result.exit_code).toBe(0);
    expect(String(result.stdout)).toContain("ok");
  });
});
