# Wire Protocol v1 (Frames · Envelopes · Messages)

[简体中文](../wire-protocol.md) · **English**

This document is the **normative contract** for zqagent's transport layer (Rust gateway +
pure Node nodes + web/mini-program/app terminals). The authoritative schema is
[`proto/fleet.proto`](../../proto/fleet.proto); implementations and cross-implementation
vectors are covered in §7.

> This protocol is **not a reimplementation of MQTT** (MQTT has been retired entirely):
> the gateway owns the routing table, so topic wildcard matching, retained messages, LWT,
> and QoS1 machinery are all unnecessary.

## 1. Frame format

Every connection — node-side and terminal-side share one frame format — is a fixed header
plus a variable-length payload:

```
┌──────────┬────────────┬────────────┬────────────┬────────────────┐
│  magic   │ ver │ type │    seq     │    len     │    payload     │
│  2 bytes │ 1 byte      │  varint    │   varint   │ protobuf bytes │
└──────────┴────────────┴────────────┴────────────┴────────────────┘
 0x5A 0x51   v(4b)|t(4b)    u64          u32
```

| Field | Description |
| --- | --- |
| `magic` | Fixed `0x5A 0x51` (ASCII `ZQ`). Lets the public-facing edge discard invalid traffic cheaply |
| `ver` | Protocol version, high 4 bits. Currently `1` |
| `type` | Frame type, low 4 bits (see §3) |
| `seq` | Monotonically increasing sequence number (varint, u64). Used for deduplication and resume positioning |
| `len` | Payload length in bytes (varint, u32). **The upper bound must be validated before decoding** |
| `payload` | Protobuf-encoded message body (interpreted according to `type`) |

**Limit**: `len` must not exceed `MAX_FRAME_BYTES = 4 MiB` (the node-side reporting limit is
currently about 3.5 MB, `FleetNodeBridge.ts:53,992-996`). Anything above the limit is an error
and the connection is closed, preventing memory amplification attacks.

**Decoding order**: `magic` → `ver` → `type` validity → `len` bound → `len` matches the
remaining byte count. Failure at any step is an error (partial parsing must never be used).

> Difference from 0.1.59: the old path encoded the payload format inside the MQTT body
> (1 byte `0x01` = protobuf, otherwise JSON). With framing, **the format is explicit in the
> frame header**, so payload format probing is no longer needed.

## 2. Envelope and signatures

The command envelope ([`Envelope`](../../proto/fleet.proto)) maps one-to-one onto the existing
`FleetCmdEnvelope` (`packages/shared/src/fleet.ts:159-178`), with unchanged semantics.

**Signature**:

```
sig = HMAC-SHA256(fleetSecret, encode(Envelope_without_sig))
```

- Covers the **encoded bytes** of fields `1..10` (`t`, `nonce`, `req_id`, `type`, `client_id`,
  `node_id`, `project_id`, `session_id`, `payload`, `timeout_ms`), **excluding** `sig` itself.
- `sig` stores the **raw 32-byte HMAC** (no longer a base64url string — unnecessary in a binary protocol).
- Replaces signing `JSON.stringify([...])` in the old implementation
  (`packages/shared/src/fleet.ts:283-307`): JSON canonicalization is fragile across languages
  (floats, field order, escaping), whereas byte signing is deterministic.
- The timestamp window (±60s) and nonce deduplication semantics are **unchanged**
  (`packages/shared/src/common.ts:17-47`).

**Verification (deterministic requirement)**: `sig` is the last field (number 11), therefore
`encode(env, sig empty) == signed bytes`. An implementation can verify by clearing `sig`,
re-encoding, and comparing. This requires the encoder to follow the determinism rules in §5,
and requires `sig` to **always be the highest-numbered field**.

**Execution budget**: `timeout_ms` is filled in by the caller, and the gateway uses it to bound
how long it waits for an acknowledgement. Keeping it in the envelope rather than inside the
opaque `payload` lets the gateway apply tiered timeouts **without parsing the payload** (§5.2).
It is covered by the signature, so tampering with the budget invalidates the signature.

