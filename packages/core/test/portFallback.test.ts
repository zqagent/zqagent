/**
 * 端口占用自动递增（runtime.listenWithPortFallback）单元测试
 *
 * 背景：8787 在开发机上经常被别的服务占用。此前 server.listen 没有 error 处理，
 * EADDRINUSE 直接变成未捕获异常，进程崩溃；装成 launchd/systemd 服务后表现为
 * 无限重启、日志反复刷同一段堆栈，用户只看到「服务 · 未运行」。
 *
 * 这里锁定三条行为：
 *   1. 起始端口被占 → 依次递增直到可用，并把实际端口写进 server-port；
 *   2. 全部被占 → 以 EADDRINUSE 拒绝，而不是无声挂起；
 *   3. 非 EADDRINUSE（如 EACCES）不递增，直接失败。
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { listenWithPortFallback } from "../src/server/runtime.js";

const HOST = "127.0.0.1";
const blockers: net.Server[] = [];
const targets: net.Server[] = [];
const dirs: string[] = [];

/** 占住一个端口（监听即可） */
function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    blockers.push(s);
    s.once("error", reject);
    s.listen(port, HOST, () => resolve());
  });
}

/** 造一个空目录当 dataDir */
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zq-port-"));
  dirs.push(d);
  return d;
}

/** 申请一个当前空闲的起始端口（避免与真实服务冲突） */
function freePortBase(): number {
  return 21000 + Math.floor(Math.random() * 2000);
}

afterEach(async () => {
  await Promise.all(
    [...blockers, ...targets].map(
      (s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r())),
    ),
  );
  blockers.length = 0;
  targets.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("listenWithPortFallback", () => {
  it("起始端口被占用时递增到下一个可用端口，并写入 server-port", async () => {
    const base = freePortBase();
    await occupy(base);

    const dataDir = tempDir();
    const server = net.createServer();
    targets.push(server);

    const actual = await listenWithPortFallback(server, base, HOST, dataDir);

    expect(actual).toBe(base + 1);
    expect(server.listening).toBe(true);
    // 安装脚本靠这个文件拿到真实端口
    expect(fs.readFileSync(path.join(dataDir, "server-port"), "utf8").trim()).toBe(
      String(base + 1),
    );
  });

  it("连续多个端口被占用时逐个跳过", async () => {
    const base = freePortBase();
    await occupy(base);
    await occupy(base + 1);
    await occupy(base + 2);

    const server = net.createServer();
    targets.push(server);

    const actual = await listenWithPortFallback(server, base, HOST, tempDir());

    expect(actual).toBe(base + 3);
  });

  it("端口空闲时直接用起始端口", async () => {
    const base = freePortBase();
    const dataDir = tempDir();
    const server = net.createServer();
    targets.push(server);

    const actual = await listenWithPortFallback(server, base, HOST, dataDir);

    expect(actual).toBe(base);
    expect(fs.readFileSync(path.join(dataDir, "server-port"), "utf8").trim()).toBe(
      String(base),
    );
  });

  it("重试次数用尽后以 EADDRINUSE 拒绝（不会无声挂起）", async () => {
    const base = freePortBase();
    await occupy(base);
    await occupy(base + 1);

    const server = net.createServer();
    targets.push(server);

    await expect(
      listenWithPortFallback(server, base, HOST, tempDir(), 1),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("端口位于特权区间（EACCES）时不递增，直接失败", async () => {
    // 非 root 下监听 80 会得到 EACCES；root 下会成功，此时跳过断言
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const server = net.createServer();
    targets.push(server);

    await expect(
      listenWithPortFallback(server, 80, HOST, tempDir()),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
