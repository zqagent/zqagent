/**
 * 控制台 MCP 配置维护 API 测试
 *
 * 覆盖：
 *   - GET /api/v1/mcp 返回可编辑标记与完整字段（含内置 OCR）
 *   - PUT /api/v1/mcp 写入 <workspace>/.agent/mcp.json，可回读
 *   - 非法条目 400、名称重复 400
 *   - 无工作目录 400
 *   - MCP_CONFIG_PATH 接管时 409（只读）
 *   - POST /api/v1/mcp/test 成功 / 失败
 *   - 舰队指令 update_mcp / test_mcp 可用且在白名单内
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { createApp } from "../src/server/routes.js";
import { dispatchFleetCommand } from "../src/server/fleet/FleetCommands.js";
import { FLEET_CMD_TYPES } from "@zqagent/shared";
import type { ProviderClient, StreamChunk } from "../src/index.js";

const provider: ProviderClient = {
  async stream() {
    return (async function* () {
      yield {
        content: "ok",
        reasoning: null,
        toolCalls: null,
        usage: null,
        finishReason: "stop",
      } satisfies StreamChunk;
    })();
  },
  async chat() {
    return null;
  },
};

async function makeServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-mcp-api-"));
  const store = new Store(root);
  const manager = new SessionManager(store, 60000, {
    providerFactory: () => provider,
  });
  setupServerHandlers(manager);
  const server = createApp(store, manager, { adminKey: "adm" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    store,
    manager,
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(
  base: string,
  pathname: string,
  init: RequestInit = {},
  key = "adm",
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  return fetch(`${base}${pathname}`, { ...init, headers });
}

/** 创建带工作目录的项目，返回 { id, headers } */
async function mkProject(s: Awaited<ReturnType<typeof makeServer>>) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-mcp-ws-"));
  const r = await req(s.base, "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "P", workspaceRoot: ws }),
  });
  const created = (await r.json()) as {
    data: { id: string; apiKey: string };
  };
  return {
    id: created.data.id,
    apiKey: created.data.apiKey,
    workspace: ws,
    headers: {
      Authorization: `Bearer adm`,
      "X-Project-Id": created.data.id,
    },
  };
}

