/**
 * `zqagent rename`：本机无 server 时的落盘 + Hub 记录同步
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { runRenameCommand } from "../src/cli/rename.js";
import { Store } from "../src/server/store.js";

// 隔离运行环境：本机即使有 serve 也不参与测试
vi.mock("../src/cli/serve-instances.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/serve-instances.js")>();
  return { ...actual, discoverRunningServeInstances: () => [] };
});

describe("rename 命令", () => {
  it("没有 server 时写本地配置，并用 fleetToken 同步 Hub", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-rename-"));
    const store = new Store(dataDir);
    store.saveNodeId("node-1");

    let received: Record<string, unknown> | null = null;
    let auth = "";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/hub/nodes/self/label") {
          auth = String(req.headers.authorization ?? "");
          received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ data: { nodeId: received.nodeId, label: received.label } }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store.saveFleetCredential({
      hubUrl: base,
      fleetToken: "fleet-token-1",
      fleetSecret: "s",
      nodeId: "node-1",
      label: "旧名字",
    });

    try {
      const ok = await runRenameCommand(["新名字", "--data-dir", dataDir]);
      expect(ok).toBe(true);
      expect(received).toMatchObject({ nodeId: "node-1", label: "新名字" });
      expect(auth).toBe("Bearer fleet-token-1");
      expect(store.loadNodeLabel()).toBe("新名字");
      expect(store.loadFleetCredential()?.label).toBe("新名字");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("未接入 Hub 时只写本地，不发请求", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-rename-local-"));
    const store = new Store(dataDir);
    store.saveNodeId("node-2");
    try {
      const ok = await runRenameCommand(["纯本地节点名字", "--data-dir", dataDir]);
      expect(ok).toBe(true);
      expect(store.loadNodeLabel()).toBe("纯本地节点名字");
      expect(store.loadFleetCredential()).toBeNull();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("缺少名称时返回失败并打印用法", async () => {
    expect(await runRenameCommand(["--data-dir", os.tmpdir()])).toBe(false);
  });
});
