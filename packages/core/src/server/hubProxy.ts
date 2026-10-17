/**
 * Hub 反向代理（本机引擎中转）
 *
 * 桌面端 WebView 直连云端 Hub 会受跨域限制（预检方法/自定义头），
 * 这里让本机引擎（127.0.0.1）作为同机中转：浏览器只访问本机引擎，
 * 由引擎在服务端带病转发到真实 Hub，彻底绕开浏览器 CORS。
 *
 * 约定：`/hub-proxy/<base64url(hubBase)>/<上游路径...>`
 *   hubBase 形如 https://hub.cd-zq.com（不带结尾斜杠）。
 *
 * 安全：
 *   - 默认仅在 `HUB_PROXY` 显式关闭（=0/false）时停用；云端部署（对外 HOST）
 *     应在镜像环境里设 `HUB_PROXY=0`。
 *   - 可选 `HUB_PROXY_ALLOW=host1,host2` 限制允许转发的目标主机。
 *   - 仅允许 http/https 目标。
 */
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "node:stream";

export const HUB_PROXY_PREFIX = "/hub-proxy/";

const ALLOW = (process.env.HUB_PROXY_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function hubProxyEnabled(host?: string): boolean {
  const v = process.env.HUB_PROXY;
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  // 未显式指定：仅在本机回环绑定时默认开启（桌面端），云端（0.0.0.0）默认关闭
  const h = (host ?? "127.0.0.1").trim();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function isHubProxyPath(path: string): boolean {
  return path.startsWith(HUB_PROXY_PREFIX);
}

/** base64url → 目标 Hub 基址（仅 scheme://host，去掉路径/结尾斜杠） */
function decodeTarget(enc: string): string | null {
  try {
    const b64 = enc.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(b64, "base64").toString("utf8").trim();
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (ALLOW.length > 0 && !ALLOW.includes(u.host)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { code, message } }));
}

const FORWARD_REQ_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "x-project-id",
  "last-event-id",
];

const FORWARD_RES_HEADERS = ["content-type", "cache-control"];

export async function handleHubProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rest = url.pathname.slice(HUB_PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  const enc = slash >= 0 ? rest.slice(0, slash) : rest;
  const subPath = slash >= 0 ? rest.slice(slash) : "/";

  const targetBase = decodeTarget(enc);
  if (!targetBase) {
    sendJson(res, 400, "bad_target", "无效或不被允许的 Hub 目标地址");
    return;
  }

  const targetUrl = `${targetBase}${subPath}${url.search}`;

  const headers: Record<string, string> = {
    // SSE 场景禁止压缩，避免中间代理缓冲导致事件延迟
    "accept-encoding": "identity",
  };
  for (const h of FORWARD_REQ_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }

  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length > 0) init.body = Buffer.concat(chunks);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (e) {
    sendJson(
      res,
      502,
      "hub_unreachable",
      e instanceof Error ? e.message : "无法连接 Hub",
    );
    return;
  }

  const outHeaders: Record<string, string> = {};
  for (const h of FORWARD_RES_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  if (res.headersSent) return;
  res.writeHead(upstream.status, outHeaders);
  // 流式响应：立即下发响应头 + 关闭 Nagle，保证 SSE 帧即时到达
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  if (!upstream.body) {
    res.end();
    return;
  }
  // 流式回传（SSE 长连接同样适用）；上游/下游出错时优雅收尾，绝不让进程因未捕获错误退出
  const src = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  src.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  res.on("close", () => src.destroy());
  res.on("error", () => src.destroy());
  src.pipe(res);
}
