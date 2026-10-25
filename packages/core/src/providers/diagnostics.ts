/**
 * LLM 连接诊断与配置归一化
 *
 * 背景：CLI 在部分环境（如 openEuler 等国产 Linux、经企业网关/代理的网络）会
 * 只看到 `Connection error.`（OpenAI SDK 的 APIConnectionError），无法判断是
 * DNS、TLS、代理还是配置问题。这里提供：
 *   - `cleanLlmValue` / `normalizeBaseURL`：清理 CRLF/引号/BOM、补协议、
 *     去掉 `/chat/completions` 之类的端点后缀（配置从其它系统/编辑器带进来时常见）
 *   - `enrichLlmError`：把「底层 errno（沿 cause 链递归，穿透 SDK 包装）
 *     + 实际请求端点」补进错误信息
 *   - `networkErrorHints`：按错误给出可执行的排查建议（CLI 直接打印）
 */

/** 是否连接/网络类错误（用于自动重试与提示） */
export function isNetworkErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "connection error",
    "fetch failed",
    "econnreset",
    "econnrefused",
    "etimedout",
    "ehostunreach",
    "enetunreach",
    "enotfound",
    "eai_again",
    "socket hang up",
    "und_err",
    "network",
    "timed out",
    "tls",
    "certificate",
    "unable_to_verify",
    "self signed",
  ].some((m) => t.includes(m));
}

/**
 * 清理从配置文件/环境变量/粘贴进来的值：
 * BOM、首尾空白、换行与制表符、以及整体包裹的引号。
 * （Windows 记事本/CRLF、PowerShell `setx`、复制粘贴常见）
 */
export function cleanLlmValue(v?: string | null): string | undefined {
  if (v == null) return undefined;
  let s = String(v).replace(/^\uFEFF/, "");
  s = s.replace(/[\r\n\t]/g, "").trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || undefined;
}

/**
 * 规范化 Base URL：
 *   - 缺协议时补 `https://`
 *   - 去掉末尾 `/`
 *   - 去掉误填的端点后缀（`/chat/completions`、`/responses`、`/completions`、`/models`）
 */
export function normalizeBaseURL(raw?: string | null): string | undefined {
  let s = cleanLlmValue(raw);
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/(chat\/completions|completions|responses|models)$/i, "");
  return s.replace(/\/+$/, "") || undefined;
}

/**
 * 是否为推理模型（o 系列 / gpt-5 等）。
 *
 * 这类模型在 Chat Completions 上**只接受** `max_completion_tokens`，传
 * `max_tokens` 会直接 400 `Unsupported parameter: 'max_tokens' is not
 * supported with this model`。Provider 与模型自检（`probeModel`）必须共用
 * 这一判断：一旦两处各写一份，自检就会把可用的推理模型误判成不可用。
 */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * 展开错误链：`err` 本身 → `cause` → `cause.cause`…
 * 同时展开 `AggregateError.errors`（IPv4/IPv6 双栈都连不上时 undici 会这样抛）。
 * 带已访问集合，防止 cause 循环引用死循环。
 */
function causeChain(err: unknown, maxNodes = 6): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0 && out.length < maxNodes) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const rec = asRecord(cur);
    if (!rec) continue;
    out.push(rec);
    if (rec["cause"]) queue.push(rec["cause"]);
    const errs = rec["errors"];
    if (Array.isArray(errs)) queue.push(...errs);
  }
  return out;
}

/**
 * 形如错误码的 name（`ECONNRESET`、`UND_ERR_CONNECT_TIMEOUT`）。
 * 内建/包装类的 name（`TypeError`、`Error`、`APIConnectionError`）不是错误码，
 * 混进 `code=` 只会误导排查方向。
 */
function isErrorCodeLike(v: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(v);
}

/**
 * 自顶向下穿透包装层，取第一个可用的错误码（如 undici 的 ECONNRESET /
 * UND_ERR_* / ENOTFOUND）。
 *
 * OpenAI SDK 在连接失败时抛出的是
 * `APIConnectionError("Connection error.")` → `cause: TypeError("fetch failed")`
 * → `cause: Error("getaddrinfo ENOTFOUND ...")`，真正的 errno 在最深处。
 * 只看一层只会拿到 `TypeError`，等于没有信息。
 */
