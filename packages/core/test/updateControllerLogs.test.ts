/**
 * 「检查了但什么都没做」必须有日志
 *
 * 这两条分支本来各有正当理由（连续失败额度用尽、清单没有当前平台产物），
 * 但后台定时器调用 `check()` 时没人读返回值：不写日志就等于完全静默。
 * 曾出现节点连续几周每天检查、却因为发布清单少了 macOS 的平台键而一直停在
 * 旧版本，日志里只有「检查更新：…」一行，无从排查。
 *
 * 这里 mock 掉能力判定与清单拉取，只验证「是否落了一条可读日志」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CURRENT = "0.2.8";
const LATEST = "9.9.9";
/** 固定平台键，避免测试结果随 CI 架构变化 */
const TEST_PLATFORM = "test-arch";

vi.mock("../src/update/platform.js", () => ({
  currentVersion: () => CURRENT,
  isSeaRuntime: () => true,
  serviceManager: () => "launchd",
  serviceEnvValue: () => undefined,
  selfUpdateCapability: () => ({ ok: true }),
}));

vi.mock("../src/update/manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/update/manifest.js")>();
  return { ...actual, platformKey: () => TEST_PLATFORM };
});

vi.mock("../src/update/downloader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/update/downloader.js")>();
  return {
    ...actual,
    fetchManifest: async () => ({
      manifest: { version: LATEST, binaries: { "other-arch": { url: "https://example.com/x" } } },
    }),
  };
});

const { UpdateController } = await import("../src/update/controller.js");

describe("UpdateController 跳过时写日志", () => {
  let dir: string;
  let logs: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zq-upd-log-"));
    logs = [];
    process.env.ZQAGENT_UPDATE_PUBKEY = "test-key";
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ZQAGENT_UPDATE_PUBKEY;
  });

  function controller() {
    return new UpdateController({
      dataDir: dir,
      isIdle: () => true,
      log: (m) => logs.push(m),
    });
  }

  it("清单没有当前平台的产物时，日志说明缺少哪个键与清单提供了什么", async () => {
    const msg = await controller().check();

    expect(msg).toContain(TEST_PLATFORM);
    const hit = logs.find((l) => l.includes(TEST_PLATFORM) && l.includes("other-arch"));
    expect(hit, "应把缺失的平台键与清单实际提供的键写进日志").toBeTruthy();
  });

  it("连续失败额度用尽时同样写日志（否则只会静默跳过）", async () => {
    fs.mkdirSync(path.join(dir, "updates"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "updates", "state.json"),
      JSON.stringify({ failedVersion: LATEST, failureCount: 3 }),
    );

    const msg = await controller().check();

    expect(msg).toContain("已连续失败");
    expect(logs.some((l) => l.includes(LATEST) && l.includes("已连续失败"))).toBe(true);
  });
});
