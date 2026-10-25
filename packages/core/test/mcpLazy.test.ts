/**
 * MCP 按需加载测试
 *
 * 用真实 stdio echo server（echo + add）验证：
 * 小规模默认全量注入、超阈值切换元工具、检索后渐进加载、
 * mcp_call_tool 转发、maxLoaded 限制与关闭清理。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_CALL_TOOL,
  MCP_SEARCH_TOOL,
  McpManager,
  ToolRegistry,
  type McpServerConfig,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "echo-mcp-server.mjs");

const ECHO_CONFIG: McpServerConfig = {
  name: "echo",
  type: "stdio",
  command: [process.execPath, FIXTURE],
  enabled: true,
};

describe("McpManager 按需加载", () => {
  const originalLazy = process.env.ZQAGENT_MCP_LAZY;

  beforeEach(() => {
    delete process.env.ZQAGENT_MCP_LAZY;
  });

  afterEach(() => {
    if (originalLazy === undefined) delete process.env.ZQAGENT_MCP_LAZY;
    else process.env.ZQAGENT_MCP_LAZY = originalLazy;
  });

  it("小规模默认全量注入（行为与旧版一致）", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, [ECHO_CONFIG]);
    await manager.connectAll();

    expect(manager.isLazyActive()).toBe(false);
    expect(registry.has("mcp__echo__echo")).toBe(true);
    expect(registry.has(MCP_SEARCH_TOOL)).toBe(false);

    await manager.closeAll();
  });

  it("启用懒加载时只暴露元工具，检索后渐进加载", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, [ECHO_CONFIG], {
      lazy: { enabled: true, maxLoaded: 2 },
    });
    await manager.connectAll();

    expect(manager.isLazyActive()).toBe(true);
    expect(manager.indexedToolCount()).toBe(2);
    expect(registry.has("mcp__echo__echo")).toBe(false);
    expect(registry.has(MCP_SEARCH_TOOL)).toBe(true);
    expect(registry.has(MCP_CALL_TOOL)).toBe(true);

    const raw = (await registry.execute(MCP_SEARCH_TOOL, {
      query: "add",
    })) as string;
    const parsed = JSON.parse(raw) as {
      total: number;
      loaded: string[];
      tools: { name: string; loaded: boolean }[];
    };
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    expect(parsed.tools[0]!.name).toBe("mcp__echo__add");
    expect(parsed.loaded).toContain("mcp__echo__add");
    expect(parsed.tools[0]!.loaded).toBe(true);

    // 命中后真实工具已注册，下一轮可直接调用
    expect(registry.has("mcp__echo__add")).toBe(true);
    expect(await registry.execute("mcp__echo__add", { a: 2, b: 3 })).toBe("5");

    // 元工具也能直接转发调用（支持原始工具名）
    const viaMeta = await registry.execute(MCP_CALL_TOOL, {
      name: "mcp__echo__echo",
      arguments: { message: "hi" },
    });
    expect(viaMeta).toBe("echo: hi");

    await manager.closeAll();
    expect(registry.has(MCP_SEARCH_TOOL)).toBe(false);
    expect(registry.has(MCP_CALL_TOOL)).toBe(false);
    expect(registry.has("mcp__echo__add")).toBe(false);
  });

  it("maxLoaded 限制自动加载数量，未加载工具仍可通过元工具调用", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, [ECHO_CONFIG], {
      lazy: { enabled: true, maxLoaded: 1 },
    });
    await manager.connectAll();

    await registry.execute(MCP_SEARCH_TOOL, { limit: 10 });
    expect(manager.allToolKeys()).toHaveLength(1);

    const out = await registry.execute(MCP_CALL_TOOL, {
      name: "echo",
      arguments: { message: "x" },
    });
    expect(out).toBe("echo: x");

    await manager.closeAll();
  });

  it("ZQAGENT_MCP_LAZY=1 可强制启用", async () => {
    process.env.ZQAGENT_MCP_LAZY = "1";
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, [ECHO_CONFIG]);
    await manager.connectAll();

    expect(manager.isLazyActive()).toBe(true);
    expect(registry.has(MCP_SEARCH_TOOL)).toBe(true);

    await manager.closeAll();
  });

  it("未知工具名返回可读错误", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, [ECHO_CONFIG], {
      lazy: { enabled: true },
    });
    await manager.connectAll();

    const out = (await registry.execute(MCP_CALL_TOOL, {
      name: "not-exist",
    })) as { error: string; isError: boolean };
    expect(out.isError).toBe(true);
    expect(out.error).toContain(MCP_SEARCH_TOOL);

    await manager.closeAll();
  });
});
