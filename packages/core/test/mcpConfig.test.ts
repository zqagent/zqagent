/**
 * MCP 配置解析测试
 *
 * 覆盖：裸数组 / {servers} / {mcpServers}（Claude/Cursor）等形状，
 * type 推断、command+args 合并、环境变量展开、非法条目告警、内置配置合并。
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_MCP_CONFIGS,
  normalizeMcpConfigs,
  splitCommandLine,
  withBuiltinMcpConfigs,
} from "../src/index.js";

describe("splitCommandLine", () => {
  it("按空白拆分并保留引号内容", () => {
    expect(splitCommandLine('npx -y "my server" --flag')).toEqual([
      "npx",
      "-y",
      "my server",
      "--flag",
    ]);
    expect(splitCommandLine("a\\ b c")).toEqual(["a b", "c"]);
  });
});

describe("normalizeMcpConfigs", () => {
  it("兼容裸数组并推断 stdio/http/sse", () => {
    const { configs, warnings } = normalizeMcpConfigs([
      { name: "a", command: ["npx", "-y", "pkg"] },
      { name: "b", url: "https://example.com/mcp" },
      { name: "c", url: "https://example.com/sse" },
    ]);
    expect(warnings).toEqual([]);
    expect(configs.map((c) => [c.name, c.type])).toEqual([
      ["a", "stdio"],
      ["b", "http"],
      ["c", "sse"],
    ]);
  });

  it("兼容 Claude Desktop 的 mcpServers 对象格式", () => {
    const raw = {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/tmp",
          ],
          env: { TOKEN: 123 },
        },
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer x" },
        },
      },
    };
    const { configs, warnings } = normalizeMcpConfigs(raw, { env: {} });
    expect(warnings).toEqual([]);
    expect(configs).toHaveLength(2);
    const fsCfg = configs.find((c) => c.name === "filesystem")!;
    expect(fsCfg.type).toBe("stdio");
    expect(fsCfg.command).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(fsCfg.env).toEqual({ TOKEN: "123" });
    expect(configs.find((c) => c.name === "remote")?.headers).toEqual({
      Authorization: "Bearer x",
    });
  });

  it("兼容 {servers:[...]} 与单条对象", () => {
    const wrapped = normalizeMcpConfigs({
      servers: [{ name: "x", command: "echo hi" }],
    });
    expect(wrapped.configs[0]!.command).toEqual(["echo", "hi"]);

    const single = normalizeMcpConfigs({ name: "y", builtin: "ocr" });
    expect(single.configs[0]!.type).toBe("builtin");
    expect(single.configs[0]!.builtin).toBe("ocr");
  });

  it("展开 ${VAR} 并对缺失变量告警", () => {
    const { configs, warnings } = normalizeMcpConfigs(
      [{ name: "x", command: ["node", "${SCRIPT}"], env: { TOKEN: "${TOKEN}" } }],
      { env: { SCRIPT: "/tmp/s.js", TOKEN: "abc" } },
    );
    expect(configs[0]!.command).toEqual(["node", "/tmp/s.js"]);
    expect(configs[0]!.env).toEqual({ TOKEN: "abc" });
    expect(warnings).toEqual([]);

    const missing = normalizeMcpConfigs(
      [{ name: "z", command: ["node", "${NOPE}"] }],
      { env: {} },
    );
    expect(missing.warnings.join("\n")).toContain("NOPE");
  });

  it("跳过无效条目并说明原因", () => {
    const { configs, warnings } = normalizeMcpConfigs([
      { name: "no-type" },
      { name: "no-url", type: "http" },
      { type: "stdio", command: ["x"] },
    ]);
    expect(configs).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("同名条目后者覆盖并告警", () => {
    const { configs, warnings } = normalizeMcpConfigs([
      { name: "dup", command: ["a"] },
      { name: "dup", command: ["b"] },
    ]);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.command).toEqual(["b"]);
    expect(warnings.join("\n")).toContain("重复");
  });
});

describe("withBuiltinMcpConfigs", () => {
  it("追加内置 OCR，用户同名配置优先", () => {
    expect(withBuiltinMcpConfigs([])).toEqual([...BUILTIN_MCP_CONFIGS]);

    const disabled = withBuiltinMcpConfigs([
      { name: "ocr", type: "builtin", builtin: "ocr", enabled: false },
    ]);
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.enabled).toBe(false);
  });
});
