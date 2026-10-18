# ZQAgent

**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

**Your AI assistant in the terminal, on the desktop, or on your phone — write code, edit files, run commands. Anything with side effects asks you first.**

🌐 **Website and docs: [agent.cd-zq.com](https://agent.cd-zq.com/en/)**

[![Website](https://img.shields.io/badge/website-agent.cd--zq.com-4f46e5)](https://agent.cd-zq.com/en/)
[![CI](https://github.com/zqagent/zqagent/actions/workflows/ci.yml/badge.svg)](https://github.com/zqagent/zqagent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/zqagent/zqagent?style=social)](https://github.com/zqagent/zqagent)
[![npm](https://img.shields.io/npm/v/@zqagent/core?label=npm&color=4f46e5)](https://www.npmjs.com/package/@zqagent/core)

![zqagent CLI](./docs/assets/cli-help.svg)

ZQAgent is a self-hostable AI coding agent. It reads code, edits files, and runs commands on its own — but **every side-effecting action asks for your approval first**.

- **Bring your own model key** — DeepSeek, OpenAI, or any OpenAI-compatible endpoint. Pay for what you use instead of a subscription.
- **Approval by default** — four modes (discuss / plan / interactive / auto); file writes and shell commands are confirmed one by one.
- **Works everywhere** — terminal CLI, desktop app, and remote task dispatch from your phone or QQ.
- **Extensible** — plug in MCP servers, or add command tools and custom agents; changes take effect immediately.

> This repository is the **open-source part**: the agent engine, built-in tools, permission system, CLI, and node service.
> Cloud accounts, subscriptions, and billing (Hub) are closed source, and are not required for local use.

---

## Install

**Linux (no dependencies, recommended)**

```bash
curl -fsSL https://agent.cd-zq.com/install.sh | sh
```

The script downloads a single-file executable for your architecture, verifies its SHA-256, and puts it on your `PATH`. No Node.js required.

**Other platforms / npm** (requires Node.js >= 18.17)

```bash
npm i -g @zqagent/core
zqagent
```

On first launch, run `/connect` and follow the prompts: pick a provider (OpenAI / DeepSeek / Qwen / Zhipu GLM / Kimi / custom) → enter your API key → choose a model → set reasoning effort. Keys are encrypted with AES-256-GCM and stored locally in `~/.config/zqagent/`; they are never uploaded.

To run from source instead:

```bash
pnpm install
pnpm build
node packages/core/bin/zqagent
```

## Quick start

```text
$ zqagent
[interactive][code] > read this project and tell me what it does

● list_files  .
● read_file   README.md
● read_file   package.json
✓ This is a TypeScript AI agent engine...

[interactive][code] > change the default port in src/config.ts to 8788, then run the tests

● read_file        src/config.ts
⏵ replace_in_file  1 change, waiting for approval
  [Y] allow once   [A] always allow   [D] deny
> Y
● run_shell        pnpm test
  ✓ 42 passed
✓ Changed the default port; tests pass
```

Common commands:

| Command | Description |
| --- | --- |
| `/connect` | Configure the model connection (provider / key / model / reasoning effort) |
| `/plan` | Plan mode: read-only exploration, proposes a plan and waits |
| `/interactive` | Interactive mode: every side-effecting action needs approval (default) |
| `/auto` | Auto mode: allow everything (risky — use in isolated environments only) |
| `/discuss` | Discuss mode: read-only conversation |
| `/sessions` | List and resume previous sessions |
| `/agent` | Switch or maintain custom agents |
| `/mcp` | Manage MCP servers |
| `/tools` | Show all tools and their risk levels |

While a task is running you can type additional instructions at any time — no need to wait for it to finish. Press `ESC` twice to interrupt.

## How it works

![Architecture](./docs/assets/architecture.svg)

`TurnEngine` drives each task: the model thinks → calls a tool → observes the result → next round,
until the task is done or the turn limit is reached.

Every tool call goes through `PermissionEngine`: each tool declares a risk level (read / write / exec),
and the current mode decides whether it runs directly or requires approval.

## Built-in tools

| Category | Tools |
| --- | --- |
| Files | `read_file` `write_file` `replace_in_file` `list_files` `grep` |
| Shell | `run_shell` `shell_task_output` `shell_task_kill` (persistent shell, background tasks) |
| Web | `web_search` `web_fetch` |
| Git | `git_log` `git_status` `git_diff` |
| Patches | `apply_patch` `apply_unified_diff` |
| Collaboration | `ask_user` `propose_plan` `request_directory` `todo_write` |
| Exploration | `explore` (sub-agent for cross-file research; returns conclusions only) |
| Media | `media` `ffmpeg` `ffprobe` (audio/video; requires ffmpeg on the host) |

Tools can be added, removed, or disabled at runtime; the next model call picks up the change immediately.

## Security model

ZQAgent assumes **model output is untrusted**:

- File writes, command execution, and network access require approval by default.
- API keys are encrypted locally and never appear in the repository or logs.
- The workspace is the permission boundary: the agent has exactly the permissions of the user and directory it was started in.
- Do not expose the node service directly to the internet.

Please **do not open a public issue** for security problems — follow [SECURITY.md](./SECURITY.md) instead.

## Documentation

| Topic | Document |
| --- | --- |
| Architecture and event flow | [docs/en/architecture.md](./docs/en/architecture.md) |
| Wire protocol (frames / messages / signatures) | [docs/en/wire-protocol.md](./docs/en/wire-protocol.md) |
| Node service REST API | [docs/en/server-api.md](./docs/en/server-api.md) |
| Shared library (protocol / crypto / approvals / notifications) | [docs/en/shared.md](./docs/en/shared.md) |
| Context compaction | [docs/en/context-compaction.md](./docs/en/context-compaction.md) |
| LLM connection errors | [docs/en/llm-connection-troubleshooting.md](./docs/en/llm-connection-troubleshooting.md) |
| QQ bot integration | [docs/qq-bot.md](./docs/qq-bot.md) *(Chinese)* |
| Windows tool compatibility | [docs/windows-tool-compat.md](./docs/windows-tool-compat.md) *(Chinese)* |
| CLI single-file (SEA) packaging and troubleshooting | [docs/cli-sea-troubleshooting.md](./docs/cli-sea-troubleshooting.md) *(Chinese)* |

Every document except the QQ bot, Windows compatibility, and CLI-packaging notes is available
in English; those three are currently Chinese only.

User-facing guides (installation, CLI usage, agents, MCP): <https://agent.cd-zq.com/en/>

## Development

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm build         # tsup → dist/
pnpm dev           # run the CLI from source
```

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a pull request. Changes touching permissions,
approval, or command execution get extra scrutiny.

## License

[Apache-2.0](./LICENSE). `@zqagent` and the ZQAgent name are trademarks of this project;
redistributions and hosted services must not imply official endorsement.
