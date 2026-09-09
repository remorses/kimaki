---
title: OpenCode v2 facts for in-place Kimaki migration
description: >
  How OpenCode v2 actually works. Deltas not snapshots, durable vs live,
  inbox vs execution. For rewriting cli/ against opencode2. Not the plugin rewrite.
---

# OpenCode v2 facts for in-place Kimaki migration

Kimaki stays the **Discord bot** (`cli/`). OpenCode v2 is the **child server**. This file is the mental model for that swap. Do not rewrite Kimaki as OpenCode plugins.

Pin packages. This worktree used `@opencode-ai/plugin`, `@opencode-ai/client`, `@opencode-ai/cli` at **`0.0.0-beta-19271`**. Binary is `opencode2`. V1 stays `opencode`.

**Package names do not match the docs site.** Official pages say `@opencode/client`. npm beta is **`@opencode-ai/client`**. `@opencode/client` on npm is a stub. Import the name you pin.

Docs:

- https://opencode.ai/v2/docs/migrate-v1/
- https://opencode.ai/v2/docs/build/client
- https://opencode.ai/v2/docs/permissions
- Source: https://github.com/anomalyco/opencode/tree/v2
- Session rules: `opencode-v2/AGENTS.md` (V2 Session Core)

# The one sentence

V1 Kimaki watches **mutable part snapshots**. V2 Kimaki must **fold facts**. Live tokens are **deltas**. Replay is **ended values**. Prompting **admits inbox work**. Execution is a **separate drain**.

If an agent still thinks in `message.part.updated` + `promptAsync` + `session.abort`, the port will be wrong even if the HTTP names are swapped.

# Mental model

```
  Discord bot
       │  OpenCode.make({ baseUrl, Basic opencode:TOKEN })
       ▼
  opencode2 serve     one process, many locations
       │
       │  session.prompt  →  session.inbox.enqueued   (admit)
       │                  →  SessionExecution.wake    (unless resume: false)
       │
       │  drain           →  session.execution.started
       │                  →  one or more logical STEPS (each = one LLM call)
       │                       text/reasoning/tool deltas (LIVE ONLY)
       │                       *.ended / tool.success (DURABLE FULL VALUE)
       │                  →  session.execution.succeeded | failed | interrupted
       │
       └─ GET /api/event  volatile SSE. Missed events are gone.
          Reconcile with GET /api/session/:id/message
```

A Discord user message is **not** an OpenCode user message until `session.inbox.delivered`. `session.prompt` returning only means the inbox accepted the item.

One Discord prompt is **not** one assistant step. Tools continue the drain. Retries are extra physical attempts inside one logical step. A **turn** (all steps until idle) is reserved for later. Do not name a step a turn.

# Deltas, not part snapshots (the core UI change)

This is the change that breaks Kimaki render if you ignore it.

## What V1 Kimaki does

`message.part.updated` is a **full snapshot** of that part.

Each event can carry the whole `part.text`, whole tool `state`, whole reasoning blob. The bot **replaces** the previous part for that `part.id`. `thread-session-runtime.ts` truncates those snapshots in the event buffer because they are large.

`message.updated` is the same idea at message level: a new full `info` + `parts[]`.

V1 plugins and the SDK still talk as if those names exist. Schema v2 says `message.updated` and `message.part.*` are **V1-only**. They are not on generated `V2Event`.

## What V2 emits instead

Stream fragments are **chunks**. Schema comments, copied:

> Stream fragments are live-only; Text.Ended is the replayable full-value boundary.

Same sentence for reasoning and tool input.

| Live (ephemeral) | Field | Durable full value |
|---|---|---|
| `session.text.delta` | `data.delta` (chunk only) | `session.text.ended` → `data.text` |
| `session.reasoning.delta` | `data.delta` | `session.reasoning.ended` → `data.text` |
| `session.tool.input.delta` | `data.delta` | `session.tool.input.ended` → `data.text` (raw JSON string) |
| `session.compaction.delta` | chunk | `session.compaction.ended` → `data.text` |
| `session.tool.progress` | live metadata **replacement** | `session.tool.success` / `failed` |

