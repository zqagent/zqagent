/**
 * `zqagent link` 账号方式的参数解析与落盘
 *
 * 覆盖：--username 自动识别邮箱/手机号、环境变量回退、凭据完整性判断，
 * 以及无本机 server 时通过 Hub `/enroll/account` 领取凭据并写 fleet.json。
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { buildAccountAuth, isCompleteAccount, linkNode } from "../src/cli/link.js";

// 隔离运行环境：本机即使有 serve 也不参与测试
vi.mock("../src/cli/serve-instances.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/serve-instances.js")>();
  return { ...actual, discoverRunningServeInstances: () => [] };
});

describe("link 账号参数", () => {
  it("--username 是邮箱时映射为 email 并小写", () => {
    const a = buildAccountAuth({ username: "User@Example.COM", password: "pw" }, {});
    expect(a).toEqual({ email: "user@example.com", phone: undefined, password: "pw", smsCode: undefined });
    expect(isCompleteAccount(a)).toBe(true);
  });

  it("--username 是手机号时映射为 phone", () => {
    const a = buildAccountAuth({ username: "13800000000", password: "pw" }, {});
    expect(a?.phone).toBe("13800000000");
    expect(a?.email).toBeUndefined();
  });

  it("显式 --email/--phone 优先于 --username 的推断", () => {
    const a = buildAccountAuth(
      { username: "13800000000", email: "a@b.com", password: "pw" },
      {},
    );
    expect(a?.email).toBe("a@b.com");
    expect(a?.phone).toBeUndefined();
  });

  it("支持环境变量回退（避免密码留在命令行）", () => {
    const a = buildAccountAuth(
      {},
      {
        ZQAGENT_HUB_USERNAME: "a@b.com",
        ZQAGENT_HUB_PASSWORD: "from-env",
      },
    );
    expect(a).toEqual({
      email: "a@b.com",
      phone: undefined,
      password: "from-env",
      smsCode: undefined,
    });
  });

  it("只有账号、没有密码时仍返回对象，由调用方补问", () => {
    const a = buildAccountAuth({ username: "a@b.com" }, {});
    expect(a?.email).toBe("a@b.com");
    expect(isCompleteAccount(a)).toBe(false);
  });

  it("短信验证码可作为密码的替代", () => {
    const a = buildAccountAuth({ username: "13800000000", smsCode: "123456" }, {});
    expect(isCompleteAccount(a)).toBe(true);
  });

  it("没有账号时返回 null", () => {
    expect(buildAccountAuth({ password: "pw" }, {})).toBeNull();
  });
});

describe("linkNode 账号接入", () => {
  it("调用 /enroll/account 并把凭据写入数据目录", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-link-account-"));
    let received: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/hub/enroll/account") {
          received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              data: {
                fleetToken: "token-1",
                fleetSecret: "secret-1",
                nodeId: received.nodeId,
                gatewayUrl: "wss://gateway.example.com",
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const r = await linkNode({
        hubUrl: base,
        account: { email: "a@b.com", password: "pw" },
        dataDir,
        label: "测试节点",
      });
      expect(r.mode).toBe("saved");
      expect(received).toMatchObject({
        email: "a@b.com",
        password: "pw",
        label: "测试节点",
      });
      expect(typeof received!.nodeId).toBe("string");

      const cred = JSON.parse(
        fs.readFileSync(path.join(dataDir, "fleet.json"), "utf8"),
      ) as { fleetToken: string; hubUrl: string; nodeId: string; label?: string };
      expect(cred.fleetToken).toBe("token-1");
      expect(cred.hubUrl).toBe(base);
      expect(cred.nodeId).toBe(received!.nodeId);
      expect(cred.label).toBe("测试节点");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("未指定 --label 时默认用主机名（Hub 显示机器名而不是 nodeId）", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-link-hostname-"));
    let received: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/hub/enroll/account") {
          received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              data: {
                fleetToken: "token-1",
                fleetSecret: "secret-1",
                nodeId: received.nodeId,
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await linkNode({
        hubUrl: base,
        account: { email: "a@b.com", password: "pw" },
        dataDir,
      });
      expect(received!.label).toBe(os.hostname());

      const cred = JSON.parse(
        fs.readFileSync(path.join(dataDir, "fleet.json"), "utf8"),
      ) as { label?: string };
      expect(cred.label).toBe(os.hostname());
      // 节点上报的 label 取自 node.json，必须与 Hub 记录同源
      const node = JSON.parse(
        fs.readFileSync(path.join(dataDir, "node.json"), "utf8"),
      ) as { label?: string };
      expect(node.label).toBe(os.hostname());
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
