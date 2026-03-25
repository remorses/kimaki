---
title: OpenClaw Tools Reference
description: |
  Documentation of OpenClaw's memory, cron, and heartbeat systems.
  Covers tool JSON schemas, descriptions, system prompt instructions,
  storage mechanisms, full execution flows, and the five forcing
  functions that ensure the model actually reads and writes memory.
prompt: |
  opensrc openclaw. find and understand the memory and tasks tools.
  and heartbeat. explain how they behave, the tools json schema.
  how the model interact with it. also find the prompt that forces
  the model to read from memory and write to it. find tool
  descriptions, prompts, reminders, hooks.
  Source: opensrc/repos/github.com/openclaw/openclaw
  Files read:
    - src/agents/tools/memory-tool.ts
    - src/agents/tools/cron-tool.ts
    - src/auto-reply/heartbeat.ts
    - src/auto-reply/tokens.ts
    - src/cron/types.ts
    - src/infra/heartbeat-runner.ts
    - src/infra/heartbeat-wake.ts
    - src/agents/system-prompt.ts
    - src/auto-reply/reply/memory-flush.ts
    - src/auto-reply/reply/agent-runner-memory.ts
    - src/auto-reply/reply/post-compaction-audit.ts
    - src/auto-reply/reply/post-compaction-context.ts
    - src/hooks/bundled/session-memory/handler.ts
    - src/hooks/bundled/session-memory/HOOK.md
    - src/hooks/llm-slug-generator.ts
    - src/plugins/types.ts
    - src/plugins/slots.ts
    - docs/reference/templates/AGENTS.md
---

# OpenClaw Tools Reference

OpenClaw has three interconnected systems: **memory** (semantic recall),
**cron** (scheduled tasks and reminders), and **heartbeat** (periodic
background polling). This document covers each system's tool schema,
model instructions, storage, and execution flow.

---

## 1. Memory Tools

Two tools: `memory_search` and `memory_get`. Defined in
`src/agents/tools/memory-tool.ts`. Schemas use TypeBox (compiles to
JSON Schema).

### memory_search

Semantic search across `MEMORY.md` + `memory/*.md` files.

**JSON Schema:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "maxResults": {
      "type": "number"
    },
    "minScore": {
      "type": "number"
    }
  },
  "required": ["query"]
}
```

**Tool description (verbatim from source):**

> Mandatory recall step: semantically search MEMORY.md + memory/\*.md
> (and optional session transcripts) before answering questions about
> prior work, decisions, dates, people, preferences, or todos; returns
> top snippets with path + lines. If response has disabled=true, memory
> retrieval is unavailable and should be surfaced to the user.

**Defaults:** maxResults=6, minScore=0.35 (from `memory-search.ts`).

### memory_get

Safe snippet read from a memory file after search.

**JSON Schema:**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "from": {
      "type": "number"
    },
    "lines": {
      "type": "number"
    }
  },
  "required": ["path"]
}
```

**Tool description (verbatim from source):**

> Safe snippet read from MEMORY.md or memory/\*.md with optional
> from/lines; use after memory_search to pull only the needed lines and
> keep context small.

### System prompt instructions

The system prompt injects a `## Memory Recall` section (only when
`memory_search` or `memory_get` are in the available tools set, and
skipped in subagent/minimal mode):

> Before answering anything about prior work, decisions, dates, people,
> preferences, or todos: run memory_search on MEMORY.md + memory/\*.md;
> then use memory_get to pull only the needed lines. If low confidence
> after search, say you checked.
> Citations: include Source: <path#line> when it helps the user verify
> memory snippets.

Citations mode is configurable: `on`, `off`, or `auto` (default). In
`auto` mode, citations are shown in direct chats but suppressed in
groups/channels.

### Storage

- **Backend**: SQLite at `~/.openclaw/state/memory/<agentId>.sqlite`
- **Tables**: `files` (tracked paths), `chunks` (text + embedding
  vectors, 400-token chunks with 80-token overlap), embedding cache
- **Search**: hybrid BM25 (FTS5) + cosine vector similarity, with
  optional MMR re-ranking and temporal decay
