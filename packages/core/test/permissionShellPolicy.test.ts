/**
 * shell 免审策略与项目级权限配置的单元测试
 *
 * 覆盖：四种 shellPolicy 的放行边界、沙箱生效后不再走路径判定、
 * 白名单的词边界匹配（`ls` 不能放行 `lsof`）、`.agent/permissions.json`
 * 的读取与逐项回退。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PermissionEngine,
  Mode,
  loadPermissionConfig,
  DEFAULT_ALLOWED_COMMANDS,
} from "../src/index.js";

const WS = "/work/project";

function makeEngine(opts: {
  policy?: "approve" | "sandbox" | "workspace" | "all";
  enforced?: boolean;
  allowed?: string[];
} = {}) {
  return new PermissionEngine({
    workspaceRoot: WS,
    mode: Mode.INTERACTIVE,
    allowedCommands: opts.allowed ?? [],
    shellPolicy: opts.policy ?? "approve",
    sandbox: {
      enforced: opts.enforced === true,
      backend: opts.enforced ? "sandbox-exec" : "none",
    },
  });
}

describe("shellPolicy", () => {
  it("approve：工作区内的命令仍需审批（保持既有语义）", () => {
    const d = makeEngine({ policy: "approve" }).evaluate("run_shell", { command: "ls -la" });
    expect(d.allowed).toBe(false);
    expect(d.needsUser).toBe(true);
  });

  it("workspace：路径都在工作区内时免审", () => {
    const d = makeEngine({ policy: "workspace" }).evaluate("run_shell", {
      command: "pnpm install",
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("工作区内");
  });

  it("workspace：路径越界时仍需审批，并说明原因", () => {
    const d = makeEngine({ policy: "workspace" }).evaluate("run_shell", {
      command: "cat /etc/passwd",
    });
    expect(d.allowed).toBe(false);
    expect(d.needsUser).toBe(true);
    expect(d.reason).toContain("路径越界");
  });

  it("sandbox：沙箱生效时免审（隔离由系统兜底）", () => {
    const d = makeEngine({ policy: "sandbox", enforced: true }).evaluate("run_shell", {
      command: "rm -rf /",
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("沙箱");
  });

  it("sandbox：沙箱未生效时不放行", () => {
    const d = makeEngine({ policy: "sandbox" }).evaluate("run_shell", { command: "ls" });
    expect(d.allowed).toBe(false);
  });

  it("all：shell 全部免审", () => {
    const d = makeEngine({ policy: "all" }).evaluate("run_shell", { command: "rm -rf /" });
    expect(d.allowed).toBe(true);
  });

  it("只影响 shell，不影响写文件的路径校验", () => {
    const d = makeEngine({ policy: "all" }).evaluate("write_file", { path: "/etc/x" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("可写目录");
  });

  it("只读模式优先于免审策略", () => {
    const engine = makeEngine({ policy: "all" });
    engine.mode = Mode.PLAN;
    const d = engine.evaluate("run_shell", { command: "ls" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("只读");
  });
});

describe("命令白名单匹配", () => {
  it("前缀必须在词边界结束：ls 放行 ls -la", () => {
    const d = makeEngine({ allowed: ["ls"] }).evaluate("run_shell", { command: "ls -la" });
    expect(d.allowed).toBe(true);
  });

  it("前缀必须在词边界结束：ls 不放行 lsof", () => {
    const d = makeEngine({ allowed: ["ls"] }).evaluate("run_shell", { command: "lsof -i" });
    expect(d.allowed).toBe(false);
    expect(d.needsUser).toBe(true);
  });

  it("空前缀不会命中任何命令", () => {
    const d = makeEngine({ allowed: ["", "  "] }).evaluate("run_shell", { command: "ls" });
    expect(d.allowed).toBe(false);
  });
});

describe("loadPermissionConfig", () => {
  let dir: string;
  const env = { HOME: "/home/me" } as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-perm-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string): void {
    fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agent", "permissions.json"), content, "utf-8");
  }

  it("文件缺失时用默认值", () => {
    const cfg = loadPermissionConfig(dir, env);
    expect(cfg.mode).toBe(Mode.INTERACTIVE);
    expect(cfg.shellPolicy).toBe("workspace");
    expect(cfg.allowedCommands).toEqual(DEFAULT_ALLOWED_COMMANDS);
    expect(cfg.sandbox.mode).toBe("auto");
  });

  it("读取文件字段", () => {
    write(
      JSON.stringify({
        mode: "auto",
        shellPolicy: "all",
        allowedCommands: ["pnpm", "rg"],
        sandbox: { mode: "off", extraWritable: ["~/store"] },
      }),
    );
    const cfg = loadPermissionConfig(dir, env);
    expect(cfg.mode).toBe(Mode.AUTO);
    expect(cfg.shellPolicy).toBe("all");
    expect(cfg.allowedCommands).toEqual(["pnpm", "rg"]);
    expect(cfg.sandbox).toEqual({ mode: "off", extraWritable: ["~/store"] });
  });

  it("sandbox 可写成字符串", () => {
    write(JSON.stringify({ sandbox: "required" }));
    expect(loadPermissionConfig(dir, env).sandbox.mode).toBe("required");
  });

  it("非法值逐项回退，不影响其它字段", () => {
    write(JSON.stringify({ mode: "nope", shellPolicy: "nope", allowedCommands: "x" }));
    const cfg = loadPermissionConfig(dir, env);
    expect(cfg.mode).toBe(Mode.INTERACTIVE);
    expect(cfg.shellPolicy).toBe("workspace");
    expect(cfg.allowedCommands).toEqual(DEFAULT_ALLOWED_COMMANDS);
  });

  it("损坏的 JSON 静默回退", () => {
    write("{ not json");
    expect(loadPermissionConfig(dir, env).shellPolicy).toBe("workspace");
  });

  it("环境变量可覆盖 shellPolicy", () => {
    const cfg = loadPermissionConfig(dir, { ...env, ZQAGENT_SHELL_POLICY: "approve" });
    expect(cfg.shellPolicy).toBe("approve");
  });
});
