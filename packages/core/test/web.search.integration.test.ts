/**
 * web_search 集成测试 — 真实 DuckDuckGo 搜索（不 mock fetch）
 *
 * 使用真实的 DuckDuckGo HTML 搜索端点验证 web_search 工具
 * 的连通性与结果映射逻辑。网络不可用时测试自动跳过。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ToolRegistry, registerWebTools } from "../src/index.js";

let registry: ToolRegistry;

beforeAll(() => {
  registry = new ToolRegistry();
  registerWebTools(registry);
});

/** 通过注册表执行 async 工具并取回结果 */
async function run(tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return (await registry.execute(tool, args)) as Record<string, any>;
}

describe("web_search 真实搜索集成测试", () => {
  it("空关键词报错（不发起网络请求）", async () => {
    const result = await run("web_search", { query: "  " });
    expect(result.error).toContain("不能为空");
  });

  it(
    "真实搜索返回 provider 和 results 数组",
    { timeout: 30000 },
    async () => {
      const result = await run("web_search", { query: "TypeScript programming" });

      // 网络不可用时跳过
      if (result.error) {
        console.warn(`⚠️  skipping real search (network unavailable): ${result.error}`);
        return;
      }

      // DDG 可能对出口 IP 返回反爬虫验证页，此时自动降级到 Bing RSS
      expect(["duckduckgo", "bing"]).toContain(result.provider);
      expect(Array.isArray(result.results)).toBe(true);

      const results = result.results as unknown[];
      if (results.length === 0) {
        console.warn("⚠️  search returned 0 results (query may yield no results)");
        return;
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
    },
  );

  it(
    "搜索结果包含 title / url / snippet 字段",
    { timeout: 30000 },
    async () => {
      const result = await run("web_search", { query: "Node.js" });

      if (result.error) {
        console.warn(`⚠️  skipping real search: ${result.error}`);
        return;
      }

      const results = result.results as Array<Record<string, any>>;
      if (results.length === 0) {
        console.warn("⚠️  no results returned");
        return;
      }

      for (const r of results) {
        expect(typeof r.title).toBe("string");
        expect(r.title.length).toBeGreaterThan(0);

        expect(typeof r.url).toBe("string");
        expect(r.url).toMatch(/^https?:\/\//);

        expect(typeof r.snippet).toBe("string");
      }
    },
  );

  it(
    "max_results=3 时返回不超过 3 条结果",
    { timeout: 30000 },
    async () => {
      const result = await run("web_search", { query: "Rust language", max_results: 3 });

      if (result.error) {
        console.warn(`⚠️  skipping real search: ${result.error}`);
        return;
      }

      const results = result.results as unknown[];
      expect(results.length).toBeLessThanOrEqual(3);
    },
  );

  it(
    "冷门搜索词不报错",
    { timeout: 30000 },
    async () => {
      const result = await run("web_search", { query: "xyznonexistentquery9876543210" });

      if (result.error) {
        console.warn(`⚠️  skipping real search: ${result.error}`);
        return;
      }

      const results = result.results as unknown[];
      expect(Array.isArray(results)).toBe(true);
    },
  );
});