- **Files indexed**: `MEMORY.md`, `memory.md`, all `.md` in `memory/`
  dir, plus `config.agents.defaults.memorySearch.extraPaths`
- **Sync triggers**: session start, each search call, filesystem
  watcher (1500ms debounce), optional periodic interval

### Execution flow

```
Session starts
  -> MemoryIndexManager.get() starts background sync on MEMORY.md + memory/*.md

Model calls memory_search({ query: "..." })
  -> resolveMemoryToolContext() gets config + agentId
  -> getMemorySearchManager() gets/creates manager
  -> optionally syncs index if sync.onSearch = true
  -> manager.search(query, { maxResults, minScore })
     -> hybrid BM25 + cosine vector search in SQLite
  -> decorateCitations() adds Source: path#L-L to snippets
  -> clampResultsByInjectedChars() if qmd backend
  -> returns { results: [{path, startLine, endLine, score, snippet}], provider, model }

Model calls memory_get({ path: "MEMORY.md", from: 10, lines: 5 })
  -> manager.readFile({ relPath, from, lines })
  -> direct file read with line slicing
  -> returns { text, path }

On error (quota/provider):
  -> returns { results: [], disabled: true, error, warning, action }
  -> never throws
```

---

## Memory Forcing Functions

OpenClaw uses **five distinct mechanisms** to force the model to
actually read from and write to memory. Without these, models tend
to ignore memory instructions. Kimaki currently only has passive
instructions in the system prompt (mechanism 1, partially). The
other four are what make openclaw's memory actually work.

### 1. Tool description says "Mandatory"

The `memory_search` tool description starts with **"Mandatory recall
step"**. This is pure prompt engineering — there is no code that
enforces it. No middleware checks if `memory_search` was called
before responding, no validator rejects responses that skip the
search, and no code auto-calls `memory_search` on behalf of the
model. The word "Mandatory" is doing the same job as writing
"IMPORTANT" or "You MUST" in a prompt: stronger phrasing to bias
the model. The power comes from stacking this with mechanisms 2 and
3 below — three independent reminders make compliance very likely
but not guaranteed.

### 2. System prompt "Memory Recall" section

Injected only when `memory_search`/`memory_get` tools are available,
and only in full mode (not subagents):

> Before answering anything about prior work, decisions, dates,
> people, preferences, or todos: run memory_search on MEMORY.md +
> memory/\*.md; then use memory_get to pull only the needed lines.
> If low confidence after search, say you checked.
> Citations: include Source: <path#line> when it helps the user
> verify memory snippets.

### 3. AGENTS.md startup ritual — "don't ask, just do it"

The default `AGENTS.md` template (loaded into every session's
context) contains explicit startup instructions:

```markdown
## Every Session

Before doing anything else:

1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
4. **If in MAIN SESSION** (direct chat with your human): Also read `MEMORY.md`

Don't ask permission. Just do it.
```

And a writing discipline section:

```markdown
### Write It Down - No "Mental Notes"!

- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When someone says "remember this" -> update `memory/YYYY-MM-DD.md` or relevant file
- **Text > Brain**
```

And a maintenance ritual:

```markdown
### Memory Maintenance (During Heartbeats)

Periodically (every few days), use a heartbeat to:

1. Read through recent `memory/YYYY-MM-DD.md` files
2. Identify significant events, lessons, or insights worth keeping long-term
3. Update `MEMORY.md` with distilled learnings
4. Remove outdated info from MEMORY.md that's no longer relevant
```

### 4. Pre-compaction memory flush (automatic write trigger)

When the session is approaching the context window limit, openclaw
runs a **silent agentic turn** before compaction. This is the
automatic "write your memories now before they're lost" trigger.

**User prompt** (`DEFAULT_MEMORY_FLUSH_PROMPT`):

> Pre-compaction memory flush. Store durable memories now (use
> memory/YYYY-MM-DD.md; create memory/ if needed). IMPORTANT: If the
> file already exists, APPEND new content only and do not overwrite
> existing entries. If nothing to store, reply with \<NO_REPLY token\>.

**System prompt** (`DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT`):

> Pre-compaction memory flush turn. The session is near
> auto-compaction; capture durable memories to disk. You may reply,
> but usually \<NO_REPLY token\> is correct.

