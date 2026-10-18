# LLM Connection Errors (`Connection error.`)

[简体中文](../llm-connection-troubleshooting.md) · **English**

## 1. Symptom and meaning

While running a task in the CLI or console you see:

```
正在压缩上下文...
  上下文已压缩

❌ 错误: Connection error.

❌ 任务出错
```

`Connection error.` is the OpenAI SDK's **`APIConnectionError`** — the request never reached or
never completed at the HTTP layer (DNS, TCP, TLS, proxy, timeout, connection reset). It is
**unrelated to the model name, parameters, or context length**. It often appears mid-task (for
example on the request right after compaction), which points to an intermittent link failure
rather than a wrong configuration.

## 2. Automatic retries and real causes

- **Transport-layer retries**: the SDK layer (`OPENAI_MAX_RETRIES`, default 3) plus engine-layer
  network retries (`NETWORK_RETRY_MAX`, default 2, with backoff `NETWORK_RETRY_BASE_MS`, default
  800ms). Seeing `🔁 网络中断（…），第 1/2 次重试…` means a retry already happened and the task
  usually still completes.
- **Error messages carry context** (v0.1.42+):

  ```
  ❌ 错误: Connection error.（code=ECONNRESET · other side closed · 端点 https://api.deepseek.com）
     💡 排查：① 网络是否可达：curl -sI <BaseURL>/models（或 /connect 重测）
     💡 ② 需要代理时：SOCKS5_PROXY=socks5://127.0.0.1:7890（HTTP_PROXY 不支持）
     💡 ③ 企业网关/证书拦截：NODE_EXTRA_CA_CERTS=/path/to/ca.pem
     💡 ④ 连接被重置：多为链路/网关抖动，已自动重试；可调大 NETWORK_RETRY_MAX
     💡 ⑤ IPv6 抖动可试：NODE_OPTIONS=--dns-result-order=ipv4first
  ```

  `code=` is the **root cause**. It is extracted recursively through
  `APIConnectionError → TypeError: fetch failed → underlying syscall error` rather than stopping
  at a meaningless `TypeError`; if there genuinely is no errno in the chain (an unknown failure
  other than pure DNS), no `code=` is printed.

  | code | Meaning | Action |
  | --- | --- | --- |
  | `ENOTFOUND` / `EAI_AGAIN` | DNS resolution failed | Check `/etc/resolv.conf`, internal domains, DNS service |
  | `ECONNREFUSED` | Port closed or refused | Egress firewall policy, port (443), proxy not taking effect |
  | `ETIMEDOUT` | Timeout | Egress restricted, slow link, proxy required |
  | `ECONNRESET` / `socket hang up` | Connection reset | Usually gateway/NAT flapping; retries recover it. Long-lived connections may be cut by middleboxes |
  | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `self signed` | Untrusted certificate chain | Corporate gateways need `NODE_EXTRA_CA_CERTS` |

## 3. Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `SOCKS5_PROXY` | Route through a socks5 proxy (`socks5://host:port`); chat and "refresh models" use the same path | none (direct) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | **Not supported** (Node's built-in fetch ignores them); a warning is printed if detected | — |
| `NODE_EXTRA_CA_CERTS` | Append system/corporate CAs (required when TLS is intercepted) | none |
| `OPENAI_TIMEOUT_MS` | Per-request timeout (ms) | 600000 |
| `OPENAI_MAX_RETRIES` | SDK transport-layer retries | 3 |
| `NETWORK_RETRY_MAX` | Engine-layer network retries (keeps the task alive) | 2 |
| `NETWORK_RETRY_BASE_MS` | Engine-layer retry backoff base (exponential) | 800 |
| `NODE_OPTIONS=--dns-result-order=ipv4first` | Prefer IPv4 when IPv6 is flaky | none |
| `OPENAI_FORCE_API_MODE=chat` | Force Chat Completions (to isolate Responses-path differences) | responses preferred |

Proxy example (local proxies such as Clash or v2ray usually expose a socks5 port):

```bash
export SOCKS5_PROXY=socks5://127.0.0.1:7890
zqagent            # or inject via Environment= in a systemd unit
```

## 4. Domestic Linux distributions (openEuler / Kylin, etc.)

1. **Use the official Node binary** (>= 18.17, 20 LTS recommended), not the old Node from system
   repositories: distribution packages may link against forked OpenSSL/glibc builds whose TLS
   behavior differs from official releases.
   ```bash
   node -v && node -p "process.versions.openssl"
   curl -sI https://api.deepseek.com/models     # compare against the system curl
   ```
2. **CA certificates**: `dnf install -y ca-certificates`; behind a corporate gateway or audit
   appliance, export its root certificate and set
   `export NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/your-ca.pem`.
3. **IPv6 flapping**: check with `sysctl net.ipv6.conf.all.disable_ipv6` whether an unusable IPv6
   stack is enabled; work around it temporarily with `NODE_OPTIONS=--dns-result-order=ipv4first`.
4. **systemd services do not inherit shell environment**: declare
   `Environment=SOCKS5_PROXY=...` or `EnvironmentFile=/etc/zqagent.env`, then `daemon-reload` and restart.
5. **Firewall / security groups**: make sure 443 egress is allowed (if using a proxy, only the
   proxy port needs to be reachable).
6. **Long tasks being cut off**: some gateways reclaim idle long-lived connections. SSE/HTTP
   retries and network retries cover this; if it still happens frequently, lower
   `OPENAI_TIMEOUT_MS` so retries kick in earlier.

## 5. Checklist

```bash
# 1) Can you connect? (same check as /connect; returning models means the link is fine)
curl -sI  "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY"

# 2) Does it work through a proxy?
SOCKS5_PROXY=socks5://127.0.0.1:7890 curl -sI --socks5 127.0.0.1:7890 "$OPENAI_BASE_URL/models"

# 3) DNS / routing
getent hosts api.deepseek.com && traceroute -T -p 443 api.deepseek.com

# 4) Certificate chain
openssl s_client -connect api.deepseek.com:443 -servername api.deepseek.com </dev/null 2>/dev/null | head -5
```

> Tip: the CLI's `/connect` calls the same `/models` check. If `/connect` lists models but chat
> still reports `Connection error.`, suspect a **proxy mismatch** first (historically `/connect`
> used node-fetch while chat used the built-in fetch; since v0.1.42 both use the same path once
> `SOCKS5_PROXY` is configured).
