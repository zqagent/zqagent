/**
 * 安全回归测试
 *
 * 覆盖此前修复的安全漏洞：
 *  1. grep 工具命令注入（pattern/path 参数 → execFileSync 参数数组）
 *  2. git_log / git_diff 命令注入（path 参数 → execFileSync 参数数组）
 *  3. symlink 沙箱逃逸（read_file / write_file 通过软链读写工作区外）
 *  4. web_fetch SSRF 绕过（IPv4-mapped IPv6 / 0.0.0.0）
 *  5. run_shell timeout 参数健壮性（非法值不崩溃）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  ToolRegistry,
  registerFileTools,
  registerSearchTool,
  registerGitTools,
  registerWebTools,
  registerShellTool,
} from "../src/index.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sec-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ==================== 1. grep 命令注入 ====================

describe("grep 命令注入防护", () => {
  it("pattern 参数无法注入 shell 命令", async () => {
    const registry = new ToolRegistry();
    registerSearchTool(registry, workspace);
    const marker = path.join(workspace, "INJECTED_PATTERN");
    const evil = `x"; touch ${marker}; echo "`;

    const result = (await registry.execute("grep", {
      pattern: evil,
      path: ".",
    })) as Record<string, unknown>;

    expect(fs.existsSync(marker)).toBe(false); // 注入命令未执行
    expect(result).toBeDefined(); // 返回结构化结果，不崩溃
  });

  it("path 参数无法注入 shell 命令", async () => {
    const registry = new ToolRegistry();
    registerSearchTool(registry, workspace);
    const marker = path.join(workspace, "INJECTED_PATH");
    const evil = `.; touch ${marker}; #`;

    const result = (await registry.execute("grep", {
      pattern: "hello",
      path: evil,
    })) as Record<string, unknown>;

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toBeDefined();
  });
});

// ==================== 2. git 工具命令注入 ====================

describe("git 工具命令注入防护", () => {
  let repo: string;

  beforeEach(() => {
    repo = path.join(workspace, "repo");
    fs.mkdirSync(repo);
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@test.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execSync("git add . && git commit -qm init", { cwd: repo });
  });

  it("git_log 的 path 参数无法注入命令", async () => {
    const registry = new ToolRegistry();
    registerGitTools(registry, repo);
    const marker = path.join(workspace, "GIT_INJECTED_LOG");
    const evil = `$(touch ${marker})`;

    const result = (await registry.execute("git_log", {
      path: evil,
      max_count: 5,
    })) as Record<string, unknown>;

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toBeDefined();
  });

  it("git_diff 的 path 参数无法注入命令", async () => {
    const registry = new ToolRegistry();
    registerGitTools(registry, repo);
    const marker = path.join(workspace, "GIT_INJECTED_DIFF");
    const evil = `$(touch ${marker})`;

    const result = (await registry.execute("git_diff", {
      path: evil,
    })) as Record<string, unknown>;

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toBeDefined();
  });
});

// ==================== 3. symlink 沙箱逃逸 ====================

describe("symlink 沙箱逃逸防护", () => {
  /** 创建工作区外目录 + 工作区内指向它的软链；平台不支持时返回 null */
  function makeOutsideLink(): string | null {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ow-outside-"));
    try {
      fs.symlinkSync(outside, path.join(workspace, "linkdir"));
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return null;
    }
    return outside;
  }

  it("read_file 无法通过 symlink 读取工作区外文件", () => {
    const outside = makeOutsideLink();
    if (!outside) return; // 平台不支持 symlink → 跳过
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
      const registry = new ToolRegistry();
      registerFileTools(registry, workspace);

      const result = registry.execute("read_file", {
        path: "linkdir/secret.txt",
      }) as Record<string, unknown>;

      expect(result.error).toContain("工作区之外");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("write_file 无法通过 symlink 写入工作区外文件", () => {
    const outside = makeOutsideLink();
    if (!outside) return;
    try {
      const registry = new ToolRegistry();
      registerFileTools(registry, workspace);

      const result = registry.execute("write_file", {
        path: "linkdir/evil.txt",
        content: "PWNED",
      }) as Record<string, unknown>;

      expect(result.error).toContain("工作区之外");
      expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("write_file 通过 symlink 父目录写入同样被拒", () => {
    const outside = makeOutsideLink();
    if (!outside) return;
    try {
      const registry = new ToolRegistry();
      registerFileTools(registry, workspace);

      const result = registry.execute("write_file", {
        path: "linkdir/sub/new.txt",
        content: "x",
      }) as Record<string, unknown>;

      expect(result.error).toContain("工作区之外");
      expect(fs.existsSync(path.join(outside, "sub", "new.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ==================== 4. web_fetch SSRF ====================

describe("web_fetch SSRF 防护", () => {
  async function fetchUrl(url: string): Promise<Record<string, unknown>> {
    const registry = new ToolRegistry();
    registerWebTools(registry);
    return (await registry.execute("web_fetch", { url })) as Record<string, unknown>;
  }

  it("拒绝 IPv4-mapped IPv6 回环 (::ffff:127.0.0.1)", async () => {
    const result = await fetchUrl("http://[::ffff:127.0.0.1]/");
    expect(result.error).toContain("回环");
  });

  it("拒绝 0.0.0.0", async () => {
    const result = await fetchUrl("http://0.0.0.0:8080/");
    expect(result.error).toBeTruthy();
  });

  it("拒绝常规回环 127.0.0.1", async () => {
    const result = await fetchUrl("http://127.0.0.1/");
    expect(result.error).toContain("回环");
  });

  it("拒绝私有网段 192.168.x.x", async () => {
    const result = await fetchUrl("http://192.168.1.1/");
    expect(result.error).toContain("私有网络");
  });

  it("拒绝云元数据端点 169.254.169.254", async () => {
    const result = await fetchUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.error).toContain("link-local");
  });
});

// ==================== 5. run_shell 参数健壮性 ====================

describe("run_shell 参数健壮性", () => {
  it("timeout_seconds 传非法值回退默认，不崩溃", async () => {
    const registry = new ToolRegistry();
    registerShellTool(registry, workspace);
    const result = (await registry.execute("run_shell", {
      command: "echo ok",
      timeout_seconds: "abc",
    })) as Record<string, unknown>;
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("timeout_seconds 传 0 回退下限，不立即超时", async () => {
    const registry = new ToolRegistry();
    registerShellTool(registry, workspace);
    const result = (await registry.execute("run_shell", {
      command: "echo ok",
      timeout_seconds: 0,
    })) as Record<string, unknown>;
    expect(result.exit_code).toBe(0);
  });
});