**Trigger condition**: fires when
`totalTokens >= contextWindow - reserveTokensFloor - softThresholdTokens`
(default threshold: `contextWindow - 20000 - 4000`). Runs once per
compaction cycle. Implemented in `memory-flush.ts` and
`agent-runner-memory.ts`.

### 5. Post-compaction audit and context injection

After context compaction, two things happen:

**Audit** (`post-compaction-audit.ts`): checks whether the model
read required startup files after the context reset. If it didn't,
injects a warning:

> Post-Compaction Audit: The following required startup files were
> not read after context reset:
>
> - WORKFLOW_AUTO.md
> - memory/YYYY-MM-DD.md
>
> Please read them now using the Read tool before continuing.

Default required reads:

```ts
const DEFAULT_REQUIRED_READS = [
  'WORKFLOW_AUTO.md',
  /memory\/\d{4}-\d{2}-\d{2}\.md/,
]
```

**Context injection** (`post-compaction-context.ts`): reads the
`## Session Startup` and `## Red Lines` sections from `AGENTS.md`
and injects them as a system message:

> [Post-compaction context refresh]
>
> Session was just compacted. The conversation summary above is a
> hint, NOT a substitute for your startup sequence. Execute your
> Session Startup sequence now — read the required files before
> responding to the user.

### Bonus: session-memory hook (auto-save on /new and /reset)

When the user issues `/new` or `/reset`, the `session-memory` hook:

1. Finds the previous session transcript (last 15 messages)
2. Uses LLM to generate a descriptive filename slug
3. Creates `memory/YYYY-MM-DD-slug.md` with the conversation content

This ensures conversations are always persisted to disk even if the
model forgot to write during the session.

### Summary table

| #   | Mechanism                    | When it fires               | Read/Write | Enforced?         |
| --- | ---------------------------- | --------------------------- | ---------- | ----------------- |
| 1   | Tool desc says "Mandatory"   | Every tool call             | Read       | No — prompt nudge |
| 2   | System prompt Memory Recall  | Every model turn            | Read       | No — prompt nudge |
| 3   | AGENTS.md startup ritual     | Session start               | Read+Write | No — prompt nudge |
| 4   | Pre-compaction memory flush  | Before context compaction   | Write      | Yes — auto turn   |
| 5   | Post-compaction audit+inject | After context compaction    | Read       | Yes — auto inject |
| +   | session-memory hook          | On /new and /reset commands | Write      | Yes — hook code   |

