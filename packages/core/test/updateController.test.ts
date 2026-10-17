/**
 * 自动更新调度器行为测试
 *
 * 关注「什么时候才允许重启」这一核心安全属性：
 * 有运行中/等待输入的会话时必须继续等待，空闲满阈值才放行。
 * 通过私有方法直接驱动，不触网、不替换任何真实文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UpdateController } from "../src/update/controller.js";

type WaitForIdle = () => Promise<boolean>;

function controller(opts: { idle: () => boolean; dataDir: string }) {
  const ctrl = new UpdateController({
    dataDir: opts.dataDir,
    isIdle: opts.idle,
    log: () => {},
  });
  // 通过私有方法验证等待逻辑（不进入安装路径）
  return ctrl as unknown as { waitForIdle: WaitForIdle } & UpdateController;
}

describe("UpdateController 空闲判定", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-upd-ctrl-"));
    vi.useFakeTimers();
    process.env.ZQAGENT_UPDATE_MIN_UPTIME_MS = "0";
    process.env.ZQAGENT_UPDATE_IDLE_MS = "3000";
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ZQAGENT_UPDATE_MIN_UPTIME_MS;
    delete process.env.ZQAGENT_UPDATE_IDLE_MS;
  });

  it("持续有任务时不放行", async () => {
    const ctrl = controller({ idle: () => false, dataDir: dir });
    let settled = false;
    void ctrl.waitForIdle().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    ctrl.stop();
  });

  it("空闲不满阈值不放行，连续空闲达到阈值才放行", async () => {
    let idle = false;
    const ctrl = controller({ idle: () => idle, dataDir: dir });
    let settled = false;
    void ctrl.waitForIdle().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);

    idle = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false); // 才空闲 2s，未达 3s

    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
    ctrl.stop();
  });

  it("空闲期间来了新任务，计时重头开始", async () => {
    let idle = true;
    const ctrl = controller({ idle: () => idle, dataDir: dir });
    let settled = false;
    void ctrl.waitForIdle().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    idle = false; // 新任务到来
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);

    idle = true; // 再次空闲，重新计时
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
    ctrl.stop();
  });

  it("stop() 后等待立即结束且不放行", async () => {
    const ctrl = controller({ idle: () => false, dataDir: dir });
    const pending = ctrl.waitForIdle();
    ctrl.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe(false);
  });
});
