/**
 * shell 运行时探测单元测试
 *
 * 覆盖：Windows 下的 shell 探测优先级、ZQAGENT_SHELL / ZQAGENT_BUSYBOX 覆盖、
 * 各 shell 家族的 argv 拼装、cd 链解析，以及 POSIX 下「不显式指定 shell」的底线
 * （保证改造前后行为一致）。因为注入 platform/env/文件探测，全部可在 Linux 上跑。
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  describeShell,
  findExecutable,
  parseCdChain,
  resolveShellSpec,
} from "../src/tools/shellRuntime.js";

/** 构造文件存在性判断：路径按目标平台语义归一化后比对 */
function existsIn(files: string[], platform: NodeJS.Platform): (p: string) => boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const set = new Set(files.map((f) => api.normalize(f).toLowerCase()));
  return (p: string) => set.has(api.normalize(p).toLowerCase());
}

const WIN = (p: string) => path.win32.normalize(p);

describe("resolveShellSpec — POSIX", () => {
  it("auto 时不显式指定 shell（保持 Node 默认 /bin/sh）", () => {
    const spec = resolveShellSpec({ platform: "linux", env: {}, fileExists: () => true });
    expect(spec.kind).toBe("default");
    expect(spec.file).toBeNull();
    expect(spec.label).toBe("/bin/sh");
  });

  it("显式 ZQAGENT_SHELL 关键字会解析到实际路径", () => {
    const spec = resolveShellSpec({
      platform: "linux",
      env: { ZQAGENT_SHELL: "bash", PATH: "/usr/bin" },
      fileExists: existsIn(["/usr/bin/bash"], "linux"),
    });
    expect(spec.kind).toBe("sh");
    expect(spec.file).toBe("/usr/bin/bash");
    expect(spec.buildArgs("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("macOS 同样走默认", () => {
    const spec = resolveShellSpec({ platform: "darwin", env: {}, fileExists: () => false });
    expect(spec.file).toBeNull();
  });
});

describe("resolveShellSpec — Windows 探测优先级", () => {
  it("产物旁的 busybox 优先，且用 busybox sh -c", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { PATH: WIN("C:\\Windows\\System32") },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn(
        [WIN("C:\\app\\busybox.exe"), WIN("C:\\Windows\\System32\\bash.exe")],
        "win32",
      ),
    });
    expect(spec.kind).toBe("busybox");
    expect(spec.file).toBe(WIN("C:\\app\\busybox.exe"));
    expect(spec.buildArgs("ls -la")).toEqual(["sh", "-c", "ls -la"]);
  });

  it("bin/ 下的 sh.exe（busybox 副本）也能被发现，且不再前置 applet 名", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { PATH: "" },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn([WIN("C:\\app\\bin\\sh.exe")], "win32"),
    });
    expect(spec.kind).toBe("busybox");
    expect(spec.file).toBe(WIN("C:\\app\\bin\\sh.exe"));
    // sh.exe 自己就是 ash，多传一个 "sh" 会被当成脚本文件名
    expect(spec.buildArgs("ls -la")).toEqual(["-c", "ls -la"]);
  });

  it("ZQAGENT_BUSYBOX 指向 sh.exe 副本时同样不前置 applet 名", () => {
    const exe = WIN("C:\\app\\sh.exe");
    const spec = resolveShellSpec({
      platform: "win32",
      env: { ZQAGENT_BUSYBOX: exe, PATH: "" },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn([exe], "win32"),
    });
    expect(spec.buildArgs("pwd")).toEqual(["-c", "pwd"]);
  });

  it("没有 busybox 时优先 Git Bash 而非 PowerShell", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { PATH: WIN("C:\\Program Files\\Git\\bin") },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn([WIN("C:\\Program Files\\Git\\bin\\bash.exe")], "win32"),
    });
    expect(spec.kind).toBe("sh");
    expect(spec.file).toBe(WIN("C:\\Program Files\\Git\\bin\\bash.exe"));
  });

  it("只有 PowerShell 时用 -NoProfile -Command", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { PATH: WIN("C:\\Windows\\System32\\WindowsPowerShell\\v1.0") },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn(
        [WIN("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")],
        "win32",
      ),
    });
    expect(spec.kind).toBe("powershell");
    expect(spec.buildArgs("ls")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "ls"]);
  });

  it("都要没有时回退 %ComSpec%（cmd.exe）", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { PATH: WIN("C:\\Windows\\System32"), ComSpec: WIN("C:\\Windows\\System32\\cmd.exe") },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: () => false,
    });
    expect(spec.kind).toBe("default");
    expect(spec.file).toBeNull();
    expect(spec.label).toBe(WIN("C:\\Windows\\System32\\cmd.exe"));
  });
});