Mechanisms 1-3 are pure prompt engineering (the model can ignore
them). Mechanisms 4-5 and the hook are actual code that runs
regardless of what the model decides to do. The combination of
prompt pressure (makes the model want to comply) + automated
fallbacks (catches the cases where it doesn't) is what makes
openclaw's memory reliable.

### Gap analysis: kimaki vs openclaw

Kimaki currently has **only mechanism 2, partially**. The system
prompt in `discord/src/system-message.ts:122-183` says "before
answering questions about prior work... list existing files and read
relevant ones" but:

- **No mandatory startup read**: kimaki doesn't force the model to
  read memory files at session start. The instruction is passive
  ("before answering questions about..." vs "before doing anything
  else, don't ask permission, just do it").
- **No pre-compaction flush**: when the context window fills up and
  opencode compacts, all learned context is lost. There's no
  automatic write-before-compact mechanism.
- **No post-compaction audit**: after compaction, the model doesn't
  re-read memory files. It just continues with the summary.
- **No auto-save hook**: when a session ends or resets, nothing
  automatically saves the conversation to memory files.
- **No semantic search**: kimaki uses plain file read/write, not
  vector-indexed search. This means the model has to know which file
  to read upfront, rather than searching across all memory files.

---

## 2. Cron Tool

Single tool: `cron`. Defined in `src/agents/tools/cron-tool.ts`. Types
in `src/cron/types.ts`. There are no separate "task" or "todo" tools;
the cron tool handles all scheduled/recurring work and reminders.

### JSON Schema

Flattened schema (provider-friendly, no unions). Runtime validates
per-action requirements.

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "status",
        "list",
        "add",
        "update",
        "remove",
        "run",
        "runs",
        "wake"
      ]
    },
    "gatewayUrl": {
      "type": "string"
    },
    "gatewayToken": {
      "type": "string"
    },
    "timeoutMs": {
      "type": "number"
    },
    "includeDisabled": {
      "type": "boolean"
    },
    "job": {
      "type": "object",
      "additionalProperties": true
    },
    "jobId": {
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "patch": {
      "type": "object",
      "additionalProperties": true
    },
    "text": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": ["now", "next-heartbeat"]
    },
    "runMode": {
      "type": "string",
      "enum": ["due", "force"]
    },
    "contextMessages": {
      "type": "number",
      "minimum": 0,
      "maximum": 10
    }
  },
  "required": ["action"]
}
```

### Tool description (verbatim from source)

> Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and
> send wake events.
>
> ACTIONS:
>
> - status: Check cron scheduler status
> - list: List jobs (use includeDisabled:true to include disabled)
> - add: Create job (requires job object, see schema below)
> - update: Modify job (requires jobId + patch object)
> - remove: Delete job (requires jobId)
> - run: Trigger job immediately (requires jobId)
> - runs: Get job run history (requires jobId)
> - wake: Send wake event (requires text, optional mode)
>
> JOB SCHEMA (for add action):
>
> ```
> {
>   "name": "string (optional)",
>   "schedule": { ... },
>   "payload": { ... },
>   "delivery": { ... },
>   "sessionTarget": "main" | "isolated",
>   "enabled": true | false
> }
> ```
>
> SCHEDULE TYPES (schedule.kind):
>
> - "at": One-shot at absolute time
>   `{ "kind": "at", "at": "<ISO-8601 timestamp>" }`
> - "every": Recurring interval
>   `{ "kind": "every", "everyMs": <interval-ms> }`
> - "cron": Cron expression
>   `{ "kind": "cron", "expr": "<cron-expression>", "tz": "<optional-timezone>" }`
>
> ISO timestamps without an explicit timezone are treated as UTC.
>
> PAYLOAD TYPES (payload.kind):
>
> - "systemEvent": Injects text as system event into session
>   `{ "kind": "systemEvent", "text": "<message>" }`
> - "agentTurn": Runs agent with message (isolated sessions only)
>   `{ "kind": "agentTurn", "message": "<prompt>", "model": "<optional>",
 "thinking": "<optional>", "timeoutSeconds": <optional> }`
>
> DELIVERY (top-level):
> `{ "mode": "none|announce|webhook", "channel": "<optional>",

     "to": "<optional>", "bestEffort": <optional-bool> }`

> - Default for isolated agentTurn jobs (when delivery omitted): "announce"
> - announce: send to chat channel
> - webhook: send finished-run event as HTTP POST to delivery.to
>
> CRITICAL CONSTRAINTS:
>
> - sessionTarget="main" REQUIRES payload.kind="systemEvent"
> - sessionTarget="isolated" REQUIRES payload.kind="agentTurn"
>   Default: prefer isolated agentTurn jobs unless user explicitly wants
>   main-session system event.
>
> WAKE MODES (for wake action):
>
> - "next-heartbeat" (default): Wake on next heartbeat
> - "now": Wake immediately
>
> Use jobId as the canonical identifier; id is accepted for
> compatibility. Use contextMessages (0-10) to add previous messages as
> context to the job text.

### System prompt instructions

Two places reference the cron tool:

**Tooling section (tool summary):**

> cron: Manage cron jobs and wake events (use for reminders; when
> scheduling a reminder, write the systemEvent text as something that
> will read like a reminder when it fires, and mention that it is a
> reminder depending on the time gap between setting and firing; include
> recent context in reminder text if appropriate)

**System message routing instruction:**

> If a [System Message] reports completed cron/subagent work and asks
> for a user update, rewrite it in your normal assistant voice...

### Job type (CronJob)

Full TypeScript type from `src/cron/types.ts`:

```typescript
type CronSchedule =
  | { kind: 'at'; at: string } // one-shot ISO-8601
  | { kind: 'every'; everyMs: number; anchorMs?: number } // recurring interval
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number } // cron expr