export function errorCode(err: unknown): string | undefined {
  for (const src of causeChain(err)) {
    for (const k of ["code", "errno"]) {
      const v = src[k];
      if (typeof v === "string" && v) return v;
    }
    const name = src["name"];
    if (typeof name === "string" && name !== "Error" && isErrorCodeLike(name)) {
      return name;
    }
  }
  return undefined;
}

/** 从 SDK 错误对象里取供应商原始错误体（OpenAI SDK 挂在 `error` 属性上） */
function errorBody(err: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(err)?.["error"]);
}

/** 「端点 + 底层原因」后缀（无可用信息时返回空串） */
export function llmErrorContext(err: unknown, baseURL?: string): string {
  const parts: string[] = [];
  const code = errorCode(err);
  if (code) parts.push(`code=${code}`);
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // 优先取「错误码所在那一层」的 message，保证 code 与文字描述同源；
  // 该层没有 message 时再取链路最深层（如 fetch failed 之下的
  // "getaddrinfo ENOTFOUND ..."），而不是停在 TypeError 的 "fetch failed"。
  const chain = causeChain(err);
  const codeSrc = chain.find(
    (c) => typeof c["code"] === "string" || typeof c["errno"] === "string",
  );
  const pickMsg = (c?: Record<string, unknown>): string | undefined => {
    const m = c?.["message"];
    return typeof m === "string" && m && m !== msg ? m : undefined;
  };
  const causeMsg =
    pickMsg(codeSrc) ??
    [...chain].reverse().map(pickMsg).find((m): m is string => !!m) ??
    "";
  if (causeMsg) parts.push(causeMsg.slice(0, 160));
  // 供应商错误体里的真实原因（经 normalizeErrorFetch 归一化后可读到）：
  // 形状非标准的网关 SDK 只会给出一句 "400 status code (no body)"
  const body = errorBody(err);
  const bodyMsg = typeof body?.["message"] === "string" ? body["message"] : "";
  if (bodyMsg && !msg.includes(bodyMsg)) parts.push(`详情: ${bodyMsg.slice(0, 200)}`);
  const bodyCode = typeof body?.["code"] === "string" ? body["code"] : "";
  if (bodyCode && !parts.some((p) => p.includes(bodyCode))) {
    parts.push(`code=${bodyCode}`);
  }
  const rid =
    (typeof err === "object" && err !== null
      ? String((err as { request_id?: unknown }).request_id ?? "")
      : "") ||
    (typeof body?.["request_id"] === "string" ? body["request_id"] : "");
  if (rid) parts.push(`request_id=${rid}`);
  if (baseURL) parts.push(`端点 ${baseURL}`);
  return parts.length > 0 ? `（${parts.join(" · ")}）` : "";
}

/**
 * 就地把「端点 + 底层原因」补进错误信息（保留原错误对象类型/status，
 * 便于上层继续按类型分支，如 Responses 不支持时降级）。
 */
export function enrichLlmError(err: unknown, baseURL?: string): unknown {
  if (!(err instanceof Error)) return err;
  const ctx = llmErrorContext(err, baseURL);
  if (!ctx) return err;
  if (err.message.includes("端点 ") || err.message.includes(ctx)) return err;
  try {
    err.message = `${err.message}${ctx}`;
  } catch {
    // message 只读时忽略
  }
  return err;
}

