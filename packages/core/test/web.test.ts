/**
 * Web 工具（web_search / web_fetch）单元测试
 *
 * web_search 测试通过 mock 全局 fetch 模拟 DDG HTML 搜索结果解析；
 * web_fetch 测试覆盖 SSRF 防护、HTML 剥离、重定向安全检查与截断逻辑。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as dns from "node:dns";
import { ToolRegistry, registerWebTools } from "../src/index.js";

let registry: ToolRegistry;

beforeEach(() => {
  registry = new ToolRegistry();
  registerWebTools(registry);
  // SSRF 检查会对域名做真实 DNS 解析；测试里固定为一个公网 IP，
  // 使用例与运行环境的 DNS 速度/可用性解耦。
  vi.spyOn(dns.promises, "lookup").mockResolvedValue({
    address: "93.184.216.34",
    family: 4,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** 通过注册表执行 async 工具并取回结果 */
async function run(tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return (await registry.execute(tool, args)) as Record<string, any>;
}

/** 构造一个最小可用的 Response 形状 */
function mockResponse(opts: {
  status?: number;
  body?: string;
  url?: string;
  contentType?: string;
  location?: string;
  /** 原始响应字节（优先于 body 的 UTF-8 编码），用于非 UTF-8 解码测试 */
  rawBytes?: Buffer;
}): Response {
  const headers = new Map<string, string>();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.location) headers.set("location", opts.location);
  const status = opts.status ?? 200;
  const bytes = opts.rawBytes ?? Buffer.from(opts.body ?? "", "utf-8");
  return {
    status,
    ok: status >= 200 && status < 300,
    url: opts.url ?? "https://example.com/",
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => opts.body ?? bytes.toString("utf-8"),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe("web_search", () => {
  it("空关键词报错", async () => {
    const result = await run("web_search", { query: "  " });
    expect(result.error).toContain("不能为空");
  });

  it("解析 DDG HTML 搜索结果（result__a + result__snippet）", async () => {
    const html = `
      <a class="result__a" href="https://example.com/page">示例页面</a>
      <a class="result__snippet">这是摘要内容</a>
      <a class="result__a" href="//cdn.example.com/x">相对地址</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html })));

    const result = await run("web_search", { query: "测试" });
    expect(result.provider).toBe("duckduckgo");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: "示例页面",
      url: "https://example.com/page",
      snippet: "这是摘要内容",
    });
    // 协议相对地址补全为 https:
    expect(result.results[1].url).toBe("https://cdn.example.com/x");
  });

  it("解码 DDG /l/ 跳转链接为真实 URL", async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2FAI&amp;rut=abc">维基百科 AI</a>
      <a class="result__snippet">人工智能条目</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html })));

    const result = await run("web_search", { query: "AI" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({
      title: "维基百科 AI",
      url: "https://zh.wikipedia.org/wiki/AI",
      snippet: "人工智能条目",
    });
  });

  it("跳过 DDG 广告链接（y.js 直链与 /l/ 包装均过滤）", async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=foo.com&amp;ad_provider=bingv7aa">广告标题</a>
      <a class="result__snippet">广告摘要</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dbar.com&amp;rut=x">包装广告</a>
      <a class="result__snippet">包装广告摘要</a>
      <a class="result__a" href="https://real-site.example.com/">真实结果</a>
      <a class="result__snippet">真实摘要</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html })));

    const result = await run("web_search", { query: "ad test" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://real-site.example.com/");
  });

  it("解析 DDG HTML 搜索结果（result__title 新版 class）", async () => {
    const html = `
      <a class="result__title" href="https://nodejs.org/">Node.js 官网</a>
      <a class="result__snippet">Node.js 是一个 JavaScript 运行时</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html })));

    const result = await run("web_search", { query: "nodejs" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({
      title: "Node.js 官网",
      url: "https://nodejs.org/",
      snippet: "Node.js 是一个 JavaScript 运行时",
    });
  });

  it("Bing 优先：Bing RSS 成功时直接返回，不再请求 DDG", async () => {
    const bingRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing: test</title>
      <item><title>Bing 结果 &amp; 更多</title><link>https://bing-result.example.com/</link><description>来自 Bing 的摘要</description></item>
    </channel></rss>`;
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: bingRss }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_search", { query: "test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("bing");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({
      title: "Bing 结果 & 更多",
      url: "https://bing-result.example.com/",
      snippet: "来自 Bing 的摘要",
    });
  });

  it("Bing 失败时降级到 DDG（含验证页检测）", async () => {
    const challengeHtml = "<html>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge</html>";
    const ddgHtml = `
      <a class="result__a" href="https://ddg-result.example.com/">DDG 结果</a>
      <a class="result__snippet">来自 DDG 的摘要</a>
    `;
    const fetchMock = vi
      .fn()
      // 第一次调用（Bing RSS）→ 网络失败
      .mockRejectedValueOnce(new Error("fetch failed"))
      // 第二次调用（DDG html 端点）→ 验证页
      .mockResolvedValueOnce(mockResponse({ body: challengeHtml }))
      // 第三次调用（DDG lite 端点）→ 正常结果
      .mockResolvedValueOnce(mockResponse({ body: ddgHtml }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_search", { query: "test" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.provider).toBe("duckduckgo");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({
      title: "DDG 结果",
      url: "https://ddg-result.example.com/",
      snippet: "来自 DDG 的摘要",
    });
  });

  it("max_results 限制返回数量", async () => {
    const results = Array.from({ length: 6 }, (_, i) => {
      const idx = i + 1;
      return `<a class="result__a" href="https://site${idx}.com">标题 ${idx}</a>`;
    }).join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: results })));

    const result = await run("web_search", { query: "test", max_results: 3 });
    expect(result.results).toHaveLength(3);
  });

  it("跳过 DDG 内部链接（//duckduckgo.com）", async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=xxx">内部链接</a>
      <a class="result__a" href="https://example.com">正常页面</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html })));

    const result = await run("web_search", { query: "test" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com");
  });

  it("Bing 网络失败时 fallback 到 DDG 端点", async () => {
    const html = `
      <a class="result__a" href="https://fallback-result.com">Fallback 结果</a>
      <a class="result__snippet">来自备用端点</a>
    `;
    const fetchMock = vi
      .fn()
      // 第一次调用（Bing RSS）→ 网络超时
      .mockRejectedValueOnce(new Error("fetch failed"))
      // 第二次调用（DDG html 端点）→ 成功
      .mockResolvedValueOnce(mockResponse({ body: html }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_search", { query: "test" });
    expect(result.provider).toBe("duckduckgo");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://fallback-result.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("所有引擎失败时返回错误信息", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_search", { query: "test" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // Bing RSS + DDG html + DDG lite
    expect(result.error).toContain("搜索失败");
    expect(result.error).toContain("duckduckgo");
    expect(result.error).toContain("bing");
    expect(result.provider).toBe("none");
  });
});

describe("web_fetch 参数与 SSRF 防护", () => {
  it("非 http/https URL 报错", async () => {
    const result = await run("web_fetch", { url: "file:///etc/passwd" });
    expect(result.error).toContain("http:// 或 https://");
  });

  it("拒绝回环地址（不发起网络请求）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await run("web_fetch", { url: "http://127.0.0.1:8080/" });
    expect(result.error).toContain("回环地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("拒绝 localhost", async () => {
    const result = await run("web_fetch", { url: "https://localhost/" });
    expect(result.error).toContain("回环地址");
  });

  it("拒绝私有网络 10.x", async () => {
    const result = await run("web_fetch", { url: "http://10.0.0.1/" });
    expect(result.error).toContain("私有网络");
  });

  it("拒绝私有网络 192.168.x", async () => {
    const result = await run("web_fetch", { url: "http://192.168.1.1/" });
    expect(result.error).toContain("私有网络");
  });

  it("拒绝 link-local（云元数据端点）", async () => {
    const result = await run("web_fetch", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(result.error).toContain("禁止访问");
  });

  it("合法公网地址可通过安全检查", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: "<html>ok</html>" })));
    const result = await run("web_fetch", { url: "https://example.com/" });
    expect(result.error).toBeUndefined();
  });
});

describe("web_fetch 内容处理", () => {
  it("HTML 剥离为纯文本（移除 script/style，解码实体）", async () => {
    const html = `<html><head><title>t</title></head>
      <script>alert(1)</script>
      <style>body{}</style>
      <p>Hello &amp; welcome</p></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: html, contentType: "text/html" })));

    const result = await run("web_fetch", { url: "https://example.com/" });
    expect(result.text).toContain("Hello & welcome");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("body{}");
  });

  it("非 HTML 内容原样返回", async () => {
    const body = '{"a":1}';
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body, contentType: "application/json" })));
    const result = await run("web_fetch", { url: "https://example.com/data.json" });
    expect(result.text).toBe(body);
  });

  it("超过 max_chars 的内容被截断并标记", async () => {
    const body = "x".repeat(5000);
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body, contentType: "text/plain" })));
    const result = await run("web_fetch", { url: "https://example.com/", max_chars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(100);
  });

  it("按 Content-Type 的 charset 解码（GBK）", async () => {
    // "v=贵州茅台" 的 GBK 字节
    const rawBytes = Buffer.from([
      0x76, 0x3d, 0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({
          rawBytes,
          body: rawBytes.toString("utf-8"), // text() 会乱码，验证走的是 charset 解码
          contentType: "text/plain; charset=GBK",
        }),
      ),
    );
    const result = await run("web_fetch", { url: "https://qt.gtimg.cn/q=sh600519" });
    expect(result.text).toBe("v=贵州茅台");
  });
});

describe("web_fetch 重定向", () => {
  it("重定向目标为内网地址时拒绝", async () => {
    // 第一次返回 302 指向内网；此时不应发起第二次请求
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "http://169.254.169.254/" }))
      .mockResolvedValueOnce(mockResponse({ body: "should not reach" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_fetch", { url: "https://example.com/redirect" });
    expect(result.error).toContain("禁止访问");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("跟随一次安全重定向", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "https://example.org/target", url: "https://example.com/redirect" }))
      .mockResolvedValueOnce(mockResponse({ body: "<p>final</p>", url: "https://example.org/target" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("web_fetch", { url: "https://example.com/redirect" });
    expect(result.url).toBe("https://example.org/target");
    expect(result.text).toContain("final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