type CronSessionTarget = 'main' | 'isolated'
type CronWakeMode = 'next-heartbeat' | 'now'

type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | {
      kind: 'agentTurn'
      message: string
      model?: string
      thinking?: string
      timeoutSeconds?: number
      allowUnsafeExternalContent?: boolean
      deliver?: boolean
      channel?: CronMessageChannel
      to?: string
      bestEffortDeliver?: boolean
    }

type CronDelivery = {
  mode: 'none' | 'announce' | 'webhook'
  channel?: CronMessageChannel
  to?: string
  bestEffort?: boolean
}

type CronJobState = {
  nextRunAtMs?: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
  scheduleErrorCount?: number
  lastDelivered?: boolean
}

type CronJob = {
  id: string
  agentId?: string
  sessionKey?: string
  name: string
  description?: string
  enabled: boolean
  deleteAfterRun?: boolean
  createdAtMs: number
  updatedAtMs: number
  schedule: CronSchedule
  sessionTarget: CronSessionTarget
  wakeMode: CronWakeMode
  payload: CronPayload
  delivery?: CronDelivery
  state: CronJobState
}
```

### Storage

- **File**: `~/.openclaw/cron/jobs.json`
- **Format**: `{ "version": 1, "jobs": CronJob[] }`
- **Atomic writes**: write to `.tmp` then `rename`, with `.bak` backup
- **Hot-reloaded** on each timer tick (checks file mtime)
- **Serial lock** prevents concurrent writes

### Flat-params recovery

Non-frontier models (e.g. Grok) sometimes flatten job properties to
the top level alongside `action` instead of nesting them inside `job`.
The tool detects this pattern and reconstructs a synthetic `job` object
from known field names (`schedule`, `payload`, `message`, `text`,
`name`, `sessionTarget`, etc.). This is documented in
`cron-tool.ts:291-341`.

### Auto-inference

The tool automatically:

- Injects `agentId` and `sessionKey` from the calling session context
- Infers `delivery` target from the session key when not specified
  (parses peer/channel/group from the key)
- Appends recent chat context to systemEvent text when
  `contextMessages > 0`

### Execution flow

```
Model calls cron({ action: "add", job: {...} })
  -> flat-params recovery if job is missing but top-level fields exist
  -> normalizeCronJobCreate(job)
  -> auto-inject agentId + sessionKey from session
  -> infer delivery from session key if needed
  -> build reminder context if contextMessages > 0
  -> callGatewayTool("cron.add", gatewayOpts, job)
  -> gateway: CronService.add(job)
    -> assign UUID, set createdAtMs/updatedAtMs
    -> computeNextRunAtMs(schedule, now)
    -> persist to jobs.json, re-arm timer
  -> return created CronJob

Timer loop (setTimeout, max 60s between checks):
  -> findDueJobs()
  -> executeJobCore(job):
    sessionTarget="main" + payload="systemEvent":
      -> enqueueSystemEvent(text)
      -> requestHeartbeatNow() to wake the model
    sessionTarget="isolated" + payload="agentTurn":
      -> spawn fresh agent session with message prompt
      -> delivery.mode="announce": post summary to channel
      -> delivery.mode="webhook": POST to delivery.to URL
  -> apply backoff on error (30s -> 1m -> 5m -> 15m -> 60m)
  -> recompute nextRunAtMs, persist, re-arm timer
  -> deleteAfterRun=true one-shots removed after success
