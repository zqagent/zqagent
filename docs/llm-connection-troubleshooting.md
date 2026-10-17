# LLM 连接错误排查（`Connection error.`）

## 1. 症状与含义

CLI / 控制台执行任务时出现：

```
正在压缩上下文...
  上下文已压缩

❌ 错误: Connection error.

❌ 任务出错
```

`Connection error.` 是 OpenAI SDK 的 **`APIConnectionError`**——请求根本没到/没走完 HTTP
（DNS、TCP、TLS、代理、超时、链路被重置），**与模型名、参数、上下文长度无关**。
它常在中途出现（例如压缩上下文后那一次请求），说明链路是「偶发中断」而不是配置整错。

## 2. 现在会自动重试，并给出真实原因

- **传输层重试**：SDK 层（`OPENAI_MAX_RETRIES`，默认 3）+ 引擎层网络重试
  （`NETWORK_RETRY_MAX`，默认 2，退避 `NETWORK_RETRY_BASE_MS`，默认 800ms）。
  出现 `🔁 网络中断（…），第 1/2 次重试…` 即表示已自动重试，通常任务仍能完成。
- **错误信息带上下文**（v0.1.42+）：

  ```
  ❌ 错误: Connection error.（code=ECONNRESET · other side closed · 端点 https://api.deepseek.com）
     💡 排查：① 网络是否可达：curl -sI <BaseURL>/models（或 /connect 重测）
     💡 ② 需要代理时：SOCKS5_PROXY=socks5://127.0.0.1:7890（HTTP_PROXY 不支持）
     💡 ③ 企业网关/证书拦截：NODE_EXTRA_CA_CERTS=/path/to/ca.pem
     💡 ④ 连接被重置：多为链路/网关抖动，已自动重试；可调大 NETWORK_RETRY_MAX
     💡 ⑤ IPv6 抖动可试：NODE_OPTIONS=--dns-result-order=ipv4first
  ```

  `code=` 是**根因**。它会沿 `APIConnectionError → TypeError: fetch failed →
  底层 syscall 错误` 逐层递归提取，不会停在无意义的 `TypeError` 上；
  若链路里确实没有 errno（例如纯 DNS 之外的未知失败），则不会输出 `code=`。
  | code | 含义 | 处理 |
  | --- | --- | --- |
  | `ENOTFOUND` / `EAI_AGAIN` | DNS 解析失败 | 检查 `/etc/resolv.conf`、内网域名、DNS 服务 |
  | `ECONNREFUSED` | 端口不通/被拒 | 防火墙出网策略、端口（443）、代理未生效 |
  | `ETIMEDOUT` | 超时 | 出网被限、链路慢、需要代理 |
  | `ECONNRESET` / `socket hang up` | 链路被重置 | 网关/NAT 抖动居多，重试即恢复；也可能是长连接被中间设备掐断 |
  | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `self signed` | 证书链不受信 | 企业网关需 `NODE_EXTRA_CA_CERTS` |

## 3. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SOCKS5_PROXY` | 走 socks5 代理（`socks5://host:port`），对话与「刷新模型」同链路 | 无（直连） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | **不支持**（Node 内置 fetch 不读这些变量）；检测到会打印提示 | — |
| `NODE_EXTRA_CA_CERTS` | 追加系统/企业 CA（证书拦截时必填） | 无 |
| `OPENAI_TIMEOUT_MS` | 单次请求超时（ms） | 600000 |
| `OPENAI_MAX_RETRIES` | SDK 传输层重试次数 | 3 |
| `NETWORK_RETRY_MAX` | 引擎层网络重试次数（整轮任务不失败） | 2 |
| `NETWORK_RETRY_BASE_MS` | 引擎层重试退避基数（指数退避） | 800 |
| `NODE_OPTIONS=--dns-result-order=ipv4first` | IPv6 抖动时优先 IPv4 | 无 |
| `OPENAI_FORCE_API_MODE=chat` | 强制 Chat Completions（排查 Responses 路径差异） | responses 优先 |

代理示例（Clash/v2ray 等本地代理通常同时开 socks5 端口）：

```bash
export SOCKS5_PROXY=socks5://127.0.0.1:7890
zqagent            # 或在 systemd unit 里用 Environment= 注入
```

## 4. 国产 Linux（openEuler / 麒麟等）专项

1. **用官方 Node 二进制**（≥18.17，建议 20 LTS），不要用系统仓库的旧 Node：
   系统包可能链接国产化 OpenSSL/glibc 分支，TLS 行为与官方发行版不同。
   ```bash
   node -v && node -p "process.versions.openssl"
   curl -sI https://api.deepseek.com/models     # 对照系统 curl 是否通
   ```
2. **CA 证书**：`dnf install -y ca-certificates`；若经企业网关/审计设备，导出其根证书后
   `export NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/your-ca.pem`。
3. **IPv6 抖动**：`sysctl net.ipv6.conf.all.disable_ipv6` 查看是否启用了不可用的 IPv6；
   临时用 `NODE_OPTIONS=--dns-result-order=ipv4first` 规避。
4. **systemd 服务不继承 shell 环境**：`Environment=SOCKS5_PROXY=...` 或
   `EnvironmentFile=/etc/zqagent.env` 显式声明，`daemon-reload` 后重启。
5. **防火墙/安全组**：确认能出 443（若走代理则只需能到代理端口）。
6. **长时间任务被掐断**：部分网关会回收空闲长连接；已通过 SSE/HTTP 重试与网络重试覆盖，
   如仍频繁出现可降低 `OPENAI_TIMEOUT_MS` 让重试更早介入。

## 5. 自检清单

```bash
# 1) 连得上吗（与 /connect 的检测同源；返回 models 即链路 OK）
curl -sI  "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY"

# 2) 走代理后是否可用
SOCKS5_PROXY=socks5://127.0.0.1:7890 curl -sI --socks5 127.0.0.1:7890 "$OPENAI_BASE_URL/models"

# 3) DNS / 路由
getent hosts api.deepseek.com && traceroute -T -p 443 api.deepseek.com

# 4) 证书链
openssl s_client -connect api.deepseek.com:443 -servername api.deepseek.com </dev/null 2>/dev/null | head -5
```

> 提示：CLI 的 `/connect` 会调用同一个 `/models` 检测。若 `/connect` 能刷出模型但对话仍报
> `Connection error.`，优先怀疑**代理差异**（历史上 /connect 走 node-fetch、对话走内置 fetch，
> v0.1.42 起配置 `SOCKS5_PROXY` 后两者已统一链路）。
