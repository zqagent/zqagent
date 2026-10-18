# Multi-tenant Agent Server — API Tutorial (curl)

This document walks through testing the multi-tenant agent service in
`packages/core/src/server` with `curl`, focusing on the critical path:
**approval suspension → persistence → timeout eviction → resume**.

- One-shot script: `bash scripts/test-server.sh` (starts a test instance and runs every
  scenario; see the end of this page)
- All examples assume: `http://localhost:8787`, demo tenant `demo` (its apiKey is generated
  randomly on first start and printed in the log)

## 1. Start the server

```bash
# Starts without an LLM key (auth/sessions/state/isolation all work; only chat turns will fail)
pnpm --filter @zqagent/core run server

# With a real model (recommended — lets you exercise the full chat and approval flow)
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=... OPENAI_MODEL=gpt-4o-mini \
  pnpm --filter @zqagent/core run server
```

The startup log prints the demo tenant:

```
zqagent server listening on http://localhost:8787
data directory: ./data
approval suspension timeout: 900s (after timeout the in-memory task is evicted; resume can restore it)
created demo tenant: id=demo apiKey=zk_xxxx (randomly generated) model=gpt-4o-mini
```

Environment variables (all set before startup):

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Listen port | `8787` |
| `DATA_DIR` | Root directory for state and tenants | `./.zqagent_data` |
| `APPROVAL_TIMEOUT_SECONDS` | Suspension timeout for approvals/questions; evicts the in-memory task | `900` |
| `TENANT_ID` / `TENANT_API_KEY` / `MODEL` | Demo tenant created on first start | `demo` / random / `gpt-4o-mini` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Model configuration for the demo tenant | — |

## 2. Authentication

Every endpoint except `/healthz` requires `Authorization: Bearer <tenant API key>`:

```bash
export BASE=http://localhost:8787
export TOKEN=zk_xxxx   # the apiKey from the "created demo tenant" log line

# Health check (public)
curl -s $BASE/healthz
# => {"status":"ok","version":"dev","features":{"mcp":false}}

# No key → 401
curl -s -w "\nHTTP %{http_code}\n" $BASE/api/v1/sessions
# => {"error":{"code":"unauthorized","message":"invalid API key"}}   HTTP 401

# Wrong key → 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer bad" $BASE/api/v1/sessions
# => 401

# Correct key → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
# => 200
```

## 3. Session CRUD and state

```bash
# Create a session (model is optional; defaults to the tenant's model)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini"}' $BASE/api/v1/sessions
# => {"data":{"sessionId":"e4df66d64d5b4d9bacea","tenantId":"demo","model":"gpt-4o-mini",
#             "modelOverridden":true,"taskCount":0,"messages":[],"compaction":null,
#             "status":"idle","approvals":[],"questions":[],
#             "sessionAllowTools":[],"sessionAllowCommands":[],"savedAt":"..."}}

export SID=e4df66d64d5b4d9bacea   # replace with the sessionId returned above

# Get / list / delete
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID
# => {"data":{"deleted":true}}

# Session state (includes suspended approvals/questions)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => {"data":{"sessionId":"...","status":"idle","model":"...","messageCount":0,
#             "compaction":null,"approvals":[],"questions":[],"savedAt":"..."}}
```

## 4. Submitting a turn and reading events

> **Steering while running**: if a task is already executing, `POST /turns` automatically
> becomes an injected instruction for the current task (returning
> `{"data":{"accepted":true,"status":"steering"}}`) instead of a 409 `busy`; the message is
> injected as a user message at the next iteration boundary.
> You can also call `POST /api/v1/sessions/:id/steer` explicitly (see below).
> If an approval or question is still pending, submitting a turn returns 409
> `has_pending_interaction` (answer the approval/question first).

```bash
# Submit a task (returns accepted immediately; the task runs in the background)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"Hello, tell me about yourself"}' $BASE/api/v1/sessions/$SID/turns
# => {"data":{"accepted":true,"status":"running"}}

# Inject an instruction while running (explicit steer; equivalent to the automatic path)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Also add error handling"}' $BASE/api/v1/sessions/$SID/steer
# => {"data":{"accepted":true}}

# Poll state until done (incremental event pull with the since cursor)
curl -s "$BASE/api/v1/sessions/$SID/events?since=0"
# => {"data":{"events":[{"seq":1,"ts":"...","type":"TURN_START","data":{...}},
#                        {"seq":2,"type":"ASSISTANT_DELTA","data":{"text":"..."}},
#                        {"seq":N,"type":"TURN_END","data":{"status":"completed","iterations":1,...}}],
#             "latestSeq":N}}

# SSE live subscription (open a terminal and watch)
curl -N -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" \
  $BASE/api/v1/sessions/$SID/events
# id: 1
# event: TURN_START
# data: {...}
```

