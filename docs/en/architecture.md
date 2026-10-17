# Architecture

**English** · [简体中文](../architecture.md)

This repository is the **open-source part** of ZQAgent: the agent engine, built-in tools,
permission system, CLI, and node service. This document explains how these modules are
organized, how a task flows through them, and how to build and package them.

> Cloud accounts, subscriptions, and billing (Hub) are closed source and not part of this
> repository. They talk to the node service in this repository over the protocol described in
> `docs/wire-protocol.md`, so nothing is missing for local use.

## 1. Layered overview

```
┌──────────────────────────────────────────────────────────┐
│  Entry points                                            │
│  ├─ CLI (packages/core/src/cli)      interactive shell    │
│  ├─ Library (packages/core/src/index.ts)  embeddable      │
│  └─ Server (packages/core/src/server)  HTTP/SSE, multi-tenant │
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│  TurnEngine (engine/)                                    │
│  think → tool call → observe → next round;               │
│  steering / compaction / retries                          │
└───────┬───────────────────────────────┬──────────────────┘
        ▼                               ▼
┌──────────────────┐          ┌──────────────────────┐
│ PermissionEngine │          │ Provider             │
│ risk levels,     │          │ OpenAI-compatible    │
│ mode gating      │          │ streaming calls      │
└───────┬──────────┘          └──────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────┐
│  ToolRegistry: files / shell / web / git / patches / …   │
└──────────────────────────────────────────────────────────┘

Shared layer: @zqagent/shared (protocol, crypto, approval views, notifications)
Protocol contract: proto/fleet.proto (mirrors docs/wire-protocol.md)
```

## 2. Directory responsibilities

| Directory | Responsibility |
| --- | --- |
| `packages/core/src/engine` | `TurnEngine` event loop, event types, context compaction, session persistence |
| `packages/core/src/tools` | Built-in tools; each declares a risk level and argument schema |
| `packages/core/src/permissions` | Risk classification, mode gating, approval decisions |
| `packages/core/src/providers` | OpenAI-compatible provider (streaming / non-streaming), retries and diagnostics |
| `packages/core/src/mcp` | MCP client (stdio / HTTP), dynamic tool injection |
| `packages/core/src/agents` | Agent registry (name + prompt + optional model) |
| `packages/core/src/cli` | Interactive CLI, connection wizard, session management |
| `packages/core/src/server` | Multi-tenant HTTP service, projects/sessions/usage, node enrollment |
| `packages/shared` | Cross-module shared code: wire protocol, crypto, approval views, notification channels |
| `proto/` | Wire protocol schema and cross-implementation test vectors |

The dependency direction is one-way: `shared ← core`. Core references `packages/shared`
sources directly through `tsconfig` `paths`, and both are bundled together at build time,
so published packages do not depend on any private package.

## 3. How a task executes

1. The CLI collects user input and hands it to `TurnEngine` along with the message history.
2. The engine issues a streaming request to the provider; the model returns text or tool calls.
3. Every tool call passes through `PermissionEngine`:
   - `discuss` / `plan`: read-only tools run, everything else is rejected;
   - `interactive`: side-effecting operations raise an approval prompt and wait for the user;
   - `auto`: everything runs.
4. Tool results are fed back as observations, and the loop continues until the model stops
   calling tools or the turn limit is reached.
5. Session state can be persisted at any point and resumed from where it left off.

## 4. Runtime data

- **Session**: `SessionRecord` holds messages, materialized state, and pending approvals/questions.
- **Project**: `workspaceRoot` defines the boundary tools may access.
- **Node**: `nodeId` plus signing credentials; reports `status` / `info` / `event` / `notify` over WSS.
- **Config**: the model connection is stored encrypted under `~/.config/zqagent/`.

## 5. Build and develop

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm build            # tsup → packages/core/dist
pnpm dev              # run the CLI from source
```

Run the server:

```bash
pnpm --filter @zqagent/core run server   # local server on :8787
```

## 6. Packaging and release

| Artifact | Command | Notes |
| --- | --- | --- |
| npm package | `pnpm build` | `@zqagent/core`, including type declarations |
| CLI single file | `pnpm --filter @zqagent/core run build:cli-bin` | Node SEA, runs without Node installed |
| Server image | `bash scripts/build_server_image.sh` | Multi-architecture image |

The CLI single-file pipeline (tsup → SEA blob → postject injection into the base binary) and
common failures are covered in [cli-sea-troubleshooting.md](../cli-sea-troubleshooting.md).

## 7. Documentation index

| Topic | Document |
| --- | --- |
| This overview | architecture.md |
| Shared library (protocol / crypto / approvals / notifications) | [../shared.md](../shared.md) |
| Context compaction | [../context-compaction.md](../context-compaction.md) |
| Wire protocol v1 (frames · envelopes · messages · signatures) | [wire-protocol.md](wire-protocol.md) |
| Node service REST API | [../server-api.md](../server-api.md) |
| QQ bot + email notifications | [../qq-bot.md](../qq-bot.md) |
| Windows tool compatibility | [../windows-tool-compat.md](../windows-tool-compat.md) |
| CLI single-file packaging and troubleshooting | [../cli-sea-troubleshooting.md](../cli-sea-troubleshooting.md) |
| LLM connection errors | [../llm-connection-troubleshooting.md](../llm-connection-troubleshooting.md) |

> Documents other than this page are currently available in Chinese only.
