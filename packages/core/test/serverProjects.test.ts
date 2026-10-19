/**
 * 控制台「多项目」API 集成测试
 *
 * 覆盖管理员密钥语义：
 *   - GET/POST/DELETE /api/v1/projects（仅管理员）
 *   - 管理员凭 X-Project-Id 在任意项目上操作（会话 CRUD）
 *   - 项目密钥访问自身正常、访问他项目 404（租户隔离不变）
 *   - GET /api/v1/node/info（管理员=全部项目；租户=自身）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { createApp } from "../src/server/routes.js";
import type { StreamChunk, ProviderClient } from "../src/index.js";

function textChunk(content: string): StreamChunk {
  return {
    content,
    reasoning: null,
    toolCalls: null,
    usage: null,
    finishReason: "stop",
  };
}

const provider: ProviderClient = {
  async stream() {
    return (async function* () {
      yield textChunk("ok");
    })();
  },
  async chat() {
    return null;
  },
};

async function makeServer(adminKey: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-proj-"));
  const store = new Store(root);
  const manager = new SessionManager(store, 60000, {
    providerFactory: () => provider,
  });
  setupServerHandlers(manager);
  const server = createApp(store, manager, { adminKey });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { root, store, manager, base, close };
}

function req(base: string, key: string, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  return fetch(`${base}${path}`, { ...init, headers });
}

describe("控制台：项目 API", () => {
  it("管理员可创建/列出/删除项目，创建时回传一次 apiKey", async () => {
    const s = await makeServer("admin-key");
    try {
      // 非管理员访问 /projects → 403
      expect((await req(s.base, "tenant-x", "/api/v1/projects")).status).toBe(
        403,
      );

      // 管理员列出：初始为空
      let res = await req(s.base, "admin-key", "/api/v1/projects");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);

      // 创建项目
      res = await req(s.base, "admin-key", "/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "我的项目",
          model: "m1",
          providerApiKey: "sk-x",
        }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        data: {
          id: string;
          name: string;
          model: string;
          apiKey: string;
          hasApiKey: boolean;
        };
      };
      expect(created.data.name).toBe("我的项目");
      expect(created.data.model).toBe("m1");
      expect(created.data.hasApiKey).toBe(true);
      expect(created.data.apiKey).toMatch(/^zk_/);

      // 再列出应包含该项目
      res = await req(s.base, "admin-key", "/api/v1/projects");
      const list = ((await res.json()) as { data: Array<{ id: string }> }).data;
      expect(list.map((p) => p.id)).toContain(created.data.id);

      // 删除项目
      res = await req(
        s.base,
        "admin-key",
        `/api/v1/projects/${created.data.id}`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(200);
      res = await req(s.base, "admin-key", "/api/v1/projects");
      expect(
        ((await res.json()) as { data: Array<{ id: string }> }).data.map(
          (p) => p.id,
        ),
      ).not.toContain(created.data.id);
    } finally {
      await s.close();
    }
  });

  it("管理员凭 X-Project-Id 在项目上创建会话；项目密钥访问他项目 404", async () => {
    const s = await makeServer("adm");
    try {
      const mk = async (name: string) => {
        const res = await req(s.base, "adm", "/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        return ((await res.json()) as { data: { id: string; apiKey: string } })
          .data;
      };
      const p1 = await mk("P1");
      const p2 = await mk("P2");

      // 管理员 + X-Project-Id 创建会话
      const created = await fetch(`${s.base}/api/v1/sessions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer adm",
          "X-Project-Id": p1.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(200);
      const { data: rec } = (await created.json()) as {
        data: { sessionId: string };
      };

      // 管理员缺 X-Project-Id → 400
      expect((await req(s.base, "adm", "/api/v1/sessions")).status).toBe(400);

      // 管理员列出 P1 会话可看到刚建的
      const listed = await fetch(`${s.base}/api/v1/sessions`, {
        headers: { Authorization: "Bearer adm", "X-Project-Id": p1.id },
      });
      expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(
        1,
      );

      // P1 自己的密钥可访问；P2 的密钥访问 → 404
      expect(
        (await req(s.base, p1.apiKey, `/api/v1/sessions/${rec.sessionId}`))
          .status,
      ).toBe(200);
      expect(
        (await req(s.base, p2.apiKey, `/api/v1/sessions/${rec.sessionId}`))
          .status,
      ).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("node/info：管理员看到全部项目，租户只看到自身", async () => {
    const s = await makeServer("adm");
    try {
      const res = await req(s.base, "adm", "/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "A" }),
      });
      const p = ((await res.json()) as { data: { id: string; apiKey: string } })
        .data;

      const adminInfo = await req(s.base, "adm", "/api/v1/node/info");
      const ai = (await adminInfo.json()) as {
        data: { nodeId: string; admin: boolean; projects: unknown[] };
      };
      expect(ai.data.nodeId).toBeTruthy();
      expect(ai.data.admin).toBe(true);
      expect(ai.data.projects).toHaveLength(1);

      const tenantInfo = await req(s.base, p.apiKey, "/api/v1/node/info");
      const ti = (await tenantInfo.json()) as {
        data: { admin: boolean; projects: Array<{ id: string }> };
      };
      expect(ti.data.admin).toBe(false);
      expect(ti.data.projects).toHaveLength(1);
      expect(ti.data.projects[0]!.id).toBe(p.id);
    } finally {
      await s.close();
    }
  });

  it("未配置管理员密钥时 /projects 不可用（403）", async () => {
    const s = await makeServer(null);
    try {
      expect((await req(s.base, "anything", "/api/v1/projects")).status).toBe(
        403,
      );
    } finally {
      await s.close();
    }
  });

  it("CORS 预检放行 X-Project-Id（控制台跨域项目级请求）", async () => {
    const s = await makeServer("adm");
    try {
      const res = await fetch(`${s.base}/api/v1/projects`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8080",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization,x-project-id",
        },
      });
      expect(res.status).toBe(204);
      const allow = (
        res.headers.get("access-control-allow-headers") ?? ""
      ).toLowerCase();
      expect(allow).toContain("x-project-id");
    } finally {
      await s.close();
    }
  });

  it("创建项目未填名称时，默认取工作目录 basename", async () => {
    const s = await makeServer("adm");
    try {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ws-"));
      try {
        const res = await req(s.base, "adm", "/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ workspaceRoot: ws }),
        });
        const p = ((await res.json()) as { data: { name: string } }).data;
        expect(p.name).toBe(path.basename(ws));
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    } finally {
      await s.close();
    }
  });

  it("项目改名：id 不变、名称更新（PUT /config）", async () => {
    const s = await makeServer("adm");
    try {
      const created = (
        (await (
          await req(s.base, "adm", "/api/v1/projects", {
            method: "POST",
            body: JSON.stringify({ name: "旧名" }),
          })
        ).json()) as { data: { id: string } }
      ).data;

      const r = await fetch(`${s.base}/api/v1/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer adm",
          "X-Project-Id": created.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "新名" }),
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { data: { name: string } }).data.name).toBe(
        "新名",
      );

      const list = (
        (await (await req(s.base, "adm", "/api/v1/projects")).json()) as {
          data: Array<{ id: string; name: string }>;
        }
      ).data;
      const found = list.find((p) => p.id === created.id);
      expect(found?.name).toBe("新名");
    } finally {
      await s.close();
    }
  });

  async function mkProject(s: { base: string }, name: string) {
    const res = await req(s.base, "adm", "/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return ((await res.json()) as { data: { id: string } }).data;
  }

  it("多 LLM 供应商：保存 + 激活后同步生效", async () => {
    const s = await makeServer("adm");
    try {
      const p = await mkProject(s, "P");
      const res = await fetch(`${s.base}/api/v1/config`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer adm",
          "X-Project-Id": p.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          providers: [
            {
              id: "a",
              name: "DeepSeek",
              type: "deepseek",
              baseURL: "https://api.deepseek.com",
              model: "deepseek-flash",
              apiKey: "sk-a",
            },
            {
              id: "b",
              name: "OpenAI",
              type: "openai",
              baseURL: "https://api.openai.com/v1",
              model: "gpt-4o",
              apiKey: "sk-b",
            },
          ],
          activeProviderId: "b",
        }),
      });
      expect(res.status).toBe(200);
      const cfg = (await res.json()) as {
        data: {
          model: string;
          baseURL: string;
          activeProviderId: string | null;
          providers: Array<{ id: string; hasApiKey: boolean; apiKey?: string }>;
        };
      };
      expect(cfg.data.providers).toHaveLength(2);
      expect(cfg.data.activeProviderId).toBe("b");
      expect(cfg.data.providers.find((x) => x.id === "b")?.hasApiKey).toBe(
        true,
      );
      expect(
        cfg.data.providers.find((x) => x.id === "b")?.apiKey,
      ).toBeUndefined();
      // 激活项的 model/baseURL 同步到生效配置
      expect(cfg.data.model).toBe("gpt-4o");
      expect(cfg.data.baseURL).toBe("https://api.openai.com/v1");
    } finally {
      await s.close();
    }
  });

  it("工具 / MCP 列表接口返回数组", async () => {
    const s = await makeServer("adm");
    try {
      const p = await mkProject(s, "P");
      const h = { Authorization: "Bearer adm", "X-Project-Id": p.id };
      const t = await fetch(`${s.base}/api/v1/tools`, { headers: h });
      expect(t.status).toBe(200);
      const tools = ((await t.json()) as { data: Array<{ name: string }> })
        .data;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.some((x) => Boolean(x.name))).toBe(true);

      const m = await fetch(`${s.base}/api/v1/mcp`, { headers: h });
      expect(m.status).toBe(200);
      expect(
        Array.isArray(((await m.json()) as { data: unknown[] }).data),
      ).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("初始项目可设置工作目录，设置后不可修改（PUT /config workspaceRoot）", async () => {
    const s = await makeServer("adm");
    try {
      const p = await mkProject(s, "P");
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ws2-"));
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ws3-"));
      try {
        const put = (workspaceRoot: string) =>
          fetch(`${s.base}/api/v1/config`, {
            method: "PUT",
            headers: {
              Authorization: "Bearer adm",
              "X-Project-Id": p.id,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ workspaceRoot }),
          });
        // 首次设置：允许
        const r = await put(ws);
        expect(r.status).toBe(200);
        expect(
          ((await r.json()) as { data: { workspaceRoot: string } }).data
            .workspaceRoot,
        ).toBe(path.resolve(ws));

        // 再次修改：拒绝（已锁定）
        const again = await put(ws2);
        expect(again.status).toBe(409);
        expect(
          ((await again.json()) as { error: { code: string } }).error.code,
        ).toBe("workspace_locked");

        // 同值重复提交：幂等放行
        expect((await put(ws)).status).toBe(200);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(ws2, { recursive: true, force: true });
      }
    } finally {
      await s.close();
    }
  });

  it("项目统计接口返回会话/token 汇总", async () => {
    const s = await makeServer("adm");
    try {
      const p = await mkProject(s, "P");
      const h = {
        Authorization: "Bearer adm",
        "X-Project-Id": p.id,
        "Content-Type": "application/json",
      };
      const created = await fetch(`${s.base}/api/v1/sessions`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(200);

      const r = await fetch(`${s.base}/api/v1/project/stats`, {
        headers: { Authorization: "Bearer adm", "X-Project-Id": p.id },
      });
      expect(r.status).toBe(200);
      const st = (await r.json()) as {
        data: {
          sessionCount: number;
          running: number;
          waiting: number;
          tokensIn: number;
          tokensOut: number;
          sessions: Array<{ sessionId: string }>;
        };
      };
      expect(st.data.sessionCount).toBe(1);
      expect(typeof st.data.running).toBe("number");
      expect(typeof st.data.waiting).toBe("number");
      expect(typeof st.data.tokensIn).toBe("number");
      expect(st.data.sessions[0]!.sessionId).toBeTruthy();
    } finally {
      await s.close();
    }
  });

  it("节点宿主信息接口返回 CPU/内存/网络/版本/会话概览", async () => {
    const s = await makeServer("adm");
    try {
      const r = await req(s.base, "adm", "/api/v1/node/host");
      expect(r.status).toBe(200);
      const h = (
        (await r.json()) as {
          data: {
            hostname: string;
            version: string;
            cpu: { count: number };
            memory: { total: number; free: number };
            network: unknown[];
            sessions: { running: number; waiting: number; items: unknown[] };
          };
        }
      ).data;
      expect(typeof h.hostname).toBe("string");
      expect(typeof h.version).toBe("string");
      expect(h.cpu.count).toBeGreaterThan(0);
      expect(typeof h.memory.total).toBe("number");
      expect(Array.isArray(h.network)).toBe(true);
      expect(typeof h.sessions.running).toBe("number");
      expect(Array.isArray(h.sessions.items)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("会话切换权限模式（PATCH /sessions/:id/mode）", async () => {
    const s = await makeServer("adm");
    try {
      const p = await mkProject(s, "P");
      const h = {
        Authorization: "Bearer adm",
        "X-Project-Id": p.id,
        "Content-Type": "application/json",
      };
      const created = (
        (await (
          await fetch(`${s.base}/api/v1/sessions`, {
            method: "POST",
            headers: h,
            body: "{}",
          })
        ).json()) as {
          data: { sessionId: string };
        }
      ).data;

      const r = await fetch(
        `${s.base}/api/v1/sessions/${created.sessionId}/mode`,
        {
          method: "PATCH",
          headers: h,
          body: JSON.stringify({ mode: "plan" }),
        },
      );
      expect(r.status).toBe(200);

      const st = await fetch(
        `${s.base}/api/v1/sessions/${created.sessionId}/state`,
        {
          headers: { Authorization: "Bearer adm", "X-Project-Id": p.id },
        },
      );
      expect(
        ((await st.json()) as { data: { permissionMode: string } }).data
          .permissionMode,
      ).toBe("plan");

      const bad = await fetch(
        `${s.base}/api/v1/sessions/${created.sessionId}/mode`,
        {
          method: "PATCH",
          headers: h,
          body: JSON.stringify({ mode: "bogus" }),
        },
      );
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
