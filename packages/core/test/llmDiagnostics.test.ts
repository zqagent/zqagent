/**
 * LLM 连接诊断与配置归一化单测
 *
 * 覆盖：配置清理（BOM/CRLF/引号）、Base URL 归一化（补协议/去端点后缀）、
 * 错误富化（端点 + 底层 code、幂等、保留原对象）、排查建议（连接类才有）。
 */
import { describe, it, expect } from "vitest";
import {
  cleanLlmValue,
  enrichLlmError,
  errorCode,
  isNetworkErrorText,
  llmErrorContext,
  llmMaxRetries,
  llmTimeoutMs,
  networkErrorHints,
  normalizeBaseURL,
  normalizeErrorFetch,
  paramErrorHints,
} from "../src/providers/diagnostics.js";

describe("配置归一化", () => {
  it("cleanLlmValue 去掉 BOM / 换行 / 制表 / 包裹引号", () => {
    expect(cleanLlmValue("\uFEFFsk-abc")).toBe("sk-abc");
    expect(cleanLlmValue("sk-abc\r\n")).toBe("sk-abc");
    expect(cleanLlmValue('"sk-abc"')).toBe("sk-abc");
    expect(cleanLlmValue("'sk-abc'")).toBe("sk-abc");
    expect(cleanLlmValue("  sk\tabc \r\n ")).toBe("skabc");
    expect(cleanLlmValue("")).toBeUndefined();
    expect(cleanLlmValue(null)).toBeUndefined();
  });

  it("normalizeBaseURL 补协议、去尾斜杠、去端点后缀", () => {
    expect(normalizeBaseURL("api.deepseek.com")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeBaseURL("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeBaseURL("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeBaseURL('"https://x.com/v1/chat/completions"')).toBe(
      "https://x.com/v1",
    );
    expect(normalizeBaseURL("http://127.0.0.1:8000/v1/responses\r\n")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(normalizeBaseURL("")).toBeUndefined();
  });
});

describe("错误富化", () => {
  const connErr = () => {
    const cause = Object.assign(new Error("other side closed"), {
      code: "ECONNRESET",
    });
    const err = Object.assign(new Error("Connection error."), { cause });
    return err as Error & { cause: Error; status?: number };
  };

  it("补充底层 code 与实际端点", () => {
    const err = connErr();
    expect(errorCode(err)).toBe("ECONNRESET");
    const ctx = llmErrorContext(err, "https://api.deepseek.com");
    expect(ctx).toContain("code=ECONNRESET");
    expect(ctx).toContain("端点 https://api.deepseek.com");
    expect(ctx).toContain("other side closed");
  });

  it("enrichLlmError 就地补充且幂等、保留原对象与 status", () => {
    const err = Object.assign(connErr(), { status: 502 });
    const out = enrichLlmError(err, "https://api.deepseek.com");
    expect(out).toBe(err);
    expect(err.message).toContain("Connection error.");
    expect(err.message).toContain("code=ECONNRESET");
    expect((out as { status?: number }).status).toBe(502);
    const once = err.message;
    enrichLlmError(err, "https://api.deepseek.com");
    expect(err.message).toBe(once); // 不重复追加
  });

  it("无 cause 时也能补端点", () => {
    const err = new Error("fetch failed");
    enrichLlmError(err, "https://x.example");
    expect(err.message).toBe("fetch failed（端点 https://x.example）");
  });

  it("穿透 SDK 包装取到最底层 errno（TypeError 不是错误码）", () => {
    // 与线上一致：APIConnectionError → TypeError("fetch failed") → syscall errno
    const syscall = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.deepseek.com"),
      { code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo" },
    );
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: syscall,
    });
    const err = Object.assign(new Error("Connection error."), {
      cause: fetchFailed,
    });

    expect(errorCode(err)).toBe("ENOTFOUND");
    const ctx = llmErrorContext(err, "https://api.deepseek.com");
    expect(ctx).toContain("code=ENOTFOUND");
    expect(ctx).toContain("getaddrinfo ENOTFOUND api.deepseek.com");
    expect(ctx).not.toContain("TypeError");
  });

  it("只有 TypeError 包装、无底层 errno 时不输出误导性 code", () => {
    const err = Object.assign(new Error("Connection error."), {
      cause: new TypeError("fetch failed"),
    });
    expect(errorCode(err)).toBeUndefined();
    expect(llmErrorContext(err, "https://x.example")).not.toContain("code=");
  });

  it("AggregateError（IPv4/IPv6 双栈都失败）取首个带码的子错误且描述同源", () => {
    const v4 = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
      code: "ECONNREFUSED",
    });
    const v6 = Object.assign(new Error("connect ENETUNREACH [::1]:443"), {
      code: "ENETUNREACH",
    });
    const err = Object.assign(new Error("Connection error."), {
      cause: new AggregateError([v4, v6], "fetch failed"),
    });

    expect(errorCode(err)).toBe("ECONNREFUSED");
    const ctx = llmErrorContext(err, "https://api.deepseek.com");
    expect(ctx).toContain("code=ECONNREFUSED");
    expect(ctx).toContain("connect ECONNREFUSED 1.2.3.4:443");
    expect(ctx).not.toContain("ENETUNREACH");
  });

  it("cause 循环引用不死循环", () => {
    const a = new Error("a");
    const b = Object.assign(new Error("b"), { cause: a, code: "ECONNRESET" });
    (a as Error & { cause?: unknown }).cause = b;
    expect(errorCode(a)).toBe("ECONNRESET");
  });
});