## 5. Tool approval flow (the core scenario)

In interactive mode, when the model requests a **side-effecting tool** (writing files,
executing commands), execution suspends and waits for approval. Ask the model to do something
that writes a file:

```bash
# (1) Submit a task that triggers an approval
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"Write hello world to /tmp/demo.txt"}' \
  $BASE/api/v1/sessions/$SID/turns
# => {"data":{"accepted":true,"status":"running"}}

# (2) Poll state: the task is suspended waiting for approval
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_approval"

# (3) List pending approvals (the id is the tool call ID)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/approvals
# => {"data":[{"id":"call_xxx","toolName":"write_file","arguments":{"path":"/tmp/demo.txt",...},
#              "reason":"...","status":"pending","createdAt":"..."}]}

# (4) Answer the approval (decision: once | always_tool | always_command | deny;
#     always_command is only valid for run_shell — other tools get a 400)
export AID=call_xxx
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"once"}' $BASE/api/v1/sessions/$SID/approvals/$AID
# => {"data":{"answered":true,"decision":"once"}}

# (5) The task continues to completion
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"completed"
```

## 6. Question flow (ask_user / propose_plan)

When the model calls `ask_user` / `propose_plan` / `request_directory`, the task suspends in
the same way:

```bash
# Ask the model to ask you a question
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"Call the ask_user tool to ask me whether to continue"}' \
  $BASE/api/v1/sessions/$SID/turns

# State becomes waiting_question
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_question"

# Read the question
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/questions
# => {"data":[{"id":"qid_xxx","kind":"ask","question":"Continue?","options":[],"status":"pending",...}]}

# Answer it
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"answer":"Continue"}' $BASE/api/v1/sessions/$SID/questions/qid_xxx
# => {"data":{"answered":true}}
```

## 7. Long pause: persistence → timeout eviction → resume (key scenario)

Design goal: when the user does not answer for a long time, the service **persists the full
suspension point** and **evicts the in-memory run instance**; when the user answers later, the
task resumes precisely from the on-disk state (this also survives a process restart).

Use a short timeout to observe it:

```bash
# Start with a 10-second approval timeout
APPROVAL_TIMEOUT_SECONDS=10 OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini \
  pnpm --filter @zqagent/core run server
```

```bash
# (1) Submit a task that triggers an approval/question (same as above)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"Call ask_user to ask me whether to continue"}' $BASE/api/v1/sessions/$SID/turns

# (2) Wait for waiting_question
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"waiting_question"

# (3) Do not answer; wait longer than 10s — the in-memory run is evicted, the disk keeps the
#     suspension point:
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => still "status":"waiting_question" (the suspension point is persisted; approvals/questions
#    remain pending)
# On disk: {DATA_DIR}/tenants/demo/sessions/$SID/session.json (full message history + suspension record)

# (4) The user answers → the service detects the run was evicted → engine.resume() restores it
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"answer":"Continue"}' $BASE/api/v1/sessions/$SID/questions/qid_xxx

# (5) Poll until done (resume replays the un-executed tool calls; it does not re-ask or re-approve)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions/$SID/state
# => "status":"completed"
```

> Note: eviction is an in-memory behavior; there is no API to query whether it happened.
> Observable evidence: after eviction (answering after the timeout), the task still completes
> normally — that is "suspension point persisted + resume" at work. If the process crashes or
> restarts while suspended, answering after the restart resumes the same way.

## 8. Multi-tenant isolation

```bash
# Manually provision a second tenant (DATA_DIR/tenants/t2/config.json)
mkdir -p .zqagent_data/tenants/t2
cat > .zqagent_data/tenants/t2/config.json <<'EOF'
{"id":"t2","apiKey":"key2","model":"gpt-4o-mini","provider":{"apiKey":"sk-..."}}
EOF

# Tenant t2's key accessing tenant demo's session → 404 (isolation in effect)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer key2" $BASE/api/v1/sessions/$SID
# => 404
```

## 9. Error codes

| HTTP | code | Scenario |
| --- | --- | --- |
| 401 | `unauthorized` | Missing or invalid key |
| 404 | `not_found` | Session does not exist / unknown route / cross-tenant access / approval or question does not exist |
| 409 | `busy` | Session is already running (POST /turns no longer triggers this — it becomes steering) |
| 409 | `not_running` | Explicit steer while the session is not running |
| 409 | `has_pending_interaction` | Pending approval/question blocks a new turn |
| 400 | `bad_request` | Malformed JSON body / empty input |
| 400 | `invalid_decision` | decision is not once/always_tool/always_command/deny, or always_command was sent for a tool other than run_shell |