describe("resolveShellSpec — 环境变量覆盖", () => {
  it("ZQAGENT_SHELL=cmd 用 cmd /d /s /c", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { ZQAGENT_SHELL: "cmd", PATH: WIN("C:\\Windows\\System32") },
      fileExists: existsIn([WIN("C:\\Windows\\System32\\cmd.exe")], "win32"),
    });
    expect(spec.kind).toBe("cmd");
    expect(spec.buildArgs("dir")).toEqual(["/d", "/s", "/c", "dir"]);
  });

  it("ZQAGENT_SHELL 指定含空格的绝对路径时按 basename 推断族", () => {
    const exe = WIN("C:\\Program Files\\Git\\bin\\bash.exe");
    const spec = resolveShellSpec({
      platform: "win32",
      env: { ZQAGENT_SHELL: exe },
      fileExists: () => false, // 显式路径不再探测
    });
    expect(spec.kind).toBe("sh");
    expect(spec.file).toBe(exe);
    expect(spec.buildArgs("pwd")).toEqual(["-c", "pwd"]);
  });

  it("ZQAGENT_BUSYBOX 显式指定时直接采用", () => {
    const exe = WIN("D:\\tools\\busybox.exe");
    const spec = resolveShellSpec({
      platform: "win32",
      env: { ZQAGENT_BUSYBOX: exe, PATH: "" },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: existsIn([exe], "win32"),
    });
    expect(spec.kind).toBe("busybox");
    expect(spec.file).toBe(exe);
  });

  it("ZQAGENT_SHELL=auto 等同未设置", () => {
    const spec = resolveShellSpec({
      platform: "linux",
      env: { ZQAGENT_SHELL: "auto" },
      fileExists: () => false,
    });
    expect(spec.file).toBeNull();
  });

  it("ZQAGENT_BUSYBOX 指向不存在的文件时不误用", () => {
    const spec = resolveShellSpec({
      platform: "win32",
      env: { ZQAGENT_BUSYBOX: WIN("D:\\nope\\busybox.exe"), PATH: "" },
      execPath: WIN("C:\\app\\zqagent.exe"),
      fileExists: () => false,
    });
    expect(spec.kind).toBe("default");
  });
});

describe("findExecutable", () => {
  it("Windows 按 PATH 顺序并补 .exe 后缀", () => {
    const found = findExecutable("bash", {
      platform: "win32",
      env: { PATH: [WIN("C:\\a"), WIN("C:\\b")].join(";") },
      fileExists: existsIn([WIN("C:\\b\\bash.exe")], "win32"),
    });
    expect(found).toBe(WIN("C:\\b\\bash.exe"));
  });

  it("POSIX 不补后缀", () => {
    const found = findExecutable("bash", {
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      fileExists: existsIn(["/usr/bin/bash"], "linux"),
    });
    expect(found).toBe("/usr/bin/bash");
  });

  it("找不到时返回 null，含路径分隔符的名字按路径判定", () => {
    expect(
      findExecutable("nosuchshell", { platform: "linux", env: { PATH: "/usr/bin" }, fileExists: () => false }),
    ).toBeNull();
    expect(
      findExecutable("/opt/x/sh", {
        platform: "linux",
        env: { PATH: "" },
        fileExists: existsIn(["/opt/x/sh"], "linux"),
      }),
    ).toBe("/opt/x/sh");
  });
});

describe("describeShell", () => {
  it("cmd.exe 提示使用 Windows 命令", () => {
    const text = describeShell(
      { kind: "default", label: "cmd.exe", file: null, buildArgs: () => [] },
      "win32",
    );
    expect(text).toContain("win32");
    expect(text).toContain("dir/type/del");
    expect(text).toContain("POSIX");
  });

  it("busybox/POSIX 提示使用 POSIX 风格命令", () => {
    const text = describeShell(
      { kind: "busybox", label: "busybox ash (POSIX)", file: "x", buildArgs: () => [] },
      "win32",
    );
    expect(text).toContain("POSIX 风格命令");
  });

  it("PowerShell 提示别名可用", () => {
    const text = describeShell(
      { kind: "powershell", label: "PowerShell", file: "x", buildArgs: () => [] },
      "win32",
    );
    expect(text).toContain("PowerShell");
    expect(text).toContain("cmdlet");
  });
});

describe("parseCdChain", () => {
  it("识别普通 cd（POSIX）", () => {
    expect(parseCdChain("cd /tmp", { platform: "linux" })).toEqual({
      target: "/tmp",
      rest: null,
    });
  });

  it("识别 cd dir && 后续命令", () => {
    expect(parseCdChain("cd sub && ls -la", { platform: "linux" })).toEqual({
      target: "sub",
      rest: "ls -la",
    });
  });

  it("Windows 下去掉 cd /d 标志", () => {
    expect(parseCdChain("cd /d D:\\work && dir", { platform: "win32" })).toEqual({
      target: "D:\\work",
      rest: "dir",
    });
  });

  it("识别 PowerShell 的 Set-Location / sl", () => {
    expect(parseCdChain('Set-Location "C:\\Program Files"', { platform: "win32" }).target).toBe(
      "C:\\Program Files",
    );
    expect(parseCdChain("sl -Path ./sub", { platform: "win32" }).target).toBe("./sub");
  });

  it("非切目录命令不误判（含 && 链）", () => {
    expect(parseCdChain("make && cd build", { platform: "linux" })).toEqual({
      target: null,
      rest: null,
    });
  });

  it("裸 cd / cd - 不跟踪", () => {
    expect(parseCdChain("cd", { platform: "linux" }).target).toBeNull();
    expect(parseCdChain("cd -", { platform: "linux" }).target).toBeNull();
  });

  it("引号包裹的目录名去引号", () => {
    expect(parseCdChain("cd 'my dir'", { platform: "linux" }).target).toBe("my dir");
  });
});