describe("排查建议", () => {
  it("连接类错误给出可执行建议，含重置类专属项", () => {
    const hints = networkErrorHints(
      "Connection error.（code=ECONNRESET）",
      "APIConnectionError",
    );
    expect(hints.length).toBeGreaterThanOrEqual(3);
    expect(hints[0]).toContain("curl");
    expect(hints.some((h) => h.includes("SOCKS5_PROXY"))).toBe(true);
    expect(hints.some((h) => h.includes("NODE_EXTRA_CA_CERTS"))).toBe(true);
    expect(hints.some((h) => h.includes("连接被重置"))).toBe(true);
  });

  it("DNS / 超时 / 证书 各有对应建议", () => {
    expect(
      networkErrorHints("getaddrinfo ENOTFOUND api.x.com").join(),
    ).toContain("DNS");
    expect(networkErrorHints("connect ETIMEDOUT").join()).toContain("防火墙");
    expect(
      networkErrorHints("self signed certificate in certificate chain").join(),
    ).toContain("CA");
  });

  it("业务错误（400/参数）不产生网络建议", () => {
    expect(
      networkErrorHints("400 Bad Request: invalid model", "BadRequestError"),
    ).toEqual([]);
    expect(isNetworkErrorText("400 Bad Request: invalid model")).toBe(false);
    expect(isNetworkErrorText("Connection error.")).toBe(true);
  });
});

describe("超时与重试参数", () => {
  it("默认值合理，且可被环境变量覆盖", () => {
    expect(llmTimeoutMs()).toBe(600_000);
    expect(llmMaxRetries()).toBe(3);
    process.env.OPENAI_TIMEOUT_MS = "5000";
    process.env.OPENAI_MAX_RETRIES = "0";
    try {
      expect(llmTimeoutMs()).toBe(5000);
      expect(llmMaxRetries()).toBe(0);
    } finally {
      delete process.env.OPENAI_TIMEOUT_MS;
      delete process.env.OPENAI_MAX_RETRIES;
    }
  });
});

