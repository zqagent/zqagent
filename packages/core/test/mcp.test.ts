/**
 * McpClient / McpManager 单元测试
 *
 * 通过真实的 stdio MCP 服务器（test/fixtures/echo-mcp-server.mjs，echo + add
 * 两个工具）验证：连接注入、前缀命名、工具调用、刷新、卸载、attach 切换
 * registry、enable/disable 全链路。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpManager,
  McpClient,
  ToolRegistry,
  mcpToolKey,
  sanitizeToolName,
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

describe("工具名工具函数", () => {
  it("sanitizeToolName 替换非法字符并截断", () => {
    expect(sanitizeToolName("hello world/测试")).toBe("hello_world___");
    expect(sanitizeToolName("a".repeat(100), 10)).toHaveLength(10);
    expect(sanitizeToolName("!!!")).toBe("tool"); // 全非法 → 兜底
  });

  it("mcpToolKey 生成 mcp__server__tool 前缀键", () => {
    expect(mcpToolKey("file server", "read file")).toBe(
      "mcp__file_server__read_file",
    );
  });
});

describe("McpClient (stdio echo server)", () => {
  let client: McpClient;

  beforeEach(async () => {
    client = new McpClient(ECHO_CONFIG);
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
  });

  it("连接后拉取工具列表", () => {
    expect(client.connected).toBe(true);
    const tools = client.listTools().map((t) => t.name).sort();
    expect(tools).toEqual(["add", "echo"]);
  });

  it("callTool 返回归一化文本", async () => {
    expect(await client.callTool("echo", { message: "hi" })).toBe("echo: hi");
    expect(await client.callTool("add", { a: 2, b: 3 })).toBe("5");
  });

  it("close 后断开连接", async () => {
    await client.close();
    expect(client.connected).toBe(false);
    expect(client.listTools()).toHaveLength(0);
  });
});

describe("McpManager (stdio echo server)", () => {
  let manager: McpManager;
  let registry: ToolRegistry;

  beforeEach(async () => {
    registry = new ToolRegistry();
    manager = new McpManager(registry, [ECHO_CONFIG]);
    await manager.connectAll();
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it("connectAll 注入 MCP 工具（带前缀）", () => {
    expect(registry.has("mcp__echo__echo")).toBe(true);
    expect(registry.has("mcp__echo__add")).toBe(true);
    expect(registry.names().filter((n) => n.startsWith("mcp__"))).toHaveLength(
      2,
    );
    // source 标记
    expect(registry.get("mcp__echo__echo")?.source).toBe("mcp:echo");
  });

  it("通过 registry.execute 调用 MCP 工具（异步 func）", async () => {
    const result = await registry.execute("mcp__echo__echo", {
      message: "hello",
    });
    expect(result).toBe("echo: hello");
    const sum = await registry.execute("mcp__echo__add", { a: 4, b: 5 });
    expect(sum).toBe("9");
  });

  it("MCP 工具默认归为 mcp 分类 / 需审批（EXTERNAL 风险）", () => {
    const spec = registry.get("mcp__echo__add");
    expect(spec?.metadata.category).toBe("mcp");
    expect(spec?.metadata.requiresApproval).toBe(true);
  });

  it("listConfigs / serverToolKeys / isConnected 查询", () => {
    expect(manager.listConfigs()).toHaveLength(1);
    expect(manager.serverToolKeys("echo").sort()).toEqual([
      "mcp__echo__add",
      "mcp__echo__echo",
    ]);
    expect(manager.isConnected("echo")).toBe(true);
  });

  it("addConfig 同名抛错", async () => {
    await expect(manager.addConfig(ECHO_CONFIG)).rejects.toThrow(/已存在/);
  });

  it("removeConfig 卸载工具并删除配置", async () => {
    expect(await manager.removeConfig("echo")).toBe(true);
    expect(registry.has("mcp__echo__echo")).toBe(false);
    expect(manager.listConfigs()).toHaveLength(0);
    expect(await manager.removeConfig("echo")).toBe(false);
  });

  it("setEnabled(false) 断开并卸载，setEnabled(true) 重连并注入", async () => {
    await manager.setEnabled("echo", false);
    expect(manager.isConnected("echo")).toBe(false);
    expect(registry.has("mcp__echo__echo")).toBe(false);

    await manager.setEnabled("echo", true);
    expect(manager.isConnected("echo")).toBe(true);
    expect(registry.has("mcp__echo__echo")).toBe(true);
  });

  it("refresh 断开重连并重新注入", async () => {
    registry.remove("mcp__echo__echo"); // 人为移除一个
    const result = await manager.refresh("echo");
    expect(result.connected).toEqual(["echo"]);
    expect(registry.has("mcp__echo__echo")).toBe(true);
  });

  it("attach 切换 registry 保持连接", async () => {
    const reg2 = new ToolRegistry();
    manager.attach(reg2);
    // 旧 registry 卸载，新 registry 注入，连接不中断
    expect(registry.has("mcp__echo__echo")).toBe(false);
    expect(reg2.has("mcp__echo__echo")).toBe(true);
    expect(manager.isConnected("echo")).toBe(true);
    // 新 registry 可正常调用
    const result = await reg2.execute("mcp__echo__echo", { message: "x" });
    expect(result).toBe("echo: x");
  });
});
