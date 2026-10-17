/**
 * 代理出口（LLM 相关 HTTP 请求统一走这里）
 *
 * 支持 `SOCKS5_PROXY`（`socks5://` / `socks5h://`），供 node-fetch 使用：
 *   - `fetchModels()`（/connect 刷新模型）→ node-fetch + agent；未配置时代理为 null。
 *   - OpenAI SDK 的请求默认走 Node 内置 fetch（undici），undici **不读**
 *     HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 环境变量；因此配置了 SOCKS5 代理时，
 *     这里同时提供 `makeSocksFetch()`，把它注入 SDK 的 `fetch` 选项，
 *     保证「对话」与「刷新模型」走同一条网络路径（避免一边通一边不通）。
 */
import nodeFetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

/** SOCKS5 代理地址（环境变量 SOCKS5_PROXY），未设置时为 null */
export function socksProxyUrl(): string | null {
  const raw = (process.env.SOCKS5_PROXY ?? "").trim();
  return raw || null;
}

/** 是否为 socks 代理地址 */
function isSocks(raw: string): boolean {
  return /^socks/i.test(raw);
}

/** 全局共享的 SOCKS5 Agent；未配置或构造失败时为 null（直连） */
let cached: { url: string; agent: SocksProxyAgent | null } | null = null;

export function socksAgent(): SocksProxyAgent | null {
  const url = socksProxyUrl();
  if (!url) return null;
  if (cached?.url === url) return cached.agent;
  let agent: SocksProxyAgent | null = null;
  if (isSocks(url)) {
    try {
      agent = new SocksProxyAgent(url);
    } catch {
      try {
        agent = new SocksProxyAgent(url.replace(/^socks5h:\/\//, "socks5://"));
      } catch {
        agent = null;
      }
    }
  }
  cached = { url, agent };
  return agent;
}

/**
 * 检测到「不支持的环境变量代理」时给出可执行提示（否则返回 null）。
 * undici/内置 fetch 不读这些变量，本项目也不引入 http(s) 代理 agent。
 */
export function unsupportedProxyHint(): string | null {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const hit = keys.filter((k) => {
    const v = (process.env[k] ?? "").trim();
    return v && !isSocks(v);
  });
  if (hit.length === 0) return null;
  return `检测到 ${hit[0]}=${process.env[hit[0]]}（HTTP 代理暂不支持）：请改为 SOCKS5_PROXY=socks5://<host>:<port>（或让本地代理开放 socks5 端口）`;
}

/** 用 node-fetch + socks agent 实现 fetch（保持与全局 fetch 相同的调用签名） */
export function makeSocksFetch(agent: SocksProxyAgent): typeof fetch {
  return ((url: unknown, init?: unknown) =>
    nodeFetch(String(url), { ...(init as object), agent } as never)) as unknown as typeof fetch;
}