/** 连接类错误 → 可执行的排查建议（非连接类返回空数组） */
export function networkErrorHints(message: string, errorType = ""): string[] {
  const text = `${message} ${errorType}`;
  if (!isNetworkErrorText(text)) return [];
  const hints: string[] = [
    "排查：① 网络是否可达：curl -sI <BaseURL>/models（或 /connect 重测）",
    "② 需要代理时：SOCKS5_PROXY=socks5://127.0.0.1:7890（HTTP_PROXY 不支持）",
    "③ 企业网关/证书拦截：NODE_EXTRA_CA_CERTS=/path/to/ca.pem",
  ];
  if (/enotfound|eai_again|getaddrinfo/i.test(text)) {
    hints.push("④ DNS 解析失败：检查 /etc/resolv.conf，或改用 IP/内网域名");
  } else if (/etimedout|econnrefused|unreachable/i.test(text)) {
    hints.push("④ 连接超时/被拒：检查防火墙出网策略与端口（443）");
  } else if (/certificate|unable_to_verify|self signed|tls/i.test(text)) {
    hints.push("④ 证书链问题：为 Node 指定系统 CA（NODE_EXTRA_CA_CERTS）或补齐 ca-certificates");
  } else if (/econnreset|socket hang up/i.test(text)) {
    hints.push("④ 连接被重置：多为链路/网关抖动，已自动重试；可调大 NETWORK_RETRY_MAX");
  }
  hints.push("⑤ IPv6 抖动可试：NODE_OPTIONS=--dns-result-order=ipv4first");
  return hints;
}

/**
 * 「凭据无效」类错误的排查建议（非该类错误返回空数组）。
 *
 * 与 `paramErrorHints` 分开：401 不是模型问题，混进去会让「模型类提示」
 * 在鉴权失败时也冒出来，反而误导。这里只解释「Key 为什么失效、去哪儿换」。
 *
 * 内置模型（志前 API）的 Key 由平台托管：用户在控制台重置 Key 后本机这份
 * 立即失效，必须引导去点「刷新内置模型」，否则会一直看到 401 以为节点坏了。
 */
export function authErrorHints(message: string, code = ""): string[] {
  const text = `${message} ${code}`;
  if (!/401|403|unauthorized|forbidden|invalid[_\s]*api[_\s]*key|api[\s_-]*key\s*(?:无效|invalid)|管理令牌无效/i.test(text)) {
    return [];
  }
  return [
    "凭据无效：若用的是「志前大模型（内置）」，在节点设置的模型页点「刷新内置模型」重新领取 Key" +
      "（在控制台重置过 Key 后需要这一步）；若是自填的供应商，请检查 Key 是否正确或已过期",
  ];
}

/**
 * 「模型/参数不被接受」类错误的排查建议（非该类错误返回空数组）。
 *
 * 典型场景（均为阿里兼容模式实测）：
 *   - 选到非对话/专用通道模型（`cmaas-*`、向量/语音/图像…）
 *     → `InvalidParameter: Required parameter(s) missing or invalid`
 *   - 模型在该账号下没开通
 *     → `invalid_parameter_error: The product is not activated`
 * 这两句原文对排查毫无帮助，必须翻成可执行的下一步。
 */
export function paramErrorHints(message: string, code = ""): string[] {
  const text = `${message} ${code}`;
  const hints: string[] = [];

  // 一、账号/开通类
  if (
    /not[_\s]*(activated|enabled|purchased)|arrearage|quota|subscription|insufficient|未开通|欠费|额度|余额不足/i.test(
      text,
    )
  ) {
    hints.push(
      "该模型在此 **API Key/账号** 下未开通（或账号欠费、额度用尽）：到网关控制台开通该模型，或换一个已开通的模型",
    );
    // 内置模型（志前 API）走的是用户自己的租户额度，额度用完是最常见的失败原因，
    // 必须给出「去哪儿充值」而不是让人对着 402 猜
    hints.push(
      "如果你用的是「志前大模型（内置）」：到 https://hub.cd-zq.com 查看余额并充值；" +
        "也可以先切换到你自己配置的其它模型继续（节点设置 → 模型 → 设为默认）",
    );
  }

  // 二、模型名/参数类
  if (
    /invalid[_\s]*parameter|invalidparameter|required[_\s]+parameter|missing[_\s]+parameter|invalid[_\s]*model|model[_\s]*not[_\s]*found|not[_\s]*support|unsupported/i.test(
      text,
    )
  ) {
    hints.push(
      "多半是**模型名不可用于对话接口**：网关 /models 列的是全量目录，含向量(embedding)、重排(rerank)、语音(asr/tts)、实时(realtime)、图像(image/wan)、专用通道(cmaas-*) 等，这些模型不能当 Agent 后端",
      "换一个对话模型：/connect 重新选择（对话模型已排在列表前面），或 /models 查看",
      "手动验证某个模型能不能用：\n" +
        "     curl -s <BaseURL>/chat/completions -H 'Authorization: Bearer $KEY' -H 'content-type: application/json' \\\n" +
        "       -d '{\"model\":\"<模型名>\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'",
      "若确认模型无误：检查是否多传了该服务不支持的参数（如推理强度 reasoning/effort），可用 /connect 把推理强度设为「默认」",
    );
  }

  return hints;
}

