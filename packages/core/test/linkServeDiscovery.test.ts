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
  mergeServeInstances,
  parseLaunchdProgramArguments,
  parseServeArgs,
  parseServeCommandLine,
  parseSystemdUnit,
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

describe("parseServeCommandLine", () => {
  it("解析 Windows SEA 进程（引号路径、显式端口）", () => {
    const line =
      '"C:\\Program Files\\zqagent\\zqagent.exe" serve --data-dir "C:\\ProgramData\\zqagent" --port 9000';
    expect(parseServeCommandLine(line)).toEqual({
      dataDir: path.win32.normalize("C:\\ProgramData\\zqagent"),
      host: DEFAULT_SERVE_HOST,
      port: 9000,
    });
  });

  it("解析 Windows node 进程与 --flag=value 形式", () => {
    const line =
      '"C:\\Program Files\\nodejs\\node.exe" C:\\app\\zqagent.js serve --data-dir=C:\\zqagent\\data --host=0.0.0.0 --port=9001';
    expect(parseServeCommandLine(line)).toEqual({
      dataDir: path.win32.normalize("C:\\zqagent\\data"),
      host: DEFAULT_SERVE_HOST,
      port: 9001,
    });
  });

  it("兼容 macOS ps 输出中带空格的路径", () => {
    const line =
      "/usr/local/bin/zqagent serve --data-dir /Library/Application Support/zqagent --port 8787";
    expect(parseServeCommandLine(line)).toEqual({
      dataDir: path.normalize("/Library/Application Support/zqagent"),
      host: DEFAULT_SERVE_HOST,
      port: 8787,
    });
  });

  it("没有绝对 --data-dir 或不是 serve 进程时忽略", () => {
    expect(parseServeCommandLine("zqagent serve")).toBeNull();
    expect(parseServeCommandLine("zqagent serve --data-dir ./relative")).toBeNull();
    expect(parseServeCommandLine("zqagent link --data-dir /var/lib/zqagent")).toBeNull();
    expect(parseServeCommandLine("zqagent.exe --version")).toBeNull();
  });
});