**Wrong:** `message.content = event.data.delta`  
**Wrong:** treat each delta like `part.updated` and replace the Discord message with only the chunk  
**Right for live Discord:** append `delta` onto a buffer keyed by identity  
**Right for reconnect / missed SSE:** use `*.ended` or `GET /api/session/:id/message`. You cannot rebuild a typewriter from history.

## Identity (not v1 `part.id`)

Text and reasoning:

```
sessionID + assistantMessageID + ordinal
```

`ordinal` is allocated in stream-start order per assistant message (`nextOrdinal++` in `publish-llm-event.ts`).

Tools:

```
sessionID + assistantMessageID + tool id
```

Producer fibers and tool fibers are concurrent. **Do not fold by global event order.** Fold by id/ordinal. A tool event can arrive interleaved with text deltas.

On `*.ended` / `tool.success` / `tool.failed`, **replace** the live buffer with the durable full value. Do not keep concatenating after ended.

## `session.message.content.updated` is not a stream

It is a **durable replacement** of a **completed** assistant message in an **idle** session. HTTP: replace content only when not busy, message completed, no unfinished tools.

Do not use it as `message.updated` while tokens stream. Live path is `text.delta` / `reasoning.delta` / `tool.input.delta`. Use content.updated after the fact (edit, reconcile), or if you missed the whole stream.

## SSE is volatile

`GET /api/event` → `client.event.subscribe()`.

- Payload is the event JSON itself: `id`, `created`, `type`, `data`, optional `location`, optional `durable`, optional `metadata`
- First event: `server.connected`
- Heartbeats: SSE comments every 15s
- **No replay. No cursor. No auto-reconnect**
- Slow consumer: dropping queue capacity **4096**, then the subscriber **fails**

After disconnect, missed deltas are gone. Reconcile with projected messages:

```
GET /api/session/:sessionID/message
GET /api/session/:sessionID/message/:messageID
```

Ordered durable replay (experimental):

```
GET /api/experimental/session/:sessionID/log?after=<seq>&follow=true
```

That log does **not** contain ephemeral deltas. It has ended/success facts plus a `log.synced` watermark.

# Durable vs ephemeral

Durable events have `durable: { aggregateID, seq, version }`. They are the session log.

Ephemeral events have no envelope. Live only.

Kimaki rule: **derive Discord from durable facts when possible.** Use ephemeral only for typewriter / progress / status chrome.

Do not store every delta in a 1000-event cap. You will drop `execution.succeeded` and the footer dies. Keep lifecycle, inbox, execution, usage. Drop or compact deltas.

# Inbox vs execution (delete the 3s interrupt plugin)

V1 `opencode-interrupt-plugin.ts`: `session.abort`, wait, `promptAsync` replay. **Delete it.**

V2 splits **admit** from **run**.

```
session.prompt(...)
    → publishes session.inbox.enqueued
    → inserts a pending session_inbox row
    → SessionExecution.wake(sessionID)   unless resume: false
```

`resume: false` = write the inbox item, do not wake. Admit-only.

`session_inbox` holds **unconsumed work only**. On `session.inbox.delivered`, the row is deleted in the same transaction that inserts the visible user message. `GET .../inbox` is pending work, not history.

## Delivery

| Mode | Meaning |
|---|---|
| `steer` | Default. Interrupt at a safe step boundary |
| `queue` | Wait. At idle, if no steer exists, deliver **exactly one** queued item, then reevaluate |

At a busy step boundary, steered **compaction** can jump ahead of earlier steered prompts, until a **move** boundary. Moves block compaction from crossing locations. Other steers keep enqueue order.

At idle: steers still win. Else one queue item.

HTTP after enqueue: `session.inbox.list` / `cancel` / `steer` / `queue`.

## Events (key by `inboxID`)

| Event | Payload | Kimaki |
|---|---|---|
| `session.inbox.enqueued` | `inboxID`, `item` (`type`, `payload`, `delivery`) | Remember payload. Do not show as Discord user text from OpenCode yet |
| `session.inbox.delivered` | `inboxID` **only** (no `item`) | Look up enqueue map. Drain line `» **user:**` if delivery was `queue` |
| `session.inbox.cancelled` | `inboxID` | Drop map entry |
| `session.inbox.delivery.changed` | `inboxID`, `delivery` | Update steer/queue before deliver |

Item types: `user`, `synthetic`, `compaction`, `move`. Compaction and move are control work, not chat.