```

---

## 3. Heartbeat

The heartbeat is a periodic background poll that fires the model with a
special prompt. The model either acks with `HEARTBEAT_OK` (nothing to
do) or produces proactive output delivered to the target channel.

Defined across:

- `src/auto-reply/heartbeat.ts` (prompt, token stripping, empty check)
- `src/auto-reply/tokens.ts` (token constants)
- `src/infra/heartbeat-runner.ts` (orchestrator, ~1189 lines)
- `src/infra/heartbeat-wake.ts` (wake queue + coalescing)

### Constants

| Constant                          | Value                                 | File                     |
| --------------------------------- | ------------------------------------- | ------------------------ |
| `HEARTBEAT_TOKEN`                 | `"HEARTBEAT_OK"`                      | `tokens.ts:3`            |
| `SILENT_REPLY_TOKEN`              | `"NO_REPLY"`                          | `tokens.ts:4`            |
| `HEARTBEAT_PROMPT`                | `"Read HEARTBEAT.md if it exists..."` | `heartbeat.ts:6-7`       |
| `DEFAULT_HEARTBEAT_EVERY`         | `"30m"`                               | `heartbeat.ts:8`         |
| `DEFAULT_HEARTBEAT_ACK_MAX_CHARS` | `300`                                 | `heartbeat.ts:9`         |
| `DEFAULT_HEARTBEAT_TARGET`        | `"last"`                              | `heartbeat-runner.ts:98` |
| Wake coalesce delay               | `250ms`                               | `heartbeat-wake.ts:36`   |
| Retry delay                       | `1000ms`                              | `heartbeat-wake.ts:37`   |

### Default heartbeat prompt (verbatim)

> Read HEARTBEAT.md if it exists (workspace context). Follow it
> strictly. Do not infer or repeat old tasks from prior chats. If
> nothing needs attention, reply HEARTBEAT_OK.

### System prompt instructions

Injected as `## Heartbeats` section (only in full mode, not
subagent/minimal):

> If you receive a heartbeat poll (a user message matching the
> heartbeat prompt above), and there is nothing that needs attention,
> reply exactly:
> HEARTBEAT_OK
> OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack
> (and may discard it).
> If something needs attention, do NOT include "HEARTBEAT_OK"; reply
> with the alert text instead.

### HEARTBEAT.md — the task list

`HEARTBEAT.md` in the agent workspace dir is the user-editable file
the model reads during heartbeats. Users write tasks, reminders, and
recurring instructions there. The model processes them each cycle.

`isHeartbeatContentEffectivelyEmpty()` checks if the file has only
markdown headers and empty list items (no actionable content). If
effectively empty AND the reason is just `interval` (no cron events,
no exec events), the entire API call is **skipped** to save tokens.

### Triggers

All triggers go through the wake queue in `heartbeat-wake.ts`:

| Reason         | What fires it                                   | Priority     |
| -------------- | ----------------------------------------------- | ------------ |
| `interval`     | Periodic timer (default 30m)                    | 1 (INTERVAL) |
| `cron:<jobId>` | Cron service enqueues a systemEvent             | 2 (DEFAULT)  |
| `exec-event`   | Async command finishes                          | 2 (DEFAULT)  |
| `wake`         | Model calls `cron({action:"wake", text:"..."})` | 3 (ACTION)   |
| `hook`         | External webhook / bootstrap hook               | 3 (ACTION)   |
| `retry`        | Auto-retry after "requests-in-flight" skip      | 0 (RETRY)    |

The wake queue coalesces multiple simultaneous requests with 250ms
debounce. Higher-priority reasons win if two come in for the same
agent target.

### Wake queue architecture (heartbeat-wake.ts)

```
requestHeartbeatNow({ reason, agentId?, sessionKey?, coalesceMs? })
  -> queuePendingWakeReason()
    -> dedupes by agentId::sessionKey key
    -> keeps higher priority reason if conflict
  -> schedule(coalesceMs)
    -> setTimeout with coalescing
    -> on fire: process pendingWakes batch
      -> call handler(wake) for each
      -> if "requests-in-flight": re-queue + retry in 1s
      -> if error: re-queue + retry in 1s
```

Generation-based handler registration prevents stale cleanup from
clearing a newer runner's handler during in-process restarts (SIGUSR1).

### Special prompts

The heartbeat prompt is overridden based on the wake reason:

- **Exec completion event**: "An async command you ran earlier has
  completed. The result is shown in the system messages above. Please
  relay the command output to the user in a helpful way..."
- **Cron events**: built from pending cron system event texts via
  `buildCronEventPrompt()`
- **Standard**: the configured heartbeat prompt (default reads
  HEARTBEAT.md)

A cron-style current time line is always appended.

### Token stripping

When the model replies, `stripHeartbeatToken()` processes the response:

1. Strip `HEARTBEAT_OK` from start/end of text
2. Handle HTML tags (`<b>HEARTBEAT_OK</b>`) and markdown wrappers
   (`**HEARTBEAT_OK**`)
