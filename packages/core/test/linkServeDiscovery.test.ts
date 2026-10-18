/**
 * `zqagent link` 定位本机 server 数据目录的回归测试
 *
 * 事故背景：安装脚本把节点跑在 `--data-dir /var/lib/zqagent` 且不设 `DATA_DIR`，
 * 而 link 只会去 `<cwd>/.zqagent_data` 找 server。两者对不上时 link 误判「本机无
 * server」，把凭据写进当前目录 —— 服务读不到，Hub 上永远显示未在线。
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  buildHotCandidates,
  parseServeArgs,
} from "../src/cli/serve-instances.js";
import { DEFAULT_DATA_DIR } from "../src/paths.js";

describe("parseServeArgs", () => {
  it("解析安装脚本生成的 serve 命令行", () => {
    const argv = [
      "/usr/local/bin/zqagent",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "8787",
      "--data-dir",
      "/var/lib/zqagent",
    ];
    expect(parseServeArgs(argv)).toEqual({
      dataDir: "/var/lib/zqagent",
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("支持 --flag=value 形式", () => {
    const argv = ["/usr/bin/zqagent", "serve", "--data-dir=/data/zq", "--port=9000"];
    expect(parseServeArgs(argv)).toEqual({
      dataDir: "/data/zq",
      host: DEFAULT_SERVE_HOST,
      port: 9000,
    });
  });

  it("未给 --host/--port 时用默认监听参数", () => {
    const argv = ["zqagent", "serve", "--data-dir", "/srv/zqagent"];
    expect(parseServeArgs(argv)).toEqual({
      dataDir: "/srv/zqagent",
      host: DEFAULT_SERVE_HOST,
      port: DEFAULT_SERVE_PORT,
    });
  });

  it("监听 0.0.0.0 / :: 时改走回环地址（本机探测才能连上）", () => {
    expect(parseServeArgs(["zqagent", "serve", "--host", "0.0.0.0"])?.host).toBe(
      DEFAULT_SERVE_HOST,
    );
    expect(parseServeArgs(["zqagent", "serve", "--host", "::"])?.host).toBe(DEFAULT_SERVE_HOST);
  });

  it("非 serve 进程（交互式 CLI / 一次性命令）一律忽略", () => {
    expect(parseServeArgs(["zqagent"])).toBeNull();
    expect(parseServeArgs(["zqagent", "link", "--data-dir", "/var/lib/zqagent"])).toBeNull();
    expect(parseServeArgs(["/usr/bin/node", "/app/dist/index.js"])).toBeNull();
    // 参数值恰好叫 serve 不算子命令
    expect(parseServeArgs(["zqagent", "link", "--label", "serve"])).toBeNull();
  });

  it("serve 未带 --data-dir 时返回 null（由调用方回推目录）", () => {
    expect(parseServeArgs(["zqagent", "serve"])?.dataDir).toBeNull();
  });
});

describe("buildHotCandidates", () => {
  const fallback = { host: DEFAULT_SERVE_HOST, port: DEFAULT_SERVE_PORT };

  it("显式 --data-dir：只探测该目录，且沿用用户给的 host/port", () => {
    const out = buildHotCandidates("/var/lib/zqagent", [], { host: "10.0.0.5", port: 9001 });
    expect(out).toEqual([{ dataDir: "/var/lib/zqagent", host: "10.0.0.5", port: 9001 }]);
  });

  it("显式目录优先于反查到的实例", () => {
    const out = buildHotCandidates("/explicit", [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
    ], fallback);
    expect(out).toHaveLength(1);
    expect(out[0].dataDir).toBe("/explicit");
  });

  it("未显式指定：默认目录在前，运行中且目录不同的实例追加在后", () => {
    const out = buildHotCandidates(undefined, [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual([path.resolve(DEFAULT_DATA_DIR), "/var/lib/zqagent"]);
  });

  it("同一数据目录只保留一条（systemd 主进程 + 子进程）", () => {
    const out = buildHotCandidates(undefined, [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
    ], fallback);
    expect(out.filter((c) => c.dataDir === "/var/lib/zqagent")).toHaveLength(1);
  });

  it("反查到的实例带自己的监听端口（服务不在 8787 时也能探测）", () => {
    const out = buildHotCandidates(undefined, [
      { dataDir: "/var/lib/zqagent", host: "127.0.0.1", port: 19001 },
    ], fallback);
    expect(out.find((c) => c.dataDir === "/var/lib/zqagent")?.port).toBe(19001);
  });
});
