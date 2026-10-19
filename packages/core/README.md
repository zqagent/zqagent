# @zqagent/core

**在终端、桌面或手机上，让 AI 帮你写代码、改文件、跑命令——有副作用的操作先问你。**

🌐 **官网与使用文档：[agent.cd-zq.com](https://agent.cd-zq.com/)**

[![Website](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-agent.cd--zq.com-4f46e5)](https://agent.cd-zq.com/)
[![CI](https://github.com/zqagent/zqagent/actions/workflows/ci.yml/badge.svg)](https://github.com/zqagent/zqagent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/zqagent/zqagent/blob/main/LICENSE)

ZQAgent 是可自托管的 AI 编码 Agent。它自己读代码、改文件、跑命令，但**每一个有副作用的动作都会先问你**。

![zqagent 演示：读文件 → 弹审批 → 跑测试](https://github.com/zqagent/zqagent/raw/main/docs/assets/demo.gif)

- **自带模型 Key**：DeepSeek、OpenAI 或任意 OpenAI 兼容端点，用多少花多少。
- **审批可控**：讨论 / 计划 / 交互 / 自动四种模式，写文件、执行命令逐次确认。
- **多端可用**：终端 CLI、桌面应用，以及手机或 QQ 远程派任务。
- **可扩展**：接入 MCP 外部工具，或用命令工具、自定义 Agent 扩展能力。

## 安装

需要 **Node.js >= 18.17**。

```bash
npm i -g @zqagent/core
zqagent
```

Linux 也可以零依赖安装（下载单文件可执行程序，无需 Node）：

```bash
curl -fsSL https://agent.cd-zq.com/install.sh | sh
```

首次启动输入 `/connect`，按提示选择 provider（OpenAI / DeepSeek / 通义千问 / 智谱 GLM / Kimi / 自定义）→
填写 API Key → 选择模型 → 设置推理强度。Key 使用 AES-256-GCM 加密保存在本机
`~/.config/zqagent/`，不会上传。

## 快速开始

```text
$ zqagent
[interactive][code] > 读一下这个项目，告诉我它是做什么的

● list_files  .
● read_file   README.md
✓ 这是一个 TypeScript 实现的 AI Agent 引擎……

[interactive][code] > 把 src/config.ts 里的默认端口改成 8788，然后跑测试

● read_file        src/config.ts
⏵ replace_in_file  1 处修改，等待审批
  [Y] 允许一次   [A] 总是允许   [D] 拒绝
> Y
● run_shell        pnpm test
  ✓ 42 passed
✓ 已修改默认端口，测试通过
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `/connect` | 配置模型连接（provider / Key / 模型 / 推理强度） |
| `/plan` | 计划模式：只读探索，输出方案后等待确认 |
| `/interactive` | 交互模式：有副作用的操作逐次审批（默认） |
| `/auto` | 自动模式：全部放行（高风险，建议只在隔离环境使用） |
| `/discuss` | 讨论模式：纯只读对话 |
| `/sessions` | 列出并恢复历史会话 |
| `/agent` | 切换或维护自定义 Agent |
| `/mcp` | 管理 MCP 服务器 |
| `/tools` | 查看全部工具及其风险等级 |

任务执行过程中可以直接输入文字追加指示，无需等它跑完；连按两次 `ESC` 中断。

## 内置能力

| 类别 | 工具 |
| --- | --- |
| 文件 | `read_file` `write_file` `replace_in_file` `list_files` `grep` |
| Shell | `run_shell` `shell_task_output` `shell_task_kill`（持久化 shell，支持后台任务） |
| 网络 | `web_search` `web_fetch` |
| Git | `git_log` `git_status` `git_diff` |
| 补丁 | `apply_patch` `apply_unified_diff` |
| 协作 | `ask_user` `propose_plan` `request_directory` `todo_write` |
| 探索 | `explore`（子代理：跨文件调研，只返回结论） |
| 媒体 | `media`，检测到本机 ffmpeg 时另有 `ffmpeg` `ffprobe` |

共 21 个内置工具。工具可在运行时新增、删除、禁用，下一次模型调用立即生效。

## 作为库使用

```ts
import { TurnEngine, ToolRegistry, PermissionEngine, OpenAIProvider } from "@zqagent/core";
import { ... } from "@zqagent/core/server";   // 多租户 HTTP 服务
import { ... } from "@zqagent/core/tools/fs"; // 单个工具
```

## 安全模型

ZQAgent 的前提是**模型输出不可信**：

- 写文件、执行命令、访问网络默认需要审批。
- API Key 加密存储在本机，仓库与日志中不会出现明文。
- 工作区就是权限边界：以哪个用户、在哪个目录启动，就拥有该用户对该目录的权限。
- 不要把节点服务直接暴露到公网。

发现安全问题请**不要开公开 issue**，按
[SECURITY.md](https://github.com/zqagent/zqagent/blob/main/SECURITY.md) 私下报告。

## 文档

| 主题 | 文档 |
| --- | --- |
| 系统架构 | [docs/architecture.md](https://github.com/zqagent/zqagent/blob/main/docs/architecture.md) |
| 线协议（帧 / 消息 / 签名） | [docs/wire-protocol.md](https://github.com/zqagent/zqagent/blob/main/docs/wire-protocol.md) |
| 上下文压缩 | [docs/context-compaction.md](https://github.com/zqagent/zqagent/blob/main/docs/context-compaction.md) |
| 节点服务 REST API | [docs/server-api.md](https://github.com/zqagent/zqagent/blob/main/docs/server-api.md) |
| 共享库 | [docs/shared.md](https://github.com/zqagent/zqagent/blob/main/docs/shared.md) |
| LLM 连接排查 | [docs/llm-connection-troubleshooting.md](https://github.com/zqagent/zqagent/blob/main/docs/llm-connection-troubleshooting.md) |
| QQ 机器人 | [docs/qq-bot.md](https://github.com/zqagent/zqagent/blob/main/docs/qq-bot.md) |

上述文档同时提供英文版（`docs/en/`）。使用者指南见 <https://agent.cd-zq.com/>。

## 开发

本包是 monorepo 的一部分（与 `@zqagent/shared` 同源构建）：

```bash
pnpm install
pnpm --filter @zqagent/core typecheck
pnpm --filter @zqagent/core test
pnpm --filter @zqagent/core build
pnpm --filter @zqagent/core dev      # 以源码方式启动 CLI
```

贡献前请阅读
[CONTRIBUTING.md](https://github.com/zqagent/zqagent/blob/main/CONTRIBUTING.md)。
涉及权限、审批、命令执行的改动会被重点审查。

## 许可

[Apache-2.0](https://github.com/zqagent/zqagent/blob/main/LICENSE)。
`@zqagent` 与 ZQAgent 名称为本项目商标，二次分发或托管服务请勿暗示官方背书。
