/**
 * 沙箱方案解析与命令包装的单元测试
 *
 * 覆盖：三平台后端选择、探测失败回退、mode=off、macOS profile 生成、
 * bubblewrap 参数、命令包装（argv 不拼字符串）、引号转义。
 * 真实探测一律注入，避免测试依赖本机是否装了 bwrap / sandbox-exec。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveSandbox,
  wrapWithSandbox,
  buildMacProfile,
  buildBwrapArgs,
  describeSandbox,
  resetSandboxCache,
  type SandboxPlan,
} from "../src/index.js";

const WS = "/work/project";

function plan(overrides: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    backend: "sandbox-exec",
    enforced: true,
    bin: "/usr/bin/sandbox-exec",
    writable: [WS],
    mode: "auto",
    reason: "test",
    ...overrides,
  };
}

beforeEach(() => resetSandboxCache());

describe("resolveSandbox 平台选择", () => {
  it("macOS 探测成功时启用 sandbox-exec", () => {
    const p = resolveSandbox({
      platform: "darwin",
      workspace: WS,
      fileExists: () => true,
      probe: () => true,
    });
    expect(p.backend).toBe("sandbox-exec");
    expect(p.enforced).toBe(true);
    expect(p.writable.some((d) => d === WS)).toBe(true);
  });

  it("Linux 探测成功时启用 bwrap", () => {
    const p = resolveSandbox({
      platform: "linux",
      workspace: WS,
      fileExists: () => true,
      probe: () => true,
    });
    expect(p.backend).toBe("bwrap");
    expect(p.enforced).toBe(true);
  });

  it("Windows 无零依赖沙箱，明确降级而不是假装生效", () => {
    const p = resolveSandbox({ platform: "win32", workspace: WS });
    expect(p.backend).toBe("none");
    expect(p.enforced).toBe(false);
    expect(p.reason).toContain("Windows");
  });

  it("mode=off 时不探测、不启用", () => {
    const p = resolveSandbox({
      platform: "darwin",
      mode: "off",
      workspace: WS,
      fileExists: () => true,
      probe: () => {
        throw new Error("不该被调用");
      },
    });
    expect(p.enforced).toBe(false);
    expect(p.reason).toContain("关闭");
  });

  it("可执行文件缺失时降级并说明原因", () => {
    const p = resolveSandbox({
      platform: "linux",
      workspace: WS,
      fileExists: () => false,
    });
    expect(p.enforced).toBe(false);
    expect(p.reason).toContain("bwrap");
  });

  it("探测失败（容器禁用 user namespace）时降级", () => {
    const p = resolveSandbox({
      platform: "linux",
      workspace: WS,
      fileExists: () => true,
      probe: () => false,
    });
    expect(p.enforced).toBe(false);
    expect(p.reason).toContain("探测失败");
  });

  it("额外可写路径会展开 ~ 并去重", () => {
    const p = resolveSandbox({
      platform: "darwin",
      workspace: WS,
      extraWritable: ["~/pnpm-store", WS, "/tmp"],
      env: { HOME: "/Users/me" } as NodeJS.ProcessEnv,
      fileExists: () => true,
      probe: () => true,
    });
    expect(p.writable).toContain("/Users/me/pnpm-store");
    // /tmp 与 /private/tmp 都应在（macOS 符号链接）
    expect(p.writable).toContain("/tmp");
    expect(new Set(p.writable).size).toBe(p.writable.length);
  });

  it("包管理器缓存目录默认可写（否则装依赖会 EPERM）", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      const p = resolveSandbox({
        platform,
        workspace: WS,
        env: { HOME: "/Users/me" } as NodeJS.ProcessEnv,
        fileExists: () => true,
        probe: () => true,
      });
      expect(p.writable).toContain("/Users/me/.npm");
      // 敏感目录不应被默认放行
      expect(p.writable).not.toContain("/Users/me/.ssh");
      expect(p.writable).not.toContain("/Users/me");
    }
  });
});

describe("buildMacProfile", () => {
  it("只收窄写权限，读与网络保持默认", () => {
    const profile = buildMacProfile([WS, "/tmp"]);
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(subpath "${WS}")`);
    expect(profile).toContain(`(subpath "/tmp")`);
    expect(profile).not.toContain("(deny default)");
  });

  it("转义引号与反斜杠", () => {
    const profile = buildMacProfile(['/tmp/a"b\\c']);
    expect(profile).toContain('(subpath "/tmp/a\\"b\\\\c")');
  });
});

describe("buildBwrapArgs", () => {
  it("整机只读 + 工作区可写 + 独立 /tmp", () => {
    const args = buildBwrapArgs([WS], WS);
    expect(args.slice(0, 4)).toEqual(["--ro-bind", "/", "/", "--dev-bind"]);
    expect(args).toContain("--tmpfs");
    expect(args).toEqual(
      expect.arrayContaining(["--bind", WS, WS, "--chdir", WS, "--die-with-parent"]),
    );
  });

  it("显式允许 /tmp 时不再挂 tmpfs", () => {
    const args = buildBwrapArgs([WS, "/tmp"], WS);
    expect(args).not.toContain("--tmpfs");
  });
});

describe("wrapWithSandbox", () => {
  it("未生效时原样返回同一对象", () => {
    const inv = { file: "/bin/sh", argv: ["-c", "ls"] };
    expect(wrapWithSandbox(plan({ enforced: false, bin: null }), inv, { cwd: WS })).toBe(inv);
    expect(wrapWithSandbox(null, inv, { cwd: WS })).toBe(inv);
  });

  it("sandbox-exec 以 -p profile 包住原命令（不拼 shell 字符串）", () => {
    const wrapped = wrapWithSandbox(
      plan(),
      { file: "/bin/sh", argv: ["-c", "echo 'a b'"] },
      { cwd: WS },
    );
    expect(wrapped.file).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.argv[0]).toBe("-p");
    expect(wrapped.argv[1]).toContain(`(subpath "${WS}")`);
    expect(wrapped.argv.slice(2)).toEqual(["/bin/sh", "-c", "echo 'a b'"]);
  });

  it("bwrap 用 -- 分隔沙箱参数与原命令", () => {
    const wrapped = wrapWithSandbox(
      plan({ backend: "bwrap", bin: "/usr/bin/bwrap" }),
      { file: "/bin/sh", argv: ["-c", "ls"] },
      { cwd: WS },
    );
    expect(wrapped.file).toBe("/usr/bin/bwrap");
    expect(wrapped.argv).toContain("--");
    expect(wrapped.argv.slice(wrapped.argv.indexOf("--"))).toEqual([
      "--",
      "/bin/sh",
      "-c",
      "ls",
    ]);
  });
});

describe("describeSandbox", () => {
  it("未启用时给出原因，便于用户判断风险", () => {
    expect(describeSandbox(plan({ enforced: false, backend: "none", reason: "x" }))).toContain(
      "未启用",
    );
  });
});