## Idempotent IDs

If you pass the same inbox item `id` (`msg_...`) for a user/synthetic item on the same session and type, **first admission wins**. Later payload, metadata, and delivery are ignored, even after delivery. Cross-session or cross-type reuse fails.

Kimaki should store a stable id per Discord message if it retries `session.prompt`.

`/queue` and `. queue` → `delivery: "queue"`. Do not keep Zustand `queueItems` for ordinary chat. A hook that forces `steer` on every non-suffix prompt will smash slash `/queue`.

# Execution, steps, interrupt

`SessionExecution` is **process-global**, keyed by `sessionID`. Different sessions run in parallel. One session has one drain fiber. Wakes coalesce.

Placement: load session from store, then run in that session's location. You do not pass `directory` on `prompt` / `interrupt`. The session already has a location.

## Lifecycle facts (durable)

- `session.execution.started`
- `session.execution.succeeded` → **footer** (natural end of this drain)
- `session.execution.failed`
- `session.execution.interrupted` → **no footer**. `data.reason`: `user` \| `shutdown` \| `superseded` \| `inactivity`

A drain can contain **many logical steps**. One step = one logical LLM call = one `llm.stream`. Generic retries are extra **physical attempts** inside the same step. They do not consume another agent-step allowance.

Do **not** show the Kimaki footer on `session.step.ended`. That is mid-drain if tools continue.

## Interrupt

`POST /api/session/:id/interrupt` → `{ interrupted: boolean }`

- `true`: this process owned an active drain and stopped it
- `false`: idle or locally unowned. **No-op**, not an error
- unknown session: **404**

Optional `continue: true` resumes pending steers and next-in-line control items (compaction, move). Queued user prompts stay parked.

V1 `session.abort` does **not** exist on the v2 HTTP client.

Restart recovery uses an execution **claim**. At-least-once. Not exactly-once. Crash can redo side effects.

## Status vs idle

`session.status` is **ephemeral**: `busy` \| `idle` \| `retry`. Chrome only.

`session.idle` still emits. Schema marks it **deprecated**. Same idle as status. It fires after interrupt too. **Do not** use it as “assistant finished, show footer.”

Wait APIs: `GET /api/session/active`, `POST /api/session/:id/wait`.

# Tools

```
tool.input.started
  → tool.input.delta*     live raw JSON chunks
  → tool.input.ended      durable raw text
  → tool.called           durable parsed input + executed: boolean
  → tool.progress*        live metadata replacement (not append)
  → tool.success | failed durable terminal
```

`tool.success` content is a **non-empty array** of content items (text, files, …), not `state.output: string`. `executed` distinguishes local run vs provider-executed.

`tool.failed` is self-contained (includes a bounded progress snapshot). You do not need to replay progress events.

V1 `part.state.output` string rendering will drop file items.

# Compaction

First-class inbox item + event lifecycle: `started` / live `delta` / `ended` / `failed`.

Manual compact **admits** a compaction item (default **steer**). It is not “compact immediately, ignore the inbox.”

`compaction.ended` has final `text`, `recent`, model, provider state. Completed compaction **moves the instruction epoch**.

There is no public `session.compacted` on generated `V2Event`.

# Instructions

Not a static `system` string on `promptAsync`.

- Baseline instructions render from stored values for the current **epoch**
- Later updates freeze as durable system messages (`session.instructions.updated`)
- Compaction advances the epoch
- Session **move** keeps the epoch
- Committed **revert** clears it
- **Fork** adopts the parent's **newest** instruction values, even if copied history ends at an earlier message

Kimaki should not inject a fake v1 system prompt as if OpenCode will ignore epochs.

# Fork

HTTP `POST /api/session/:id/fork` body `{ boundary }`:

- `{ type: "before", messageID }`
- `{ type: "through" }` (through latest)

Copies **settled** projected history only (completed assistant / shell / compaction). No in-flight tool. Copies location, agent, model, metadata. Instructions = parent **current**, not instructions-at-boundary.

Not on plugin `SessionDomain`. In-place Kimaki uses HTTP.

`. btw` in Kimaki v1 forked Discord + OpenCode without replaying Discord history. Verify fork copies model/worktree and **not** Discord thread messages (those are Kimaki-side).

# Forms, not question events