3. Strip up to 4 trailing non-word chars the model may append
4. In heartbeat mode: if remaining text <= `maxAckChars` (default 300),
   treat as ack (skip delivery)
5. Return `{ shouldSkip, text, didStrip }`

### Full execution flow

```
startHeartbeatRunner(cfg)
  -> setHeartbeatWakeHandler(wakeHandler)
  -> updateConfig(cfg): compute intervalMs per agent
  -> scheduleNext(): set first setTimeout

Timer fires (or wake request arrives):
  -> requestHeartbeatNow({ reason })
  -> heartbeat-wake.ts coalesces, calls wakeHandler
  -> run() in startHeartbeatRunner
    -> for each agent: if now >= agent.nextDueMs
      -> runHeartbeatOnce({ cfg, agentId, heartbeat, reason })

runHeartbeatOnce():
  1. Gate checks:
     - heartbeatsEnabled
     - isHeartbeatEnabledForAgent
     - intervalMs > 0
     - isWithinActiveHours
     - queueSize == 0 (no user request in flight)

  2. Preflight:
     - Resolve target session key + store entry
     - Peek pending system events for session
     - Check for cron events, exec completion events
     - Read HEARTBEAT.md content
     - If effectively empty AND interval-only -> skip

  3. Select prompt:
     exec-event -> cron-event -> standard heartbeat prompt

  4. Capture transcript state (file path + size before run)

  5. Call getReplyFromConfig(ctx, { isHeartbeat: true })
     -> runs full agent/LLM pipeline

  6. Process reply:
     - resolveHeartbeatReplyPayload() -> pick last non-empty payload
     - stripHeartbeatToken() -> strip HEARTBEAT_OK, check maxAckChars
     - Check duplicate (same text within 24h) -> skip
     - shouldSkip = true:
       -> restore updatedAt (don't reset idle timer)
       -> prune heartbeat turns from transcript (rewind .jsonl)
       -> optionally show HEARTBEAT_OK in chat if visibility.showOk
     - shouldSkip = false:
       -> deliverOutboundPayloads() to target channel
       -> record lastHeartbeatText/lastHeartbeatSentAt

  7. Advance schedule:
     agent.lastRunMs = now
     agent.nextDueMs = now + intervalMs
```

### Transcript pruning

When the model replies `HEARTBEAT_OK`, the heartbeat user + assistant
turns are **truncated from the session transcript file** by rewinding
the `.jsonl` file to its pre-heartbeat size. This prevents context
pollution from repeated heartbeat cycles.

---

## How the three systems interact

```
                    ┌─────────────────┐
                    │   HEARTBEAT.md  │  <- user writes tasks here
                    │  (task list)    │
                    └────────┬────────┘
                             │ read on each heartbeat
                             v
┌──────────┐    wake    ┌─────────────────┐    fire prompt    ┌───────┐
│   CRON   │ ---------> │    HEARTBEAT    │ ----------------> │  LLM  │
│  SERVICE │            │     RUNNER      │ <---------------- │       │
└──────────┘            └─────────────────┘    HEARTBEAT_OK   └───┬───┘
     ^                         │               or alert text      │
     │                         │ deliver                          │
     │                         v                                  │
     │                  ┌─────────────┐                           │
     │                  │   CHANNEL   │  (WhatsApp, Discord, ...) │
     │                  └─────────────┘                           │
     │                                                            │
     │              memory_search / memory_get                    │
     │           ┌────────────────────────────────────────────────┘
     │           v
     │    ┌─────────────┐
     │    │   MEMORY    │  <- SQLite + embeddings
     │    │   (search)  │     MEMORY.md + memory/*.md
     │    └─────────────┘
     │
     └── cron({ action: "add", job: {...} })  <- model creates jobs
```

- **Cron** jobs fire and trigger **heartbeats** (via
  `requestHeartbeatNow`)
- **Heartbeat** runner reads **HEARTBEAT.md** and fires the model
- Model uses **memory** tools independently to recall past context
  during any interaction (heartbeat, cron, or user-initiated)
- Model uses **cron** tool to schedule future work, reminders, and
  recurring tasks