/** LLM 请求超时（毫秒）：OPENAI_TIMEOUT_MS，默认 10 分钟 */
export function llmTimeoutMs(): number {
  const n = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

/**
 * LLM 流空闲超时（毫秒）：OPENAI_STREAM_IDLE_MS，默认 2 分钟。
 *
 * 上面的 `llmTimeoutMs()` 走 SDK 的 timeout，而 SDK 在**响应头返回后**就清掉了
 * 计时器 —— 响应体的流式读取阶段没有任何超时保护。网关静默断供（既不推数据
 * 也不关连接）时，引擎会永久挂在 `for await` 上，会话状态卡在 running。
 * 故对两次 chunk 之间的间隔单独设一道看门狗。
 */
export function llmStreamIdleMs(): number {
  const n = Number(process.env.OPENAI_STREAM_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

// ===================== 错误体归一化（fetch 层） =====================

type FetchLike = (input: any, init?: any) => Promise<any>;

/** 把 Headers 转成普通对象（不同 fetch 实现的 Headers 都能遍历） */
function headerRecord(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  try {
    const iter =
      (h as any).entries?.() ?? ((h as any)[Symbol.iterator]?.() as any);
    if (iter) for (const [k, v] of iter) out[String(k)] = String(v);
  } catch {
    // 不可遍历的 Headers：放弃（新 Response 用默认头）
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 包装 fetch：把**非标准形状的错误响应体**归一化成 OpenAI SDK 认识的结构。
 *
 * SDK 的 `APIError.generate` 只读 `body.error`，而阿里云百炼兼容模式的
 * `/chat/completions` 错误体是顶层 `{code, message, request_id}`（没有
 * `error` 包裹），于是 SDK 抛出的 message 变成
 * `400 status code (no body)` —— 真实原因（InvalidParameter / 模型不可用）
 * 被彻底吞掉，降级判定与排查建议全部失效。这里在读到非 2xx 时补一层
 * `{error:{...}}`，让下游（分类、日志、CLI 提示）拿到原始信息。
 */
export function normalizeErrorFetch(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init);
    if (res?.ok) return res;
    // 204/205/304 不允许带 body（Response 构造会抛），也没有错误信息可读
    if (res?.status === 204 || res?.status === 205 || res?.status === 304) return res;

    let text: string;
    try {
      text = await res.text();
    } catch {
      return res; // 读不动就原样交回（SDK 会按连接错误处理）
    }

    let out = text;
    try {
      const body = JSON.parse(text) as Record<string, unknown> | null;
      const std = body && typeof body === "object" && !("error" in body) &&
        (body.message != null || body.code != null);
      if (std && body) {
        out = JSON.stringify({
          error: {
            message: String(body.message ?? `HTTP ${res.status}`),
            code: body.code ?? null,
            type: body.type ?? "invalid_request_error",
            param: body.param ?? null,
          },
          request_id: body.request_id ?? null,
        });
      }
    } catch {
      // 非 JSON 错误体（网关 HTML 等）：保持原文，让 SDK 至少带上状态码
    }

    return new Response(out, {
      status: res.status,
      statusText: res.statusText,
      headers: headerRecord(res.headers),
    });
  };
}

/** LLM SDK 传输层重试次数：OPENAI_MAX_RETRIES，默认 3 */
export function llmMaxRetries(): number {
  const n = Number(process.env.OPENAI_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}