`question.asked` is **not** on `V2Event`. The question tool creates a **form** with `metadata.kind = "question"`.

Events (all **ephemeral**): `form.created` / `form.replied` / `form.cancelled`.

Recover with HTTP: list/get/state/reply/cancel under `/api/session/:id/form`.

Port Discord dropdowns to forms. After reconnect, list pending forms. Do not wait for a missed `form.created`.

# Permissions

Bus already used `permission.asked` in v1 runtime. V2 names match.

Ask: `data.id`, `data.sessionID`, `data.action`, `data.resources[]`, optional `save[]`, `message`, `metadata`, `source`.

Reply: `POST /api/session/:sessionID/permission/:requestID/reply` body `{ reply, message? }` with `reply`: `once` \| `always` \| `reject`. Use ask **`data.id` as `requestID`**. You cannot widen patterns.

Config: ordered `permissions` array. Last match wins. `bash` → `shell`, `task` → `subagent`, `write`/`patch` → `edit`.

`session.create` in this beta has **no** `permission` field. The v1 trap (create-time rules beating `opencode.json`) is not on this payload. Still do not inject allow-all elsewhere.

# Location and process

One `opencode2` serves **many directories**. Session stores `directory` (+ optional `workspaceID`). Runner, tools, permissions, fs are location-scoped.

Create: `location` in the **JSON body**.

Prompt / interrupt / get: **`sessionID` only**. Server looks up location.

Location-scoped routes (plugin list, agents, RPC): query `location[directory]=...` (client `query: { location }`). Also `location[workspace]`. Fallback header **`x-opencode-directory`** still works. Prefer query. Do not send v1 `directory` on every session method.

Event `location` may be missing. Unlocated session events use the session owner at publish time. **Moves** go to old and new location.

Kimaki today: one OpenCode child per project. That still works but fights v2. Prefer one serve and a `sessionID → directory` map in sqlite.

`setup()` for plugins runs **per location**. Module eval can run twice. `globalThis` is shared. If Kimaki still injects a plugin, Discord/sqlite must be process singletons.

Config `plugins` path must be a **directory** (or package / `file://` dir). `./plugin.ts` is dropped. Official migrate-v1 still shows a `.ts` file in one example. Source rejects it.

# Client SDK map

```ts
import { OpenCode } from '@opencode-ai/client'

const client = OpenCode.make({
  baseUrl,
  headers: {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  },
})
```

Docs show Bearer. **`opencode2 serve` is Basic** `opencode:TOKEN`.

Foreground serve logs (password line only if password was not from env):

```
server listening on http://127.0.0.1:PORT
server password TOKEN
```

Generated `SessionPromptInput` types look nested. Codegen artifact. **HTTP body is flat:**

```ts
POST /api/session/:sessionID/prompt
{
  id?,          // inbox item id, idempotent
  text,
  files?,
  agents?,
  skills?,
  metadata?,
  delivery?,    // "steer" | "queue"
  resume?,      // default wakes; false = admit only
}
```

Success unwraps `{ data: SessionInbox.User }`. That is the **inbox row**, not the assistant reply.

| V1 | V2 |
|---|---|
| `session.promptAsync({ parts, directory })` | `session.prompt({ sessionID, text, delivery?, resume?, id? })` |
| `session.abort` | `session.interrupt({ sessionID, continue? })` |
| `session.create({ title, directory })` | `session.create({ title, agent, model, location, metadata })` |
| `parts[]` | `text` + `files` / `agents` / `skills` |
| empty prompt to resume | inbox wake, or `resume` |
| Kimaki queue Zustand | `delivery: "queue"` |

Plugin `SessionDomain` (only if you keep an in-process plugin): `create`, `get`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `synthetic`, `interrupt`, `rename`, `move`, `wait`, `context`, `hook`. No `abort`. No `fork`. Plugin `interrupt` typed `Promise<void>`; HTTP returns `{ interrupted }`.

RPC: `POST /api/rpc/:rpcID/:method` body `{ input }`, response `{ output? }`. Location on the **call options**, not inside plugin input.

`POST /api/plugin/await-activation` → **204**. Does not mean every plugin succeeded. `GET /api/plugin` returns 200 during setup; inventory can be incomplete. Await before depending on plugin RPC.

