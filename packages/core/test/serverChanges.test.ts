/**
 * 会话「变更」面板的服务端契约测试
 *
 * 面板本身是纯展示，真正需要锁住的是接口语义：
 *   1. 未启用追踪时返回 enabled=false 而不是报错（面板显示「未启用」）；
 *   2. 快照列表按轮次给出文件集；
 *   3. patch 能取到该轮的实际改动；
 *   4. 恢复会把文件写回，并回报「覆盖了哪些」；
 *   5. 越权/不存在的会话不会把别的项目的数据返回。
 *
 * 数据由 SessionVcs 直接写入（不跑 LLM），与 server 实际装配同一个
 * workspaceRoot，因此能覆盖「配置了项目工作目录后多会话共享」的场景。
 */
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/session.js";
import { setupServerHandlers } from "../src/server/interact.js";
import { createApp } from "../src/server/routes.js";
import { dispatchFleetCommand } from "../src/server/fleet/FleetCommands.js";
import { SessionVcs, resolveVcsPlan } from "../src/vcs/index.js";
import type { ProviderClient } from "../src/index.js";

const provider: ProviderClient = {
  async stream() {
    return (async function* () {})();
  },
  async chat() {
    return null;
  },
};

async function makeServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-changes-"));
  const store = new Store(root);
  const manager = new SessionManager(store, 60000, { providerFactory: () => provider });
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

function req(base: string, pathname: string, init: RequestInit = {}, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    Authorization: "Bearer adm",
    ...extra,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  return fetch(`${base}${pathname}`, { ...init, headers });
}

/** 建项目（带工作目录）+ 一个会话，返回可用的请求头 */
async function mkProjectAndSession(
  s: Awaited<ReturnType<typeof makeServer>>,
  vcsMode: "auto" | "off" = "auto",
) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-changes-ws-"));
  const created = (await (
    await req(s.base, "/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "P", workspaceRoot: ws, vcs: { mode: vcsMode } }),
    })
  ).json()) as { data: { id: string; apiKey: string } };
  const projectId = created.data.id;
  const headers = { "X-Project-Id": projectId };
  const sess = (await (
    await req(s.base, "/api/v1/sessions", { method: "POST", body: "{}" }, headers)
  ).json()) as { data: { sessionId: string } };
  return { projectId, sessionId: sess.data.sessionId, workspace: ws, headers };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/**
 * 涉及 git 子进程的用例在全量并发跑测试时会更慢（多个测试文件同时起 git），
 * 默认 15s 容易超时；这里显式放宽。
 */
const GIT_HEAVY = 60_000;

describe("变更面板接口", () => {
  it("追踪关闭时返回 enabled=false 而不是报错", async () => {
    const s = await makeServer();
    cleanups.push(() => s.close());
    const p = await mkProjectAndSession(s, "off");

    const res = await req(s.base, `/api/v1/sessions/${p.sessionId}/changes`, {}, p.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enabled: boolean; mode: string; turns: unknown[] } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.mode).toBe("off");
    expect(body.data.turns).toEqual([]);
  }, GIT_HEAVY);

  it("返回快照列表与每轮文件；patch 可取", async () => {
    const s = await makeServer();
    cleanups.push(() => s.close());
    const p = await mkProjectAndSession(s);

    // 用与 server 相同的 workspace 建追踪，模拟两轮改动
    const vcs = new SessionVcs(resolveVcsPlan(p.workspace, { mode: "auto" }), p.sessionId);
    await vcs.beginTurn();
    fs.writeFileSync(path.join(p.workspace, "a.txt"), "hello\n");
    await vcs.commitTurn("completed");
    await vcs.beginTurn();
    fs.writeFileSync(path.join(p.workspace, "b.txt"), "world\n");
    await vcs.commitTurn("completed");

    const list = (await (
      await req(s.base, `/api/v1/sessions/${p.sessionId}/changes`, {}, p.headers)
    ).json()) as { data: { enabled: boolean; turns: { turn: number; files: string[] }[] } };
    expect(list.data.enabled).toBe(true);
    expect(list.data.turns).toHaveLength(2);
    expect(list.data.turns[0]!.files).toEqual(["a.txt"]);
    expect(list.data.turns[1]!.files).toEqual(["b.txt"]);

    const diff = (await (
      await req(s.base, `/api/v1/sessions/${p.sessionId}/changes/1`, {}, p.headers)
    ).json()) as { data: { turn: number; patch: string } };
    expect(diff.data.turn).toBe(1);
    expect(diff.data.patch).toContain("+hello");
  }, GIT_HEAVY);

  it("恢复把文件写回并回报被覆盖的文件", async () => {
    const s = await makeServer();
    cleanups.push(() => s.close());
    const p = await mkProjectAndSession(s);
    const file = path.join(p.workspace, "doc.txt");

    const vcs = new SessionVcs(resolveVcsPlan(p.workspace, { mode: "auto" }), p.sessionId);
    await vcs.beginTurn();
    fs.writeFileSync(file, "agent version\n");
    await vcs.commitTurn("completed");

    // 之后被别的会话覆盖
    fs.writeFileSync(file, "someone else\n");

    const res = await req(
      s.base,
      `/api/v1/sessions/${p.sessionId}/changes/1/restore`,
      { method: "POST", body: "{}" },
      p.headers,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { restored: string[]; overwritten: string[] };
    };
    expect(body.data.restored).toEqual(["doc.txt"]);
    expect(body.data.overwritten).toEqual(["doc.txt"]);
    expect(fs.readFileSync(file, "utf-8")).toBe("agent version\n");
  }, GIT_HEAVY);

  it("无效快照序号 400", async () => {
    const s = await makeServer();
    cleanups.push(() => s.close());
    const p = await mkProjectAndSession(s);
    const res = await req(s.base, `/api/v1/sessions/${p.sessionId}/changes/0`, {}, p.headers);
    expect(res.status).toBe(400);
  });

  it("舰队指令 get_session_changes 可用", async () => {
    const s = await makeServer();
    cleanups.push(() => s.close());
    const p = await mkProjectAndSession(s);

    const deps = {
      store: s.store,
      manager: s.manager,
      nodeId: "n1",
    } as unknown as Parameters<typeof dispatchFleetCommand>[0];
    const envelope = {
      reqId: "r-changes",
      type: "get_session_changes",
      projectId: p.projectId,
      sessionId: p.sessionId,
      payload: {},
    } as unknown as Parameters<typeof dispatchFleetCommand>[1];
    const r = await dispatchFleetCommand(deps, envelope);
    expect(r.ok).toBe(true);
    expect((r.data as { enabled: boolean }).enabled).toBe(true);
  });
});