describe("错误体归一化（normalizeErrorFetch）", () => {
  /** 用给定的响应体/状态构造一个假 fetch，返回归一化后的响应 JSON */
  async function wrap(bodyText: string, status = 400, ct = "application/json") {
    const inner = async () =>
      new Response(bodyText, { status, headers: { "content-type": ct } });
    const res = await normalizeErrorFetch(inner)(
      "https://x/v1/chat/completions",
      {},
    );
    return {
      status: res.status,
      json: () => res.json(),
      text: () => res.text(),
    };
  }

  it("阿里兼容模式的顶层 {code,message,request_id} → 补成 SDK 认得的 {error:{}}", async () => {
    const res = await wrap(
      JSON.stringify({
        code: "InvalidParameter",
        message:
          "Required parameter(s) missing or invalid, please check the request parameters.",
        request_id: "c4fb412e-b457",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.message).toContain("Required parameter(s)");
    expect(body.error.code).toBe("InvalidParameter");
    expect(body.request_id).toBe("c4fb412e-b457");
  });

  it("标准 {error:{...}} 形状原样保留（不二次包裹）", async () => {
    const original = { error: { message: "boom", code: "bad" } };
    const res = await wrap(JSON.stringify(original));
    expect(await res.json()).toEqual(original);
  });

  it("非 JSON 错误体不炸，状态码保留", async () => {
    const res = await wrap("<html>502 Bad Gateway</html>", 502, "text/html");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("502 Bad Gateway");
  });

  it("2xx 响应直接透传（不读 body）", async () => {
    let consumed = false;
    const inner = async () => {
      const r = new Response('{"ok":1}', { status: 200 });
      const origText = r.text.bind(r);
      r.text = async () => {
        consumed = true;
        return origText();
      };
      return r;
    };
    const res = await normalizeErrorFetch(inner)("u", {});
    expect(res.ok).toBe(true);
    expect(consumed).toBe(false);
  });

  it("llmErrorContext 带上错误体里的详情 / code / request_id", () => {
    const err = Object.assign(
      new Error("400 Required parameter(s) missing or invalid"),
      {
        status: 400,
        error: {
          message: "Required parameter(s) missing or invalid",
          code: "InvalidParameter",
        },
        request_id: "req-9",
      },
    );
    const ctx = llmErrorContext(err, "https://gw.example/compatible-mode/v1");
    expect(ctx).toContain("code=InvalidParameter");
    expect(ctx).toContain("request_id=req-9");
    expect(ctx).toContain("端点 https://gw.example/compatible-mode/v1");
  });
});

describe("模型/参数类错误的排查建议（paramErrorHints）", () => {
  it("InvalidParameter → 指出模型名不可用于对话接口并给出验证命令", () => {
    const hints = paramErrorHints(
      "400 Required parameter(s) missing or invalid, please check the request parameters.",
    );
    expect(hints.length).toBeGreaterThanOrEqual(3);
    expect(hints.join()).toContain("模型名");
    expect(hints.join()).toContain("/chat/completions");
    expect(hints.join()).toContain("cmaas-");
  });

  it("带 code 也能命中", () => {
    expect(
      paramErrorHints("400 status code (no body)", "InvalidParameter").length,
    ).toBeGreaterThan(0);
    expect(paramErrorHints("model_not_found", "").length).toBeGreaterThan(0);
  });

  it("网络类/鉴权类错误不产生模型建议", () => {
    expect(paramErrorHints("Connection error.（code=ECONNRESET）")).toEqual([]);
    expect(paramErrorHints("401 Incorrect API key provided")).toEqual([]);
  });
});

describe("paramErrorHints：开通类与模型类分开", () => {
  it("「产品未开通」→ 提示开通模型，而不是笼统的换模型", () => {
    const hints = paramErrorHints(
      "400 The product is not activated, please confirm that you have activated products and try again after activation.",
      "invalid_parameter_error",
    );
    expect(hints.some((h) => h.includes("未开通"))).toBe(true);
  });

  it("鉴权失败不产生这两类建议", () => {
    expect(
      paramErrorHints("401 Incorrect API key provided", "authentication_error"),
    ).toEqual([]);
  });
});
