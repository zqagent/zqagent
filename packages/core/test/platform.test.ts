/**
 * 服务托管判定测试
 *
 * 背景：`zqagent update --status/--check/--now` 在交互 shell 里执行时拿不到
 * unit 注入的 ZQAGENT_SERVICE_MANAGER，此前会误判成「未托管」并禁用自动更新。
 * 这里锁定兜底检测（cgroup 归属）的判定规则，尤其是「不能把名字相近的 unit
 * 或裸跑的进程误判为托管」这条安全边界。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  parseLaunchdEnvironment,
  parseServiceEnvironment,
  serviceManager,
  serviceManagerFromCgroup,
  serviceManagerFromLaunchctl,
} from "../src/update/platform.js";

describe("serviceManagerFromCgroup cgroup 归属判定", () => {
  it("cgroup v2 的 /system.slice/<name>.service 判定为 systemd", () => {
    expect(serviceManagerFromCgroup("0::/system.slice/zqagent.service")).toBe(
      "systemd",
    );
  });

  it("cgroup v1 的多行格式同样可识别", () => {
    const cgroup = [
      "12:pids:/system.slice/zqagent.service",
      "1:name=systemd:/system.slice/zqagent.service",
      "0::/system.slice/zqagent.service",
    ].join("\n");
    expect(serviceManagerFromCgroup(cgroup)).toBe("systemd");
  });

  it("unit 位于子路径（如 user slice 之外的嵌套）也能识别", () => {
    expect(
      serviceManagerFromCgroup("0::/system.slice/zqagent.service/sub"),
    ).toBe("systemd");
  });

  it("默认服务名之外可通过参数指定", () => {
    expect(
      serviceManagerFromCgroup("0::/system.slice/node-a.service", "node-a"),
    ).toBe("systemd");
    // 未指定时不应把 node-a 当成默认的 zqagent
    expect(
      serviceManagerFromCgroup("0::/system.slice/node-a.service"),
    ).toBeNull();
  });

  it("名字相近的 unit 不被误判", () => {
    expect(
      serviceManagerFromCgroup("0::/system.slice/my-zqagent.service"),
    ).toBeNull();
    expect(
      serviceManagerFromCgroup("0::/system.slice/zqagent.service.bak"),
    ).toBeNull();
  });

  it("裸跑（在 user slice / 根 cgroup）不判定为托管", () => {
    expect(serviceManagerFromCgroup("0::/user.slice/user-0.slice/session-1.scope")).toBeNull();
    expect(serviceManagerFromCgroup("0::/")).toBeNull();
    expect(serviceManagerFromCgroup("0::/init.scope")).toBeNull();
  });

  it("空内容或格式异常时安全返回 null", () => {
    expect(serviceManagerFromCgroup("")).toBeNull();
    expect(serviceManagerFromCgroup("\n\n")).toBeNull();
    expect(serviceManagerFromCgroup("garbage-without-colon")).toBeNull();
  });
});

describe("parseServiceEnvironment unit 环境变量解析", () => {
  it("解析 systemctl show -p Environment 的输出", () => {
    const raw =
      "NODE_ENV=production PATH=/usr/local/bin:/usr/bin ZQAGENT_UPDATE_CHANNEL=stable " +
      "ZQAGENT_UPDATE_PUBKEY=MCowBQYDK2VwAyEA2yUqjyILwd/qhGN4DK6utonlzE4/QssMC6Uxv1FirVA=";
    const env = parseServiceEnvironment(raw);
    expect(env.NODE_ENV).toBe("production");
    expect(env.ZQAGENT_UPDATE_CHANNEL).toBe("stable");
    // 公钥里的 `/` `+` `=` 必须原样保留
    expect(env.ZQAGENT_UPDATE_PUBKEY).toBe(
      "MCowBQYDK2VwAyEA2yUqjyILwd/qhGN4DK6utonlzE4/QssMC6Uxv1FirVA=",
    );
  });

  it("忽略无等号的片段与空值键", () => {
    const env = parseServiceEnvironment("  A=1  garbage  =nokey  B=2 ");
    expect(env.A).toBe("1");
    expect(env.B).toBe("2");
    expect(env[""]).toBeUndefined();
  });

  it("空输入返回空表", () => {
    expect(parseServiceEnvironment("")).toEqual({});
    expect(parseServiceEnvironment("\n")).toEqual({});
  });
});

describe("serviceManagerFromLaunchctl launchd 归属判定", () => {
  const output = [
    "gui/501/com.zqagent.node = {",
    "\tactive count = 1",
    "\tpath = /Users/me/Library/LaunchAgents/com.zqagent.node.plist",
    "\tstate = running",
    "\tprogram = /usr/local/bin/zqagent",
    "\tpid = 4242",
    "}",
  ].join("\n");

  it("pid 与当前进程一致时判定为 launchd", () => {
    expect(serviceManagerFromLaunchctl(output, 4242, "/opt/other/zqagent")).toBe(
      "launchd",
    );
  });

  it("program 指向当前可执行文件时判定为 launchd（交互 shell 场景）", () => {
    // 模拟在 shell 里执行 update：pid 是 shell 的子进程，与作业 pid 不同
    expect(serviceManagerFromLaunchctl(output, 9999, "/usr/local/bin/zqagent")).toBe(
      "launchd",
    );
  });

  it("pid 与 program 都不匹配时不判定为托管", () => {
    expect(
      serviceManagerFromLaunchctl(output, 9999, "/tmp/scratch/zqagent"),
    ).toBeNull();
  });

  it("作业描述为空或格式异常时安全返回 null", () => {
    expect(serviceManagerFromLaunchctl("", 1, "/usr/local/bin/zqagent")).toBeNull();
    expect(
      serviceManagerFromLaunchctl("garbage", 1, "/usr/local/bin/zqagent"),
    ).toBeNull();
  });

  it("非 SEA 形态下作业存在即算托管（自替换仍由 isSeaRuntime 拦住）", () => {
    const npmJob = output.replace(
      "program = /usr/local/bin/zqagent",
      "program = /opt/node/bin/node",
    );
    expect(
      serviceManagerFromLaunchctl(npmJob, 9999, "/tmp/scratch/zqagent", false),
    ).toBe("launchd");
    // SEA 形态仍要求 program 精确匹配，避免把裸跑的副本误判为托管
    expect(
      serviceManagerFromLaunchctl(npmJob, 9999, "/tmp/scratch/zqagent", true),
    ).toBeNull();
  });
});

describe("parseLaunchdEnvironment plist 环境变量解析", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zqagent.node</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    <key>ZQAGENT_SERVICE_MANAGER</key><string>launchd</string>
    <key>ZQAGENT_UPDATE_CHANNEL</key><string>stable</string>
    <key>ZQAGENT_UPDATE_PUBKEY</key><string>MCowBQYDK2VwAyEA2yUqjyILwd/qhGN4DK6utonlzE4/QssMC6Uxv1FirVA=</string>
    <key>ZQAGENT_AUTO_UPDATE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/zqagent/node.log</string>
</dict>
</plist>`;

  it("取出 EnvironmentVariables 里的键值", () => {
    const env = parseLaunchdEnvironment(plist);
    expect(env.ZQAGENT_SERVICE_MANAGER).toBe("launchd");
    expect(env.ZQAGENT_UPDATE_CHANNEL).toBe("stable");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    // 公钥里的 / + = 必须原样保留
    expect(env.ZQAGENT_UPDATE_PUBKEY).toBe(
      "MCowBQYDK2VwAyEA2yUqjyILwd/qhGN4DK6utonlzE4/QssMC6Uxv1FirVA=",
    );
  });

  it("不把 EnvironmentVariables 之外的键当环境变量", () => {
    const env = parseLaunchdEnvironment(plist);
    // Label / StandardOutPath 在字典之外，不应被收进来
    expect(env.Label).toBeUndefined();
    expect(env.StandardOutPath).toBeUndefined();
  });

  it("没有 EnvironmentVariables 或输入为空时返回空表", () => {
    expect(parseLaunchdEnvironment("<plist></plist>")).toEqual({});
    expect(parseLaunchdEnvironment("")).toEqual({});
  });
});

describe("serviceManager 环境变量优先", () => {
  afterEach(() => {
    delete process.env.ZQAGENT_SERVICE_MANAGER;
  });

  it("显式注入 systemd / launchd 时直接采信", () => {
    process.env.ZQAGENT_SERVICE_MANAGER = "systemd";
    expect(serviceManager()).toBe("systemd");

    process.env.ZQAGENT_SERVICE_MANAGER = "launchd";
    expect(serviceManager()).toBe("launchd");
  });

  it("大小写与空白不影响判定", () => {
    process.env.ZQAGENT_SERVICE_MANAGER = "  SystemD  ";
    expect(serviceManager()).toBe("systemd");
  });

  it("非法值不采信（交由兜底检测）", () => {
    process.env.ZQAGENT_SERVICE_MANAGER = "supervisord";
    // 测试进程通常不在 zqagent.service 的 cgroup 内，兜底应返回 null 而非 "supervisord"
    expect(serviceManager()).not.toBe("supervisord");
  });
});