### 2.1 Command timeout tiers

| Case | Wait limit |
| --- | --- |
| `timeout_ms` specified | `timeout_ms` + margin (default 5s), capped by a hard limit (default 300s) |
| `run_command` / slow commands (`read_file`/`download_file`/`get_events`/`search_files`/`git_diff`) | 60s |
| Other control / write operations | 10s |
| Node offline | **Do not wait**, immediately return `ok=false` (`error` mentions offline) |

These tiers follow the convention from the original Hub-proxy era (`isSlowCmd`/`cmdTimeoutMsFor`,
now implemented by the gateway, which is not part of this repository): a slow-command timeout
fails only that request and is not taken as evidence that the node is wedged.

## 3. Frame types

| Value | Name | Direction | Payload |
| --- | --- | --- | --- |
| 0 | `HELLO` | node/terminal → gateway | handshake (M2) |
| 1 | `AUTH` | node/terminal → gateway | authentication (M2) |
| 2 | `SNAPSHOT` | gateway → node/terminal | authoritative state pushed on connect (replaces retained, M2) |
| 3 | `STATUS` | node → gateway | `Status` |
| 4 | `INFO` | node → gateway | `Info` (capabilities / project summary) |
| 5 | `EVENT` | node → gateway | `Event` |
| 6 | `NOTIFY` | node → gateway → terminal | `Notify` (approval / question / turn completed; shares cursor and buffer with `EVENT`) |
| 7 | `CMD` | terminal → gateway → node | `Envelope` (gateway forwards by `node_id`, waits for `Ack` back to the originator) |
| 8 | `ACK` | node → gateway → terminal | `Ack` (gateway routes back to the originating connection by `req_id`) |
| 9 | `SUBSCRIBE` | terminal → gateway | multiplexed subscription (M5) |
| 10 | `UNSUBSCRIBE` | terminal → gateway | cancel subscription (M5) |
| 11 | `RESUME` | terminal → gateway | resume after disconnect (M5) |
| 12 | `PING` / 13 `PONG` | both directions | application-level heartbeat |
| 14 | `AUTH_OK` | gateway → node/terminal | `AuthOk` (handshake result; separate from `AUTH` to avoid parsing ambiguity for a bidirectional type) |

**Payloads implemented in M1**: `Envelope` (CMD), `Ack`, `Status`, `Event`.
**Implemented in M2**: `Auth`/`AuthOk` (handshake), `Snapshot`/`NodeState` (rebuilt view
replacing retained), `Subscribe`/`Unsubscribe` (terminal multiplexing), `Resume` (resume after
disconnect), `Info` (capabilities / project summary), `Notify` (approval / question / turn
completed), `Envelope.timeout_ms` (execution budget + gateway timeout tiers).
Remaining types get `.proto` messages in M5/M7 as needed (adding messages is backward
compatible and does not change the frame format).

## 3.5 Fields needed for terminal multiplexing and snapshots (M5)

A single terminal connection can subscribe to multiple nodes (the mini-program's
`wx.connectSocket` allows at most 5), so downstream frames must be **attributable to a specific
node**; and a snapshot must be able to replace the former retained info verbatim. Three fields
were added for this (proto3 is additive only — old clients ignore them, and existing vector
bytes are unchanged):

| Message | Field | Filled by | Why |
| --- | --- | --- | --- |
| `Event` | `string node_id = 7` | **gateway**, from the connection binding (left empty on node uplink) | Identify which node an event came from under multiplexing |
| `Notify` | `string node_id = 7` | same as above | Approvals/questions must indicate their node |
| `NodeState` | `bytes detail = 7` | gateway forwards the amplifying node's `Info.detail` | Get projects/statistics in one shot after subscribing, replacing retained info |