describe("buildHotCandidates", () => {
  const fallback = { host: DEFAULT_SERVE_HOST, port: DEFAULT_SERVE_PORT };

  it("显式 --data-dir：该目录排第一，且沿用用户给的 host/port", () => {
    const out = buildHotCandidates("/var/lib/zqagent", [], { host: "10.0.0.5", port: 9001 });
    expect(out).toEqual([{ dataDir: "/var/lib/zqagent", host: "10.0.0.5", port: 9001 }]);
  });

  it("显式目录优先，运行中的实例作为后备追加", () => {
    // 显式目录可能是错的（macOS 上照抄 Linux 路径、或猜成 ~/.zqagent），
    // 丢掉反查结果会让 link 误判「本机无 server」并把凭据写丢。
    const out = buildHotCandidates("/explicit", [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual(["/explicit", "/var/lib/zqagent"]);
  });

  it("显式目录与反查到的实例相同：不重复", () => {
    const out = buildHotCandidates("/var/lib/zqagent", [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 19001 },
    ], fallback);
    expect(out).toHaveLength(1);
    expect(out[0].dataDir).toBe("/var/lib/zqagent");
  });

  it("未显式指定：运行中的实例在前，默认目录最后兜底", () => {
    // 默认目录只是「当前目录」的猜测；真正的服务应从进程反查得到。
    const out = buildHotCandidates(undefined, [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8787 },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual(["/var/lib/zqagent", path.resolve(DEFAULT_DATA_DIR)]);
  });

  it("托管服务优先于临时实例与默认目录（macOS 热接入打偏事故回归）", () => {
    // 事故现场：家目录残留一个手动 serve（~/.zqagent_data + 8787），
    // 安装脚本起的托管服务在 ~/Library/Application Support/zqagent + 8788。
    // 旧顺序会命中前者，凭据写到托管服务读不到的地方，命令却报成功。
    const managedDir = "/Users/me/Library/Application Support/zqagent";
    const out = buildHotCandidates(undefined, [
      { dataDir: "/Users/me/.zqagent_data", host: DEFAULT_SERVE_HOST, port: 8787 },
      { dataDir: managedDir, host: DEFAULT_SERVE_HOST, port: 8788, managed: true },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual([
      managedDir,
      "/Users/me/.zqagent_data",
      path.resolve(DEFAULT_DATA_DIR),
    ]);
    // 托管服务自己的端口必须保留，否则探测会落到 8787 上
    expect(out[0].port).toBe(8788);
  });

  it("显式 --data-dir 仍然最优先，即使本机有托管服务", () => {
    const out = buildHotCandidates("/explicit", [
      { dataDir: "/var/lib/zqagent", host: DEFAULT_SERVE_HOST, port: 8788, managed: true },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual(["/explicit", "/var/lib/zqagent"]);
  });

  it("多个托管实例按发现顺序排在临时实例之前", () => {
    const out = buildHotCandidates(undefined, [
      { dataDir: "/a", host: DEFAULT_SERVE_HOST, port: 1, managed: true },
      { dataDir: "/b", host: DEFAULT_SERVE_HOST, port: 2, managed: true },
      { dataDir: "/c", host: DEFAULT_SERVE_HOST, port: 3 },
    ], fallback);
    expect(out.map((c) => c.dataDir)).toEqual(["/a", "/b", "/c", path.resolve(DEFAULT_DATA_DIR)]);
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

describe("parseLaunchdProgramArguments", () => {
  it("取出 ProgramArguments 里的字符串参数", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zqagent.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/me/.local/bin/zqagent</string>
    <string>serve</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8788</string>
    <string>--data-dir</string>
    <string>/Users/me/Library/Application Support/zqagent</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`;
    expect(parseLaunchdProgramArguments(xml)).toEqual([
      "/Users/me/.local/bin/zqagent",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "8788",
      "--data-dir",
      "/Users/me/Library/Application Support/zqagent",
    ]);
  });

  it("没有 ProgramArguments 或结构不完整时返回空", () => {
    expect(parseLaunchdProgramArguments("<plist></plist>")).toEqual([]);
    expect(parseLaunchdProgramArguments("<key>ProgramArguments</key>")).toEqual([]);
  });

  it("解码 XML 实体（桌面端写 plist 前会转义路径）", () => {
    const xml = `<key>ProgramArguments</key>
  <array>
    <string>/bin/zqagent</string>
    <string>serve</string>
    <string>--data-dir</string>
    <string>/Users/a&amp;b/Library/Application Support/zqagent</string>
  </array>`;
    expect(parseLaunchdProgramArguments(xml)[3]).toBe("/Users/a&b/Library/Application Support/zqagent");
  });

  it("解析结果可直接交给 parseServeArgs 得到实例参数", () => {
    const xml = `<key>ProgramArguments</key>
  <array>
    <string>/Users/me/.local/bin/zqagent</string>
    <string>serve</string>
    <string>--port</string>
    <string>8788</string>
    <string>--data-dir</string>
    <string>/Users/me/Library/Application Support/zqagent</string>
  </array>`;
    expect(parseServeArgs(parseLaunchdProgramArguments(xml))).toEqual({
      dataDir: "/Users/me/Library/Application Support/zqagent",
      host: DEFAULT_SERVE_HOST,
      port: 8788,
    });
  });
});

describe("parseSystemdUnit", () => {
  it("解析 install.sh / 桌面端写出的 unit", () => {
    const unit = `[Unit]
Description=zqagent node (agent server)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/var/lib/zqagent
ExecStart=/usr/local/bin/zqagent serve --host 127.0.0.1 --port 8787 --data-dir /var/lib/zqagent
Restart=always
Environment=ZQAGENT_SERVICE_MANAGER=systemd

[Install]
WantedBy=multi-user.target
`;
    expect(parseSystemdUnit(unit)).toEqual({
      dataDir: "/var/lib/zqagent",
      host: DEFAULT_SERVE_HOST,
      port: 8787,
      managed: true,
    });
  });

  it("ExecStart 未带 --data-dir 时退回 WorkingDirectory", () => {
    const unit = `[Service]
WorkingDirectory=/home/me/.zqagent_data
ExecStart=/home/me/.local/bin/zqagent serve --port 8788
`;
    expect(parseSystemdUnit(unit)).toEqual({
      dataDir: "/home/me/.zqagent_data",
      host: DEFAULT_SERVE_HOST,
      port: 8788,
      managed: true,
    });
  });

  it("不是 serve 的 unit 或没有数据目录时返回 null", () => {
    expect(parseSystemdUnit("[Service]\nExecStart=/bin/true\n")).toBeNull();
    expect(parseSystemdUnit("[Service]\nExecStart=/usr/bin/zqagent link --code x\n")).toBeNull();
  });
});

describe("mergeServeInstances", () => {
  it("同一目录保留进程侧监听参数，并标记为托管", () => {
    const out = mergeServeInstances(
      [{ dataDir: "/var/lib/zqagent", host: "127.0.0.1", port: 8788 }],
      [{ dataDir: "/var/lib/zqagent", host: "127.0.0.1", port: 8787, managed: true }],
    );
    expect(out).toEqual([
      { dataDir: "/var/lib/zqagent", host: "127.0.0.1", port: 8788, managed: true },
    ]);
  });

  it("plist 登记但 ps 没解析到的实例会被补上", () => {
    const dataDir = "/Users/me/Library/Application Support/zqagent";
    const out = mergeServeInstances([], [
      { dataDir, host: "127.0.0.1", port: 8788, managed: true },
    ]);
    expect(out).toEqual([{ dataDir, host: "127.0.0.1", port: 8788, managed: true }]);
  });

  it("按数据目录去重（systemd 主进程 + 子进程）", () => {
    const out = mergeServeInstances(
      [
        { dataDir: "/a", host: "127.0.0.1", port: 8787 },
        { dataDir: "/a", host: "127.0.0.1", port: 8787 },
      ],
      [{ dataDir: "/a", host: "127.0.0.1", port: 8787, managed: true }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].managed).toBe(true);
  });
});
