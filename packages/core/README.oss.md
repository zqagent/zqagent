# ZQAgent

**简体中文** · [English](./README.en.md) · [繁體中文](./README.zh-TW.md)

**在终端、桌面或手机上，让 AI 帮你写代码、改文件、跑命令——有副作用的操作先问你。**

🌐 **官网与使用文档：[agent.cd-zq.com](https://agent.cd-zq.com/)**

[![Website](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-agent.cd--zq.com-4f46e5)](https://agent.cd-zq.com/)
[![CI](https://github.com/__OSS_REPO__/actions/workflows/ci.yml/badge.svg)](https://github.com/__OSS_REPO__/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/__OSS_REPO__?style=social)](https://github.com/__OSS_REPO__)
[![npm](https://img.shields.io/npm/v/@zqagent/core?label=npm&color=4f46e5)](https://www.npmjs.com/package/@zqagent/core)

![zqagent 演示：读文件 → 弹审批 → 跑测试](./docs/assets/demo.gif)

ZQAgent 是一个可自托管的 AI 编码 Agent。它自己读代码、改文件、跑命令，但**每一个有副作用的动作都会先问你**。

- **自带模型 Key**：DeepSeek、OpenAI 或任意 OpenAI 兼容端点，用多少花多少，不被订阅制绑定。
- **审批可控**：讨论 / 计划 / 交互 / 自动四种模式，写文件、执行命令逐次确认。
- **多端可用**：终端 CLI、桌面应用，以及手机或 QQ 远程派任务。
- **可扩展**：接入 MCP 外部工具，或用命令工具、自定义 Agent 扩展能力，改完即生效。

> 本仓库是**开源部分**：Agent 引擎、内置工具、权限系统、CLI 与节点服务。
> 云端账号、订阅与计费（Hub）为闭源，但不影响本地完整使用。

---

## 安装

**Linux（零依赖，推荐）**

```bash
curl -fsSL https://agent.cd-zq.com/install.sh | sh
```

脚本下载对应架构的单文件可执行程序、校验 SHA-256，并装进 `PATH`，无需预先安装 Node。

**其它平台 / 用 npm 管理版本**（需要 Node.js >= 18.17）

```bash
npm i -g @zqagent/core
zqagent
```

首次启动输入 `/connect`，按提示选择 provider（DeepSeek / OpenAI / 自定义）→ 填写 API Key →
选择模型 → 设置推理强度。Key 使用 AES-256-GCM 加密保存在本机 `~/.config/zqagent/`，
不会上传到任何服务器。

不想全局安装，也可以直接从源码运行：

```bash
pnpm install
pnpm build
node packages/core/bin/zqagent
```

## 快速开始

```text
$ zqagent
[interactive][code] > 读一下这个项目，告诉我它是做什么的

● list_files  .
● read_file   README.md
● read_file   package.json
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

## 它是怎么工作的

![架构](./docs/assets/architecture.svg)

一次任务由 `TurnEngine` 驱动：模型思考 → 调用工具 → 观察结果 → 进入下一轮，
直到任务完成或达到轮次上限。

所有工具调用都经过 `PermissionEngine`：每个工具声明风险等级（读 / 写 / 执行），
再由当前运行模式决定是直接放行、还是弹出审批。

## 内置工具

| 类别 | 工具 |
| --- | --- |
| 文件 | `read_file` `write_file` `replace_in_file` `list_files` `grep` |
| Shell | `run_shell` `shell_task_output` `shell_task_kill`（持久化 shell，支持后台任务） |
| 网络 | `web_search` `web_fetch` |
| Git | `git_log` `git_status` `git_diff` |
| 补丁 | `apply_patch` `apply_unified_diff` |
| 协作 | `ask_user` `propose_plan` `request_directory` `todo_write` |
| 探索 | `explore`（子代理：跨文件调研，只返回结论） |
| 媒体 | `media` `ffmpeg` `ffprobe`（音视频处理，需本机有 ffmpeg） |

工具可在运行时新增、删除、禁用，下一次模型调用立即生效。

## 安全模型

ZQAgent 的前提是**模型输出不可信**：

- 写文件、执行命令、访问网络默认需要审批。
- API Key 加密存储在本机，仓库与日志中不会出现明文。
- 工作区就是权限边界：以哪个用户、在哪个目录启动，就拥有该用户对该目录的权限。
- 不要把节点服务直接暴露到公网。

发现安全问题请**不要开公开 issue**，按 [SECURITY.md](./SECURITY.md) 私下报告。

## 文档

| 主题 | 文档 |
| --- | --- |
| 架构与事件流 | [docs/architecture.md](./docs/architecture.md) |
| 线协议（帧 / 消息 / 签名） | [docs/wire-protocol.md](./docs/wire-protocol.md) |
| 上下文压缩 | [docs/context-compaction.md](./docs/context-compaction.md) |
| 节点服务 REST API | [docs/server-api.md](./docs/server-api.md) |
| QQ 机器人 | [docs/qq-bot.md](./docs/qq-bot.md) |
| 共享库（协议 / 加密 / 审批 / 通知） | [docs/shared.md](./docs/shared.md) |
| Windows 终端兼容 | [docs/windows-tool-compat.md](./docs/windows-tool-compat.md) |
| 单文件可执行（SEA）排错 | [docs/cli-sea-troubleshooting.md](./docs/cli-sea-troubleshooting.md) |
| LLM 连接错误排查 | [docs/llm-connection-troubleshooting.md](./docs/llm-connection-troubleshooting.md) |

面向使用者的指南（安装、CLI 用法、Agent、MCP）：<https://agent.cd-zq.com/>

架构、线协议、REST API、共享库、上下文压缩与连接排错另有英文版：
[architecture](./docs/en/architecture.md) · [wire-protocol](./docs/en/wire-protocol.md) ·
[server-api](./docs/en/server-api.md) · [shared](./docs/en/shared.md) ·
[context-compaction](./docs/en/context-compaction.md) ·
[llm-connection](./docs/en/llm-connection-troubleshooting.md)

## 交流

用户群（微信群）：扫码加入，提问、报 Bug、提需求都行，不用加好友。
群满会自动切换到新群，同一个码长期有效。

<img src="https://agent.cd-zq.com/wecom-group.png" alt="ZQAgent 用户群二维码" width="200" />

站点上的说明与群规：<https://agent.cd-zq.com/community/>

不想用微信：到 [GitHub Issues](https://github.com/__OSS_REPO__/issues) 提问。

## 开发

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm build         # tsup → dist/
pnpm dev           # 源码方式启动 CLI
```

提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。涉及权限、审批、命令执行的改动会被重点审查。

## 许可

[Apache-2.0](./LICENSE)。`@zqagent` 与 ZQAgent 名称为本项目商标，
二次分发或托管服务请勿暗示官方背书。
