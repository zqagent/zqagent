/**
 * 跨平台配置 / 状态目录解析测试
 *
 * 关键回归点：Windows 的 cmd / PowerShell 里通常没有 `HOME`，旧实现会回退 `/tmp`
 * （在 Windows 上实际是当前盘符根下的 `\tmp\...`）。这里断言 Windows 优先使用
 * `%APPDATA%` / `%LOCALAPPDATA%`，其余平台保持 XDG 语义。
 *
 * paths.ts 在模块顶层读取 `process.platform`，因此每个用例都要重置模块后再导入。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as path from "path";

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
] as const;

const realPlatform = process.platform;
const saved = new Map<string, string | undefined>();

type Paths = typeof import("../src/paths.js");

/** 以指定环境变量与平台重新加载 paths 模块 */
async function loadPaths(env: Record<string, string>, platform: string): Promise<Paths> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../src/paths.js");
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  vi.resetModules();
});

describe("configDir", () => {
  it("POSIX：XDG_CONFIG_HOME 优先", async () => {
    const { configDir } = await loadPaths({ XDG_CONFIG_HOME: "/xdg/conf", HOME: "/home/dev" }, "linux");
    expect(configDir()).toBe(path.join("/xdg/conf", "zqagent"));
  });

  it("POSIX：无 XDG → ~/.config/zqagent", async () => {
    const { configDir } = await loadPaths({ HOME: "/home/dev" }, "linux");
    expect(configDir()).toBe(path.join("/home/dev", ".config", "zqagent"));
  });

  it("Windows：优先 %APPDATA%，不再落回 /tmp", async () => {
    const { configDir } = await loadPaths(
      { APPDATA: "C:\\Users\\dev\\AppData\\Roaming", USERPROFILE: "C:\\Users\\dev" },
      "win32",
    );
    const dir = configDir();
    expect(dir.startsWith("C:\\Users\\dev\\AppData\\Roaming")).toBe(true);
    expect(dir).not.toContain("tmp");
  });

  it("Windows：XDG_CONFIG_HOME 仍优先于 %APPDATA%", async () => {
    const { configDir } = await loadPaths(
      { XDG_CONFIG_HOME: "D:\\xdg", APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      "win32",
    );
    expect(configDir()).toBe(path.join("D:\\xdg", "zqagent"));
  });

  it("Windows：无 %APPDATA% → 用户主目录（USERPROFILE）", async () => {
    const { configDir } = await loadPaths({ USERPROFILE: "C:\\Users\\dev" }, "win32");
    expect(configDir().startsWith("C:\\Users\\dev")).toBe(true);
  });

  it("极端情况：无任何主目录变量时仍返回绝对路径", async () => {
    const { configDir } = await loadPaths({}, "win32");
    expect(path.isAbsolute(configDir())).toBe(true);
  });
});

describe("stateDir", () => {
  it("POSIX：XDG_STATE_HOME 优先", async () => {
    const { stateDir } = await loadPaths({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/dev" }, "darwin");
    expect(stateDir()).toBe(path.join("/xdg/state", "zqagent"));
  });

  it("POSIX：无 XDG → ~/.local/state/zqagent", async () => {
    const { stateDir } = await loadPaths({ HOME: "/home/dev" }, "linux");
    expect(stateDir()).toBe(path.join("/home/dev", ".local", "state", "zqagent"));
  });

  it("Windows：优先 %LOCALAPPDATA%（而非漫游的 APPDATA）", async () => {
    const { stateDir } = await loadPaths(
      {
        APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      },
      "win32",
    );
    const dir = stateDir();
    expect(dir.startsWith("C:\\Users\\dev\\AppData\\Local")).toBe(true);
    expect(dir).not.toContain("tmp");
  });

  it("Windows：无 %LOCALAPPDATA% → 用户主目录", async () => {
    const { stateDir } = await loadPaths({ USERPROFILE: "C:\\Users\\dev" }, "win32");
    expect(stateDir().startsWith("C:\\Users\\dev")).toBe(true);
  });
});