> `NodeState.detail` is **only populated in `SNAPSHOT`**: `STATUS` is a high-frequency fan-out
> path, and attaching the whole info JSON to every state change would needlessly amplify traffic.
> The two paths are produced by `to_proto_snapshot()` and `to_proto()` on the gateway side.

Field numbering follows the discipline in §8: existing fields of `Event`/`Notify`/`NodeState`
occupy 1..6, and new fields always take 7.

## 3.2 Two uplink channels: EVENT and NOTIFY (M2c)

| | `EVENT` | `NOTIFY` |
| --- | --- | --- |
| Semantics | high-frequency real-time progress | low frequency but must reach the terminal (approval request / question / turn completed / error) |
| Loss tolerance | tolerated, recovered via `resume` | **should not be lost** |
| Cursor | gateway assigns `seq` | same cursor space (interleaved with EVENT, monotonically increasing) |
| Buffer eviction | **evicted first** | **retained first** (when the buffer is full, the oldest EVENT is evicted first) |

Both share one ring buffer, so a single `resume(since)` restores events and notifications
together — an approval request will not be squeezed out by a subsequent event storm (the
gateway has a `notifies_survive_event_storm` test covering this behavior).

## 3.1 Command routing semantics (M2b)

```
terminal --CMD(Envelope)--> gateway --CMD--> node
terminal <--ACK(Ack)-------- gateway <--ACK-- node
```