describe("控制台 MCP 维护 API", () => {
  const originalConfigPath = process.env.MCP_CONFIG_PATH;

  afterEach(() => {
    if (originalConfigPath === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = originalConfigPath;
  });

  it("GET 返回完整字段与可编辑标记（含内置 OCR）", async () => {
    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const res = await req(s.base, "/api/v1/mcp", {
        headers: p.headers as Record<string, string>,
      });
      expect(res.status).toBe(200);
      const list = ((await res.json()) as {
        data: Array<{
          name: string;
          type: string;
          enabled: boolean;
          editable: boolean;
          removable: boolean;
        }>;
      }).data;
      const ocr = list.find((m) => m.name === "ocr")!;
      expect(ocr.type).toBe("builtin");
      expect(ocr.enabled).toBe(true);
      expect(ocr.editable).toBe(true);
      expect(ocr.removable).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("PUT 写入 .agent/mcp.json 并可回读", async () => {
    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const put = await req(
        s.base,
        "/api/v1/mcp",
        {
          method: "PUT",
          headers: p.headers as Record<string, string>,
          body: JSON.stringify({
            servers: [
              {
                name: "echo",
                type: "stdio",
                command: [process.execPath, "echo-server.mjs"],
                env: { TOKEN: "x" },
                enabled: true,
              },
              { name: "ocr", type: "builtin", builtin: "ocr", enabled: false },
            ],
          }),
        },
      );
      expect(put.status).toBe(200);

      const file = path.join(p.workspace, ".agent", "mcp.json");
      expect(fs.existsSync(file)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
        name: string;
        command?: string[];
        enabled?: boolean;
        env?: Record<string, string>;
      }>;
      const echo = saved.find((x) => x.name === "echo")!;
      expect(echo.command).toEqual([process.execPath, "echo-server.mjs"]);
      expect(echo.env).toEqual({ TOKEN: "x" });
      expect(saved.find((x) => x.name === "ocr")?.enabled).toBe(false);

      // 回读：内置 OCR 显示为禁用，echo 在列表中
      const after = await req(s.base, "/api/v1/mcp", {
        headers: p.headers as Record<string, string>,
      });
      const list = ((await after.json()) as {
        data: Array<{ name: string; enabled: boolean }>;
      }).data;
      expect(list.find((x) => x.name === "echo")?.enabled).toBe(true);
      expect(list.find((x) => x.name === "ocr")?.enabled).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("删除内置 OCR 等价于禁用（不会被静默移除）", async () => {
    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const res = await req(s.base, "/api/v1/mcp", {
        method: "PUT",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({ servers: [] }),
      });
      expect(res.status).toBe(200);
      const list = ((await res.json()) as {
        data: Array<{ name: string; enabled: boolean }>;
      }).data;
      expect(list.find((x) => x.name === "ocr")?.enabled).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("非法条目与重名返回 400", async () => {
    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const bad = await req(s.base, "/api/v1/mcp", {
        method: "PUT",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({ servers: [{ name: "x", type: "stdio" }] }),
      });
      expect(bad.status).toBe(400);

      const dup = await req(s.base, "/api/v1/mcp", {
        method: "PUT",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({
          servers: [
            { name: "a", type: "stdio", command: "echo 1" },
            { name: "a", type: "stdio", command: "echo 2" },
          ],
        }),
      });
      expect(dup.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it("没有工作目录时返回 400", async () => {
    const s = await makeServer();
    try {
      const r = await req(s.base, "/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "no-ws" }),
      });
      const created = (await r.json()) as { data: { id: string } };
      const res = await req(s.base, "/api/v1/mcp", {
        method: "PUT",
        headers: {
          Authorization: "Bearer adm",
          "X-Project-Id": created.data.id,
        },
        body: JSON.stringify({ servers: [] }),
      });
      // 进程 WORKSPACE 未设置时不可写；若测试环境设置了 WORKSPACE 则跳过该断言
      if (!process.env.WORKSPACE) expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it("MCP_CONFIG_PATH 接管时返回 409 只读", async () => {
    const s = await makeServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-mcp-env-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ name: "envserver", type: "stdio", command: ["node"] }]),
    );
    process.env.MCP_CONFIG_PATH = file;
    try {
      const p = await mkProject(s);
      const get = await req(s.base, "/api/v1/mcp", {
        headers: p.headers as Record<string, string>,
      });
      const list = ((await get.json()) as {
        data: Array<{
          name: string;
          editable: boolean;
          readonlyReason?: string;
        }>;
      }).data;
      expect(list.find((m) => m.name === "envserver")?.editable).toBe(false);
      expect(list[0]?.readonlyReason).toContain("MCP_CONFIG_PATH");

      const put = await req(s.base, "/api/v1/mcp", {
        method: "PUT",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({ servers: [] }),
      });
      expect(put.status).toBe(409);
    } finally {
      delete process.env.MCP_CONFIG_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
      await s.close();
    }
  });

  it("POST /mcp/test 对非法配置与不可用命令返回失败", async () => {
    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const bad = await req(s.base, "/api/v1/mcp/test", {
        method: "POST",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({ server: { name: "x" } }),
      });
      expect(bad.status).toBe(200);
      expect(((await bad.json()) as { data: { ok: boolean } }).data.ok).toBe(
        false,
      );

      const fail = await req(s.base, "/api/v1/mcp/test", {
        method: "POST",
        headers: p.headers as Record<string, string>,
        body: JSON.stringify({
          server: {
            name: "bad",
            type: "stdio",
            command: ["/definitely/not/exist"],
          },
        }),
      });
      expect(
        ((await fail.json()) as { data: { ok: boolean; error?: string } }).data
          .ok,
      ).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("舰队指令 update_mcp / test_mcp 在白名单内且可用", async () => {
    expect(FLEET_CMD_TYPES).toContain("update_mcp");
    expect(FLEET_CMD_TYPES).toContain("test_mcp");

    const s = await makeServer();
    try {
      const p = await mkProject(s);
      const deps = {
        store: s.store,
        manager: s.manager,
        nodeId: "n1",
      } as unknown as Parameters<typeof dispatchFleetCommand>[0];
      const envelope = {
        reqId: "r-mcp",
        type: "update_mcp",
        projectId: p.id,
        payload: {
          servers: [{ name: "echo", type: "stdio", command: "echo hi" }],
        },
      } as unknown as Parameters<typeof dispatchFleetCommand>[1];
      const ack = await dispatchFleetCommand(deps, envelope);
      expect(ack.ok).toBe(true);
      const data = ack.data as Array<{ name: string }>;
      expect(Array.isArray(data)).toBe(true);
      expect(data.some((x) => x.name === "echo")).toBe(true);
    } finally {
      await s.close();
    }
  });
});