## 10. One-shot test script

```bash
# Smoke test (no LLM key needed): auth / sessions / state / events / isolation / error paths, 18 checks
bash scripts/test-server.sh

# Full path (reads OPENAI_API_KEY etc. from the project .env):
# real chat + ask_user suspension + timeout eviction + resume, 24 checks
bash scripts/test-server.sh

# Custom port / override model config from .env (explicit values win over .env)
PORT=8790 OPENAI_MODEL=deepseek-chat bash scripts/test-server.sh
```

What the script does: it starts an isolated test instance with a **temporary data directory**
(8s approval timeout), then tears down the process and temporary data, leaving any existing
service untouched; if the port is in use it asks you to pick another one.
Model settings (`OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`) come from explicit
environment variables first, falling back to `.env` in the repository root.
The full-path demo depends on the model actually calling `ask_user` (the prompt is written to
encourage it); if the model does not, the script says so and skips the interactive demo — the
other 18 smoke checks are unaffected.

## 11. Graphical console

The official graphical console (organized as node → project → session, covering every API on
this page) is **not part of this repository**; it ships with the desktop app and the cloud user
center. It is just a client of the REST endpoints above, and everything it does can be done with
`curl`.

The admin key is printed in the startup log ("admin key: ...") or stored in
`{DATA_DIR}/admin.json`. It can create/switch/delete projects; a single project key can also be
used to connect (degrading to a single-project view). Section 12 shows the equivalent `curl` usage.

## 12. Console API: projects and nodes (admin)

The admin key (`Authorization: Bearer <adminKey>`) can operate across projects. Project-scoped
endpoints require an `X-Project-Id: <projectId>` header to select the target project; a
project's own key ignores that header.

```bash
export ADMIN=$(node -e "console.log(require('./.zqagent_data/admin.json').apiKey)")

# List / create / delete projects (= tenants)
curl -s -H "Authorization: Bearer $ADMIN" $BASE/api/v1/projects
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"openworker","workspaceRoot":"/path/to/repo","model":"deepseek-chat"}' \
  $BASE/api/v1/projects
# => {"data":{"id":"...","name":"openworker","apiKey":"zk_...", ...}}   # apiKey is returned only once, at creation
curl -s -X DELETE -H "Authorization: Bearer $ADMIN" $BASE/api/v1/projects/<id>

# Node metadata (admin = all projects; tenant key = its own only)
curl -s -H "Authorization: Bearer $ADMIN" $BASE/api/v1/node/info

# Admin creates a session in a specific project
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H "X-Project-Id: <id>" \
  -H "Content-Type: application/json" -d '{}' $BASE/api/v1/sessions

# Available models (fetched from the OpenAI-compatible /models using the project's baseURL + apiKey)
curl -s -H "Authorization: Bearer $ADMIN" -H "X-Project-Id: <id>" $BASE/api/v1/models
# => {"data":{"models":["deepseek-chat","deepseek-reasoner"],"endpoint":"https://api.deepseek.com/models"}}

# Browse the node/local engine filesystem (to pick a working directory when creating a project)
curl -s -H "Authorization: Bearer $ADMIN" "$BASE/api/v1/fs/list?path=/home/user"
# => {"data":{"path":"/home/user","parent":"/home","entries":[{"name":"repo","path":"/home/user/repo","type":"dir"}, ...]}}
```

## 13. Session naming (automatic + manual)

Same as the CLI: after the **1st, 3rd, and 5th successful task completion**, the server generates
a session title with the LLM in the background and persists it. Once the user renames the
session manually (`nameSource=user`), automatic naming stops.

- Session records and state gain three fields: `name` / `nameSource` (`auto` | `user`) / `taskCount`.
- Automatic naming runs in the background and does not block the turn; on completion it writes a
  `session_named` event (`data: { name, source }`) to the session's event stream, so SSE
  subscribers can refresh immediately.
- The naming prompt only asks for a short title; if the model returns nothing (for example a
  reasoning model with a small output budget), the step is skipped silently without affecting
  the main flow.

```bash
# Manual rename (sets nameSource=user, disabling automatic naming from then on)
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fix login timeout"}' $BASE/api/v1/sessions/$SID
# => {"data":{"sessionId":"...","name":"Fix login timeout","nameSource":"user"}}

# The session list returns name (the console uses it as the title)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sessions
```

> Note: the server has supported CORS since 2026-08-08 (`Access-Control-Allow-Origin: *`), so
> browser cross-origin debugging works directly; since the browser's `EventSource` cannot send
> an `Authorization` header, the console reads SSE via streaming `fetch` instead.
