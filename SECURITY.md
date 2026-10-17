# 安全策略

## 报告漏洞

**请不要用公开 issue 报告安全问题。** ZQAgent 会读写文件、执行命令，安全问题一旦公开，
影响的是所有已部署的节点。

请通过以下任一渠道私下报告：

- 邮件：security@cd-zq.com（如需 PGP 加密，请先来信说明，我们会提供公钥）
- 或通过 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)

请在报告中包含：

- 受影响的版本（`zqagent --version`）与平台
- 复现步骤或最小复现脚本
- 影响范围（能否绕过审批、读到工作区外的文件、执行未授权命令等）

## 响应时限

| 阶段 | 目标 |
| --- | --- |
| 确认收到 | 3 个工作日内 |
| 初步评估与定级 | 7 个工作日内 |
| 修复与披露 | 视严重程度，一般 30 天内 |

修复发布后，我们会在 CHANGELOG 与 GitHub Security Advisory 中致谢报告者（除非你要求匿名）。

## 支持范围

| 版本 | 是否接收安全修复 |
| --- | --- |
| 最新 minor | ✅ |
| 上一个 minor | ✅（仅高危） |
| 更早版本 | ❌ 请先升级 |

## 安全边界（部署前请知悉）

ZQAgent 的设计前提是：**模型输出不可信**。因此：

- 写文件、执行命令、访问网络等有副作用的操作默认需要逐次审批（`interactive` 模式）。
- `auto` 模式会跳过审批，只应在隔离环境或可丢弃的工作区使用。
- API Key 使用 AES-256-GCM 加密保存在本机 `~/.config/zqagent/`，但仍建议为 agent 单独申请一把低权限、可限额的 Key。
- 不要把 `zqagent serve` 直接暴露到公网；对外提供服务请通过反向代理并启用鉴权。
- 工作区即权限边界：以哪个用户、在哪个目录启动，就拥有该用户对该目录的全部权限。

## 不在范围内的报告

- 需要用户主动执行 `auto` 模式或手动放行后才会发生的问题
- 依赖库自身的已知漏洞（请同时反馈给上游，我们会跟进升级）
- 缺少速率限制、缺少 HTTPS 等纯部署配置问题（可提普通 issue）