- **Serialized per node**: commands for the same node are dispatched in arrival order; the next
  one is not sent until the previous acknowledgement arrives (concurrent dispatch saturates the
  node's event loop and makes it miss keepalives — a finding from the original Hub-proxy era).
- **Correlated by `req_id`**: no `ack/{clientId}` targeting is needed — the acknowledgement is
  routed to the originating connection by `req_id`.
- **Unmatched acknowledgements are dropped**: late or duplicate acknowledgements that find no
  waiter are discarded, which makes node-side retransmission idempotent.
- **Subscription constraint**: a terminal may only send commands to nodes it has **subscribed**
  to; otherwise it receives `ok=false` (not subscribed to this node).
- **Fail fast on a full queue**: exceeding the per-node queue depth immediately returns
  `node_busy` instead of accumulating unboundedly.
- **Snapshot ordering**: on connect the gateway first pushes an initial snapshot with the
  current (empty) subscription set; after `SUBSCRIBE` it pushes a second one including the
  subscription scope. Clients **must consume them in order** and must not just take the first.

Command state and drops are observable: `/metrics` exposes
`zqagent_gateway_pending_commands`, `commands_dispatched_total`, `commands_timed_out_total`,
`commands_rejected_offline_total`, `orphan_acks_total`, `dropped_frames_total`,
`slow_evicted_total`.

## 3.3 Backpressure and slow consumers (M2c)

Three layers of protection, from lightest to heaviest:

1. **Bounded send queue** (`GATEWAY_SEND_QUEUE`, default 64): when full, frames are dropped
   rather than blocking fan-out. Counted by `dropped_frames_total`.
2. **Write timeout** (`GATEWAY_WRITE_TIMEOUT_SECS`, default 10s): if TCP blocks (the peer is not
   reading) beyond the limit, the connection is closed, so one stuck client cannot pin gateway memory.
3. **Slow-consumer eviction** (`GATEWAY_MAX_CONSECUTIVE_DROPS`, default 500;
   `GATEWAY_REAPER_INTERVAL_SECS`, default 5s): the reaper disconnects terminals whose
   **consecutive** drops exceed the threshold and clears their subscriptions. Consecutive drops
   are tracked with an atomic counter that resets on successful delivery, so a healthy connection
   that drops once occasionally is not killed.

> **Snapshots must not be dropped**: the fan-out path may drop frames, but the initial snapshot
> and the post-`SUBSCRIBE` snapshot are the replacement for retained messages and must be
> delivered. The implementation waits for a free slot with a timeout fallback instead of using
> `try_send` (otherwise a momentarily full queue would leave the terminal with an empty view and
> no way to notice).

## 3.4 TLS termination

Both deployment forms are supported:

| Form | Configuration | When to use |
| --- | --- | --- |
| Terminate at the edge | no TLS variables, plaintext `/ws` (internal only) | k8s Ingress / nginx already terminates TLS |
| Gateway terminates TLS | `GATEWAY_TLS_CERT` + `GATEWAY_TLS_KEY` (PEM) | Exposed directly to the public internet; **mini-programs require wss** |

**Configuring only one of the two fails at startup** (non-zero exit) rather than silently
degrading to plaintext — the most error-prone deployment state. The HTTP observability endpoints
(`/healthz`, `/metrics`) share the same port as `/ws`, so they are covered by TLS as well.

## 4. Why no MQTT machinery

| MQTT mechanism | Replacement |
| --- | --- |
| topic wildcard matching | gateway holds a `nodeId → shard → conn` routing table |
| retained | gateway holds authoritative `states`, pushes `SNAPSHOT` on connect |
| LWT (last will) | socket close + heartbeat timeout (more reliable than LWT) |
| QoS1 PUBACK / session redelivery | application-level `seq` + `ack` + server-side replay buffer |
| ACL | connection-level handshake auth + naturally converging routing (each connection only reaches its own `node_id`) |

## 5. Encoding determinism (prerequisite for cross-language agreement)

All implementations must follow proto3's **default-value omission** rules, otherwise the bytes
differ and signature verification fails:

| Type | Omitted when |
| --- | --- |
| numeric (including `uint64`) | value is `0` |
| `bool` | value is `false` |
| `string` | empty string `""` |
| `bytes` | length `0` |

Fields are encoded in **ascending field-number order**. `string` must be valid UTF-8
(strictly validated; invalid input is an error).

## 6. Boundaries and rejection rules

| Case | Handling |
| --- | --- |
| `magic` mismatch / unsupported `ver` | error, close |
| `type` outside the defined set | error, close |
| `len > MAX_FRAME_BYTES` | error, close (no buffer allocated) |
| `len` mismatch with remaining bytes / out-of-bounds varint field | error, close |
| Unknown field number (added by a future version) | **skip** (consume by wire type), not an error — preserves forward compatibility |
| Invalid wire type (groups 3/4, etc.) | error |

## 7. Implementations and cross-validation

| Implementation | Location | Notes |
| --- | --- | --- |
| JS/TS (Node + browser + mini-program) | `packages/shared/src/wire/` | Portable: `Uint8Array`/`DataView`, **no Node API dependency** |
| Node signing | `packages/shared/src/wire/node.ts` | `node:crypto`, Node-side only (not shipped to browsers) |
| Rust gateway (not in this repository) | crate `zqagent-gateway` | `prost` + hand-written frame codec; modules `frame/stream/auth/registry/eventbuf` |
| Connection layer (not in this repository) | gateway `main` | wss termination, handshake, heartbeat, snapshot, fan-out, `/healthz`, `/metrics` |

**Cross vectors**: [`proto/fixtures/wire-vectors.json`](../../proto/fixtures/wire-vectors.json)
(committed) holds canonical inputs and their expected bytes. Both the Node and Rust sides must
**produce exactly the same bytes** and **decode them back to the same semantics**.

> Note: the original plan called for "three codecs". During implementation we found that Node and
> browsers can share a single portable implementation (`Buffer` is a `Uint8Array` subclass and
> encoding itself needs no platform API), so this converged to **one JS implementation + one Rust
> implementation**, with signing split by platform. One fewer duplicate implementation is one
> fewer place where bytes can diverge.

Regenerate the vectors (required after any protocol change):

```bash
cd packages/core && npx tsx scripts/gen_wire_vectors.ts
```

## 8. Version evolution

- Frame header `ver` and protobuf field numbers express compatibility **in two layers**: adding
  fields is handled by protobuf (no `ver` change); only changes to frame semantics bump `ver`.
- During a transition period the gateway may accept multiple versions (dispatching the parser by `ver`).