Kimaki leaks `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT`. Tests: private `HOME` / `XDG_*`, unset `OPENCODE_CONFIG_CONTENT`. Copy `opencode-v2/packages/core/script/test.ts`.

`@opencode-ai/core` npm has **no** `test/` helpers. Submodule branch `v2` if you need `packages/core/test/plugin/`.

# Event name cheat sheet

**Drop (not on `V2Event`):** `message.updated`, `message.part.*`, `permission.updated`, `question.*`, `session.error` as the main channel, `session.diff` as a part stream, `session.compacted`.

**Lifecycle:** `session.created`, `deleted`, `renamed`, `moved`, `forked`, `viewed`, `agent.selected`, `model.selected`, `status`, `idle` (deprecated), `execution.*`.

**Live + ended:** `session.text.*`, `reasoning.*`, `tool.input.*`, `tool.called`, `tool.progress`, `tool.success` / `failed`, `compaction.*`.

**Other:** `session.message.content.updated`, `usage.updated` (public, ephemeral), `usage.recorded` (durable, **internal**, not on public union), `step.started` / `streamed` / `ended` / `failed`, `inbox.*`, `instructions.updated`, `synthetic`, `skill.activated`, `shell.started` / `ended`, `retry.scheduled`, `revert.*`, `form.*`.

Footer: **`execution.succeeded` only**. Hide on **`execution.interrupted`**. Duration from last **`execution.started`**. Model from `created` or `step.started` (`data.model.id` + `providerID`). Tokens: `usage.updated` / `step.ended`. Context window may be missing; do not print fake `0%`.

Filter the process bus: `event.location.directory` when present, else sqlite `sessionID → directory`. Do not accept every event with no location.

# Config Kimaki must not smash

V2 still reads the same `opencode.json` paths. Native keys: `plugins`, `agents`, `permissions`, `providers`. V1 keys still load. Native wins on conflict.

Permission arrays are ordered. Do not inject bot allow-all over the user file.

Deterministic provider matchers still use AI SDK stream parts (`text-delta`, `tool-call`). That is the **model** stream, not the Kimaki bus. Wire via project `opencode.json`, not leaked `OPENCODE_CONFIG_CONTENT`.

# What to delete in `cli/`

- `opencode-interrupt-plugin.ts`
- Zustand queue for normal chat
- Render on `message.part.updated` snapshots
- Footer on `session.idle`
- `promptAsync({ parts: [] })` as resume
- `directory` on every session call as if v1
- `state.output` string as the only tool result
- Question handlers on `question.asked`
- Treating `prompt()` return as “user message is in the transcript”
- Treating one prompt as one step / one footer
- Storing all deltas in a tiny ring buffer
- Assuming SSE reconnect replays tokens

# What to keep (Discord)

`custom_id` 100, nonce 25, Components V2 budget, typing ~7s from busy/step-start not from user message, `allowedMentions`, 2000-char split, GuildMember unions, thread rename rate limit, worktree folder ≠ branch, line-based `. queue` / `. btw`, Digital Twin = fake Discord only.

# Test strategy

1. Spawn `opencode2 serve`, isolated XDG
2. `OpenCode.make` + Basic password
3. Digital Twin unchanged
4. New jsonl from v2 streams. V1 fixtures will not parse
5. First paths: new thread, follow-up, queue drain (key inboxID), interrupt with no footer, reconnect after drop (ended text still correct, no fake typewriter)
6. Permissions: ask `data.id` → reply `requestID`
7. Forms if you port questions

# Suggested `cli/` order

1. Serve + client + Basic auth + location on create only
2. `prompt` + inbox events + delete interrupt plugin
3. Renderer: delta fold by identity, commit on ended, footer on execution.succeeded
4. `/queue` → `delivery: "queue"`
5. Interrupt
6. Permissions + forms
7. Fork / compact via inbox+HTTP
8. One `opencode2` for many projects if stable

# Known gaps in this beta

- Docs import `@opencode/client`; npm is `@opencode-ai/client`
- `question.*` not on the client union; forms replace them
- `usage.recorded` internal
- Context % may be unknown
- Plugin domain has no `fork`
- APIs still move. Pin versions
- V1 Kimaki plugins do not load on v2. Rewrite or drop `kimaki-opencode-plugin.ts`
