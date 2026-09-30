---
title: Kimaki rebuild spec on OpenCode V2
description: >
  First-principles spec of what Kimaki does for the user today, how every part works
  (Discord ingress, prompts, plugins, tools, event loop, markdown, queue, btw, onboarding,
  CLI), and how to rebuild it on the OpenCode V2 event model with almost no Kimaki state.
---

# Kimaki rebuild spec on OpenCode V2

Kimaki turns a **Discord server into a remote control for OpenCode**. One Discord channel
maps to one project folder. One Discord thread maps to one OpenCode session. The user
types in Discord; the agent works on the user's machine; the agent's output streams back
into the thread.

```
Discord user ──message──▶ Kimaki bot process ──session.prompt──▶ OpenCode V2 server
     ▲                          │  ▲                                    │
     │                          │  └──────── /api/event (one stream) ◀──┘
     └──── thread messages ◀────┘            session.text.* / tool.* / execution.*
```

This document has three jobs:

1. describe **current behavior** from the user's point of view (the product we keep)
2. describe **current implementation**, with source paths, so nothing is lost
3. define the **V2 design**: what OpenCode now owns, what Kimaki keeps, what we delete

Rule for the rebuild: **OpenCode events are the source of truth.** Kimaki keeps only
Discord-specific facts that OpenCode cannot know (thread ↔ session binding, channel ↔
directory, bot credentials, user preferences, scheduled tasks). Everything about a run
(busy, queue, pending question, tokens, model, agent, footer) is derived from events.

Target API (full reference in [section 28](#28-opencode-v2-architecture-and-api-reference)): `@opencode/client`, `@opencode/plugin` from the OpenCode `v2` branch
(currently `2.0.20`). The old migration branch pinned `2.0.2`; some method names differ
(see [section 20](#20-open-questions-and-risks)). Pin one version and treat the generated
client types as the contract, not the docs (docs have stale signatures).

---

## Table of contents

- [1. Product from the user's point of view](#1-product-from-the-users-point-of-view)
- [2. Processes and transports](#2-processes-and-transports)
- [3. Onboarding (current)](#3-onboarding-current)
- [4. Discord ingress](#4-discord-ingress)
- [5. What we send to the model](#5-what-we-send-to-the-model)
- [6. The event loop (core of the rebuild)](#6-the-event-loop-core-of-the-rebuild)
- [7. Model output to Discord messages](#7-model-output-to-discord-messages)
- [8. Markdown pipeline and extensions](#8-markdown-pipeline-and-extensions)
- [9. Interrupt, queue, btw](#9-interrupt-queue-btw)
- [10. Interactive UI: questions, permissions, buttons, uploads, sleep](#10-interactive-ui)
- [11. OpenCode plugins we inject](#11-opencode-plugins-we-inject)
- [12. Tools we inject](#12-tools-we-inject)
- [13. Plugin ↔ bot transport](#13-plugin--bot-transport)
- [14. Discord slash commands](#14-discord-slash-commands)
- [15. Kimaki CLI commands](#15-kimaki-cli-commands)
- [16. Secondary features](#16-secondary-features)
- [17. State inventory: keep, derive, delete](#17-state-inventory-keep-derive-delete)
- [18. Removal list](#18-removal-list)
- [19. Proposed module layout](#19-proposed-module-layout)
- [20. Open questions and risks](#20-open-questions-and-risks)
- [21. Review of the existing V2 branch](#21-review-of-the-existing-v2-branch)
- [22. Coupled features: remove candidates](#22-coupled-features-remove-candidates)
- [23. CLI simplification](#23-cli-simplification)
- [24. Multiple machines](#24-multiple-machines)
- [25. Feature loss and persistence audit](#25-feature-loss-and-persistence-audit)
- [26. Remaining complexity to cut](#26-remaining-complexity-to-cut)
- [27. Code architecture](#27-code-architecture)
- [28. OpenCode V2 architecture and API reference](#28-opencode-v2-architecture-and-api-reference)
- [29. Ground truth: recorded V2 event streams](#29-ground-truth-recorded-v2-event-streams)

---

## 1. Product from the user's point of view

### The core loop

1. User runs `npx kimaki` once. Onboarding connects a Discord server and picks projects.
2. Each project gets a text channel in a `Kimaki` category.
3. User writes a message in a project channel. Kimaki creates a **thread**, starts an
   OpenCode session in that folder, and replies inside the thread.
4. The agent's text, tool calls, questions, and permission prompts show up in the thread.
5. When the turn ends, a **footer** shows folder, branch, duration, context %, model.
6. Any message in the thread continues the same session.

### What a thread looks like

```
Tommy: fix the flaky login test
-# *using anthropic/claude-opus-4-6 ⋅ build*          ◀── banner, new session only
Looking at the test first.                            ◀── text, full width (V2: never quoted)
-# ┣ bash _pnpm test login_                           ◀── tool part, subtext
-# ◼︎ *login.test.ts* (+4-2)                            ◀── file edit
The test raced the session cookie. I await it now.    ◀── final text, full width
-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6*   ◀── footer
```

### Things the user can do inside a thread

| Action | How | Effect |
|---|---|---|
| Continue | plain message | interrupts the current run and sends the new prompt |
| Queue | `message. queue` or `/queue` | runs after the current run ends |
| Side question | `question. btw` or `/btw` | forks the session into a new `btw:` thread |
| Shell | `!ls -la` | runs a shell command in the project dir, streams output, no model turn |
| Stop | `/abort` | stops the run, clears the queue |
| Undo / redo | `/undo`, `/redo` | reverts file changes of the last turn |
| Change model / agent | `/model`, `/agent`, `/<name>-agent` | affects next turn |
| Voice | Discord voice message | transcribed, then sent as a prompt |
| Attach files | Discord attachments | images/PDF go inline, text files inlined or saved |
| Answer questions | dropdowns under the question | replies to the agent's `question` tool |
| Approve tools | Accept / Accept Always / Deny buttons | replies to permission requests |

### Things the agent can do to the user

- ask multiple-choice questions (dropdowns)
- show 1-3 **action buttons** (click sends `User clicked: X` or runs a shell command)
- request **file uploads** (native Discord file picker)
- **sleep** for hours or days and wake itself up in the same thread
- **upload files** to the thread (`kimaki upload-to-discord`)
- start **new threads/sessions** in any project (`kimaki send`), schedule cron tasks,
  read other sessions, create worktrees, open tunnels to dev servers

---

## 2. Processes and transports

### Current process map

```
 user machine
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ bin.ts wrapper (restarts child on crash, SIGUSR2 = restart)                          │
│   └─▶ kimaki bot process  (cli-runner.ts, discord-bot.ts)                            │
│         ├─ discord.js client ──────────────▶ Discord  (or gateway-proxy, see below)  │
│         ├─ SQLite ~/.kimaki/discord-sessions.db (direct file access)                 │
│         ├─ lock-port HTTP server :29988 (hrana-server.ts)                            │
│         │     /health  /kimaki/opencode-port  /kimaki/wake  /v2 /v2/pipeline (Hrana) │
│         ├─ SSE client  GET /global/event ◀─────────────────────────┐                 │
│         └─ spawns ONE `opencode serve` for all projects             │                 │
│               ├─ loads kimaki-opencode-plugin.ts (14 exports)       │                 │
│               ├─ loads @subrouter/opencode                          │                 │
│               ├─ plugin writes SQLite via Hrana HTTP ──▶ lock port  │                 │
│               └─ agent bash runs `kimaki ...` via ~/.kimaki/bin shim                  │
│                     (CLI subcommands: direct SQLite + Discord REST)                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Source: `cli/src/opencode.ts` lines 1-6: "ONE opencode serve process shared by all
project directories." Each SDK client scopes requests with `x-opencode-directory`.

### Why a plugin ↔ bot transport exists at all

The plugin runs **inside the OpenCode server process**. The Discord connection lives in
the **bot process**. Some tools need Discord UI and must wait for a human:

- `kimaki_file_upload` waits for the user to pick files, then returns local paths
- `kimaki_action_buttons` needs the bot to render buttons
- `kimaki_sleep` must persist a wake time the bot's scheduler can see

The plugin cannot talk to Discord (no gateway, and in gateway mode no bot token is
passed to it on purpose). So it needs a channel to the bot. Today that channel is
**SQLite rows over HTTP**:

```
plugin tool ──INSERT ipc_requests (Hrana HTTP, Bearer token)──▶ bot lock port ──▶ SQLite
bot ipc-polling.ts ──every 200ms claim pending rows──▶ show Discord UI ──▶ UPDATE response
plugin tool ──polls its row every 300ms (max 6 min)──▶ reads response ──▶ tool result
```

That is why `hrana-server.ts`, `ipc-polling.ts`, `ipc_requests`, `KIMAKI_DB_URL`,
`KIMAKI_DB_AUTH_TOKEN`, and `plugin-opencode-client.ts` exist. In V2 all of it goes away
(see [section 13](#13-plugin--bot-transport)).

### Gateway mode vs self-hosted

```
self-hosted:  bot process ──bot token──────────────────────────────▶ Discord
gateway:      bot process ──clientId:secret──▶ gateway-proxy (Rust, fly.io) ──▶ Discord
                                                   one shared "Kimaki" bot for all users
```

In gateway mode REST calls must be guild-scoped or allowlisted by the proxy. The rebuild
keeps this unchanged. See `docs/gateway-architecture.md`.

### V2 process map

```
 user machine
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ kimaki bot process                                                                   │
│   ├─ discord.js ─────────────────────────────▶ Discord / gateway-proxy               │
│   ├─ SQLite (bot-only, config + bindings)                                            │
│   ├─ lock-port HTTP: /health, /kimaki/send                                           │
│   ├─ @opencode/client  OpenCode.make({ baseUrl, headers: Basic auth })               │
│   │     └─ client.event.subscribe()  ◀── ONE stream, all locations, all sessions     │
│   └─ connects to the user's OpenCode service (Service.discover / ensure)            │
│         └─ plugins (Plugin.define): kimaki  +  subrouter                             │
│               no SQLite, no HTTP back to bot, no timers that abort sessions          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Facts that make this possible (verified in `opencode/v2` source):

- one server serves many directories; requests take `location: { directory }`
- one `/api/event` subscription covers all loaded locations
- queueing (`delivery: "queue"`), steering, interrupt, forms, permissions, durable
  instructions, fork, revert, compaction are native
- plugins can register RPC methods and emit `rpc.<id>.<event>` on the same stream


### V2 components and how they talk

```
                         ┌──────────────── Discord (or gateway-proxy) ───────────────┐
                         │ gateway WS + REST                                          │
                         ▼                                                            │
┌──────────────────── kimaki bot process (long-lived, one per machine) ──────────┐   │
│  discord client ─▶ ingress ─▶ dispatch / startSession ──┐                       │   │
│                                                         │ HTTP (@opencode/client)│   │
│  event loop ◀── one SSE /api/event ─────────────────────┼──────────┐            │   │
│     └─▶ renderer ─▶ Discord REST                        │          │            │   │
│  scheduler (cron tasks, sleep wakes) ─▶ startSession    │          │            │   │
│  SQLite (bindings, prefs, tasks, sleeps)                │          │            │   │
│  lock-port HTTP :29988  /health  /kimaki/send                      │            │   │
└───────▲─────────────────────────────────────────────────┼──────────┼────────────┘   │
        │ POST /kimaki/send (token)                       ▼          │                │
        │                                  ┌──── opencode service (user's) ───────┐   │
┌───────┴──────────┐   bash via shim       │ sessions, inbox, forms, permissions, │   │
│ kimaki CLI       │◀──────────────────────│ shell, instructions, event log       │   │
│ (short-lived)    │                       │  └─ kimaki plugin (in-process)       │   │
│ send, session …  │── reads ─────────────▶│      context hook, bash schema       │   │
└──────────────────┘   @opencode/client    └──────────────────────────────────────┘   │
        └──────────────── Discord REST (upload-to-discord, archive, user list) ───────┘
```

| Component | Runs where | Owns | Talks to |
|---|---|---|---|
| **bot process** | long-lived, one per machine, restarted by `bin.ts` wrapper | Discord connection, ingress, rendering, scheduler, SQLite, lock port | Discord, OpenCode server, CLI |
| **OpenCode server** | the user's OpenCode background service, shared with the TUI, one for all projects | all session state: history, inbox/queue, forms, permissions, shell runs, instructions, durable event log | bot (HTTP in, SSE out), plugin (in-process) |
| **kimaki plugin** | inside the OpenCode server process | custom tools, bash schema, per-request context (git branch), guarded by session metadata | only OpenCode APIs (`ctx.*`). Never SQLite, never the bot, never Discord |
| **kimaki CLI** | short-lived; run by the user or by the agent's bash through `~/.kimaki/bin/kimaki` | nothing | bot lock port (writes), OpenCode server (reads), Discord REST (independent actions) |
| **gateway-proxy / website** | fly.io / Cloudflare | shared bot, onboarding | bot (gateway mode only) |

#### Channels, one per direction

| From → to | Channel | Used for |
|---|---|---|
| bot → OpenCode | HTTP, Basic auth (password from the service registration file) | `session.create/prompt/shell/command/interrupt/fork`, `form.reply`, `permission.reply`, `inbox.cancel`, `instructions.entry.put` |
| OpenCode → bot | one `/api/event` SSE stream, all sessions and locations | everything shown in Discord; replay with `session.log(after: seq)` |
| plugin → bot | **no direct channel**. Tool input/output appears on the event stream; tools that need a human answer create a **form** | action buttons, sleep (read from events); file upload (form) |
| bot → plugin | `form.reply` through the OpenCode server | file upload result |
| CLI → bot | lock port HTTP, token from `<dataDir>/lock-token` | `POST /kimaki/send` (start or continue a session, returns IDs) |
| CLI → OpenCode | HTTP via `Service.discover()` (same as the `opencode` CLI) | `session read/list/search/wait` |
| CLI → Discord | REST with credentials from SQLite | `upload-to-discord`, `session archive`, `user list`, `thread list` |
| agent → CLI | bash + shim on `PATH`; OpenCode sets `OPENCODE_SESSION_ID` natively in shell tool env | the agent calls `kimaki send`, `kimaki upload-to-discord`, … |

#### Lock port server

One small HTTP server in the bot process, fixed port (`KIMAKI_LOCK_PORT`, default 29988).

| Route | Purpose |
|---|---|
| `GET /health` | single-instance lock: a new bot calls it, sees the old one, sends SIGTERM to its wrapper, then binds the port |
| `POST /kimaki/send` | the only write API for the CLI. Calls `startSession` / `dispatch` in-process |

Removed from it: Hrana `/v2` and `/v2/pipeline` (plugin SQLite access), `/kimaki/wake`
(scheduler is in-process). If the bot is not running, CLI write commands fail with
"kimaki bot is not running"; read commands can still fall back to SQLite + Discord.

#### What each piece must never do

- plugin: no SQLite, no Discord, no bot HTTP, no timers that abort sessions, no `console.*`
- bot: never mirror OpenCode state it can derive from events; never read its own
  Discord messages as prompts (except the remote-send envelope, if kept)
- CLI: never write session state; writes go through the bot so there is one code path

---

## 3. Onboarding (current)

Source: `cli/src/cli-runner.ts` (not `cli.ts`; the gateway doc is partly stale).

### Startup order

1. start macOS `caffeinate`
2. ensure `opencode` and `bun` are installed (auto install in non-TTY)
3. check OpenCode version compatibility
4. background `kimaki` self-upgrade unless `--no-auto-upgrade`
5. bind lock port (evicts an older instance: SIGTERM wrapper, wait 20s, SIGKILL)
6. init SQLite, run migrations
7. resolve credentials
8. start OpenCode server **in parallel** with Discord login
9. interactive: pick projects and guild, create channels
10. register slash commands per guild (bulk overwrite, async)
11. start handling messages

### V2 startup (simplified)

Kimaki uses the user's OpenCode service (28.2). It does not install, pin, spawn, or
upgrade OpenCode.

Delete from startup:

| Step today | Why it goes |
|---|---|
| `ensureCommandAvailable('opencode')` + auto install | the user installs OpenCode; onboarding prints the install command if `Service.discover/ensure` fails |
| `OPENCODE_PATH` lookup, spawning `opencode serve`, port and password generation | the service owns its process |
| `assertCompatibleOpencodeVersion()` | replaced by one minimum-version check on the registration `version` |
| `backgroundUpgradeKimaki()`, `--no-auto-upgrade`, `/upgrade-and-restart` | no self-upgrade |
| `bun` check | not needed; the service installs its own plugin dependencies |

New startup order:

1. `caffeinate` (macOS)
2. bind lock port (single instance)
3. init SQLite, run migrations
4. resolve credentials (wizard if missing)
5. in parallel: `Service.discover()` (else `ensure()`) + Discord login
6. check the OpenCode version and that the Kimaki plugin is in the config (onboarding
   adds it)
7. onboarding UI if needed, register slash commands
8. subscribe to `/api/event`, seed views, start handling messages

### Credential resolution (priority)

1. `KIMAKI_BOT_TOKEN` env (a `clientId:secret` pair means gateway mode)
2. saved row in `bot_tokens`
3. interactive wizard: **gateway** (recommended) or **self-hosted**

### Gateway onboarding

```
CLI                              website (kimaki.dev, CF Worker)          Discord
 │ generate clientId (uuid) + secret (32 bytes hex), save to bot_tokens
 │ open  kimaki.dev/discord-install?client_id&secret ──▶ better-auth signInSocial
 │                                                   ──▶ OAuth: pick guild, install bot
 │                                  callback: upsert gateway_clients(client_id, guild_id)
 │ poll /api/onboarding/status every 3s (100 tries) ◀── 200 { guild_id, discord_user_id }
 │ wait 2s for proxy KV sync, then log in with token "clientId:secret"
```

Non-TTY: the install URL is printed as an SSE-style `install_url` event.

### Self-hosted onboarding

User creates a Discord app, enables **Message Content Intent** (Server Members Intent is
optional, only for name lookup), pastes the bot token, installs the bot with the printed
URL, confirms.

### Channels

- guild list comes from the Gateway READY event
- first run: user multiselects OpenCode projects (`project.list`), excluding already
  registered and `opencode-test-*`
- one guild is auto-selected, many guilds prompt
- category `Kimaki` (or `Kimaki <botName>`) resolved by **stored ID**, adopted from a
  tracked channel's parent, else created; `guild_categories` table
- text channel named from sanitized folder basename; optional voice channel in
  `Kimaki Audio` (`--enable-voice-channels`)
- a **default channel** `kimaki` (gateway) or `kimaki-<bot>` backed by
  `<projectsDir>/kimaki` (git init + `.gitignore`); not recreated if the user deleted it;
  `KIMAKI_NO_DEFAULT_CHANNEL=1` disables
- welcome message + `Kimaki tutorial` thread; replying in it injects the tutorial prompt
  (build a Three.js browser game) via the context plugin

### Rebuild notes

Onboarding does not depend on OpenCode internals except `project.list`. Port as is.
Replace the V1 `project.list` with the V2 project API. The OpenCode server can start in
parallel exactly like today.

---

## 4. Discord ingress

Source: `cli/src/discord-bot.ts` lines 555-1203, `message-preprocessing.ts`,
`message-formatting.ts`, `btw-prefix-detection.ts`.

### Gates, in order

1. serialize per-channel ingress (Discord arrival order)
2. (V1 only, removed in V2, see 9.5) read embed-footer marker (CLI-injected prompts from `kimaki send` carry YAML with
   agent, model, permissions, worktree, parent session, user)
3. ignore own messages unless CLI-injected
4. other bots need Kimaki permission (multi-agent orchestration is opt-in)
5. leading mention of **another** user: ignored in channels, **context-only** in threads
   (added to the session, no AI reply)
6. mention mode (per channel): channel messages need a bot mention; `!` is exempt
7. ownership: only answer channels mapped on **this machine** (multi-machine guilds)
8. permission: owner, Administrator, Manage Server, or role `Kimaki`; role `no-kimaki`
   always denies; `--allow-all-users` opens it (except credential commands)

### Channel message

- `!cmd` runs a shell command in the project dir, no thread
- otherwise create a thread (title = message text or `Voice Message`, max 80 chars,
  1 day auto archive), optionally a **worktree** (`--use-worktrees` or channel toggle,
  only if dir is a git root), then send the first prompt

### Thread message

A thread is handled if it has a session row, the bot is mentioned, it is CLI-injected,
or the bot created it. Then:

| Input | Route |
|---|---|
| `!cmd` | immediate shell, no model turn |
| `!cmd. queue` | queued shell |
| `text. btw` / last line `btw` | fork into `btw:` thread now |
| `text. btw queue` | fork after current run |
| `text. queue` / last line `queue` | queue after current run |
| leading `/command args` matching a registered OpenCode command | `session.command` |
| leading `@otheruser` | context-only (`noReply`) |
| anything else | interrupt + prompt |

Regexes (`btw-prefix-detection.ts`, `message-formatting.ts`):

```ts
const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i
const QUEUE_SUFFIX_RE = /(?:[.!?,;:]|^)\s*queue\.?\s*$|\n\s*queue\.?\s*$/i
```

Suffixes are stripped **before** extras (embeds, attachments) are appended, so they stay
at the end of the text.

A real new message (not bot, not CLI-injected, not context-only) **dismisses pending UI**:
action buttons, HTML actions, file uploads; a pending permission is rejected and a
pending question removed, then the run is aborted before the new prompt.

Editing or deleting a queued Discord message updates or removes the queue entry.

### Attachments and extras

| Discord input | Prompt shape |
|---|---|
| image / PDF | file part (data URL), HEIC converted, resized to 1500px JPEG q85 |
| text file ≤ 64 KiB (or `prompt.md`) | `<attachment filename mime size url path>contents</attachment>` |
| text file > 64 KiB | same tag with `large="true"` + "read the local path" |
| embed | `<embed>Author/Title/URL/description/fields/Footer</embed>` |
| poll | `<poll>Question: ... - answer</poll>` |
| forwarded message | `<forwarded-message>...</forwarded-message>` |
| reply | `<replied-message author="...">` (max 1000 chars) |
| voice | transcribed first, prefixed `Voice message transcription from Discord user:` |
| new thread from a message that has thread context | `Context from thread: ... User request: ...` |

Local copies go to `<dataDir>/attachments/`. Images also get the notice "The following
images are already included in this message as inline content (do not use Read tool on
these)".

### V2 changes

- files: V2 accepts `file://` and `data:` URIs only. Save attachments locally and pass
  `files: [{ uri: 'file:///…', name }]`. OpenCode materializes them.
- ingress stays in Kimaki (it is Discord-specific). Only the send call changes.

---

## 5. What we send to the model

### 5.1 System prompt

Source: `cli/src/system-message.ts` `getOpencodeSystemMessage` (lines 484-1058).
Generated **once per session** and pinned in `<dataDir>/session-system-pinned/<id>.txt`
so prompt cache stays warm. Forks copy it byte for byte.

| Section | Content |
|---|---|
| identity | "The user is reading your messages from inside Discord, via kimaki.dev"; be concise, no narration between tool calls; bash needs `description` + `hasSideEffect` |
| IDs | session ID, channel ID, thread ID, guild ID |
| permissions | who can talk to the bot; bots need the Kimaki role |
| upgrading | `/upgrade-and-restart`, `kimaki upgrade`; never restart unless asked. V2: drop this section (no self-upgrade) |
| debugging | read `~/.kimaki/kimaki.log`; bug report guide URL |
| upload files | `kimaki upload-to-discord --session <id> files…`; never markdown images |
| audio | `kimaki tts` then upload, only when asked |
| file requests | use `kimaki_file_upload` |
| sleep | `kimaki_sleep` rules; "The tool result is not a wake" |
| archive / abort / title | `kimaki session archive/abort/title` |
| mentions | `<@userId>`, `kimaki user list` |
| new sessions | `kimaki send` rules: `--parent-session`, `--agent`, `--user`, quoting, destinations |
| existing threads | `--thread` over `--session`, cross-machine lookup |
| suffixes | `. queue`, `. btw`, `. btw queue` |
| commands / agents | `/cmd` prompts, `/<agent>-agent`, handoff near context limit |
| scheduling | `--send-at` UTC/cron, `--pre-run`, `--allow-concurrency`, task files in `tasks/`, notification policy, `kimaki task list/edit/delete` |
| worktrees | only when asked, `kimaki send --worktree`, `--cwd` |
| reading sessions | `session list/search/read`, Discord links, `session editors` |
| cross-project | `kimaki project list/add/create`, "plan first" |
| waiting | `--wait`, `session wait`, 20+ min bash timeout, active-session loop |
| critique | (if enabled) run critique after edits, include URL |
| tunnels | `kimaki tunnel` + tuistory for dev servers |
| markdown | headings, lists, no URLs in code, `<callout>` usage and colors, diagrams |
| endings | question / action buttons / upload / sleep must be called **last**, after text |
| channel topic | optional `<channel-topic>` |

### 5.2 Per-turn context (synthetic text part)

Source: `getOpencodePromptContext` in `system-message.ts` lines 390-482. Sent as a
`synthetic: true` text part (hidden in the TUI, visible to the model):

```xml
<discord-user name="Tommy" user-id="…" message-id="…" thread-id="…" thread-name="…" />

<system-reminder>
Your current OpenCode session ID is: ses_…
Your current Discord thread ID is: …
</system-reminder>

This message was a reply to message

<replied-message author="…">…</replied-message>

<system-reminder>
Current agent: opus
</system-reminder>
```

Plus a long worktree-changed reminder when the thread moved into a worktree.

### 5.3 Plugin-added context (`chat.message` hooks)

| Source | Text | When |
|---|---|---|
| context-awareness | `[current git branch is main]` or detached HEAD warning | branch changed |
| context-awareness | `[working directory changed … Previous folder (DO NOT TOUCH) … New folder …]` | cwd changed |
| context-awareness | `<system-reminder>The previous assistant message was large…MEMORY.md…</system-reminder>` | last reply ≥ 12k output+reasoning tokens. **V2: removed** |
| context-awareness | tutorial instructions | first reply in the tutorial thread |
| memory-overview | `<system-reminder>Project memory from MEMORY.md (condensed table of contents…)` | first real user message, frozen for cache. **V2: removed** |

### 5.4 V2 mapping

| Today | V2 |
|---|---|
| pinned system file per session | `client.session.instructions.entry.put({ sessionID, key: 'kimaki', value })` once at session creation. Durable, owned by OpenCode, survives restart, forks inherit it. Delete `session-system-pinned/`. |
| synthetic per-turn part | V2 prompts have no synthetic sub-parts. Append the per-turn block to `text`, and put the same facts in `metadata` (`discord: { userId, username, messageId, threadId }`) so renderers can strip it. Alternative: plugin `session.hook('context')` injects it from message metadata (not exposed on model messages; needs lookup). Pick the simple option. |
| `Current agent` reminder | derive from `session.agent.selected`; keep as text only if the model needs it |
| context plugin hooks | `ctx.session.hook('context', e => e.system.push(...))` for request-scoped info (git branch, cwd). MEMORY.md overview and reminders are removed in V2 (not in every request. |
| tutorial detection | plugin reads prompt text in `session.hook('prompt')`, or Kimaki adds an instruction entry for that one session when it creates the tutorial thread. Second is simpler. |

---

## 6. The event loop (core of the rebuild)

### 6.1 Current implementation (V1)

Source: `cli/src/session-handler/` (runtime is 5752 lines).

```
global-event-listener.ts
  one GET /global/event, reconnect 500ms → 30s backoff
  dispatchEvent(payload) ─▶ every registered ThreadSessionRuntime (one per active thread)

ThreadSessionRuntime.handleEvent
  ├─ drop events not for my session or a known child task session
  ├─ append to in-memory event buffer (max 1000, compacted, persisted to session_events)
  └─ switch (event.type)
       message.updated        → flush parts, natural completion → footer, context %
       message.part.updated   → store part, render text/tool/task parts
       session.idle           → drain local queue
       session.error          → "✗ opencode session error: …"
       permission.asked       → Accept / Always / Deny buttons
       permission.replied     → clear UI
       question.asked         → dropdowns (after preceding text finished)
       question.replied       → clear UI, maybe drain
       session.status         → typing on busy, stop on idle, retry notice
       session.updated        → rename Discord thread from title
       tui.toast.show         → subtext notice (session-tagged toasts only)
```

Pain points that motivate the rebuild:

- the runtime mirrors OpenCode state: `sentPartIds`, `partBuffer`, local queue,
  `dispatchingQueueId`, `shownQuestionRequestIds`, context limit cache, …
- a 1000-entry event buffer that must be compacted, persisted, and protected from
  delta floods (a flood once evicted `busy` events and broke `. queue`)
- local queue in SQLite with drain gates that race with question handoff
- the interrupt plugin aborts after 3s and **replays** prompts because V1 abort clears
  OpenCode's own queue
- part ↔ Discord message map persisted in `part_messages`

### 6.2 V2 event model (what we consume)

Verified against `packages/schema/src/session-event.ts` on `opencode#v2`.

Envelope: `{ id, type, created, data, location?, metadata?, durable?: { aggregateID, seq } }`.
Session events carry `data.sessionID`. `seq` is **per session**.

| Group | Events we use | Kind |
|---|---|---|
| execution | `session.execution.started` `.succeeded` `.failed` `.interrupted` | durable |
| inbox | `session.inbox.enqueued` `.delivered` `.cancelled` `.delivery.changed` | durable |
| step | `session.step.started` `.ended` `.failed`, `session.retry.scheduled` | durable |
| text | `session.text.started` `.delta` `.ended` (full text) | delta is live-only |
| reasoning | `session.reasoning.started` `.delta` `.ended` | delta is live-only |
| tool | `session.tool.input.started` `.called` `.progress` `.success` `.failed` | progress live-only |
| session | `session.created` `.renamed` `.agent.selected` `.model.selected` `.forked` `.moved` `.deleted` | durable |
| usage | `session.usage.updated` (cost, tokens) | live-only |
| compaction | `session.compaction.started` `.ended` `.failed` | durable |
| synthetic | `session.synthetic`, `session.shell.*`, `session.skill.activated` | durable |
| ui | `permission.asked` `.replied`, `form.created` `.replied` `.cancelled` | live-only |
| other | `tui.toast.show`, `vcs.branch.updated`, `server.connected`, `rpc.*` | live-only |

Keys: text/reasoning are `assistantMessageID + ordinal`; tools are `assistantMessageID +
id`. There is **no partID** and **no `message.part.updated`**. There is **no
`session.error`** and **no `question.*`**: questions are forms with
`metadata.kind === 'question'`. `session.status`/`session.idle` exist in the schema but
the V2 core does not publish them; use execution events.

Boundaries are different things and must not be merged:

```
prompt()  ─▶ inbox.enqueued ─▶ inbox.delivered ─▶ step.started … step.ended
                 (admitted)        (consumed)          (one model call)
execution.started ───────────── (one busy period, may cover many turns) ─── execution.succeeded
```

A queued prompt does **not** always get its own `execution.started`. Several queued
turns can run in one busy period.

### 6.3 V2 architecture

```
                 client.event.subscribe()            one stream, all sessions
                            │
                            ▼
                 ┌──────────────────────┐
                 │ event router         │  index: sessionID ─▶ threadId
                 │ (thread_sessions +   │  children: unknown session → session.get → parentID chain
                 │  session.created)    │
                 └─────────┬────────────┘
                           │ per-thread FIFO (never block the reader; 4096-event
                           │ subscriber buffer overflows and kills the stream)
                           ▼
                 ┌──────────────────────┐        pure
                 │ fold(state, event)   │◀────── deriveThreadView(events)
                 │ per-thread view      │        (busy, queue, pending forms, tokens,
                 └─────────┬────────────┘         current turn, footer data)
                           │ diff(view before, view after)
                           ▼
                 ┌──────────────────────┐
                 │ Discord effects      │  send / edit / typing / buttons / rename
                 │ (throttled, serial)  │
                 └──────────────────────┘
```

Principles:

1. **Fold, do not mirror.** Per thread, keep a view reduced from events:
   `view = events.reduce(fold, empty)`. Discord side effects come from comparing
   `before` and `after`, not from ad-hoc flags.
2. **Snapshot + live, on every connect.** Same protocol as the OpenCode mini TUI
   (`packages/tui/src/mini/stream-v2.transport.ts`, see 6.8): hydrate from REST
   projections while holding live events, then apply the held events. Missed output is
   filled from `message.list`, not from the experimental `session.log`.
3. **One reader, many writers.** The SSE reader only pushes into per-thread queues.
   Discord REST work runs in per-thread serialized workers.
4. **Only Discord facts in memory.** The set of posted block keys (for dedupe) and
   the Discord message IDs of live UI prompts. Kept in the per-thread view, in memory.

### 6.4 Event → Discord action table (V2)

| Event | Discord action |
|---|---|
| `session.execution.started` | start typing (7s keepalive) |
| `session.step.started` | first step of a new session: banner `-# *using model ⋅ agent*` |
| `session.text.delta` | nothing (optionally a live-edit preview, throttled 1/s) |
| `session.text.ended` | post text block, full width |
| `session.reasoning.ended` | render `-# ┣ thinking` only at high verbosity |
| `session.tool.called` | render tool line (`-# ┣ bash _cmd_`); for `question`, upload, buttons, sleep: nothing |
| `session.tool.success` | edit tool line if the title changed; action buttons tool: render buttons; sleep tool: record wake and show time |
| `session.tool.failed` | render `-# ⨯ tool error` |
| `session.retry.scheduled` | subtext `retrying in Ns (attempt N)`, throttled 10s |
| `session.step.ended` | update context usage; show `-# context usage N%` at each 10% window |
| `session.execution.succeeded` | stop typing, footer |
| `session.execution.failed` | stop typing, `✗ error message` (max 400 chars), no footer |
| `session.execution.interrupted` | stop typing, no footer, no error |
| `session.inbox.enqueued` (queue) | reply `Queued (position N)` + Remove button on the source message |
| `session.inbox.delivered` | queued item: post `» Tommy: prompt preview`; remove its Remove button |
| `session.inbox.cancelled` | remove queued ack |
| `form.created` (question) | stop typing, dropdowns after preceding text is rendered |
| `form.replied` / `.cancelled` | disable dropdowns |
| `permission.asked` | stop typing, Accept / Accept Always / Deny |
| `permission.replied` | disable buttons |
| `session.renamed` | rename thread (2 renames / 10 min limit, dedupe) |
| parent `session.tool.progress` with `metadata.sessionID` (task tool) | register child session → same thread, label from the task input (`explore`) |
| child session `tool.called` | tool line in the parent thread, same verbosity, prefixed `explore ⋅` |
| child session text, reasoning, execution, footer | ignored (the result reaches the parent as the task output) |
| `tui.toast.show` | subtext notice if it names our session |
| `session.usage.updated` | analytics `tokens_used` (billed tokens) |

### 6.5 Derived state (pure functions)

All of these are `f(events) → value`. No stored flags.

```ts
isBusy(events)            // last execution.started without a later terminal event
pendingQueue(events)      // inbox.enqueued(delivery=queue) − delivered − cancelled
pendingForms(events)      // form.created − replied − cancelled
pendingPermissions(events)// permission.asked − replied
currentTurn(events)       // steps since the last delivered user input
footer(events)            // model, agent, duration, tokens from step.* of the turn
contextPercent(events, model) // last step.ended tokens / model.limit.context
didSleep(events)          // latest turn has a kimaki_sleep tool.success
```

On reconnect, rebuild `pendingForms` and `pendingPermissions` from
`client.session.form.list` and `client.permission.list` (they are not durable in the log).

### 6.7 No event buffer

**Today (V1 and the V2 branch):** each runtime keeps up to 1000 events, compacts text to
512 chars, flushes them to SQLite `session_events` every 2s, hydrates them on restart,
dedupes durable events on reconnect (`hasSeenNativeDurableEvent`), injects its own
`kimaki.*` events (`queue-dispatch.started/settled`, `question-queue-handoff.started`,
`subagent.routing`, `fork.cache-baseline`), and derives busy by scanning backward. A
delta flood once evicted the busy markers and broke `. queue`.

**V2 rebuild:** **no buffer.** Each event is folded into the thread view by `reduce()`
and then dropped. The view holds everything later decisions need (busy, turn, children,
pending UI). Nothing is persisted. The `derive*` helpers in 6.5 become reducer cases
over the view, not scans over a log.

Views are (re)built by the **hydration** step on every connect (6.8), not only at
startup:

| Needed | Source |
|---|---|
| busy | `client.session.active()` (sessions absent are idle) |
| pending questions | `session.form.list` per bound session (children too) |
| pending permissions | `permission.list` (children too) |
| queue positions | `session.inbox.list` per busy session |
| posted block keys | `message.list` (recent messages, keys only on the first connect) |

Event handling table (everything not listed is ignored):

| Event | Used for | Kept in view |
|---|---|---|
| `session.execution.started` | typing on, busy | `busy`, `turn.startedAt` |
| `session.execution.succeeded` | footer, typing off | clears `turn`, `busy` |
| `session.execution.failed` | error line, typing off | clears `turn`, `busy` |
| `session.execution.interrupted` | typing off | clears `turn`, `busy` |
| `session.step.started` | banner on first step of a session; model and agent | `turn.model`, `turn.agent` |
| `session.step.ended` | tokens for footer % | `turn.tokens` |
| `session.retry.scheduled` | retry line | |
| `session.text.ended` | text block | `lastKind`, `postedKeys` |
| `session.tool.input.started` | tool **name** (`session.tool.called` has no name, only `assistantMessageID`, `id`, `input`; see `ToolBase` in `session-event.ts:472`) | `toolNames[assistantMessageID+id]` |
| `session.tool.called` | tool line (root and children), name from `input.started` | `lastKind`, `postedKeys` |
| `session.tool.failed` | error line | |
| `session.tool.progress` (task tool, `metadata.sessionID`) | fast path to register a child | `children`, store `sessionThreads` |
| any event of an **unknown** session | hold its events, `session.get` → follow `parentID` up; if it reaches a bound session, register it as a child and apply the held events | `children`, store `sessionThreads` |
| `session.inbox.enqueued` / `.delivered` / `.cancelled` | queue ack, `» user` echo, Remove | `queued` |
| `session.shell.started` / `.ended` | `!cmd` output | |
| `form.created` / `.replied` / `.cancelled` | question UI (root **and children**) | `ui.forms` |
| `permission.asked` / `.replied` | permission UI (root **and children**) | `ui.permissions` |
| `kimaki.ui.rendered` (internal) | message IDs of UI prompts | `ui.*` |

Ignored: `session.text.started/delta`, all `session.reasoning.*`,
`session.tool.input.delta/ended`, `session.tool.success` (the line was posted at `called`),
`session.tool.progress` without child metadata, `session.compaction.*` (optional
`-# compacting` line), `session.usage.updated` (analytics subscriber only),
`session.renamed`, `session.agent.selected`, `session.model.selected`,
`tui.toast.show`, `vcs.*`, child session text, reasoning and execution events.

### 6.8 Connect protocol (from the OpenCode mini TUI)

The OpenCode mini TUI renders a session into an append-only scrollback, the same problem
Kimaki has. **Use it as the reference implementation** for the event loop:

| File | Reference for |
|---|---|
| [mini/ folder](https://github.com/anomalyco/opencode/tree/v2/packages/tui/src/mini) | whole renderer |
| [stream-v2.transport.ts](https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/mini/stream-v2.transport.ts) | `connect()`, `hydrate()`, `apply()`: event handling, dedupe, reconnect |
| [stream-v2.subagent.ts](https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/mini/stream-v2.subagent.ts) | child session discovery, child permissions and forms |
| [stream-v2.fragment.ts](https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/mini/stream-v2.fragment.ts) | text/reasoning keys (`messageID + kind:ordinal`), delta vs projection dedupe |
| [verbosity.ts](https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/mini/verbosity.ts) | verbosity presets over separate settings |

Copy its connect loop (`connect()` / `hydrate()`):

```
loop:
  generation++                                  stale attempts become no-ops
  stream = client.event.subscribe()
  first event must be server.connected          else treat as disconnected
  hold live events in a list
  hydrate in parallel:                          message.list (limit ~200, per bound busy session)
                                                inbox.list, permission.list, form.list,
                                                session.active()
  apply held events in order, then go live
on error: post nothing, wait 250ms, optionally re-resolve the client
          (OpenCode restarted with a new port or password), retry
```

Dedupe keys, same as the TUI: text `assistantMessageID + "text:" + ordinal`, tools
`assistantMessageID + toolId`. The reducer skips any block whose key is in
`postedKeys`.

| Connect | Hydration renders? |
|---|---|
| first connect after bot start | **no**: record keys of existing messages only, so old history is not posted again |
| reconnect | **yes**: post blocks from `message.list` whose keys are not in `postedKeys`. This fills gaps without `session.log` |

Subagents (TUI `stream-v2.subagent.ts`) are discovered from four sources: task tool
`metadata.sessionID` in projected messages, `session.list` filtered by `parentID`,
`session.active()`, and live events of unknown sessions (walk `parentID` with
`session.get`, buffer that session's events meanwhile). This also covers subagents of
subagents and survives a bot restart, unlike `tool.progress` alone.

### 6.6 Typing indicator

Unchanged rules (see root `AGENTS.md`): start only on OpenCode busy facts
(`execution.started`, `step.started`); refresh every ~7s; stop on terminal execution
events, on permission/form prompts, and before the final message; clear both the
interval and any pending restart timeout on stop.

---

## 7. Model output to Discord messages

Source: `thread-session-runtime.ts` 2011-2226, `message-formatting.ts` 216-481 and
865-999, `discord-utils.ts` 476-837.

### 7.1 Formatting per block

| Block | Output |
|---|---|
| text | trimmed text, no prefix, full width |
| reasoning | `-# ┣ thinking` (content hidden) |
| bash | `-# ┣ bash _description_` (command shown when no description) |
| edit | `-# ◼︎ edit *file.ts* (+3-1)` |
| write | `-# ◼︎ write *file.ts* (42 lines)` |
| apply_patch | `-# ◼︎ apply_patch` with per-file `(+a-d)` from `patch-text-parser.ts` |
| other tool | `-# ┣ tool _title_` |
| tool error | `-# ⨯ tool error text` |
| todowrite | active todo only: `3.  **fix the parser**` |
| task (subagent) | `-# ┣ explore **find auth files**` while running |
| child tool | `-# ┣ explore ⋅ grep _pattern_` (same verbosity rules) |
| question / upload / buttons / sleep | nothing (dedicated UI) |
| synthetic text | nothing |
| large tool output (> 3000 est. tokens) | `-# ⬦ bash returned N tokens` |

Prefixes: `┣ ` tool, `◼︎ ` file edit, `-# ` subtext, `⬦ ` status, `» ` user echo.

### 7.2 Verbosity (per channel, `/verbosity`)

| Level | Shows |
|---|---|
| `tools_and_text` | everything |
| `text_and_essential_tools` (default) | text + tools except `read`, `glob`, `grep`, `describe-media`, `todoread`, and bash with `hasSideEffect: false`; hides thinking |
| `text_only` | text only |

**V2 (2 levels, as settings like the OpenCode mini TUI `verbosity.ts`):**

| Setting | `text` | `tools` (default) |
|---|---|---|
| tool lines | hide | show (minus read-only tools and bash without side effects) |
| text of assistant messages that contain tool calls | **drop** | show |
| text of other assistant messages (the final answer) | show | show |
| `!cmd` output | show | show |
| footer | show | show |

The `text` rule is the TUI "quiet" rule (`toolMessages` in `stream-v2.transport.ts`):
narration between tool calls is dropped, only the answer stays. Needs a small buffer: a
text block is held until the step ends; if the step had a tool call, drop it.

### 7.3 Spacing (quoting removed)

**Today:** intermediate single-line text is quoted (`> text`) and the last text block is
edited back to full width before the footer (`unquoteFinalTextPart`).

**V2:** no quoting. Every text block is posted full width when `session.text.ended`
arrives. The only layout rule left: a blank line when the block kind changes (text ↔
tool). No lookahead, no edits, no message map.

### 7.4 Footer

```
-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6 ⋅ plan*
```

folder ⋅ branch ⋅ turn duration ⋅ context % (rounded) ⋅ model ⋅ agent (omitted for
`build`) ⋅ optional `<@author>` mention (`--enable-footer-mentions`, skipped when a queued
message follows or the turn slept). Only on natural completion, never on abort or error.

V2: emit on `session.execution.succeeded`. Duration = succeeded.created − first
`step.started` of the turn. Model/agent from `step.started.data`.

### 7.5 Ordering and rate limits

- one serialized Discord worker per thread
- sends and edits share ~5 per 5s per channel; throttle edits to 1/s
- flush pending text before showing interactive UI (question, buttons)

---

## 8. Markdown pipeline and extensions

Source: `discord-utils.ts` `sendThreadMessage` (734-837), `format-tables.ts`,
`unnest-code-blocks.ts`, `limit-heading-depth.ts`, `html-components.ts`.

```
formatted block
  → optional leading blank line
  → splitTablesFromMarkdown(content)          (marked lexer)
       ├─ component segment ──▶ send with IsComponentsV2 flag   (no text transforms)
       └─ text segment
            → unnestCodeBlocksFromLists     (Discord can't render code in lists)
            → limitHeadingDepth(3)          (#### → ###)
            → escapeBackticksInCodeBlocks   (` inside fences → \`)
            → splitMarkdownForDiscord(2000) (close + reopen fences with language)
            → hard truncate safety
            → thread.send({ content })
```

### Extensions

| Syntax | Rendering |
|---|---|
| GFM table | Components V2 `Container`; each row = `TextDisplay` with `**Header** value` lines, `Separator` between rows; links become URLs; split by 40-component / 4000-char budgets |
| `<callout accent="#f59e0b">…</callout>` | accented `Container`; body can hold markdown and tables; single-line or tags on own lines; accent `#RRGGBB`, `#RGB`, or decimal; malformed or inside a code fence stays text |
| `<button id="x" variant="danger">Delete</button>` in a table cell | real button, only when the caller passes a `resolveButtonCustomId` (Kimaki's own UIs like `/worktrees`); model output falls back to the label text |

**V2: keep tables and `<callout>` as they are. Rebuild the pipeline on a typed AST.**

Both are pure `text → Discord payloads` transforms. They never touch the event loop,
queue or session state, so they cannot break the core.

Syntax stays:

```md
<callout accent="#f59e0b">
## Tests not fully green

- `pnpm test` failed in `cli.test.ts`
</callout>
```

#### Why an AST

Today the pipeline is string passes in sequence: `marked` lexer for tables, then regex
and line scans for callouts, code-block unnesting, heading depth, backtick escaping, and
a fence-tracking 2000-char splitter. Each pass re-discovers structure (is this line
inside a fence? inside a list?) and bugs come from passes disagreeing.

V2: parse **once** into mdast, transform the tree, render typed segments.

```
text ──fromMarkdown(gfm)──▶ mdast Root
        │
        ├─ groupCallouts      html "<callout …>" … html "</callout>"  ──▶ Callout node
        ├─ unnestCodeInLists  list > item > code                       ──▶ code lifted after the list
        ├─ clampHeadings      heading.depth > 3                        ──▶ depth 3
        ▼
toSegments(root): Segment[]
        ├─ table    ──▶ Components V2 Container (rows = TextDisplay + Separator)
        ├─ callout  ──▶ Components V2 Container with accent (children rendered recursively)
        └─ text     ──▶ toMarkdown(nodes) ──▶ splitNodes(2000) ──▶ classic content messages
```

Libraries: `mdast-util-from-markdown` + `mdast-util-gfm` (+ `micromark-extension-gfm`)
to parse, `mdast-util-to-markdown` + `mdast-util-gfm` to serialize, `@types/mdast` for
node types. No `unified` plugin chain needed; plain functions over typed nodes.

#### Types

```ts
import type { Root, RootContent, Table } from 'mdast'

// custom node, registered so every visitor is type-checked
interface Callout { type: 'callout'; accent: number; children: RootContent[] }
declare module 'mdast' {
  interface RootContentMap { callout: Callout }
}

type Segment =
  | { kind: 'text'; markdown: string }                // ≤ 2000 chars, always valid markdown
  | { kind: 'table'; table: Table }
  | { kind: 'callout'; accent: number; segments: Segment[] }  // text + table only inside

function renderMarkdown(text: string): Segment[]      // pure, snapshot-tested
```

#### Callout grouping

CommonMark parses a custom HTML tag as an `html` node, so `<callout>` on its own line
followed by a blank line gives: `html(<callout accent>)`, normal markdown nodes,
`html(</callout>)`. `groupCallouts` walks root children, pairs open/close tags, and
wraps the nodes between them in a `Callout` node. Cases:

| Input | Handling |
|---|---|
| tags on own lines, blank lines around body | pair siblings (common case) |
| no blank line after `<callout …>` | CommonMark html block swallows lines until a blank line: take the html node's text after the opening tag, parse it as markdown, prepend to the body |
| single line `<callout>text</callout>` | html node contains both tags: parse the inner text |
| inside a fenced code block | it is a `code` node, never seen as html. No special case |
| missing `</callout>` or bad `accent` | leave nodes unchanged (rendered as text) |
| nested callouts | not supported; inner tags stay text |

Accent parsing: `#RRGGBB`, `#RGB`, or a decimal integer → number.

#### Splitting to 2000 chars (node-based)

- serialize top-level nodes one by one and pack them into messages ≤ 2000 chars
- a single node larger than the limit: `code` splits by lines into several `code` nodes
  with the same `lang` (each one a valid fence); `list` splits by items; `paragraph`
  splits by sentences, then by words
- because every piece is serialized from a node, a message never ends inside a fence
  and never needs a "reopen fence" fixup

`toMarkdown` picks a fence longer than any backtick run in the code, so
`escapeBackticksInCodeBlocks` is not needed. (Verify Discord renders 4-backtick fences;
if not, escape inside `code.value` before serializing.)

#### Tests

One snapshot test file with real model outputs as fixtures: tables with links and
inline code, callouts in each shape above, code in lists, long code blocks, headings
deeper than 3, mixed segments. Inline snapshots of `renderMarkdown(text)`.

**V2: remove the `<button>` markdown extension.** The model cannot create real buttons
with it: without a `resolveButtonCustomId` it renders as plain label text. Only `/tasks`
and `/worktrees` use it, to put Delete / Run now / toggle buttons in table rows. Those two
commands build their Components V2 message directly (`TextDisplay` + `ActionRow` per
row, like the table renderer already does), with no HTML parsing. Model buttons have one
path only: `kimaki buttons` (12.1). Deletes `html-components.ts`, `html-actions.ts`
(`html_action:<id>` registry), and the button branch in `format-tables.ts`.

Outbound mentions: discord.js `allowedMentions: { parse: ['users'] }` by default
(`--allow-mention` adds roles/everyone). Model text is not stripped.

The pipeline is independent of OpenCode. **Port it unchanged** into one `markdown/`
module. `markdown.ts` (`ShareMarkdown`) is the session-to-markdown exporter used by
`kimaki session read`; in V2 it reads `client.session.message.list`.

---

## 9. Interrupt, queue, btw

### 9.1 Interrupt (plain message during a run)

**Today:**

1. bot calls `session.promptAsync` (V1 queues it inside OpenCode)
2. the **interrupt plugin** (inside OpenCode) starts a 3s timer per user message
3. if no assistant message with that `parentID` appears in 3s: `session.abort`, poll
   `session.status` every 100ms up to 3s, then **replay** the same message ID with
   `promptAsync` (because V1 abort clears OpenCode's queue, issue #77)
4. pending permission/question: bot rejects it and aborts before sending

**V2:**

```ts
await client.session.prompt({ sessionID, id, text, files, metadata, delivery: 'steer' })
if (isBusy(view)) await client.session.interrupt({ sessionID, resume: true })
```

`steer` is admitted durably; `interrupt({ resume: true })` stops the active step and
resumes with pending steering input. Queued prompts stay parked. No timer, no replay,
no plugin. Deletes `opencode-interrupt-plugin.ts`, `plugin-opencode-client.ts`,
`abortActiveRunAndWait`, `retryLastUserPrompt`.

Pending form/permission on a new message: `form.cancel` / `permission.reply('reject')`,
then the same two calls.

`/model` change mid-run: `session.switchModel` then `interrupt({ resume: true })` only if
the user wants the current turn restarted; otherwise just switch (applies next step).

### 9.2 Queue

**Today:** `thread_queue_items` table + in-memory `queueItems`; drain on `session.idle`
when the last turn completed naturally; `dispatchingQueueId` guard; special handoff
when a question is pending; restored on startup; Remove button `queue_remove:<thread>:<queueId>`;
edits/deletes of the Discord message update the row.

**V2:**

| Action | Call |
|---|---|
| queue a prompt | `session.prompt({ …, delivery: 'queue', metadata: { discord: {...} } })` |
| show position | derive `pendingQueue(view)` from `inbox.enqueued − delivered − cancelled` |
| Remove button | `session.inbox.cancel({ sessionID, inboxID })`; customId `queue_remove:<inboxID>` (fits 100 chars) |
| `/clear-queue [position]` | cancel one or all pending inbox IDs |
| edit queued Discord message | see 9.2.2 |
| delete queued Discord message | `inbox.cancel({ inboxID: msg_discord_<messageId> })` |
| "now running" echo | on `inbox.delivered` for a queued item: `» Tommy: preview` |
| promote to now | `session.inbox.update({ inboxID, delivery: 'steer' })` (2.0.2: `inbox.steer`) |
| `/abort` | `interrupt({ resume: false })` + cancel all pending queued items |

Semantics note: V2 `queue` delivers at the end of the current **logical turn**
(continuation boundary), one item at a time. That matches "after the current run".

Kimaki queue state: **none**. Delete `thread_queue_items`, `queueItems`,
`tryDrainQueue`, `restorePersistedLocalQueues`, question handoff logic.

**Not native:** queued `btw`. Drop `. btw queue`. A queued synthetic marker item does not
work: when the runner promotes a queued item it continues the next turn, so the agent
would reply to it.

### 9.2.2 Editing and deleting queued Discord messages

Map a Discord message to its inbox item **by ID, with no stored state**: pass the prompt
`id` as `msg_discord_<discordMessageId>`. V2 only requires the `msg_` prefix
(`packages/schema/src/session-message.ts:23`), and the inbox item ID is the prompt ID.

| Discord event | V2 call | Native? |
|---|---|---|
| `messageDelete` of a queued message | `session.inbox.cancel({ inboxID: 'msg_discord_<id>' })`; no-op if already delivered | yes |
| `messageUpdate` of a queued message | no API to change the text of an inbox item. `inbox.update` only changes `delivery` | **no** |

Edit options:

| Option | Behavior | Cost |
|---|---|---|
| A. cancel + re-enqueue with the new text | works now | the item moves to the **end** of the queue; the new prompt needs a new ID (`msg_discord_<id>_e<n>`) because IDs are unique |
| B. upstream: `inbox.update({ inboxID, prompt })` for undelivered items | keeps the position | OpenCode PR; small (the item is not delivered yet, so only the stored payload changes) |

Recommendation: **A now, B upstream**. Also propose `delivery` on `session.shell` in the same
PR (9.2.1), so queued `!cmd` can come back.

Check: custom message IDs must not break message ordering. V2 creates IDs with an
`ascending()` time prefix; if any listing sorts by ID, `msg_discord_…` would sort after
all generated IDs. Verify before using custom IDs, else find the item with
`session.inbox.list` + `metadata.discord.messageId`.

### 9.2.1 `!cmd` shell commands: native `session.shell`

V2 already implements "user runs a command, output goes into context, agent does not
reply". No plugin needed.

```ts
await client.session.shell({ sessionID, id: 'msg_…', command: 'pnpm test' })
```

What OpenCode does (`packages/core/src/session/session.ts` `Session.shell`):

1. runs the command in the **session's working directory** (worktree aware)
2. emits `session.shell.started { shell: { id, command, cwd, … } }`
3. waits for exit, emits `session.shell.ended { shell, output: { output, cursor, size, truncated } }`
4. adds a synthetic message with `resume: false`:
   `The following shell command was executed by the user: …output…`
   so the agent sees it on its next turn but is **not woken**
5. start failures also become a synthetic `User shell command failed to start`

```
!pnpm test ──▶ session.shell ──▶ shell.started ──▶ bot posts "-# $ pnpm test"
                                   │ poll client.shell.output({ id, cursor }) 1/s
                                   │ ──▶ edit the Discord message in place (≤2000 chars)
                                   ▼
                                shell.ended ──▶ final edit, exit status
                                   ▼
                                synthetic(resume:false) ──▶ in context for next prompt
```

Consequences:

- `!cmd` works while the agent is busy. It runs in parallel and does not interrupt;
  its output joins the context at the next step boundary.
- **`!cmd. queue` is dropped for now**: `session.shell` has no `delivery` option, and a
  Kimaki-side shell queue cannot be ordered against the native inbox. Requested upstream:
  [anomalyco/opencode#52274](https://github.com/anomalyco/opencode/issues/52274) (`delivery: "queue"` for `session.shell`). When it
  lands, `!cmd. queue` becomes `session.shell({ command, delivery: 'queue' })` with no
  Kimaki state.
- the TUI and `session read` show the command too (it is part of the session history)
- action buttons with `command` use the same call
- delete `commands/run-command.ts` process spawning and the "shell output as context"
  plumbing; keep only the throttled Discord renderer (1 edit/s, new message past 2000
  chars) fed by `shell.output`
- `!cmd` in a **channel** (no thread, no session): create the thread + session first,
  then `session.shell`. One code path instead of a separate "run in project dir" path
- `/run-shell-command` becomes the same call

Open: `session.shell` has no `delivery` and no `timeout` parameter. Long-running
commands (dev servers) block until exit; tell users to use `kimaki tunnel` / tuistory
for those. Check how `/abort` interacts: `session.interrupt` may not kill a user shell;
if not, kill it with `client.shell.remove({ id })`.

### 9.3 btw

**Today:** `session.fork` (whole history, no messageID) → new `btw: <prompt>` thread →
copy session preferences + pinned system prompt + workspace → post
`Reusing context from <thread>` → prompt with "Do NOT continue, resume, or reference the
previous task. Only answer the question below." Parent session keeps running. Parent ID
is not passed so the prompt cache stays shared.

**V2:** `client.session.fork({ sessionID })` (2.0.2: `boundary: { type: 'through' }`).
Instructions, agent, model are part of the forked session, so nothing to copy. Create the
thread, bind it, prompt. `/fork` uses `before: messageID` and replays history from
`session.message.list`.



### 9.4 One route type for text and voice

Today voice has its own dispatch path. `transcribeAudio` returns
`{ transcription, queueMessage, sessionAction?: 'btw' | 'new-session', agent? }`, then
`routeVoiceSession` (`message-preprocessing.ts`) re-implements btw fork and new-thread
creation, `forceQueue` threads a flag into `resolveMessagePrompt`, and pending UI is
dismissed only after transcription finished. Several e2e tests exist only for races in
that path (slow transcription after queue drain, question dropdown kept on routing).

V2 design: **every input parser returns the same `Route`**. Dispatch knows nothing
about where the route came from.

```ts
type Route = {
  kind: 'steer' | 'queue' | 'btw' | 'new-session' | 'shell' | 'command'
  text: string
  files: FileAttachment[]
  agent?: string          // optional agent hint
}

parseTextMessage(message): Route     // suffixes: ". queue", ". btw", "!", "/cmd"
parseVoiceMessage(message): Route    // transcription tool call → same fields
```

```
text message ──parseTextMessage──┐
                                 ├──▶ Route ──▶ dispatch(route, thread)
voice message ──transcribe───────┘                 │
   (tool call: text, route, agent)                 ├─ steer      → cancel UI, prompt(steer), interrupt if busy
                                                   ├─ queue      → prompt(queue)
                                                   ├─ btw        → fork + new thread + prompt
                                                   ├─ new-session→ same function as a channel message
                                                   ├─ shell      → session.shell
                                                   └─ command    → session.command
```

Transcription tool schema (Gemini / OpenAI function call), one enum instead of two flags:

```ts
{
  transcription: string,
  route: 'steer' | 'queue' | 'btw' | 'new-session',   // default 'steer'
  agent?: '<enum of primary agents>',
}
```

Only offer `btw` and `queue` in the enum when the thread has a session (today:
"contextual routing").

Why this is simpler:

- **no voice-only dispatch code**: `btw` and `new-session` reuse the exact functions the
  text suffix and channel messages use
- **no ordering races**: the per-thread ingress chain awaits transcription, then
  dispatches. Queueing is native, so a slow transcription that lands after the run
  ended just becomes a prompt on an idle session. The "slow transcription after drain"
  bug class disappears with the local queue
- **UI dismissal happens in one place**: `dispatch` for `steer` only. `queue`, `btw`,
  `new-session` never touch the source thread's forms or permissions
- **tests**: `parseVoiceMessage` is tested with the deterministic transcription fixture
  (pure mapping); dispatch is tested once for all sources

Agent hint: V2 prompts have no `agent` field. `dispatch` calls
`session.switchAgent({ agent })` before `prompt` for `steer`, and passes the agent to
`session.create` for `btw` / `new-session`. For `queue`, `switchAgent` would change the
**running** turn's next steps, so ignore the agent hint on queued voice messages (log it)
or drop `agent` from the schema when `route = queue`.

Voice-channel live assistant (Gemini Live) stays separate; it uses its own tools.


### 9.5 `kimaki send` without the embed marker

**Today.** `kimaki send` is a separate short-lived process. It cannot reach the running
bot directly, so it uses **Discord itself as the transport**:

```
kimaki send ──REST: post message as the bot + embed footer YAML──▶ Discord
                     { start, agent, model, permissions,
                       worktree, cwd, parentSessionId, userId, username }
Discord ──messageCreate (own bot message)──▶ bot ingress
   parseEmbedFooterMarker → isCliInjectedPrompt → bypass "ignore own messages"
   → apply agent/model/permissions → create worktree → session → prompt
kimaki send ──polls SQLite thread_sessions (waitForSessionId, 15s)──▶ prints session ID
```

The same marker also carries **sleep wakes** (`sleepWake`, `sleepId`) and **scheduled
runs** (`scheduleKind`, `scheduledTaskId`, `scheduledTaskRunId`): the bot posts a message
to itself, then its own ingress picks it up.

Why it is complex:

- ingress must read its **own** messages and trust a YAML footer in them
- every option (agent, model, permissions, worktree, cwd, parent, injection patterns)
  becomes an ingress branch, far from the code that knows the option
- session creation is asynchronous to the CLI, so the CLI polls SQLite for the session ID
- the bot talks to itself through Discord for wakes and scheduled tasks (rate limits,
  nonce dedupe, "claim the wake row" races)

Why it exists: it works **across machines**. A CLI on machine A can start a session in a
channel owned by the bot on machine B, because both see Discord.

**V2 design: one in-process function, three callers.**

```ts
// bot process
startSession({ channelId | threadId, prompt, files, agent, model, permissions,
               worktree, cwd, parentSessionId, userId, source }): { threadId, sessionId }
```

```
Discord channel message ──────────────▶ startSession
scheduler (cron, --send-at), sleep wake ─▶ startSession / dispatch   (in-process call)
kimaki send (local) ──POST lock port /kimaki/send──▶ startSession   (returns IDs at once)
```

- the bot posts the visible Discord text itself (`» kimaki-cli: prompt`), then calls
  OpenCode: `session.create({ agent, model, permissions, metadata: { kimaki: { parentSessionId, source } } })`
  and `prompt`. Options are applied where they are known, not parsed back from Discord
- ingress **never** processes its own messages. The self-message exception goes away
- the CLI gets `{ threadId, sessionId }` in the HTTP response. No `waitForSessionId`
- `--wait` uses `client.session.wait` directly
- lock port auth: a random token in `<dataDir>/lock-token` (mode 0600). Same trust level
  as the SQLite file the CLI already reads
- sleep wake: scheduler posts `-# Woke after sleeping until …` and calls
  `session.prompt`. No nonce, no wake-row claim race
- scheduled tasks: runner calls `startSession`. The task run ID goes in session
  `metadata`, so analytics and `session list` can read it from OpenCode

**Cross-machine sends** (target channel owned by another machine). Options:

| Option | Cost |
|---|---|
| A. drop cross-machine sends; CLI errors with "channel is owned by machine X" | simplest; loses a real feature |
| B. keep a minimal Discord transport only for remote: CLI posts the **same JSON body** as `/kimaki/send` in a single embed; the owning bot decodes it and calls `startSession` | one decoder, one function; ingress has one early branch `if (isRemoteSendEnvelope(message)) return startSession(decode(message))` |

B keeps the feature with one small branch. All option handling still lives in
`startSession`, so remote and local cannot drift.

---

## 10. Interactive UI

### 10.1 Questions

**Today:** `question.asked` → one message per question, select menu with ≤24 options +
`Other`, multi-select when `multiple`; custom ID `ask_question:<hash>:<index>`; when all
answered → `question.reply`; if the session went idle, resend as a new prompt
`Answers to your previous questions: "Q"="A"`.

**V2:** `form.created` where `form.metadata.kind === 'question'`. Fields are `q0, q1…`,
`type: 'string'` (single) or `'multiselect'`, `title` = header, `description` = question,
`custom: true` allows free text. Reply with
`client.session.form.reply({ sessionID, formID, answer: { q0: 'A', q1: ['B','C'] } })`.
`Other` → Discord modal for free text (today it asks to type in chat). Forms are
in-memory in OpenCode; on reconnect list pending forms and re-render. The "resume with
text if idle" path is gone: a form only exists while its tool waits.

### 10.2 Permissions

**Today:** `permission.asked` → Accept / Accept Always / Deny, dedupe by pattern,
child-session permissions shown in the parent thread (kept in V2: subagents can ask
permissions and questions, see `hydrateBlockers` in the TUI `stream-v2.subagent.ts`),
auto-reject after
`--permission-timeout-minutes` (10), accept resumes an idle session with an empty prompt.

**V2:** same UI. `client.permission.reply({ sessionID, requestID, decision })`
(2.0.2: `reply`). Session rules via `session.update({ permissions })` (2.0.2:
`permission.rules`). **No timeout**: a pending permission waits until the user answers
or a new message cancels it. The "resume idle session" hack goes away.

### 10.3 Action buttons

**Today:** tool inserts an `ipc_requests` row, bot acknowledges, runtime waits for the
completed tool part, flushes text, renders ≤3 buttons (`action_button:<hash>:<i>`,
24h TTL). Click → prompt `User clicked: <label>`, or run `command` like `!cmd`.

**V2:** the tool just validates and returns. The bot renders buttons from the tool
**input** in `session.tool.called`/`.success` (it is on the event stream). No IPC.

### 10.4 File upload

**Today:** tool inserts `ipc_requests(file_upload)`, polls 300ms up to 6 min; bot shows
an `Upload Files` button → native file modal (`file_upload_modal:<hash>`), downloads to
`<dir>/uploads/`, writes paths back.

**V2:** the tool must **wait for a result**, so it needs request/reply:

- preferred: plugin creates a **form** with `metadata.kind = 'kimaki.file-upload'` and
  one string field; the bot sees `form.created`, shows the upload button, downloads
  files, then `form.reply({ answer: { paths: '…' } })`. Forms already handle waiting,
  cancel on interrupt, and listing on reconnect. (Verify the plugin context exposes form
  creation; the built-in `question` tool uses the internal `Form.Service`.)
- fallback: plugin RPC `kimaki.fileUpload` request event + `kimaki.resolve` method
  (see [section 13](#13-plugin--bot-transport)).

### 10.5 Sleep

**Today:** tool writes `session_sleeps` over Hrana; bot task runner checks every 5s,
posts `-# Woke after sleeping until …` with a nonce ≤25 chars, ingress claims the row and
starts a turn. A new real message cancels the sleep.

**V2:** the tool validates and returns. The bot sees `kimaki_sleep` `tool.success` and
writes its **own** `session_sleeps` row (bot-owned scheduler; no IPC). Wake: post the
Discord line and `session.prompt({ text, metadata: { kimaki: 'wake' } })`. Cancel rule
derived: any `inbox.enqueued` user item after the sleep cancels it.

---

## 11. OpenCode plugins we inject

Current exports of `cli/src/kimaki-opencode-plugin.ts` (every export is a plugin) plus
`@subrouter/opencode`.

| Plugin | V1 hooks | Purpose | V2 decision |
|---|---|---|---|
| `ipcToolsPlugin` | `tool` | file upload, action buttons, sleep tools | **port** via `ctx.tool.transform`; no SQLite |
| `contextAwarenessPlugin` | `chat.message`, `event` | git branch, cwd change, MEMORY reminder, tutorial, restore system prompt on commands | **port** git branch only to `session.hook('context')`; drop MEMORY reminder; drop system-prompt restore (instruction entries) |
| `memoryOverviewPlugin` | `chat.message`, `event` | frozen MEMORY.md heading TOC | **delete** (MEMORY.md support removed) |
| `interruptOpencodeSessionOnUserMessage` | `chat.message`, `event` | 3s abort + replay | **delete** (native steer + interrupt) |
| `anthropicAuthPlugin` | `auth`, `chat.headers` | Claude OAuth, Claude Code request spoofing, rotation | **delete from Kimaki**; subrouter owns provider auth |
| `openaiRotationPlugin` | `event`, `chat.headers` | legacy account rotation | **delete** (subrouter) |
| `xaiRotationPlugin` | `event`, `chat.headers` | legacy account rotation | **delete** (subrouter) |
| `imageOptimizerPlugin` | `tool.execute.after`, messages transform | shrink images > 2000px / 4 MiB | **port** to `tool.hook('execute.after')` + `session.hook('context')`; or delete if V2 resizes natively (check) |
| `cacheDriftPlugin` | system transform, `event` | debug: detect system prompt drift | **delete** (instruction entries make the prompt stable) |
| `kittyGraphicsPlugin` | `shell.env`, `tool.execute.after` | PNGs from bash output as attachments | **port** (`shell.hook('create.before')`, `tool.hook('execute.after')`) |
| `injectionGuard` | `tool.execute.after` | LLM judge on tool output | **delete** (no injection guard in V2) |
| `kimakiWorkspaceAdaptorPlugin` | workspace register | worktree adaptor | **replace** with `ctx.worktree.transform` strategy, or built-in git strategy + `worktree.directory` config |
| `fileEditTrackerPlugin` | `tool.execute.after` | `file-edit-events.jsonl` for `session editors` | **port** or derive from session logs (tool.called input has file paths) |
| `bashToolSchemaPlugin` | `tool.definition`, `shell.env` | add `hasSideEffect`/`summary` to bash schema; `OPENCODE_SESSION_ID` env | **port** as a guarded `session.hook('context')` tool-schema edit; session ID env is native (28.3) |
| `taskIdPlugin` | `tool.execute.before` | drop invalid `task_id` | **delete** unless the V2 task tool still has the bug |
| subrouter | `config`, `auth`, headers, system | subscription pooling, failover | **port in subrouter repo** (V2 provider/integration transforms) |

V2 plugin rules: one `Plugin.define({ id: 'kimaki', setup })` default export; setup runs
**per location** in one process, so process-wide resources go on `globalThis` symbols;
key per-session data by `sessionID`; no `console.*`; no imports of the bot logger.

---

## 12. Tools we inject

| Tool | Args | Behavior today | V2 |
|---|---|---|---|
| `kimaki_file_upload` | `prompt`, `maxFiles` 1-10 (5) | waits for Discord upload, returns local paths | form or RPC request/reply |
| `kimaki_action_buttons` | `buttons[1..3]: { label ≤80, command?, color? }` | bot renders buttons; total must fit 2000 chars | tool returns immediately; bot reads input from events |
| `kimaki_sleep` | `duration` or `until` (UTC Z), `reason?` | durable wake in same session | tool returns immediately; bot persists wake |
| bash schema change | adds `description`, `hasSideEffect`, `summary` | drives Discord verbosity | keep |

All tool descriptions tell the model to call them **last, after visible text**.

Also exposed to the agent (not tools): the `kimaki` CLI via the `~/.kimaki/bin/kimaki`
shim on `PATH`, with `OPENCODE_SESSION_ID` in the bash env (live ID, beats stale
`--session` in forks).

Voice tools (`cli/src/tools.ts`: `submitMessage`, `createNewChat`, `listChats`,
`searchFiles`, `readSessionMessages`, `abortChat`, `getModels`) belong to the Gemini Live
voice assistant, not to OpenCode.


### 12.1 Proposal: all three tools become CLI commands

All three custom tools only exist to reach the bot. The agent can already reach the bot
through bash and the `kimaki` shim, and the new lock port has a write API. So each tool
can be a CLI command that calls the bot directly:

| Tool | CLI command | Lock port route | Blocks? |
|---|---|---|---|
| `kimaki_sleep` | `kimaki sleep (--duration 2h \| --until <Z>) [--reason]` | `POST /kimaki/sleep` | no: bot stores the wake, prints wake time |
| `kimaki_action_buttons` | `kimaki buttons --button 'Label' --button 'Build=pnpm build:green'` | `POST /kimaki/buttons` | no: bot renders, prints "shown" |
| `kimaki_file_upload` | `kimaki upload-request --prompt 'Send the logo' [--max-files 5]` | `POST /kimaki/upload-request` (long request) | yes: returns the local paths when the user uploads, or "cancelled" |

```
agent bash ──kimaki buttons …──▶ ~/.kimaki/bin shim ──POST /kimaki/buttons { sessionID }──▶ bot
                                  OPENCODE_SESSION_ID (native in shell env)              │
                                                          thread = thread_sessions[sessionID]
                                                          (child session → parent thread)
```

**What gets simpler**

- the plugin has **no custom tools**. It keeps only the `context` hook, the bash schema
  (session ID env is native). No forms, no RPC, no request/reply design (section 13 cases B and
  C are not needed)
- the bot handles each request in one HTTP handler, with the thread known from the
  session ID. No "watch tool events for special tool names" in the renderer
- commands are testable without an OpenCode server (plain HTTP to the bot)
- they also work for humans and scripts, e.g. `kimaki sleep` from a cron job

**Costs and how to handle them**

| Issue | Handling |
|---|---|
| **order**: buttons must show after the text before them. The HTTP request can arrive before the bot has rendered that text from the event stream | the handler waits until the thread's fold has seen the running shell `tool.called` for this session, then pushes the render into the same per-thread FIFO. Everything before the bash call is then rendered first |
| **bash line noise**: `┣ bash kimaki buttons …` appears in Discord | the model passes `description` (e.g. "show build button"); or the renderer hides shell calls whose command starts with `kimaki buttons\|sleep\|upload-request` (a string check; acceptable because Kimaki owns both sides) |
| **upload waits minutes**, bash default timeout is 2 min | the command description in the system prompt says to set the bash timeout to 10 min; the bot also answers `timeout` after 6 min so the command always exits |
| **interrupt** while waiting for an upload | OpenCode kills the bash process, the HTTP connection closes, the bot sees `close` and removes the upload button. A new user message makes the bot answer "cancelled" |
| **argument quoting**: JSON in bash is error-prone | flat repeatable flags (`--button 'Label[=command][:color]'`), no JSON |
| **discoverability**: tools are in the tool list, CLI commands only in the system prompt | the system prompt already documents `kimaki` commands at length; move the three tool descriptions there |
| **sleep cancel** rule | the bot deletes the sleep row on any new user prompt to that session (it sees them in ingress) |

**Recommendation:** convert all three. The only non-trivial part is the ordering wait
for `buttons`, and it is one function (`waitForShellCall(sessionID)`) in the handler.

Help additions (group **Agent**):

```
  sleep                                Wake this session later with a new message in the same thread

    --duration <duration>              Relative wait, e.g. 30m, 2h, 1d
    --until <date>                     UTC ISO date ending in Z
    --reason <text>                    Shown in Discord and in the wake message
    -s, --session <sessionId>          Session to wake (default: OPENCODE_SESSION_ID)

  buttons                              Show 1-3 buttons in the session thread. Call it last, after your text

    -b, --button <spec>                Repeatable, max 3: 'Label', 'Label=command', 'Label:color', 'Label=command:color'
                                       Colors: white (default), blue, green, red
    -s, --session <sessionId>          Session whose thread gets the buttons (default: OPENCODE_SESSION_ID)

  upload-request                       Ask the user to upload files. Waits, then prints the local paths

    -p, --prompt <text>                Text shown above the upload button
    --max-files <n>                    1 to 10 (default: 5)
    -s, --session <sessionId>          Session whose thread gets the button (default: OPENCODE_SESSION_ID)
```

---

## 13. Plugin ↔ bot transport

### Why it is needed

See [section 2](#why-a-plugin--bot-transport-exists-at-all): tools run in the OpenCode
process, Discord lives in the bot process, and some tools must wait for a human.

### V2 design: use the event stream first, RPC only when a reply is needed

```
case A: tool needs no reply (action buttons, sleep)
  plugin tool returns ──▶ session.tool.called/success on /api/event ──▶ bot renders

case B: tool needs a reply (file upload)
  plugin tool ──form.create(kind=kimaki.file-upload)──▶ form.created ──▶ bot shows UI
  bot ──form.reply(answer)──▶ tool resolves   (interrupt cancels the form natively)

case C: plugin needs bot data or a custom reply (fallback)
  Rpc.define({ id: 'kimaki', methods: { resolve }, events: { requested } })
  plugin ──events.emit('requested', { requestID, sessionID, … })──▶ rpc.kimaki.requested
  bot ──client.rpc(Kimaki).resolve({ requestID, result })──▶ plugin resolves pending promise
  plugin also exposes `pending()` so the bot can reconcile after reconnect
  (RPC events are live-only)
```

Result:

- delete `hrana-server.ts` Hrana routes, `ipc-polling.ts`, `ipc_requests`,
  `KIMAKI_DB_URL`, `KIMAKI_DB_AUTH_TOKEN`, `/kimaki/wake`
- the plugin never opens Kimaki's SQLite
- the lock port keeps `/health` (single instance), adds `POST /kimaki/send` and
  (see [V2 components](#v2-components-and-how-they-talk))

CLI subcommands inside agent bash (`kimaki send`, `upload-to-discord`, …) keep direct
SQLite + Discord REST access. They are separate short-lived processes, not the plugin.

---

## 14. Discord slash commands

36 fixed commands + dynamic families. Registered per guild (bulk overwrite, max 100,
DM disabled). Dynamic priority: agents, config commands, MCP prompts, skills.

### Sessions

| Command | Today | V2 call |
|---|---|---|
| `/new-session prompt files? agent?` | new thread, files as `@path` | `session.create` + `prompt` |
| `/resume session` | bind thread to existing session, replay last 30 parts | `session.message.list` |
| `/fork` | select a user message, fork before it, replay | `session.fork({ before })` |
| `/fork-subagent` | fork a child task session | `session.fork` on child |
| `/btw prompt` | fork full context into side thread | `session.fork` |
| `/abort` | stop, clear queue, cancel sleep | `interrupt` + `inbox.cancel` |
| `/compact` | summarize | `session.compact` |
| `/share` | public URL | **no V2 API found**; drop or keep V1 until available |
| `/diff` | critique upload of git diff | unchanged |
| `/undo` `/redo` | revert / unrevert | `session.revert.stage / clear / commit` |
| `/context-usage` | tokens, %, cost | derive from `step.ended` + `session.usage.updated` |
| `/session-id` | IDs + `opencode attach` command | unchanged |

### Queue

| Command | V2 |
|---|---|
| `/queue message` | `prompt({ delivery: 'queue' })` |
| `/clear-queue position?` | `inbox.cancel` |
| `/queue-command command args?` | `session.command({ name, text, delivery: 'queue' })` |

### Agent, model, display

| Command | V2 |
|---|---|
| `/agent` | session: `session.switchAgent`; channel: Kimaki pref |
| `/model` (provider → model → variant → scope session/channel/global) | session: `switchModel`; channel/global: Kimaki prefs |
| `/model-variant` | same |
| `/verbosity` | Kimaki channel pref |
| `/<agent>-agent prompt? variant?` | switch or new thread with agent |
| `/<cmd>-cmd`, `/<skill>-skill`, `/<prompt>-mcp-prompt` | `session.command`; lists from `command.list` / `skill.list` |

### Projects and worktrees

| Command | Notes |
|---|---|
| `/add-project`, `/remove-project`, `/create-new-project` | Discord + SQLite; V2 project list |
| `/new-worktree name? base-branch?` | V2 `worktree.create` + `session.move` or fork into new location |
| `/merge-worktree strategy? target-branch?` | git logic, unchanged |
| `/worktrees` | table with Delete + auto-worktree toggle; `worktree.list` |

### Other

`/last-sessions`, `/tasks`, `/login` (provider auth → V2 `integration.*`),
`/transcription-key`, `/mcp` (V2 `mcp.list`, transform to toggle), `/run-shell-command`,
`/screenshare`, `/vscode`, `/restart-opencode-server`. (`/upgrade-and-restart` removed.)

### Component custom IDs

`permission_once|always|reject:<hash>`, `queue_remove:<thread>:<queueId>`,
`action_button:<hash>:<i>`, `file_upload_btn:<hash>`, `ask_question:<hash>:<i>`,
`model_*:<hash>`, `agent_select:<hash>`, `verbosity_select:<channel>`, `fork_select:<session>`,
`login_*:<hash>`, `html_action:<id>` (removed in V2). All ≤100 chars; long context stays server-side.

V2 simplification: questions, permissions, and queue items have native IDs
(`formID`, `requestID`, `inboxID`), so their custom IDs can carry those IDs and the
in-memory context maps shrink to "which Discord message shows it".

---

## 15. Kimaki CLI commands

Root: `kimaki` with flags `--data-dir`, `--projects-dir`, `--restart-onboarding`,
`--add-channels`, `--gateway`, `--gateway-callback-url`, `--use-worktrees`,
`--enable-voice-channels`, `--verbosity`, `--mention-mode`, `--no-critique`,
`--enable-footer-mentions`, `--allow-all-users`, `--restrict-directories`,
`--permission-timeout-minutes`, `--enable-sync`, `--no-analytics`, `--no-auto-upgrade`,
`--opencode-hostname`, `--opencode-port`, `--allow-mention`, `--enable-skill`,
`--disable-skill`, `--install-url`, `--auto-restart`.

V2 drops `--no-auto-upgrade`, `--enable-sync`, `--enable-footer-mentions` (features
removed). `--mention-mode` becomes the `channels.mention_only` default.

| Command | Purpose |
|---|---|
| `send` (alias `start-session`) | V2: `POST /kimaki/send` to the local bot, returns thread + session IDs. New thread or `--thread/--session` follow-up; `--agent --model --user --file --worktree --cwd --notify-only --send-at --pre-run --allow-concurrency --parent-session --permission --injection-guard --wait` (V2 drops `--injection-guard`) |
| `session list [--active --exclude --all --json]` | sessions with status and tokens |
| `session read <id|thread>` | markdown transcript |
| `session search <text|/re/>` | 14-day default window |
| `session wait <id>` | block until done or waiting on a question |
| `session archive / abort / title / discord-url / editors / export-events-jsonl` | thread and session ops |
| `project list / add / remove / create / open-in-discord` | channel ↔ directory |
| `task list / edit / delete` | scheduled tasks |
| `thread list --channel` | cross-machine thread lookup |
| `user list --guild --query` | mention IDs |
| `upload-to-discord --session files…` | attach files to the thread |
| `tts text -o file` | speech via OpenAI / Gemini |
| `tunnel [-t id] -- cmd` | traforo public URL, `TRAFORO_URL` env |
| `screenshare` | noVNC over tunnel |
| `merge-worktree` | CLI version of `/merge-worktree` |
| `bot install-url / token / status set / status clear`, `discord-install-url` | bot admin |
| `upgrade [--skip-restart]`, `sqlitedb` | maintenance |
| `multioauth …` | legacy account rotation, **delete** with the auth plugins |

V2 notes: `session export-events-jsonl` becomes a thin wrapper over
`client.session.log` (no SQLite copy). `session wait` uses `client.session.wait` plus a
pending-forms check. `session list --active` derives from execution events or
`session.status`-equivalent APIs.

---

## 16. Secondary features

| Feature | Keep? | Notes |
|---|---|---|
| voice message transcription (OpenAI `gpt-audio-1.5` / Gemini) with routing hints | keep | transcription tool returns `{ transcription, route, agent? }`; same `Route` as text (9.4) |
| gateway free transcription (`/api/transcribe`, Whisper on Workers AI) | keep | |
| live voice channels (Gemini Live worker) | keep, low priority | talks to OpenCode through voice tools |
| `openai-realtime.ts` | **delete** | no importer |
| scheduled tasks (`--send-at`, cron UTC, runner every 5s) | keep | bot-owned |
| sleep/wake | keep | bot-owned, see 10.5 |
| worktrees | keep | move to V2 worktree API |
| forum sync | **delete or re-wire** | `startConfiguredForumSync` has no caller |
| external session sync (`--enable-sync`, 5s polling) | keep, rewrite | use `session.created` on the global stream instead of polling |
| analytics (Strada) | keep | `tokens_used` from `session.usage.updated` / `step.ended` |
| sentry | **delete** | no-op stubs |
| heap monitor, cpuprof, SIGUSR1/2 | keep | |
| screenshare, vscode, tunnels | keep | |
| self-upgrade | keep | |
| image optimizer | check V2 | |
| multi-account OAuth rotation | **delete** | subrouter |

---

## 17. State inventory: keep, derive, delete

### V2 schema: a subset of the existing tables

**Decision:** V2 uses the **same file** (`~/.kimaki/discord-sessions.db`) and a **subset
of the existing tables with their existing columns**. No new tables, no new columns, no
dropped or rebuilt tables, no import step. Old databases work unchanged, and a user can
downgrade to V1 at any time.

```
used by V2 (unchanged DDL)                    left alone (V1 only)
───────────────────────────────────           ───────────────────────────────────
bot_tokens          credentials                session_events      part_messages
bot_api_keys        audio keys                 thread_queue_items  ipc_requests
guild_categories    category per guild         session_models      session_agents
channel_directories channel → directory        thread_worktrees    thread_workspaces
channel_models      channel default model      scheduled_task_runs session_start_sources
channel_agents      channel default agent      forum_sync_configs  global_models
channel_verbosity   channel verbosity
channel_worktrees   auto-worktree toggle
channel_mention_mode mention-only toggle
thread_sessions     thread ↔ session
scheduled_tasks     tasks
session_sleeps      sleeps
```

The V2 Drizzle schema (`cli2/src/schema.ts`) declares **only the used tables**, copied
from the V1 schema with identical column names, types, and the same custom `datetime`
type. `schema.sql` generated from it creates exactly these tables with
`CREATE TABLE IF NOT EXISTS`, so:

| Database | Result |
|---|---|
| existing V1 database | all statements are no-ops; V1-only tables stay untouched |
| new install | only the used tables exist; if the user later runs V1, V1's own `migrateSchema()` creates the rest |

Rules for the V2 code:

| Table | V2 usage |
|---|---|
| `bot_tokens`, `bot_api_keys`, `guild_categories`, `channel_directories` | same as V1 |
| `channel_models`, `channel_agents` | channel defaults, read at `session.create` |
| `channel_verbosity` | V1 enum kept on disk. Read map: `text_only` → `text`; `text_and_essential_tools`, `tools_and_text` → `tools`. Write map: `text` → `text_only`, `tools` → `text_and_essential_tools` |
| `channel_worktrees`, `channel_mention_mode` | same as V1 |
| `thread_sessions` | one session per thread. V2 writes `source = 'kimaki'` and leaves `last_synced_name`, `parent_session_id` null. "One thread per session" is enforced in code: `/resume` deletes other rows with the same `session_id` in the same transaction (no UNIQUE index, so no table rebuild). The existing `updated_at` stays the tiebreaker |
| `scheduled_tasks` | same columns and status enum. `payload_json` keeps the V1 `ScheduledTaskPayload` shape; V2 ignores `injectionGuardPatterns`. V2 does not write `scheduled_task_runs`; `session_id`/`thread_id` columns hold the last run |
| `session_sleeps` | same columns. The bot writes the row when it sees `kimaki sleep`; `delivery_id` is used as the idempotent prompt ID (`msg_sleep_<delivery_id>`), so a retried wake cannot wake twice; `status` stays `planned → consumed / cancelled` |
| `global_models` | not used (global default = OpenCode config) |

Session IDs in existing `thread_sessions` rows: OpenCode V2 migrates V1 sessions into
its own database (`packages/core/src/database/v1-migration.bun.ts`) and appears to keep
their IDs, so old threads keep working. Verify with an old thread before P1 relies on it.

Migrations: only the bot start runs `schema.sql` (plus future additive `ALTER TABLE …
ADD COLUMN` if ever needed, following root `AGENTS.md`). Subcommands never run it. No
`PRAGMA user_version` (V1 does not set it; a subcommand that finds a missing table
prints `run kimaki once to set up the database`).

Access: only the bot and the CLI open the file (WAL mode). The plugin never does, so
`KIMAKI_DB_URL` and the Hrana HTTP proxy disappear.

### In-memory state

Today: `store.ts` (21 fields), per-thread store (6), runtime class (~27 fields), ~15
module-level maps. Target:

| Keep | Why |
|---|---|
| config flags (`dataDir`, verbosity default, flags) | process config |
| `registeredUserCommands` | Discord name → OpenCode name |
| per-thread view: folded events + Discord message IDs of rendered blocks | render/edit |
| per-thread typing timer | resource handle |
| pending Discord UI message IDs (question, permission, upload, buttons) keyed by native IDs | to edit/disable them |
| slash-command wizard contexts (`/model`, `/login`) with TTL | UI flow state |

Everything else (busy flag, queue, sent part IDs, context limit cache, question handoff,
dispatching IDs, event buffer persistence, replay sets) is derived or gone.

### Files outside SQLite

- `session-system-pinned/*.txt` → delete (instruction entries)
- `injection-guard/<session>.json` → delete (no injection guard in V2)
- `file-edit-events.jsonl` → delete; `session editors` derives from `session.log` tool inputs
- `opencode-config.json` → delete; the plugin is registered in the user's `~/.config/opencode/opencode.json`
- `discord-sessions.db` → read once by the importer, never written by V2
- new: `lock-token` (0600) for CLI → bot auth

---

## 18. Removal list

Native in V2 now, delete:

- **local queue**: `thread_queue_items`, `queueItems`, drain gates, Remove-by-queueId,
  question handoff, `restorePersistedLocalQueues` → `delivery: 'queue'` + `inbox.cancel`
- **interrupt plugin**: 3s timer, abort, status polling, replay → `steer` + `interrupt({ resume: true })`
- `plugin-opencode-client.ts` (V1 plugin client was broken; V2 ctx is a real client)
- `abortActiveRunAndWait`, `retryLastUserPrompt` (empty prompt resume hack)
- permission-accept "resume idle session with empty prompt"
- question "resume with text if idle" fallback
- pinned system prompt files and `copySessionSystemPrompt` → instruction entries
- `copySessionPreferences` on fork → fork keeps agent/model
- event buffer compaction, persistence, flood protection → `session.log` replay
- `sentPartIds` / `part_messages` dedupe → durable `seq` cursor per session in memory
- Hrana server + IPC polling + `KIMAKI_DB_URL` → events / forms / RPC
- `cacheDriftPlugin`, `taskIdPlugin` (verify), legacy auth + rotation plugins,
  `multioauth` CLI, `oauth-rotation-shared.ts`
- `sentry.ts`, `openai-realtime.ts`, forum sync (unless re-wired)
- `session.ts` shim re-exports, `worktree-utils.ts` re-exports
- OpenCode auto install, `OPENCODE_PATH` lookup, version compatibility check
- background self-upgrade (`backgroundUpgradeKimaki`, `--no-auto-upgrade`,
  `autoUpgradeEnabled`), `/upgrade-and-restart`
- CLI embed YAML marker for local sends, self-message ingress exception, `waitForSessionId`
  polling, sleep wake nonce + claim, bot-to-itself scheduled messages → `startSession`
  in-process and `POST /kimaki/send`
- voice-only dispatch (`routeVoiceSession`, `forceQueue`) → one `Route` type for all inputs
- `commands/run-command.ts` process spawning → `session.shell`
- `<button>` markdown extension, `html-components.ts`, `html-actions.ts` → `/tasks` and
  `/worktrees` build components directly; model buttons only via `kimaki buttons`
- `!cmd. queue` (until [opencode#52274](https://github.com/anomalyco/opencode/issues/52274) adds queued shell), `. btw queue`
- 12 V1-only SQLite tables are no longer read or written (left in place for downgrade)
- external session sync, thread rename from OpenCode title, footer mentions, cache
  notices, large output notice, toast relay, thinking lines, fork/resume replay
  (see [section 22](#22-coupled-features-remove-candidates))

---

## 19. Proposed module layout

Flat folders inside `cli/src/`, files ≥100 lines, kebab-case.

```
cli/src/
  opencode/
    server.ts            discover / ensure the OpenCode service, Basic auth, client factory
    events.ts            single subscribe loop, per-thread FIFO fan-out, connect protocol (6.8)
    derive.ts            pure f(events) → busy, queue, forms, permissions, turn, footer
    derive.test.ts       fixture event streams, inline snapshots
  discord/
    ingress.ts           gates → parseTextMessage / parseVoiceMessage → Route
    dispatch.ts          dispatch(route), startSession(): the only callers of session.prompt/shell/fork
    render.ts            fold view → Discord effects (send, edit, typing, UI)
    markdown/            tables, callouts, unnest, headings, split (ported as is)
    ui/                  questions (forms), permissions, action buttons, upload, queue ack
  commands/              one file per slash command, thin, calls opencode client
  plugin/
    index.ts             Plugin.define({ id: 'kimaki' }): context hook, bash schema (guarded by metadata)
    tools.ts             kimaki_file_upload, kimaki_action_buttons, kimaki_sleep
  cli/                   goke commands (send, session, project, task, …)
  scheduler.ts           scheduled tasks + sleeps, calls startSession / dispatch in-process
  lock-server.ts         /health, POST /kimaki/send (token auth)
  db/                    drizzle schema: subset of the V1 tables, same file
```

The bot process has exactly one loop that matters:

```ts
for await (const event of client.event.subscribe({ signal })) {
  const threadId = router.threadFor(event)
  if (threadId) threads.get(threadId).push(event)   // never await Discord here
}
```

---

## 20. Open questions and risks

<details>
<summary>API version notes</summary>

| Concern | 2.0.2 | v2 branch (2.0.20) |
|---|---|---|
| interrupt | `interrupt({ continue })` | `interrupt({ resume })` |
| command | `command({ command, text })` | `command({ name, text })` |
| fork | `fork({ boundary })` | `fork({ before? })` |
| messages | `message.list` | `session.message.list` |
| rename | `session.rename` | `session.update({ title })` |
| inbox delivery | `inbox.steer / queue` | `inbox.update({ delivery })` |
| permission reply | `reply` | `decision` |
| permission rules | `permission.rules` | `session.update({ permissions })` |
| catalog event | `catalog.updated` | `provider.updated` + `model.updated` |

</details>

1. **Version pin.** Pick 2.0.20+ (or later stable). The old branch is on 2.0.2.
2. **Share.** No V2 share endpoint found. Drop `/share` or keep until upstream adds it.
3. **Plugin forms.** Confirm a plugin tool can create a form and await its answer. If
   not, use the RPC request/reply in case C.
4. **Per-turn context visibility.** Appending the `<discord-user>` block to prompt text
   makes it visible in the TUI (V1 hid it as synthetic). Accept, or inject it through
   the `context` hook from stored metadata.
5. **Restart rendering.** After a bot restart, replay `session.log` from where? Options:
   render nothing old (post `-# kimaki restarted`), or keep a `rendered_seq` column in
   `thread_sessions`. First is simpler; second avoids gaps mid-turn.
6. **Event backpressure.** The client subscriber buffer is 4096 events; a slow Discord
   worker must never block the reader. Drop text/reasoning deltas early.
7. ~~Queued `!cmd` and `btw`.~~ Decided: `!cmd` uses native `session.shell` (no queue
   needed); `. btw queue` is removed.
8. **Worktree in thread.** V2 `session.move` can move a session to a worktree location at
   a delivery boundary. Decide: move in place, or keep "new thread per worktree".
9. **Image optimizer / task_id bug.** Check if V2 still needs them before porting.
10. **Subrouter port** happens in its own repo and blocks provider auth.
11. **Prompt ID idempotency.** Sleep wake relies on `session.prompt` with a repeated `id`
    returning `ConflictError`. Verify in `packages/core/src/session/session.ts`.
12. ~~Remote sends.~~ Decided: option B in 9.5 (embed envelope only for channels owned
    by another machine). See section 24.
13. **`/resume` binding.** `session_id UNIQUE` means resuming in a new thread detaches the
    old thread. Confirm this is acceptable.
14. **`session.shell` and `/abort`.** Check whether `interrupt` kills a running user shell;
    else call `client.shell.remove`.

---

## 21. Review of the existing V2 branch

Branch `opencode/kimaki-opncd-v2-kmk-plgn-mgrtn`, worktree
`~/.kimaki/worktrees/8f21a809/opncd-v2-kmk-plgn-mgrtn`, local tip `17d661aa` (56 commits
ahead of main, 2 more than `origin`, plus uncommitted edits). Pinned to
`@opencode/cli|client|plugin@2.0.19`. Diff vs main: 224 files, +20k / −21k lines.

### What it got right (reuse)

| Piece | File | Reuse |
|---|---|---|
| binary resolution + Basic auth + readiness probe on `/api/session/active` | `cli/src/opencode2.ts` | yes, drop the PATH fallback |
| one `Plugin.define({ id: 'kimaki' })`, `globalThis` singletons, per-session maps | `cli/src/kimaki-opencode-plugin/index.ts` | yes, structure |
| subrouter `model.request` headers + `revealRoutedModel` in `context` hook | same | yes |
| shell tool schema override (`description`, `hasSideEffect`) via `tools.update` | same | yes |
| git branch / cwd / MEMORY / tutorial via `session.hook('context')` | same | git branch only; MEMORY removed |
| V2 event → part mapping: `text.started/delta/ended`, `reasoning.*`, `tool.input.started/called/success/failed`, ids `messageID + ordinal` / `messageID + toolId` | `session-handler/discord-event-projection.ts` | yes, the mapping logic |
| pure `projectDiscordActions(event, …) → DiscordAction[]` with an executor | same | yes, this is the right shape |
| questions as forms (`metadata.kind === 'question'`, `q0…`), `session.form.reply` | `commands/ask-question.ts` | yes |
| steer + `interrupt({ resume: true })` when busy | `thread-session-runtime.ts` 2980 | yes |
| footer only on `execution.succeeded`, typing on `execution.started` / `step.started` | projection | yes |
| `instructions.entry.put` for the system prompt | runtime, `context-usage.ts` | yes |
| e2e tests against the real V2 binary with the deterministic provider | `opencode2-*.e2e.test.ts`, `kimaki-opencode-plugin-v2.e2e.test.ts` | yes, as the test harness |

### Why it is still a mess

It swapped the SDK under the old architecture instead of removing the old architecture.

1. **Two queues.** The local queue is still there (`thread_queue_items`, `queueItems`,
   `mode: 'local-queue'`, `tryDrainQueue`, `dispatchPrompt`). At drain time it sends the
   item with `delivery: 'queue'`. So a queued message waits in Kimaki, then waits again
   in OpenCode's inbox. The projection even emits a `drain-queue` action on terminal
   events. Native inbox events (`inbox.enqueued/delivered/cancelled`) are not the
   queue source of truth.
2. **Still mirrors state.** `session_events` (event buffer persisted to SQLite),
   `part_messages`, `sentPartIds` / `deliveredPartIds`, `markQueueDispatchBusy/Idle`
   (a fake busy flag), `abortInFlight`, `pendingForms`/`shownFormIds` in memory.
3. **IPC unchanged.** Plugin tools still import `database.js` from the plugin, insert
   `ipc_requests` rows and poll every 200-300ms. Hrana server and `ipc-polling.ts` stay.
   Action buttons even wait up to 30s for the bot to ack, although the bot could read
   the tool input from the event stream.
4. **Rebuilds V1 parts.** The projection converts V2 events back into V1-shaped
   `DiscordSessionPart` objects (`state.status: 'pending'|'running'|'completed'`, fake
   `time.start/end`) so the old formatter and `planAssistantTurnFlush` keep working.
   Tool input is lost on `success` if the part was not seen (`input: {}`), and
   `findToolName` scans the buffer backwards.
5. **Runtime size.** `thread-session-runtime.ts` is still 4606 lines with 58 methods;
   `event-stream-state.ts` 1258; `opencode.ts` 1772.
6. **Startup unchanged.** Still `ensureCommandAvailable('bun')`,
   `assertCompatibleOpencodeVersion()`, `backgroundUpgradeKimaki()`, Hrana server.
7. **Leftovers.** Cache drift detection moved into the `context` hook (writes patches
   on every drift); `session.status` handling kept although V2 core does not publish it.

### Lessons for the rebuild

- start from the event table in [section 6.4](#64-event--discord-action-table-v2), not
  from the old runtime
- render from V2 blocks directly: a text block is `{ messageId, ordinal, text }`, a tool
  block is `{ messageId, toolId, name, input, status, output }`. Rewrite `formatPart`
  for these two shapes instead of faking V1 parts
- queue = inbox events only. No `drain-queue` action anywhere
- the plugin must not import `database.js`
- keep the projection-as-pure-function idea and its tests; drop everything that feeds it
  mirrored state

---

## 22. Coupled features: remove candidates

Test for each feature: **does it add a branch to ingress, the event loop, the renderer,
or session lifecycle?** If yes, it multiplies core states and can break the core. If it
only calls the OpenCode client or Discord from its own command handler (like `/vscode`,
`/screenshare`, `/diff`, `kimaki tunnel`, `kimaki tts`), it is independent and stays.

```
independent (keep freely)          coupled (each one adds branches to the core)
───────────────────────────        ─────────────────────────────────────────────────────
/vscode /screenshare /diff         ingress ──▶ admission ──▶ event loop ──▶ renderer
/tasks list, /worktrees list          ▲            ▲             ▲              ▲
kimaki tunnel, tts, user list      voice routing  queued !cmd   external sync   unquote
/login /mcp /verbosity UI          context-only   btw queue     sleep cancel    cache notice
                                   ...            ...           ...             ...
```

### Tier 1: remove (high coupling, low value)

| Feature | Where it hooks into the core | Why remove |
|---|---|---|
| **`!cmd. queue` and `. btw queue`** | local queue with `queuedAction`, drain logic | the only reason to keep a Kimaki queue beside the native inbox. Plain `!cmd` stays: native `session.shell` runs it without interrupting and puts output in context (see 9.2.1), so queueing it is pointless |
| **edit / delete a queued Discord message updates the queue** | `messageUpdate` / `messageDelete` handlers → queue mutation | Remove button already covers it |
| **external session sync** (`--enable-sync`, TUI sessions mirrored to `Sync:` threads) | second renderer path (`collectSessionChunks`, batching), ownership rules (`<discord-user>` detection), typing for foreign sessions, 5s polling | a whole second event→Discord pipeline; replace with `/resume` or `kimaki session read` |
| **context-only messages** (leading `@otheruser` in a thread → `noReply` synthetic) | extra admission kind (`synthetic resume:false`), skip UI dismissal, skip typing | ignore these messages, like in channels |
| **question queue handoff** (queued prompt answers a pending question) | special path between queue and forms | native: a new message cancels the form, then steers |
| **pending UI dismissal chain** on new message (reject permission, remove question, abort, wait idle) | ingress awaits run state | V2: cancel form / reject permission, then steer + interrupt. No wait |
| **text quoting + final unquote** | per-block Discord message ID map, an edit at `execution.succeeded`, restart gap | **decided: no quoting at all** |
| **prompt cache clear notice** (`show-prompt-cache-clear`) | token math on first step, known upstream gap (TODO in branch) | debug feature; move to logs |
| **cache drift detection** | context hook compares system prompts, writes patches | instruction entries make it moot |
| **large tool output notice** (`bash returned 12k tokens`) | extra render action, needs model context limit | debug-ish; drop or move to `/context-usage` |
| **context usage notices every 10%** | per-thread "last shown %" state, model limit lookup | footer already shows %; keep `/context-usage` |
| **retry notices** (`retrying in Ns`) | throttle state per thread | keep only if cheap: it is one row in the event table, no state beyond a timestamp |
| **tui toast relay** | parses session ID out of toast text | toasts are TUI UI; drop |
| **thread rename from OpenCode title** | `session.renamed` → rename with 2/10min limit, dedupe state `appliedOpencodeTitle`, `last_synced_name` column | thread title = first message; `kimaki session title` stays for explicit renames |
| **footer mentions** (`--enable-footer-mentions`, skip when queued/slept) | footer logic reads queue + sleep state | Discord already notifies on thread replies |
| **per-channel mention mode** | extra ingress gate + table | keep one global rule: channels need a mention or not, via flag |
| **`/fork` with history replay**, `/resume` with replay of last 30 parts | second renderer (history → Discord batches) | keep fork/resume, drop replay; post a link `-# forked from <thread>` |
| **`/fork-subagent`** | child session handling in commands | rare |
| **CLI-injected prompts via embed YAML marker** (agent, model, permissions, injection patterns, worktree, cwd, parent session, user, sleep wake, scheduled run) | ingress parses bot-authored embeds, self-message exception, `waitForSessionId` polling in the CLI | local sends go to the bot over the lock port; scheduler and sleep call the same function in-process. See 9.5 |
| **injection guard** (plugin + `--injection-guard` + per-session files) | per-tool LLM judge, files written by the bot | **decided: removed** |
| **per-session permission rules from `kimaki send --permission`** | stored and applied at session creation | if kept, pass as `session.create({ permissions })`; no Kimaki storage |
| **permission dedupe + child permissions in parent thread** | pattern matching across requests, child permission routing | **decided:** drop dedupe; **keep** child permissions and forms in the parent thread (subagents can ask) |
| **permission timeout auto-reject** | per-request timer, restart handling | **decided: removed** |
| **thinking rendering** (`┣ thinking`) | extra block kind in verbosity | drop; reasoning is never shown |
| **3 verbosity levels** | filter logic in renderer + per-channel table | keep 2: `text` and `tools` (default hides read-only tools) |
| **multi-machine channel ownership** (only answer channels mapped on this machine) | ingress gate + `project list --all` scanning Discord | keep: needed for correctness when two machines share a guild. Low cost |

### Tier 2: keep, but make independent

| Feature | Coupling today | Decoupled design |
|---|---|---|
| **sleep / wake** | plugin writes SQLite, ingress claims wake rows, any real message cancels sleep, footer and quoting check sleep | bot reads `kimaki_sleep` tool.success from events, stores `(sessionId, wakeAt)`; scheduler at wake time calls `session.prompt`; cancel = derived "any user input after the tool call". No ingress hook |
| **scheduled tasks** | `scheduled_task_runs` status updated from event loop (complete/fail), concurrency check reads run state | scheduler owns its table; concurrency = "is the last session of this task busy" derived from events on demand. Event loop does not know tasks exist |
| **worktrees** | worktree change reminder in per-turn context, `thread_workspaces` status, cwd-change detection in plugin, `lastPromptWorktreeKey` | a worktree thread is just a session created with `location: { directory: worktreePath }`. Never move a live session between folders. Drop the cwd-change reminder and plugin cwd tracking |
| **btw** | copies prefs, system prompt, workspace; runtime binding | `session.fork` + new thread + prompt. No copying (fork inherits) |
| **subagent rendering** | child session routing, labels `explore-1`, child permission routing | **decided:** keep child **tool lines** in the parent thread with the same verbosity, label = agent name; keep child permissions and questions; no child text |
| **action buttons** | IPC + ack wait + flush before render | render from `tool.called` input; no IPC |
| **file upload** | IPC polling | form; see 10.4 |
| **voice routing hints** | own dispatch path (`routeVoiceSession`) duplicating btw and new-session, `forceQueue` flag, deferred UI dismissal | voice is only a different **parser** that returns the same `Route` as text. See 9.4 |
| **analytics** | tokens computed inside the event loop | separate subscriber on the same event stream |
| **file-edit tracker** | plugin wraps every tool | derive `session editors` from `session.log` tool inputs on demand; delete the JSONL |
| **agent/model per channel** (global = OpenCode config) | resolved at every admission | resolve once at `session.create`; later changes go through `switchAgent/switchModel` |

### Tier 3: independent, keep as is

`/vscode`, `/screenshare`, `/diff`, `/tasks`, `/worktrees` list and delete,
`/merge-worktree`, `/login`, `/mcp`, `/transcription-key`, `/run-shell-command` and `!cmd`
(immediate, not queued), `kimaki tunnel`, `tts`, `upload-to-discord`, `user list`,
`thread list`, `project *`, `session read/search/list/archive`, onboarding, heap/cpu
profiling, live voice channels (talks to OpenCode through its own tools).

### Result: the core after removals

```
Discord message
  │ gates: bot? owner machine? permission? mention?
  │ suffix: ". queue" → queue | ". btw" → fork | "!" → shell | "/cmd" → command
  ▼
admission:  cancel pending form/permission → session.prompt(steer|queue) → interrupt if busy
  ▼
event loop: route by sessionID → fold → render blocks, forms, permissions, typing, footer
```

Four ingress routes, one admission function, one renderer. Everything else is a
separate subscriber or a command handler.

---

## 23. CLI simplification

### 23.1 Migrations only in the bot start

Today every CLI subcommand calls `initDatabase()` / `getDb()`, and the first open runs
`migrateSchema()` + `schema.sql`. So `kimaki session read`, run by an agent inside a
session, can migrate the database under the running bot.

V2 rule:

| Process | DB access |
|---|---|
| `kimaki` (bot start) | open, run `schema.sql` (idempotent), then serve |
| every subcommand | open read-only, **no migrations**. If the schema version is older than the CLI expects: error `run kimaki once to migrate` |

No schema version pragma (V1 does not set one). Most subcommands need no DB at all in
V2: writes go through `POST /kimaki/send`, reads go to OpenCode.

### 23.2 Target CLI (full definition)

Built from scratch with goke. Rules:

- **one verb per job**, grouped by noun: `session`, `project`, `task`, `thread`, `user`, `bot`
- writes that touch a session go through the running bot (`POST /kimaki/send`); if the
  bot is not running, they fail with `kimaki bot is not running (start it with: kimaki)`
- reads go to OpenCode (`Service.discover()`, same server as the `opencode` CLI) or Discord REST
- every list command supports `--json`
- IDs accept a session ID **or** a Discord thread ID where it makes sense (`<id>`)
- no subcommand runs migrations (23.1)

#### Help output

Global flags on every command: `--data-dir <path>` (default `~/.kimaki`), `--json` on
every list/read command, `-h, --help`.

```
kimaki/1.0.0

Usage:
  $ kimaki [options]

Commands:

  kimaki                               Start the bot. Runs onboarding on first start

    --data-dir <path>                  Data directory (default: ~/.kimaki)
    --projects-dir <path>              Where `project create` makes folders (default: <data-dir>/projects)
    --gateway                          Use the shared Kimaki bot, no Discord app needed
    --gateway-callback-url <url>       Redirect here after the gateway install (appends ?guild_id=<id>)
    --install-url                      Print the install URL and exit (non-interactive onboarding)
    --restart-onboarding               Run the onboarding wizard again
    --add-channels                     Pick more projects to add as channels, then start
    --worktrees                        New threads get a git worktree by default
    --voice-channels                   Also create voice channels for projects
    --verbosity <level>                text | tools (default: tools)
    --mention-only                     Channels answer only when the bot is mentioned
    --allow-all-users                  Anyone in the server can use the bot
    --allow-mentions <kind>            users | roles | everyone, allowed in bot output (default: users)
    --restrict-directories             Agents can only touch their project folder
    --no-critique                      Do not upload diffs to critique.work
    --no-analytics                     Disable anonymous usage analytics

  send                                 Start a session in a channel, or continue one in a thread

    -c, --channel <channelId>          New thread in this channel
    -d, --project <path>               New thread in the channel of this project directory
    --thread <threadId>                Continue this thread
    --session <sessionId>              Continue the thread of this session (same machine only)
    -p, --prompt <text>                Prompt text. Thread only: end with ". queue" or ". btw"
    -f, --file <path>                  Attach a local file (repeatable)
    -n, --name <name>                  Thread name (default: prompt preview)
    --agent <name>                     Agent for the new session
    --model <provider/model>           Model for the new session
    --permission <rule>                Permission rule (repeatable): "tool:action" or "tool:pattern:action"
    --worktree [name]                  Create a git worktree for the new session
    --cwd <path>                       Run in an existing subfolder or worktree of the project
    --parent-session <sessionId>       Mark the new session as a child of this session
    -u, --user <user>                  Add this Discord user (ID or mention) to the thread
    --notify-only                      Post a notification thread, start no session
    --wait                             Wait until the session finishes, then print it as markdown
    --send-at <when>                   Schedule: UTC ISO date ending in Z, or cron expression (UTC)
    --pre-run <command>                Scheduled only: run first. Exit 0 starts, stdout is appended
    --allow-concurrency                Scheduled only: allow overlapping runs of this task

  session list                         List sessions with status (idle, busy, waiting) and tokens

    --active                           Only busy sessions. Exit 0 if any, 1 if none, 64 on error
    --exclude <sessionId>              Skip this session (repeatable)
    --project <path>                   Sessions of this project (default: current directory)
    --all                              Sessions of every local project
    --json                             Output as JSON

  session read <id>                    Print a session as markdown. <id> is a session or thread ID

    --thinking                         Include reasoning
    --verbose                          Include full tool inputs and outputs
    --json                             Print the raw OpenCode event log (session.log)

  session search <query>               Search titles, then message text. <query> is text or /regex/flags

    --days <n>                         Only sessions updated in the last n days (default: 14, 0 = all)
    --project <path>                   Search this project (default: current directory)
    --channel <channelId>              Search the project of this channel
    --all                              Search every local project
    --json                             Output as JSON

  session wait <id>                    Wait until the session is idle or waits for the user, then print it

    --timeout <duration>               Give up after this long, e.g. 30m, 2h (default: none)

  session abort <id>                   Stop the running turn. The thread stays open

  session archive [threadId]           Archive the Discord thread. The session is kept

    --session <sessionId>              Archive the thread of this session instead

  session title <title>                Rename the session. The Discord thread follows

    --session <sessionId>              Session to rename (default: OPENCODE_SESSION_ID)

  session url <id>                     Print the Discord thread URL of a session

  session editors <file>               List sessions that edited a file, newest first

    --days <n>                         Only sessions updated in the last n days (default: 14, 0 = all)
    --json                             Output as JSON

  task list                            List scheduled tasks

    --json                             Output as JSON

  task edit <taskId>                   Change a scheduled task. Empty string clears a value

    --prompt <text>                    New prompt
    --send-at <when>                   New schedule: UTC ISO date ending in Z, or cron (UTC)
    --agent <name>                     Agent for the scheduled session
    --model <provider/model>           Model for the scheduled session
    -u, --user <user>                  Discord user added to each run's thread
    --pre-run <command>                Command to run before each run
    --allow-concurrency <bool>         true | false

  task delete <taskId>                 Delete a scheduled task

  project list                         List projects and their channels

    --all                              Include projects of other machines (scans Discord)
    -g, --guild <guildId>              Guild to scan with --all
    --prune                            Remove mappings whose channel no longer exists
    --json                             Output as JSON

  project add [directory]              Create a channel for a directory (default: current directory)

    -g, --guild <guildId>              Guild (auto-detected if the bot is in one server)

  project create <name>                Create <projects-dir>/<name> with git init and a channel

    -g, --guild <guildId>              Guild (auto-detected if the bot is in one server)

  project remove <channelId>           Forget a channel mapping. The Discord channel stays

  thread list                          List threads in a channel

    -c, --channel <channelId>          Channel to list (required)
    --archived                         Include archived threads
    --json                             Output as JSON

  user list                            Find Discord user IDs for mentions

    -g, --guild <guildId>              Guild to search (required)
    -q, --query <text>                 Name filter
    --json                             Output as JSON

  upload-to-discord <files...>         Attach files to a session thread

    -s, --session <sessionId>          Session whose thread gets the files (default: OPENCODE_SESSION_ID)

  tunnel -- <command>                  Run a command and expose its local port with a public URL

    -t, --tunnel-id <id>               Fixed tunnel ID (default: random). Only for public-safe services
    --port <port>                      Local port, when it cannot be read from the command output

  screenshare                          Share the screen via a VNC tunnel. Stops after 30 minutes

    --duration <minutes>               Stop after this many minutes (default: 30)

  tts [text]                           Text to speech. Reads stdin if no text is given

    -o, --output <path>                Output file (default: speech.mp3)
    -p, --provider <name>              openai | gemini (default: from the stored key)
    -v, --voice <voice>                Voice ID (default: alloy for OpenAI, Kore for Gemini)
    -i, --instructions <text>          Style instructions (OpenAI only)
    --speed <n>                        0.25 to 4.0 (OpenAI only)

  merge-worktree                       Merge the current worktree into its base branch

    --target <branch>                  Target branch (default: the branch the worktree came from)
    --strategy <kind>                  merge | squash | rebase (default: merge)

  status                               Bot health: running, pid, uptime, OpenCode URL and version, guilds

    --json                             Output as JSON

  logs                                 Print the log file path

    -f, --follow                       Print the log and keep printing new lines

  bot install-url                      Print the bot install URL

    --gateway                          Install URL of the shared Kimaki bot
    --gateway-callback-url <url>       Redirect here after the gateway install

  bot token                            Print KIMAKI_BOT_TOKEN for CI and automation

  bot presence set <text>              Set the bot status text in Discord

    --type <kind>                      playing | watching | listening | competing | custom (default: custom)
    --status <status>                  online | idle | dnd | invisible (default: online)

  bot presence clear                   Clear the bot status text

Options:
  -h, --help                           Show help
  -v, --version                        Show version
```

Default session for `session title`, `session archive`, `upload-to-discord`: the
`OPENCODE_SESSION_ID` env var that OpenCode sets in agent bash, so agents need no
`--session` flag.

#### `session` details

| Command | Flags (see help) | V2 implementation |
|---|---|---|
| `session list` | `--active`, `--exclude <id>`, `--project <path>`, `--all`, `--json` | `client.session.list({ directory })` + busy state from `session.status`-equivalent / execution events; exit codes 0 active, 1 none, 64 error (kept for the wait loop) |
| `session read <id>` | `--thinking`, `--verbose`, `--json` | `session.message.list`; `--json` prints `session.log` (replaces `export-events-jsonl`) |
| `session search <q>` | `--days <n>` (14, 0 = all), `--project`, `--channel`, `--all`, `--json` | title via `session.list({ search })`, then content scan (23.4) |
| `session wait <id>` | `--timeout <duration>` | `client.session.wait`, stops early on a pending form |
| `session abort <id>` | | `session.interrupt({ resume: false })` via the bot |
| `session archive [threadId]` | `--session <id>` | Discord REST |
| `session title <title>` | `--session <id>` | `session.update({ title })` |
| `session url <id>` | | SQLite lookup |
| `session editors <file>` | `--json` | scan `tool.called` inputs from `session.log` |

#### New compared to today

| Addition | Why |
|---|---|
| `kimaki status` | the CLI now depends on the running bot; one command shows if it runs, its pid, the OpenCode service URL and version, connected guilds |
| `kimaki logs [--follow]` | the log path is in the system prompt today; a command is easier for users and agents |
| `session read --json` | replaces `session export-events-jsonl` with OpenCode's own durable log |
| `session wait --timeout` | today agents must rely on the bash tool timeout |
| `bot presence set/clear` | renamed from `bot status set/clear` so `status` is free for the bot health command |
| `--verbosity text\|tools` | 2 levels instead of 3 (section 22) |
| `--worktrees`, `--voice-channels`, `--mention-only`, `--allow-mentions` | same features, shorter consistent names (today `--use-worktrees`, `--enable-voice-channels`, `--mention-mode`, `--allow-mention`) |

#### Not carried over

`multioauth *`, `discord-install-url` (use `bot install-url`), `upgrade`, `sqlitedb`,
`session export-events-jsonl`, `session discord-url` (now `session url`),
`project open-in-discord`, `send --app-id`, `send --injection-guard`, `task list --all`,
`--permission-timeout-minutes`,
root `--no-auto-upgrade`, `--enable-sync`, `--enable-footer-mentions`,
`--opencode-hostname`, `--opencode-port`, `--auto-restart`, `--enable-skill`,
`--disable-skill` (use OpenCode config for skills).

### 23.3 Provider fallback: an OpenCode plugin, not Kimaki

Today Kimaki carries `anthropicAuthPlugin`, `openaiRotationPlugin`, `xaiRotationPlugin`,
`oauth-rotation-shared.ts`, account stores, `multioauth` CLI, and the subrouter
integration. None of this is Discord-specific.

V2 plan:

- Kimaki uses the logins OpenCode already has (`opencode auth`, V2 `credential.*`).
  Kimaki `/login` becomes a thin UI over `client.credential.create` and
  `client.integration.*`
- **no subrouter support** in Kimaki
- fallback later as a **separate, standalone OpenCode plugin** (own repo or package, works
  in the TUI too). V2 already stores several credentials per provider and has
  `credential.activate`, so the plugin only needs to: watch
  `session.execution.failed` / `session.retry.scheduled` for rate-limit errors, call
  `credential.activate` on the next credential (or switch model), then
  `session.interrupt({ resume: true })`
- Kimaki core knows nothing about it

### 23.4 Session search

**Today** (`cli-commands/session.ts` 650-820): for every project directory,
`session.list()`, filter by the 14-day window, then `session.messages()` for **each**
session (concurrency 4) and match text in memory. Cost grows with sessions × messages;
that is why the 14-day default exists.

**V2 built-in:** `session.list({ search })` exists, but it only matches the **title**
(`like(SessionTable.title, '%q%')` in `packages/core/src/session/store.ts`). There is no
content search API. All sessions of all projects live in one OpenCode SQLite DB.

Options:

| Option | Speed | Cost |
|---|---|---|
| A. title search only: `session.list({ search })` | instant | loses content search |
| B. client-side scan as today, but one server and `session.message.list` pages | same as today | no new code risk |
| C. read OpenCode's SQLite directly (read-only) with a `LIKE` / FTS query | fast | couples Kimaki to OpenCode's private schema; breaks on upstream migrations |
| D. upstream a content search to OpenCode (`session.list({ search, content: true })` or an FTS table) | fast | needs an OpenCode PR |

Recommendation: **A + B now** (title hits first, then content scan limited by `--days`),
and propose **D** upstream. Avoid C: it is the kind of hidden coupling this rebuild
removes.

### 23.5 Discord parity: every slash command is also a CLI command

Rule: anything a user can do in Discord, a user or an agent can do from the CLI. Both
call the **same action function** in the bot.

```
slash command handler ──┐
                        ├──▶ actions.ts: typed action registry ──▶ OpenCode client / SQLite / Discord
kimaki CLI ──POST /kimaki/action/<name> { args, sessionID? }──┘
```

- `actions.ts` defines each action once: name, input type, handler. Slash commands only
  collect input (options, select menus) and call the action. The CLI only parses flags
  and posts the same input to the lock port
- `/kimaki/send` from 9.5 becomes the `send` action in the same registry
- target session defaults to `OPENCODE_SESSION_ID`
- **no Kimaki command when the OpenCode CLI already does it and Discord does not need
  to change**. Those rows point to `opencode …` below (23.6)

#### Parity table

| Discord | CLI | Action |
|---|---|---|
| message in channel, `/new-session` | `send --channel` | `send` |
| message in thread | `send --thread` | `send` |
| `. queue`, `/queue` | `send --thread … -p '… . queue'` or `session queue add <text>` | `send` (delivery queue) |
| queue Remove button, `/clear-queue` | `session queue list`, `session queue remove <inboxId>`, `session queue clear` | `queue.list/remove/clear` |
| `/queue-command` | `session command <name> [args] --queue` | `command` |
| `/<cmd>-cmd`, `/<skill>-skill`, `/<prompt>-mcp-prompt` | `session command <name> [args]` | `command` |
| `. btw`, `/btw` | `session btw <text>` | `btw` |
| `!cmd`, `/run-shell-command` | `session shell <command>` | `shell` |
| `/abort` | `session abort` | `abort` |
| `/agent`, `/<agent>-agent` | session: `opencode api session.switchAgent`; channel: `kimaki channel agent <name>` | `agent.set` |
| `/model`, `/model-variant` | session: `opencode api session.switchModel`; channel: `kimaki channel model …`; global: OpenCode config | `model.set` |
| `/verbosity` | `channel verbosity <text\|tools>` | `channel.set` |
| mention mode | `channel mention-only <on\|off>` | `channel.set` |
| `/worktrees` toggle | `channel worktrees <on\|off>` | `channel.set` |
| `/compact` | `opencode api session.compact` | |
| `/fork` | `session fork [--before <messageId>]` | `fork` |
| `/fork-subagent` | `session fork <childSessionId>` | `fork` |
| `/resume` | `session resume <sessionId> --channel <id>` | `resume` |
| `/undo`, `/redo` | `opencode api session.revert.*` | |
| `/diff` | `session diff` | `diff` |
| `/context-usage` | `opencode api session.get` / `opencode stats` | |
| `/session-id` | `session url`, `session read` | |
| `/last-sessions` | `session list` | |
| `/new-worktree` | `worktree new [name] [--base <branch>]` or `send --worktree` | `worktree.create` |
| `/worktrees` | `worktree list`, `worktree delete <name>` | `worktree.*` |
| `/merge-worktree` | `merge-worktree` | `worktree.merge` |
| `/tasks` | `task list/edit/delete`, `task run <id>` | `task.*` |
| `/add-project`, `/create-new-project`, `/remove-project` | `project add/create/remove` | `project.*` |
| `/login` | `opencode auth login`, `opencode auth switch` | |
| `/mcp` | `opencode mcp list/add/auth/logout` | |
| `/transcription-key` | `bot keys set --openai/--gemini <key>` | `keys.set` |
| `/restart-opencode-server` | `opencode service restart` | |
| `/screenshare` | `screenshare` | |
| `/vscode` | `vscode` | |
| agent list, model list (select menus) | `opencode debug agents`, `opencode models` | read only |

#### Help additions

```
  session command <name> [args]        Run an OpenCode command, skill, or MCP prompt

    --queue                            Run after the current turn instead of interrupting
    -s, --session <sessionId>          Target session (default: OPENCODE_SESSION_ID)

  session shell <command>              Run a shell command in the session folder. Output goes to context, no reply

    -s, --session <sessionId>          Target session (default: OPENCODE_SESSION_ID)

  session btw <text>                   Fork the session into a new side thread with this prompt

    -s, --session <sessionId>          Source session (default: OPENCODE_SESSION_ID)

  session queue list                   List queued prompts of a session

    -s, --session <sessionId>          Target session (default: OPENCODE_SESSION_ID)
    --json                             Output as JSON

  session queue add <text>             Queue a prompt after the current turn
  session queue remove <inboxId>       Remove one queued prompt
  session queue clear                  Remove all queued prompts

    -s, --session <sessionId>          Target session (default: OPENCODE_SESSION_ID)

  session diff                         Upload the git diff to critique.work and print the URL

    -s, --session <sessionId>          Target session (default: OPENCODE_SESSION_ID)

  session fork [sessionId]             Fork into a new thread (default: whole history)

    --before <messageId>               Fork before this user message
    -n, --name <name>                  Thread name

  session resume <sessionId>           Bind an existing OpenCode session to a new thread

    -c, --channel <channelId>          Channel for the new thread (default: channel of the session folder)

  channel agent <name>                 Default agent for new sessions in a channel
  channel model <provider/model>       Default model for new sessions in a channel

    --variant <name>                   Model variant
    -c, --channel <channelId>          Target channel (default: channel of the current folder)
    --clear                            Remove the channel default

  channel verbosity <text|tools>       What the bot shows in a channel
  channel mention-only <on|off>        Answer only when the bot is mentioned
  channel worktrees <on|off>           New threads get a git worktree

    -c, --channel <channelId>          Target channel (default: channel of the current folder)

  worktree new [name]                  Create a worktree thread for a project

    --base <branch>                    Base branch (default: current HEAD)
    -c, --channel <channelId>          Project channel (default: channel of the current folder)

  worktree list                        List worktrees of a project
  worktree delete <name>               Delete a worktree and its branch

    -c, --channel <channelId>          Project channel (default: channel of the current folder)

  task run <taskId>                    Run a scheduled task now

  bot keys set                         Store API keys for voice transcription and TTS

    --openai <key>                     OpenAI key
    --gemini <key>                     Gemini key

  vscode                               Open the project in VS Code in the browser via a tunnel

    -d, --project <path>               Project (default: current directory)
```

`merge-worktree` moves to `worktree merge` for consistency.

### 23.6 Use the OpenCode CLI directly

Verified with `opencode2 --help` (installed `opencode v2.0.19`). These cover Kimaki
commands that only talk to OpenCode, so Kimaki does not reimplement them:

| Need | OpenCode command |
|---|---|
| list models | `opencode models` |
| list agents | `opencode debug agents` |
| provider login, account switch | `opencode auth list / login / logout / switch` |
| MCP servers | `opencode mcp list / add / auth / logout` |
| plugins | `opencode plugin list / add / check / update / remove` |
| session list, delete | `opencode session list / delete` |
| transcript export, import | `opencode session export [session] [--sanitize]`, `opencode session import [file]` |
| any server endpoint | `opencode api <operationId> [--param k=v] [-d body] [-H name:value]` |
| one-off prompt without Discord | `opencode run [message] --session --model provider/model#variant --agent --file --format json` |
| usage stats | `opencode stats` |
| paths, config sources | `opencode debug paths / config` |

`opencode api` examples for actions that have no Kimaki command:

```sh
opencode api session.switchModel --param sessionID=$OPENCODE_SESSION_ID -d '{"model":"anthropic/claude-opus-4-6"}'
opencode api session.switchAgent --param sessionID=$OPENCODE_SESSION_ID -d '{"agent":"plan"}'
opencode api session.compact     --param sessionID=$OPENCODE_SESSION_ID
opencode api session.log         --param sessionID=$OPENCODE_SESSION_ID
```

The bot still sees these changes: `session.model.selected`, `session.agent.selected`,
`session.compaction.*` arrive on the event stream and update the thread view.

#### Connecting to Kimaki's server

Nothing to do: Kimaki uses the user's OpenCode service (28.2), and the `opencode` CLI
connects to that service by default. No shim, no `--server` flag.

#### Removed from the Kimaki CLI because of this

`session agent`, `session model`, `session compact`, `session undo`, `session redo`,
`session context`, `model default`, `model list`, `agent list`, `login`, `mcp list/enable/disable`,
`opencode restart`. Discord slash commands for the same features stay; they call the
OpenCode client in `actions.ts`.

Not in the installed 2.0.19 build but in 2.0.20 source: `opencode auth export/import`.

---

## 24. Multiple machines

Decision: **one Kimaki bot process per machine**, as today. No remote OpenCode clients,
no plugin RPC, no `kimaki node`. Adding a machine = run `kimaki` on it.

```
Discord server
├─ Kimaki macbook            ◀── category owned by the bot process on the MacBook
│   ├─ #kimakivoice
│   └─ #website
├─ Kimaki mac-mini           ◀── category owned by the bot process on the Mac mini
│   ├─ #kimakivoice-mac-mini
│   └─ #build-server
└─ Kimaki Audio macbook      (voice channels, optional)

macbook:  kimaki bot ──▶ opencode service ──▶ SQLite (own)
mac-mini: kimaki bot ──▶ opencode service ──▶ SQLite (own)
```

### 24.1 Why not remote OpenCode clients

OpenCode V2 (2.0.20) has no federation: a server does not forward another server's
sessions or events, remote workspace adaptors do not exist, and `session.move` is
same-host only. A single bot driving N remote servers would need network exposure of
every server, N event streams, remote file handling, and an RPC relay for agent→bot
calls. Per-machine bots need none of this; each machine is a complete, local Kimaki.

### 24.2 Rules

| Concern | Rule |
|---|---|
| ownership | a channel belongs to the machine whose SQLite has it in `channels`. Other bots ignore it (existing ingress gate, kept) |
| finding a machine | one category per machine, named `Kimaki <machine>`. `<machine>` defaults to the hostname; `--machine-name <name>` overrides it. Stored by category ID, so a rename in Discord still works |
| same project on two machines | two channels; the second gets a `-<machine>` suffix |
| gateway mode | each machine has its own `client_id:secret` (already true) |
| self-hosted mode | machines can share one bot token; ownership is by channel, not by bot |
| starting a session on another machine | post in that machine's channel, or `kimaki send --channel <id>` |
| agent on machine A starts a session on machine B | `kimaki send --channel <B channel>`: the channel is not in A's SQLite, so the CLI uses the remote-send envelope (9.5 option B). B's bot decodes it and calls its own `startSession` |
| listing machines | `kimaki project list --all` scans Kimaki categories in Discord (existing) |

So Q12 (cross-machine `kimaki send`) is decided: **option B**, the minimal embed
envelope, only for channels owned by another machine.

### 24.3 What stays local per machine

Lock port (`/health`, `/kimaki/send`), SQLite, the OpenCode service,
plugin, scheduler, sleeps. The agent→bot transport stays the local lock port
(section 2); nothing crosses machines except Discord messages.

### 24.4 New flag

```
    --machine-name <name>              Name shown in the category `Kimaki <name>` (default: hostname)
```

---

## 25. Feature loss and persistence audit

### 25.1 Features removed

| Feature | Today | V2 | Replacement |
|---|---|---|---|
| external session sync (`--enable-sync`) | TUI sessions mirrored into `Sync:` threads | gone | `kimaki session read`, `/resume` |
| queued shell `!cmd. queue` | runs after the turn | gone until [opencode#52274](https://github.com/anomalyco/opencode/issues/52274) | `!cmd` runs in parallel via `session.shell`, output joins context |
| `. btw queue` | fork after the turn | gone | `. btw` (fork now) |
| edit/delete a queued Discord message | updates/removes the queue item | gone | Remove button, `session queue remove` |
| thread rename from OpenCode title | automatic | gone | `kimaki session title` |
| footer mentions (`--enable-footer-mentions`) | `<@user>` in footer | gone | Discord thread notifications |
| cache-clear notice, cache drift patches | debug notices | gone | logs |
| large tool output notice (`bash returned N tokens`) | subtext line | gone | `/context-usage`, `opencode stats` |
| context usage notices every 10% | subtext line | gone | footer %, `/context-usage` |
| TUI toast relay | subtext line | gone | none |
| MEMORY.md support | TOC injected on the first message, reminder after large replies | gone | agents read `MEMORY.md` themselves if the project `AGENTS.md` says so |
| thinking lines `┣ thinking` | at top verbosity | gone | none |
| third verbosity level | 3 levels | 2 levels (`text`, `tools`) | |
| history replay in `/fork`, `/resume` | last 30 parts re-posted | gone | link to the source thread |
| `/share` | public URL | gone until V2 has a share API | |
| one session bound to several threads | `/resume` adds a binding | a session has one thread; `/resume` moves it | |
| injection guard (plugin, `--injection-guard`, per-session patterns) | LLM judge on tool output | gone | none |
| permission timeout (`--permission-timeout-minutes`) | auto-deny after 10 min | gone | a new message cancels a pending permission |
| self-upgrade (`/upgrade-and-restart`, `kimaki upgrade`, background upgrade) | automatic | gone | `npm i -g kimaki` |
| OpenCode auto install | installs `opencode` if missing | gone | user installs OpenCode; Kimaki uses its service |
| `--opencode-hostname/--opencode-port` | connect to an existing server | gone | Kimaki always uses the OpenCode service |
| Kimaki-owned OpenCode process | Kimaki spawns and restarts OpenCode | gone | shared service; `/restart-opencode-server` removed (`opencode service restart`) |
| multi-account OAuth rotation, Claude OAuth plugin, subrouter | built in | gone | OpenCode credentials; later a separate fallback plugin |
| `<button>` markdown extension | internal only | gone | direct components in `/tasks`, `/worktrees` |
| task run history (`scheduled_task_runs`), `task list --all` | stored | gone | sessions carry `metadata.kimaki.taskId` |
| forum sync, `openai-realtime.ts`, sentry | dead code | gone | |
| misc CLI | `discord-install-url`, `sqlitedb`, `project open-in-discord`, `send --app-id`, `session export-events-jsonl` | gone | `bot install-url`, `status`, `session read --json` |

Behavior changes (not removed, but different):

| Feature | Change |
|---|---|
| text layout | no quoting; all text full width |
| subagents | task line + child tool lines (label `explore ⋅`, no `-1` counters); no child text; child permissions and questions shown in the parent thread |
| question "Other" | Discord modal instead of typing in chat |
| permission prompts | no dedupe across identical patterns |
| voice agent hint on `queue` | ignored |
| worktree reminder | sessions never move folders, so no "cwd changed" reminder |
| `kimaki send` result | returns session ID at once (no polling) |
| cross-machine send | embed envelope, only for channels of another machine |
| pending sleeps and planned tasks | kept: V2 reads the same tables |

Still proposed, not confirmed (section 22 Tier 1): context-only `@otheruser` messages,
per-channel mention mode (kept as a `channels` column in the schema).

### 25.2 `kimaki session editors <file>`

Still supported, different implementation:

| | Today | V2 |
|---|---|---|
| data | plugin appends every edit/write/patch to `file-edit-events.jsonl` | scan `session.log` of recent sessions for `session.tool.called` inputs with a path |
| speed | instant (read one file) | one log fetch per session in the window (`--days`, default 14) |
| coverage | only since the plugin was installed, all time | any session OpenCode has, limited by `--days` |

If the scan is too slow, keep the plugin writing the JSONL index. That is allowed: a
plain file append in the data dir, no SQLite, no bot call.

### 25.3 What needs persistence, and who owns it

**OpenCode owns** (survives bot restarts, nothing to do in Kimaki):

| Data | V2 mechanism |
|---|---|
| sessions, messages, tool results | session store |
| queue (inbox) | durable `session.inbox.*` |
| system prompt | `session.instructions` entries |
| agent, model per session | `session.agent.selected`, `session.model.selected` |
| permission rules per session | `session.update({ permissions })` |
| event history for replay | `session.log` (durable events, per-session `seq`) |
| worktrees | `worktree.*`, session location |
| provider logins | `credential.*` |
| pending questions and permissions | **in memory in OpenCode**: lost if the OpenCode server restarts (the waiting tool is gone too) |

**Kimaki owns** (SQLite, subset of the V1 tables, section 17):

| Data | Table | Why it cannot live in OpenCode |
|---|---|---|
| bot credentials, audio keys, global default model | `bots` | Discord / Kimaki config |
| category per guild | `guild_categories` | Discord IDs |
| channel → directory, channel prefs | `channels` | Discord IDs and Discord-only prefs |
| thread ↔ session | `thread_sessions` | Discord IDs |
| scheduled tasks | `scheduled_tasks` | Kimaki scheduler |
| sleeps | `session_sleeps` | Kimaki scheduler |

**Kimaki files**: `lock-token`, `opencode-config.json`, `attachments/`, `kimaki.log`,
optionally `file-edit-events.jsonl`.

### 25.4 What is in memory only (lost on bot restart)

| State | Effect of a restart | Fix |
|---|---|---|
| block → Discord message ID map | last text of an in-progress turn is not re-edited; mid-turn gap (Q5) | accept, post `-# kimaki restarted` in busy threads |
| typing timers | restarted from the next busy event | none needed |
| pending question dropdowns, permission buttons | re-rendered from `form.list` / `permission.list` at startup; custom IDs carry native IDs, so old buttons still work | built in |
| queue Remove buttons | custom ID carries `inboxID`: still works | built in |
| **action buttons** (`kimaki buttons`) | today stored in memory with a 24h TTL and `action_button:<hash>:<i>`; after a restart clicks fail | encode the button in the custom ID when it fits (`ab:<sessionId>:<i>`) and read label/command back from the rendered message's components, so no store is needed |
| upload requests | the waiting CLI call is dropped with the connection | the CLI prints an error; the agent can ask again |
| slash command wizards (`/model`, `/login`) | user reruns the command | none needed |

---

## 26. Remaining complexity to cut

After sections 18, 22 and 25, these parts of the V2 design still carry the most
complexity. Ranked by how much they remove.

| # | Area | Complex part | Simpler design | Removes |
|---|---|---|---|---|
| 1 | **renderer** | message edits: live text preview, tool line edit on success, quoting and final un-quote, restart map | **append-only renderer**: post text on `text.ended` (full width, never quoted), tools on `tool.called`, footer on `execution.succeeded`. No edits, no lookahead, no block → message ID map | edit throttling, message map, restart gap (Q5) |
| 2 | **reconnect replay** | `seq` cursor per session, `session.log` catch-up (experimental API) | TUI connect protocol (6.8): hydrate from `message.list` on every connect, dedupe by block keys, render only on reconnect | cursor state, dependency on an experimental endpoint |
| 3 | **system prompt** | ~1000 lines in `system-message.ts`, 30 sections, conditionals | small instruction entry (identity, IDs, Discord formatting, callouts, "call UI commands last"). Move all `kimaki` CLI usage (send, schedule, worktrees, sessions, tunnels) into a bundled **`kimaki` skill** the model loads on demand | ~800 lines, tokens on every request |
| 4 | **dynamic slash commands** | one Discord command per agent, OpenCode command, skill, MCP prompt; 100-command limit; name mapping state (`registeredUserCommands`); re-registration | fixed commands with **autocomplete**: `/agent name:`, `/command name: args:` (commands, skills, MCP prompts). Autocomplete reads `agent.list` / `command.list` live | registration sync, name mapping, limit handling |
| 5 | **sleep** | own table, own scheduler path, wake claim | keep the `session_sleeps` table (compatibility); same scheduler loop as tasks, idempotent wake by `delivery_id` prompt ID. Originally proposed: a sleep **is a one-shot scheduled task** to the thread (`kind: 'wake'`). A new user prompt deletes wake tasks of that session | `session_sleeps` table, second scheduler loop |
| 6 | **attachments** | HEIC conversion, image resizing (sharp), text inlining with size rules, `<attachment>` tags | save every attachment under `<dir>/uploads/` and pass `files: [{ uri: 'file://…' }]`. V2 core already resizes images (`packages/core/src/image.ts`: maxWidth, maxHeight, maxBytes) and reads text files | image pipeline, sharp/heic deps (verify HEIC support in V2 first) |
| 7 | **`!cmd` live output** | poll `shell.output` 1/s, throttled edits, split at 2000 chars | post `-# $ cmd` at start and the output once at `shell.ended` (tail, truncated, as a file if long) | edit loop, throttle state |
| 8 | **live voice channels** | Gemini Live worker, audio pipeline, voice tools (`voice-handler.ts` 1000 lines, `genai*.ts` 700) | drop. Keep voice **messages** (transcription + routing) | ~2000 lines, `--voice-channels`, audio category |
| 9 | **subagent rendering** | per-child `-1/-2` counters, child text | keep task line + child tool lines with the agent name as label, and child permissions/forms. Discover children like the TUI (6.8). Drop counters and child text | counter state |
| 10 | **model scopes** | session, channel, global defaults + variants | session + channel. Global default = OpenCode's own default model in its config | `bots.default_model`, `model default` command |
| 11 | **bundled plugins** | injection guard, kitty graphics, image optimizer inside Kimaki's plugin | injection guard removed; kitty graphics and image optimizer dropped (V2 resizes images) | plugin size, per-tool wrapper |
| 12 | **onboarding tutorial** | default `kimaki` channel, tutorial thread, tutorial prompt detection | keep the default channel; drop the tutorial thread and its prompt injection | tutorial detection, instruction special case |
| 13 | **permission timeout** | per-request timer, restart handling | **removed**. A new user message cancels a pending permission | timers, flag |

After these cuts the bot core is:

```
ingress (gates → Route) ──▶ dispatch ──▶ OpenCode
                                           │ /api/event
renderer (append-only) ◀┘ ──▶ Discord
UI: forms, permissions, buttons, upload        scheduler: tasks (incl. wakes)
```

Open checks for this section: HEIC input in V2 (`packages/core/src/image.ts`), and
whether Discord autocomplete covers the `/command` case well enough for users who type
`/review` today (they would type `/command review`).

---

## 27. Code architecture

### 27.1 No runtime class

`ThreadSessionRuntime` (5752 lines) exists because every thread owned mutable state:
local queue, event buffer, busy flags, sent part IDs, message maps, typing timers,
dispatch guards. After sections 9, 18, 22 and 26 most of that is gone or derived. What is
left per thread is small **data**, plus two **resources** (a typing timer and a serial
Discord queue). Data goes in one store, resources in one executor. No classes, except
errore tagged errors.

### 27.2 The moving parts

```
                 ┌──────────── writers ────────────┐
Discord messages ─▶ ingress ─▶ routes ─┐            │
slash commands ────────────────────────┼─▶ actions ─┼─▶ OpenCode (HTTP)
buttons / selects ─────────────────────┤            │        │
lock server (CLI) ─────────────────────┤            │        │ /api/event
scheduler (tasks, wakes) ──────────────┘            │        ▼
                                                    │   event loop ─▶ reduce (pure) ─▶ effects ─▶ Discord
                                                    │        ▲              │
                                                    │        └──── store ◀──┘ (views, UI refs)
                 └──────────── readers ─────────────┘
```

Four chokepoints. Each is the **only** place that does its job:

| Chokepoint | Only place that … | Module |
|---|---|---|
| **actions** | calls OpenCode write APIs (`prompt`, `shell`, `interrupt`, `fork`, `form.reply`, `permission.reply`, `inbox.*`, `switchModel`, …) and creates threads | `actions.ts` |
| **reducer** | interprets OpenCode events | `thread-reducer.ts` |
| **effects executor** | posts, edits, types in session threads | `effects.ts` |
| **store** | holds mutable in-memory state | `store.ts` |

Dependency direction is one way: `ingress | commands | cli | scheduler → actions →
OpenCode`, and `OpenCode → event loop → reducer → effects → Discord`. Actions never
render session output; they only return an ack for the caller (slash reply, CLI output).
The renderer never calls OpenCode.

### 27.3 Reducer: pure, returns effects

```ts
type ThreadView = {
  threadId: string
  sessionId: string
  busy: boolean                          // execution.started … terminal
  turn: { startedAt: number; model: string; agent: string; tokens: number } | null
  children: Readonly<Record<string, string>>   // child sessionId → label ("explore")
  toolNames: Readonly<Record<string, string>>  // assistantMessageID+toolId → name (from tool.input.started)
  postedKeys: ReadonlySet<string>              // dedupe on reconnect hydration (6.8)
  lastKind: 'text' | 'tool' | null       // blank line between kinds
  queued: readonly InboxItem[]           // pending queue, for "position N"
  ui: {                                  // Discord message IDs of live prompts
    forms: Readonly<Record<string, string>>        // formID → messageId
    permissions: Readonly<Record<string, string>>  // requestID → messageId
  }
}

type Effect =
  | { type: 'send'; content: DiscordPayload }
  | { type: 'typing'; on: boolean }
  | { type: 'show-form'; form: Form }              // result feeds back as kimaki.ui.rendered
  | { type: 'show-permission'; request: PermissionRequest }
  | { type: 'disable'; messageId: string }
  | { type: 'queue-ack'; inboxID: string; position: number }

function reduce(view: ThreadView, event: OpenCodeEvent | KimakiEvent): { view: ThreadView; effects: Effect[] }
```

- tests feed fixture event arrays and snapshot `effects`. No Discord, no OpenCode
- `KimakiEvent` is the small set of internal events (`kimaki.ui.rendered { formID,
  messageId }`, `kimaki.reconnected`). Effect results come back **through the reducer**,
  so there is one path that changes a view
- verbosity and channel prefs are inputs (`reduce(view, event, prefs)`), not state

### 27.4 Store

`zustand/vanilla`, one atom:

```ts
type State = {
  threads: Readonly<Record<string, ThreadView>>       // threadId → view
  sessionThreads: Readonly<Record<string, string>>    // sessionId (root + children) → threadId
}
```

- `sessionThreads` is filled from SQLite `thread_sessions` at startup and on bind, and
  gets children through subagent discovery (6.8). Events of an unknown session are held
  until `session.get` + `parentID` walk decides; sessions that do not lead to a bound
  session (TUI sessions) are dropped
- ingress reads `threads[id].busy` to decide steer + interrupt
- nothing else: config is plain constants from the CLI flags, wizard contexts live in the
  command that owns them (closure + TTL map), timers live in the executor

### 27.5 Effects executor

```ts
// per-thread serial queue + typing timer; the only Discord writer for session output
function runEffects(threadId: string, effects: Effect[]): void
```

- one promise chain per thread (order), one typing interval per thread (7s refresh)
- rate limits: rely on discord.js queueing; the append-only renderer has no edits to
  throttle
- never awaited by the event loop (the SSE reader must not block; 4096-event buffer)

### 27.6 Co-location: feature files

Each interactive feature owns its whole vertical slice in one file: reducer cases,
Discord rendering, component custom IDs, interaction handler, and the action it calls.
The core reducer composes feature reducers.

| File | Contains |
|---|---|
| `thread-reducer.ts` | `ThreadView`, `Effect`, `reduce()` composing the slices below; busy, turn, footer, text and tool lines |
| `format-parts.ts` | pure formatting: tool lines per tool, footer line, banner, verbosity filter |
| `questions.ts` | form events slice, dropdown rendering, `Other` modal, select handler → `actions.answerForm` |
| `permissions.ts` | permission events slice, Accept / Always / Deny buttons, timeout, handler → `actions.replyPermission` |
| `queue.ts` | inbox events slice, "Queued (position N)" ack, Remove button handler, edit/delete of Discord messages → `actions.queue*` |
| `agent-ui.ts` | `kimaki buttons`, `kimaki upload-request`: lock-server handlers, rendering, click/upload handlers |
| `ingress.ts` | gates (bots, ownership, permission, mentions), attachments → files |
| `routes.ts` | `parseTextMessage`, `parseVoiceMessage` → `Route` (pure, tested) |
| `voice.ts` | transcription providers + transcription tool schema |
| `actions.ts` | typed registry: every write, shared by slash commands, CLI, scheduler, buttons |
| `event-loop.ts` | connect protocol (6.8): subscribe, hold, hydrate, apply; subagent discovery; route by `sessionThreads`, `reduce`, store update, `runEffects` |
| `effects.ts` | executor |
| `store.ts` | zustand store |
| `opencode-server.ts` | discover/ensure the service, version check, plugin registration, auth, client, reconnect |
| `lock-server.ts` | `/health`, `/kimaki/send`, agent UI routes |
| `scheduler.ts` | tasks and wakes, calls `actions` |
| `markdown/` | AST pipeline (section 8) |
| `commands/*.ts` | slash command definitions: collect input, call `actions`, reply |
| `cli/*.ts` | goke commands: HTTP to the lock server, direct OpenCode reads |
| `db.ts`, `schema.ts` | SQLite (subset of V1 tables, same file), `schema.sql` at bot start only |
| `onboarding.ts` | credentials wizard, gateway flow, guild and channel setup |
| `main.ts` | wiring: lock → db → OpenCode + Discord → event loop, ingress, scheduler, lock server |
| `plugin/index.ts` | OpenCode plugin (separate process): context hook and bash schema, guarded by session metadata |

Rules:

- a feature file may import `actions`, `store` (read), `format-parts`, `markdown`; it
  never imports another feature file
- only `event-loop.ts` writes `store.threads`; only `actions.ts` imports the OpenCode
  client for writes
- files under ~100 lines merge into their closest neighbour (for example `routes.ts`
  stays with its tests but `voice.ts` absorbs small provider helpers)

### 27.7 What each moving part must not know

| Part | Must not know about |
|---|---|
| reducer | Discord API, OpenCode client, SQLite, time (timestamps come from events) |
| effects | OpenCode, event types (it only sees `Effect`) |
| actions | how session output is rendered |
| ingress / routes | OpenCode events, busy flags except `view.busy` |
| plugin | Discord, SQLite, the bot |
| CLI | SQLite writes (except `project`/`task` admin), session state |

---

## 28. OpenCode V2 architecture and API reference

Verified against `anomalyco/opencode#v2` source (2.0.20) and the installed CLI
(`opencode2`, 2.0.19). Paths are relative to that repo. Anything under `/experimental/`
can change between releases; those rows are marked **exp**.

### 28.1 Architecture

```
one opencode server process (HTTP + SSE, Basic auth user "opencode")
├─ locations (one per loaded directory, created on first request for it)
│    each location = its own service graph: config, agents, tools, MCP, plugins
│    └─ plugin instance: setup(ctx) runs once per location, ctx.location = that dir
├─ sessions: stored in one SQLite db (~/.local/share/opencode/opencode.db)
│    each session belongs to one location; requests route by session → location
└─ /api/event: one stream for every location and session of this process
```

| Fact | Consequence for Kimaki |
|---|---|
| **one process, many directories.** Requests pick a location with `location[directory]` or `x-opencode-directory` (`packages/server/src/location.ts`) | Kimaki needs one client for all projects |
| **plugin `setup` runs once per location**, not once per process and not per session. `ctx.location` is the loading directory, not the session's | process-wide resources (caches, maps) go on `globalThis` symbols; never assume one setup call |
| **module code runs once per import**; setup runs again for each location and after each reload | keep top-level module code side-effect free |
| **transforms** (`ctx.tool/agent/model/… .transform`) are **per location**, not per session. They replay on `reload()`; reload does **not** rerun setup | a transform cannot be limited to Discord sessions |
| **hooks** (`ctx.session.hook`, `ctx.tool.hook`, `ctx.permission.hook`) run per request and most receive `sessionID` | per-session behavior goes in hooks, guarded by metadata (28.3) |
| `ctx.shell.hook('create.before')` has **no** `sessionID` (`packages/plugin/src/promise/shell.ts`) | cannot be per session. Not needed: the shell tool already sets `OPENCODE_SESSION_ID` (`packages/core/src/tool/plugin/shell.ts:213`) |
| **reload**: `location.reload` (`opencode reload`) shuts down and rebuilds every loaded location: cleanup functions run, setup runs again, pending permissions and forms are **cancelled**, running sessions continue at the next step | never reload while Discord prompts are pending; re-render UI from `form.list` / `permission.list` after `location.shutdown` |
| **plugin files are watched** (`packages/core/src/plugin/module.ts`); a change triggers reload | editing the Kimaki plugin in dev reloads it live |
| plugin loading: files in `.opencode/plugins/` load automatically; others via `plugins` in `opencode.json(c)` (string or `{ package, options }`) | Kimaki registers its plugin by path in the config it passes to its server; options via `ctx.options` |
| **plugin storage**: `ctx.storage.get/set/scan`, durable JSON scoped to the plugin | small plugin state without files |
| **events**: live-only by default; durable session events also in `session.log` (**exp**). Subscriber buffer 4096 events, overflow kills the subscriber (`packages/server/src/event-feed.ts`) | never block the event reader |
| **session metadata**: durable, opaque, **inherited by children and forks** (`packages/schema/src/session-metadata.ts`) | the Discord marker, see 28.3 |
| **pending forms and permissions live in memory** | lost on server restart or reload together with the waiting tool |
| **no federation, no remote workspaces** | one server per machine (section 24) |

### 28.2 Server process: reuse the user's OpenCode service

**Decision: Kimaki does not spawn OpenCode.** It connects to the user's OpenCode V2
**background service**, the same server the TUI and the `opencode` CLI use.

| Need | API |
|---|---|
| find the server | `Service.discover()`: reads `~/.local/state/opencode/service.json` (url, pid, version, password, mode 0600) and checks health |
| server not running | `Service.ensure()` **without** a version option. It starts `opencode serve --service` with the user's `opencode` binary |
| auth | `Authorization: Basic base64("opencode:" + password)` from the registration file |
| client | `@opencode/client` `OpenCode.make({ baseUrl, headers })` |
| register the Kimaki plugin | onboarding adds it to `plugins` in `~/.config/opencode/opencode.json` (asks first), then `POST /api/location/reload` |
| version | read `version` from the registration; below the minimum Kimaki supports → exit with `run: opencode upgrade`. Never pass a version to `ensure()`: it **replaces** a server with a different version, which would kill the user's running TUI sessions |
| service restarted or upgraded by the user | the event stream ends; reconnect with backoff, re-read the registration (new port/password), post `-# reconnected` in busy threads, re-seed views (27) |

Consequences:

- no process spawn, no generated password, no `@opencode/cli` binary dependency (keep
  `@opencode/client` and `@opencode/plugin` as dependencies; they type the API)
- the Kimaki plugin loads in **every** session of the service, including TUI sessions.
  Every Discord-only hook is guarded by session metadata (28.3)
- plain `opencode …` in agent bash already talks to the same server: no `opencode` shim
  and no `/kimaki/opencode` route
- Kimaki per-session settings (agent, model, permissions, restrict-directories) go into
  `session.create`, never into the global config
- TUI sessions appear on the same event stream; the event loop drops unknown sessions,
  `/resume` can bind them
- tests do not touch the user's service: each test file spawns its own server with its
  own directories and SQLite database (see 28.2.1)

#### 28.2.1 Isolated OpenCode server for tests

Verified in the `v2` source: every path OpenCode uses comes from XDG base directories
(`packages/util/src/global-roots.ts`) or an `OPENCODE_*` env var
(`packages/cli/src/server-process.ts`, `packages/cli/src/database-path.ts`). So a test
server is fully isolated by env alone:

| Env var | Effect | Test value |
|---|---|---|
| `XDG_DATA_HOME` | data dir → `opencode.db`, logs, repos | `<tmp>/data` |
| `XDG_STATE_HOME` | state dir → **service registration file**, locks | `<tmp>/state` |
| `XDG_CONFIG_HOME` | global config dir (`opencode.json`, plugins) | `<tmp>/config` |
| `XDG_CACHE_HOME` | cache, installed plugin deps, `bin` | `<tmp>/cache` (or shared, to reuse installs between runs) |
| `OPENCODE_DB` | database file name or path relative to data dir; `:memory:` for in-memory | default, or `:memory:` for speed |
| `OPENCODE_CONFIG_CONTENT` | inline config JSON: deterministic provider, model, Kimaki plugin by path | per test file |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | ignore `opencode.json` files in the test project dirs | set |
| `OPENCODE_DISABLE_MODELS_FETCH=1` + `OPENCODE_MODELS_PATH` | no network for the models catalog | set, fixture file |
| `OPENCODE_PASSWORD` | server password | random per run |
| `OPENCODE_TEST_HOME` | overrides `home` inside OpenCode | `<tmp>/home` |

Harness (one server per test **file**, started in `beforeAll`):

```ts
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-e2e-'))
const env = {
  ...process.env,
  XDG_DATA_HOME: `${root}/data`, XDG_STATE_HOME: `${root}/state`,
  XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`,
  OPENCODE_TEST_HOME: `${root}/home`,
  OPENCODE_PASSWORD: crypto.randomUUID(),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(testConfig),   // provider + kimaki plugin path
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
}
// same command the service uses, so Kimaki's production discovery path is tested
const server = spawn(opencodeBin, ['serve', '--service'], { env })
const bot = await startTestBot({ opencodeServiceFile: `${root}/state/opencode/service.json` })
```

- Kimaki connects through `Service.discover({ file })` pointing at the temp state dir,
  the **same code path as production**
- `opencodeBin` is the real native binary from the `@opencode/cli` devDependency, not
  the `.bin` shell wrapper (it survives SIGTERM and orphans the server)
- `afterAll`: kill the server, `rm -rf <tmp>` (inside the OS temp dir only)
- parallel test files never share a server, database, or port

Open checks: whether `serve --service` picks a free port by itself or needs `--port`;
whether plugin dependencies install into `XDG_CACHE_HOME` (share that dir across runs if
installs are slow).

### 28.3 Discord marker: session metadata

Every Kimaki session is created with metadata:

```ts
await client.session.create({
  location: { directory },
  agent, model, permissions,
  metadata: { kimaki: { threadId, channelId, source: 'discord' | 'cli' | 'task', taskId? } },
})
```

- inherited by subagents and forks, so their hooks see the marker too
- `/resume` of a TUI session adds it with `session.update({ metadata })`
- visible to the bot in `session.created` and `session.get`
- plugin hooks that must only affect Discord sessions check it first, cached per
  session on `globalThis`:

```ts
const kimakiSessions = (globalThis[Symbol.for('kimaki.sessions')] ??= new Map<string, boolean>())

async function isKimakiSession(ctx, sessionID: string) {
  const cached = kimakiSessions.get(sessionID)
  if (cached !== undefined) return cached
  const session = await ctx.session.get({ sessionID })
  const result = Boolean(session.metadata?.kimaki)
  kimakiSessions.set(sessionID, result)
  return result
}
```

Arguments the plugin needs per session (thread ID, verbosity-related schema changes)
come from the same metadata, not from env vars.

| Plugin behavior | Mechanism | Discord-only? |
|---|---|---|
| git branch | `session.hook('context')`, push to `event.system` | yes, guarded |
| bash `description` / `hasSideEffect` params | `session.hook('context')`: edit `event.tools.<shell>.input` for this request | yes, guarded (per request, not a global transform) |
| session ID in bash | native `OPENCODE_SESSION_ID` | no plugin needed |
| Discord system prompt | `session.instructions.entry.put` at create (**exp**) | yes, only set on Kimaki sessions |
| per-turn `<discord-user>` context | added to prompt text by the bot | yes, by construction |

### 28.4 APIs Kimaki uses

Client method names follow the OpenAPI identifier (`session.prompt` → `client.session.prompt`).

**Sessions**

| API | HTTP | Kimaki use |
|---|---|---|
| `session.create` | `POST /api/session` `{ id?, title?, agent?, model?, location?, metadata?, permissions? }` | new thread, btw target, task run |
| `session.get` | `GET /api/session/:id` | metadata, location |
| `session.list` | `GET /api/session?search&limit&order&parentID` (search = **title only**) | `session list/search` |
| `session.active` | `GET /api/session/active` | busy state at startup |
| `session.update` | `PATCH /api/session/:id` `{ title?, metadata?, permissions? }` | title, marker on resume |
| `session.prompt` | `POST /api/session/:id/prompt` `{ id?, text, files?, agents?, skills?, delivery: 'steer'\|'queue', metadata? }` | every user message |
| `session.command` | `POST /api/session/:id/command` | `/command`, queued commands |
| `session.shell` | `POST /api/session/:id/shell` `{ id?, command }` | `!cmd` |
| `session.synthetic` | `POST /api/session/:id/synthetic` | optional notes into context |
| `session.interrupt` | `POST /api/session/:id/interrupt?resume=` | interrupt + steer, `/abort` |
| `session.inbox.list / cancel / update` | `/api/session/:id/inbox[/:inboxID]` | queue list, Remove, promote |
| `session.fork` | `POST /api/session/:id/fork` | btw, `/fork` |
| `session.switchAgent / switchModel` | `POST /api/session/:id/agent`, `/model` | `/agent`, `/model` |
| `session.compact` | `POST /api/session/:id/compact` | `/compact` |
| `session.revert.stage / clear / commit` | `/api/session/:id/revert…` | `/undo`, `/redo` |
| `session.diff` | `GET /api/session/:id/diff` | `/diff` (optional, instead of git) |
| `session.messages`, `session.message` | `GET /api/session/:id/message[/:messageID]` | `session read`, content search |
| `session.context` | `GET /api/session/:id/context` | context usage |
| `session.wait` **exp** | `POST /api/experimental/session/:id/wait` | `session wait` |
| `session.log` **exp** | `GET /api/experimental/session/:id/log?after&follow` | `session read --json`, `session editors` |
| `session.instructions.entries` **exp** | `/api/experimental/session/:id/instructions/entries[/:key]` | system prompt |
| `session.export / import` **exp** | `/api/experimental/session/…` | not used in v1 of the rebuild |

**Interactive**

| API | HTTP | Kimaki use |
|---|---|---|
| `session.form.list / get / reply / cancel` | `/api/session/:id/form[/:formID[/reply]]` | questions (`metadata.kind === 'question'`) |
| `session.permission.list / reply` | `/api/session/:id/permission[/:requestID/reply]` `{ decision: 'once'\|'always'\|'reject', message? }` | permission buttons |
| `permission.request.list` | `GET /api/permission/request` | pending permissions at startup |
| `shell.output / remove` | `/api/shell/:id[/output]` | `!cmd` output, kill on abort |

**Catalog and config**

| API | Kimaki use |
|---|---|
| `agent.list`, `command.list`, `model.list`, `model.default`, `provider.list` | slash command autocomplete, `/model` picker |
| `integration.*`, `credential.*` | `/login` |
| `worktree.*` (`/api/worktree`) | `/new-worktree`, `/worktrees` |
| `location.reload` | after config changes |
| `event.subscribe` (`GET /api/event`) | the event loop |

### 28.5 Events Kimaki consumes

See 6.2 and 6.7 for the full table. Summary: `session.execution.*`, `session.step.*`,
`session.retry.scheduled`, `session.text.ended`, `session.tool.called/failed/progress`,
`session.inbox.*`, `session.shell.started/ended`, `session.created`,
`form.created/replied/cancelled`, `permission.asked/replied`, `location.shutdown`,
`session.usage.updated` (analytics only). There is no `session.status`,
`session.idle`, `session.error`, `message.part.updated` or `question.*` in V2 core.

### 28.6 API names that changed since 2.0.2

Earlier sections sometimes use shorthand. The source of truth is this table:

| Shorthand in this doc | Real 2.0.20 API |
|---|---|
| `client.permission.reply({ … decision })` | `session.permission.reply({ sessionID, requestID, decision })` |
| `session.message.list` | `session.messages` |
| `permission.list` | `session.permission.list` or `permission.request.list` |
| `KIMAKI_SESSION_ID` | `OPENCODE_SESSION_ID` (native) |

---

## 29. Ground truth: recorded V2 event streams

Real event streams recorded from `opencode serve` **2.0.19** (2.0.20 was blocked by the
npm minimum release age) with model `openai/gpt-6-luna` (variant low), driven through
`@opencode/client`. Files: `docs/opencode-v2-events/`.

| Fixture | Scenario |
|---|---|
| `tools.events.jsonl` | shell, patch, glob, read in one turn, including 2 failed tool calls |
| `task-subagent.events.jsonl` | one `subagent` call (agent `general`) with child glob/read, then parent read |
| `task-parallel.events.jsonl` | two parallel `subagent` calls, background mode, a reused child session |
| `question.events.jsonl` | `question` tool with a single-choice and a multi-choice question, answered by `form.reply` |
| `permission.events.jsonl` | session rule `shell: ask`; first request `once`, second `reject` |
| `steer-queue.events.jsonl` | 3 queued prompts, one cancelled by custom ID, then steer + `interrupt({ resume: true })` |
| `queue-plain.events.jsonl` | 2 queued prompts while busy, no interrupt |
| `queue-parked.events.jsonl` | queued prompt, `interrupt({ resume: false })`, then a new prompt |
| `abort.events.jsonl` | `interrupt({ resume: false })` during a 30s shell, then a new prompt |
| `shell.events.jsonl` | `session.shell` while idle and while busy, plus a `resume: false` prompt |
| `fork-compact.events.jsonl` | `session.fork`, prompt in the fork, `session.compact` |
| `worktree.events.jsonl` | `worktree.create` + session in the worktree location |
| `switch-model.events.jsonl` | `switchModel` (variant), `switchAgent` (plan), `session.update({ title })` |

Each line is `{ at, event }`; `event` is the raw envelope
`{ id, created, type, location?, data, durable?: { aggregateID, seq, version } }`.
Regenerate with `docs/opencode-v2-events/record-events.ts`; read with
`bun docs/opencode-v2-events/summarize-events.ts <file>`. Use them as reducer test
fixtures (29.3).

### 29.1 A normal turn

```
session.inbox.enqueued { inboxID, item: { type: 'user', payload: { text }, delivery } }
session.execution.started
session.instructions.updated { delta: { 'core/…': hash } }      first turn only
session.inbox.delivered { inboxID }
session.step.started { agent, model: { id, providerID, variant }, started, snapshot? }
  session.tool.input.started { id, name }            ◀── only place with the tool name
  session.tool.input.delta … / .ended { id, text }
  session.tool.called { id, input, executed: false }
  shell.created / shell.exited                        global, no sessionID (shell tool)
  session.tool.progress { id, metadata: { shellID } }
  session.tool.success { id, content: [{ type: 'text', text }], metadata }
session.step.streamed
session.step.ended { finish: 'tool-calls' | 'stop', cost, tokens: { input, output, reasoning, cache } }
… more steps …
session.text.started { ordinal } / .delta / .ended { ordinal, text, state: { phase: 'final_answer' } }
session.execution.succeeded { }                        no duration: use envelope `created`
```

### 29.2 Surprises and spec impact

| # | Observed | Spec impact |
|---|---|---|
| 1 | `session.tool.called` has **no tool name**; only `session.tool.input.started { id, name }` has it | confirmed: `toolNames` in the view (6.7) |
| 2 | tool names differ from V1: bash is **`shell`**, task is **`subagent`**, edits use **`patch`** / `edit` / `write` | verbosity rules and tool formatting use V2 names; `hasSideEffect` goes on the `shell` schema |
| 3 | subagents can run **in the background**: the `subagent` tool returns "working in the background (sessionID …)" at once; the parent can reach `execution.succeeded` while children still run; each child completion enqueues a `synthetic` item `<subagent sessionID state=…>` into the parent, which starts a **new parent execution**. With one subagent the tool waited and returned the result inline | a thread is busy while the parent **or any child** runs. The footer can fire more than once per user message; post it only when the parent is done **and** no child is running |
| 4 | children announce themselves with `session.created { parentID }` **before** the parent's `tool.progress { metadata.sessionID }` | `session.created.parentID` is the earliest child signal |
| 5 | a reused subagent session gets a new `user` inbox item in the child | children map stays valid across calls |
| 6 | plain queue: queued items are delivered **inside the same execution**; one `execution.succeeded` after all of them | turn boundary = `inbox.delivered` of a `user` item, not execution events. One footer per execution, or per turn with the next `inbox.delivered` as boundary |
| 7 | **interrupt parks queued items.** After `interrupt({ resume: false })` they run only after the next prompt. After steer + `interrupt({ resume: true })` the queued items stayed in the inbox **after** `execution.succeeded` and never ran | after an interrupted execution ends, if `inbox.list` still has `queue` items, wake them (try `inbox.update({ delivery: 'steer' })` on the first; verify) or report upstream. `/abort` should cancel queued items explicitly |
| 8 | `prompt({ resume: false })` is enqueued but starts nothing; it is delivered with the next turn | native "context-only" message; `@otheruser` thread messages can use it |
| 9 | `session.shell` emits `session.shell.started/ended` plus a `synthetic` inbox item "The following shell command was executed by the user" (`resume: false`); while busy it is delivered at the next step boundary | confirms 9.2.1 |
| 10 | `session.log` returned only `{ type: 'log.synced', seq }`, even with `after=0`: **no history** in 2.0.19 | do not rely on `session.log` for `session editors`, `session read --json` or catch-up; use `session.message.list`. Durable events still carry `durable.seq` |
| 11 | interrupt emits `tool.failed { error.type: 'aborted' }`, `step.failed`, `execution.interrupted { reason: 'user' }`, global `shell.deleted` | no error line for `aborted`; no footer |
| 12 | fork emits `session.forked { parentID, boundary, instructions }`, not `session.created` | btw/fork binding uses the fork response or `session.forked` |
| 13 | `switchAgent('plan')` enqueues a `synthetic` "You are in Plan mode" item | synthetic items are never rendered |
| 14 | compaction: own execution, `compaction.started { reason }`, many `compaction.delta`, `compaction.ended { text }` | ignore deltas; optional `-# compacted` line |
| 15 | permission action for bash is `shell`; `permission.asked { id, action, resources, save, source: { type: 'tool', messageID, id } }`; `permission.replied { requestID, reply }` | `kimaki send --permission 'shell:deny'`, not `bash` |
| 16 | `form.created { form: { id, sessionID, title, metadata: { kind: 'question', tool }, fields: [{ key: 'q0', title, description, type, options }] } }`; `form.replied { id, answer }` | the sessionID of `form.created` is inside `data.form` |
| 17 | custom prompt ID `msg_kimaki_…` accepted; `inbox.cancel` by that ID emits `inbox.cancelled` | confirms 9.2.2 |
| 18 | noisy global events: `skill.updated` (dozens per turn), `project.updated`, `provider.updated`, `model.updated`, `agent.updated`, `command.updated`, `plugin.updated`, `worktree.updated`, `vcs.branch.updated`, `integration.updated` | drop them in the event loop before routing |
| 19 | `session.execution.succeeded` data is only `{ sessionID }` | footer duration = envelope `created` of succeeded − `created` of execution.started |
| 20 | `text.ended.state.phase` is `final_answer` (OpenAI provider) | provider-specific; do not depend on it |
| 21 | V2 reads the V1 `~/.config/opencode/opencode.json` with diagnostics; V1 plugin files fail ("must export a default definition"); agents pointing at subrouter models fail subagents with `provider.no-route` | strip `OPENCODE_CONFIG*` env when spawning; users' V1 plugins and subrouter-based agents do not work under V2 |


### 29.2.1 Background subagents: timeline and rendering

Background mode is a **model choice**: the `subagent` tool has `background: true`
(`packages/core/src/tool/plugin/subagent.ts:44`). Without it the tool waits and returns
the result inline (`task-subagent` fixture).

Recorded timeline (`task-parallel`; the tail was recorded under the next scenario and is
missing from the fixture, re-record it):

```
parent  subagent(background) ×2 → tool.success "working in the background"
child A shell → text "49" → execution.succeeded
parent  inbox.enqueued synthetic <subagent … completed>  (delivered in the same execution)
parent  text "Both tasks are running…"                   ◀ parent does NOT wait
parent  text "49 … waiting for the second result"
parent  execution.succeeded                               ◀ child B still running
child B shell → text → execution.succeeded
parent  inbox.enqueued synthetic → execution.started → final text → execution.succeeded
```

The parent never waits: it posts text and can end its execution while children run.
The final answer comes in a **later** parent execution started by the child completion.

Rendering (proposed):

| Child kind | Discord |
|---|---|
| foreground (`background` absent) | live child tool lines `┣ general ⋅ grep …`, same verbosity as the parent |
| background | one start line `┣ general **List repo folders** (background)`, **no** child tool lines, one end line `-# ⬦ general finished: List repo folders` on the child's terminal execution event |
| both | no child text; footer only when the parent execution ended **and** no child execution is running; typing stays on while any child runs |

Why hide background tool lines: they arrive after the parent's text and even after a
parent execution ended, so they interleave with unrelated output and look like a new
turn.

### 29.3 Use the fixtures in tests

Every reducer and renderer test runs on **real recorded events**, not hand-written
ones. Paths (repo root):

```
docs/opencode-v2-events/tools.events.jsonl
docs/opencode-v2-events/task-subagent.events.jsonl
docs/opencode-v2-events/task-parallel.events.jsonl
docs/opencode-v2-events/question.events.jsonl
docs/opencode-v2-events/permission.events.jsonl
docs/opencode-v2-events/steer-queue.events.jsonl
docs/opencode-v2-events/queue-plain.events.jsonl
docs/opencode-v2-events/queue-parked.events.jsonl
docs/opencode-v2-events/abort.events.jsonl
docs/opencode-v2-events/shell.events.jsonl
docs/opencode-v2-events/fork-compact.events.jsonl
docs/opencode-v2-events/worktree.events.jsonl
docs/opencode-v2-events/switch-model.events.jsonl
```

Rules:

- one test per fixture: load the JSONL, bind the root session to a fake thread, fold all
  events through `reduce()`, and snapshot the resulting **effects** and the final view
  with `toMatchInlineSnapshot()`. The snapshot shows exactly what Discord would get
  (text blocks, tool lines, footer, question and permission UI, queue acks)
- no mocks: the reducer is pure, the input is real OpenCode output
- when a fixture reveals a bug, fix the reducer and update the inline snapshot; review
  the snapshot diff like code
- new behavior or a new OpenCode version: record a new fixture with
  `record-events.ts` first, then write the test. Never hand-edit fixture files
- keep fixtures small: one scenario per file, only the sessions of that scenario

```ts
import fs from 'node:fs'
import { test, expect } from 'vitest'
import { reduce, emptyView } from '../thread-reducer.ts'

function replay(file: string) {
  const events = fs.readFileSync(`docs/opencode-v2-events/${file}`, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line).event)
  const root = events.find((e) => e.type === 'session.created' && !e.data.parentID).data.sessionID
  let view = emptyView({ threadId: 'thread', sessionId: root })
  const effects = []
  for (const event of events) {
    const result = reduce(view, event, { verbosity: 'tools' })
    view = result.view
    effects.push(...result.effects)
  }
  return { view, effects }
}

test('parallel subagents: child tool lines, one footer after children finish', () => {
  const { effects } = replay('task-parallel.events.jsonl')
  expect(effects).toMatchInlineSnapshot()
})
```

Cases each fixture must pin down in its snapshot:

| Fixture | Must show |
|---|---|
| `tools` | tool names from `tool.input.started`, failed tool lines, one footer |
| `task-subagent` | child tool lines labelled with the agent, no child text, footer after the parent |
| `task-parallel` | background subagents: start/end lines only, no child tool lines, no footer while children run (29.2.1) |
| `question` | form UI effect with both questions, then disable on `form.replied` |
| `permission` | two permission UIs, second rejected, failed tool line |
| `steer-queue` | queue acks with positions, cancel of B, no footer on interrupted, parked items (29.2 #7) |
| `queue-plain` | `» user` echo per delivered queued item, footer once |
| `queue-parked` | parked item runs after the next prompt |
| `abort` | no error line for `aborted`, no footer, next turn normal |
| `shell` | `!cmd` output blocks idle and busy, `resume: false` prompt renders nothing |
| `fork-compact` | fork session renders like a normal session, compaction renders nothing (or one line) |
| `worktree` | session in the worktree location renders normally |
| `switch-model` | synthetic plan reminder not rendered, banner shows the new model and agent |


---

## 30. Build phases

The rebuild happens in a new `cli2/` package. Every phase ends in a **working bot** that
passes its end-to-end tests against `discord-digital-twin` and a real OpenCode V2 server
running the deterministic provider. In production Kimaki uses the user's OpenCode
service (28.2); each test file spawns its own isolated server with separate XDG dirs and
SQLite database (28.2.1), so tests never touch the user's service or data. Each phase is one commit
(or a few), sized to fit a single agent session of ~500k tokens including reading this
spec, writing code, and running tests.

Rules for every phase:

- **tests first**: write the e2e test for the phase's user-visible flow, see it fail,
  then implement. Pure modules (reducer, routes, markdown) get inline-snapshot unit
  tests
- **no stubs for later phases**: a feature is either complete or absent. No `TODO`
  branches in the reducer
- **only the modules of section 27**; a phase may add a module or extend one, never
  add a second path for an existing job
- `tsc` and `lintcn lint` clean at the end of every phase
- `cli/` stays untouched until phase 10

```
P0 harness ─▶ P1 hello thread ─▶ P2 renderer ─▶ P3 interrupt+queue ─▶ P4 questions+perms
                                                                         │
P9 schedule ◀─ P8 worktrees ◀─ P7 CLI+lock ◀─ P6 btw/fork/cmds ◀─ P5 shell+voice+files
   │
   └─▶ P10 onboarding + gateway + import ─▶ P11 swap cli2 → cli
```

### Phase 0: harness

**Goal:** an empty bot that starts, connects to Discord (twin) and to an OpenCode
service, and reconnects when either restarts. No message handling yet.

**Files**

| File | Contents |
|---|---|
| `cli2/package.json` | deps: `@opencode/client`, `@opencode/plugin`, `discord.js`, `drizzle-orm`, `@libsql/client`, `zustand`, `errore`, `goke`, `string-dedent`, mdast libs (used in P2). devDeps: `@opencode/cli` (test server binary), `vitest`, `discord-digital-twin` (`workspace:^`), `opencode-deterministic-provider` (`workspace:^`) |
| `cli2/tsconfig.json`, `vitest.config.ts` | ESM, strict, `.ts` imports; vitest `KIMAKI_VITEST=1`, logs off unless `KIMAKI_TEST_LOGS=1` |
| `src/logger.ts` | prefixed logger to `<dataDir>/kimaki.log` + stderr |
| `src/errors.ts` | errore tagged errors used across modules (`OpenCodeError`, `DiscordError`, `DbError`, `ConfigError`) |
| `src/db.ts`, `src/schema.ts` | the V1 table subset (17), same file and DDL, `openDb({ migrate: boolean })`. Only `main.ts` passes `migrate: true` |
| `src/opencode-server.ts` | `connectOpencode({ serviceFile? })`: `Service.discover`, else `ensure()` without version; min-version check; Basic auth client; `watchConnection()` that re-discovers after the stream ends (new port/password) with backoff 0.5s → 30s |
| `src/lock-server.ts` | `/health` only (rest in P7); takeover of an older instance |
| `src/main.ts` | `startBot({ dataDir, token, opencodeServiceFile?, clock? })` returns a handle `{ stop, discord, opencode }`. Order: lock → db → (OpenCode ‖ Discord login) |
| `src/test/harness.ts` | `startOpencodeTestServer()` (28.2.1), `startTwin()`, `startTestBot()`, `seedProjectChannel()`, `stopAll()` |

**Test harness details**

- one isolated OpenCode server per test **file** (`beforeAll`), temp XDG dirs, its own
  SQLite DB, `OPENCODE_CONFIG_CONTENT` with the deterministic provider as the only
  provider and the Kimaki plugin by path (the plugin is a no-op file until P7)
- `startTestBot` runs the bot **in-process** (so tests can reach the handle, the store,
  and later the scheduler), with a temp `dataDir` and a random lock port
- `seedProjectChannel({ directory })` creates a twin guild, category, and channel, and
  inserts the `channels` row (onboarding is P10)
- `warmUp()`: one throwaway `session.create` + `prompt` so the first real test does not
  pay OpenCode cold start inside Discord waits
- wait helpers: port only what P1–P2 need (`waitForFooter`, `waitForBotMessageContaining`),
  as twin methods where possible; timeouts clamped 8–10s like today

**Tests**

- e2e `harness.e2e.test.ts`: bot starts, `/health` answers, OpenCode `session.active`
  answers; kill and restart the test OpenCode server → the bot reconnects (log-free check:
  `handle.opencode.connected` becomes true again within 10s)
- unit `db.test.ts`: (1) fresh DB gets exactly the subset tables; (2) a **real V1
  database fixture** (copied from a V1 install, all 24 tables with rows) opens with
  `migrate: true`, V2 reads its channels, thread bindings, tasks, and sleeps, and the
  V1-only tables are byte-identical afterwards; (3) verbosity read/write mapping

**Done when:** `pnpm tsc`, `lintcn lint`, and the two tests pass; no test touches
`~/.local/share/opencode` or `~/.kimaki`.

**Not in P0:** message handling, slash commands, plugin behavior, onboarding.

### Phase 1: hello thread

**Goal:** the smallest real product. A message in a project channel creates a thread
and a session; the reply text and a footer appear; follow-ups continue the session.

**Files**

| File | Contents |
|---|---|
| `src/store.ts` | zustand vanilla: `threads: Record<threadId, ThreadView>`, `sessionThreads: Record<sessionId, threadId>` |
| `src/thread-reducer.ts` | `ThreadView`, `Effect`, `emptyView()`, `reduce(view, event, prefs)`. P1 cases: `execution.started/succeeded/failed/interrupted`, `step.started/ended`, `text.ended` |
| `src/event-loop.ts` | one `client.event.subscribe()`; drop noisy global events (29.2 #18); route by `sessionThreads`; `reduce`; `store` update; `runEffects`. Never awaits Discord |
| `src/effects.ts` | per-thread promise chain; typing interval (start on `typing: on`, refresh 7s, stop on `off`, cleared on thread stop); `send` only |
| `src/ingress.ts` | `messageCreate` gates: ignore bots and own messages, only channels in `channels` (ownership), permission roles (owner, admin, manage server, `Kimaki` role; deny `no-kimaki`) |
| `src/routes.ts` | `parseTextMessage(message) → Route`; P1 returns only `{ kind: 'steer', text }` |
| `src/actions.ts` | `startSession({ channelId, text, author })`: create thread (name from text, 80 chars, 1 day archive), `session.create({ location, metadata.kimaki })`, `instructions.entry.put` (base prompt), insert `thread_sessions`, register in store, then `send`. `send({ threadId, text, author })`: `prompt({ id: msg_discord_<messageId>, text: context + text, delivery: 'steer' })` |
| `src/system-prompt.ts` | the small base instruction (section 26 #3) and the per-turn `<discord-user …>` block, built with `string-dedent` |

**Reducer rules in P1**

- `execution.started` → `typing on`, `busy = true`, `turn.startedAt = event.created`
- first `step.started` of a session → banner `-# *using <provider>/<model> ⋅ <agent>*`
- `step.ended` → `turn.tokens` (for the context %)
- `text.ended` → `send` the text, trimmed, full width. Empty text → nothing
- `execution.succeeded` → `typing off`, footer (folder, branch from `vcs` at start of
  turn or a cached `git branch` read in actions, duration from envelope `created` diff,
  context %, model, agent unless `build`). Ends the turn
- `execution.failed` → `typing off`, `✗ <message>` (400 chars), no footer
- `execution.interrupted` → `typing off`, no footer, no error line
- anything else → no effects (explicitly listed in a test so nothing is silently handled)

**Tests**

- unit `thread-reducer.test.ts`: replay a text-only turn built from the `tools` fixture
  with tool events filtered out (or a new `text.events.jsonl` recorded for P1) → inline
  snapshot of effects
- e2e `hello-thread.e2e.test.ts`:
  1. user message in the channel → thread appears; `thread.text()` snapshot shows the
     user message, banner, reply, footer
  2. second message in the thread → second reply in the **same session**
     (`thread_sessions` has one row; banner not repeated)
  3. a message from a user without permission → no thread
  4. a message in a channel not in `channels` → no thread
- e2e `restart.e2e.test.ts`: restart the bot between two messages → the second message
  still continues the session (binding from SQLite)

**Done when:** tests pass, the whole flow uses one path (`ingress → routes → actions →
OpenCode → event-loop → reduce → effects`).

**Not in P1:** tools, markdown, splitting, interrupt, queue.

### Phase 2: renderer and markdown

**Goal:** output looks right for everything a normal turn produces: tools, subagents,
long and formatted text.

**Files**

| File | Contents |
|---|---|
| `src/format-parts.ts` | pure: `formatTool({ name, input, status, error })`, footer, banner, verbosity filter. V2 tool names (29.2 #2): `shell` (description or command; hidden at `text` verbosity; hidden at `tools` when `hasSideEffect === false`), `edit` / `write` / `patch` (`◼︎` + file + `+a-d`), `read` / `glob` / `grep` (hidden at `text`, hidden at `tools` default), `todowrite` (active item), `subagent` (`┣ <agent> **<description>**`, `(background)` suffix), `question` and Kimaki UI tools (nothing), any other (`┣ <name> _<title>_`) |
| `src/markdown/` | `render-markdown.ts`: mdast parse → `groupCallouts` → `unnestCodeInLists` → `clampHeadings` → `toSegments` → node-based split (section 8). `components.ts`: table and callout → Components V2 payloads. One file per concern only if each is ≥100 lines |
| `src/thread-reducer.ts` | new cases below |
| `src/effects.ts` | `send` accepts `Segment[]`: text segments as content, table/callout segments with `IsComponentsV2` |

**Reducer additions in P2**

- `tool.input.started { id, name }` → remember `toolNames[id] = name` (29.2 #1); no
  effect
- `tool.called { id, input }` → format with the remembered name, `send` if visible at the
  channel verbosity; blank line before when the previous block was text
- `tool.failed` → `⨯ <tool> <error>` unless `error.type === 'aborted'`
- `retry.scheduled` → `-# retrying in Ns (attempt N)`, at most one per 10s per thread
  (timestamp from the event)
- `text.ended` → markdown segments; blank line before when the previous block was a tool
- subagents (29.2 #3–#5, 29.2.1):
  - `session.created { parentID }` with a known parent → add the child to
    `view.children` and `sessionThreads` (earliest signal); label from the parent's
    `subagent` input (`agent`) once `tool.called` arrives
  - foreground child `tool.called` → `┣ <agent> ⋅ <tool line>`, same verbosity
  - background child → no tool lines; one end line `-# ⬦ <agent> finished: <description>`
    on the child's terminal execution event
  - child text, child banner, child footer → never rendered
  - thread `busy` = parent executing **or** any child executing; typing stays on
  - footer only when the parent execution succeeded **and** no child is running;
    if a child is still running, the footer waits for the next parent
    `execution.succeeded` (background completion)
- synthetic inbox items (`<subagent …>`, plan-mode reminder) → never rendered

**Verbosity** (per channel, `channels.verbosity`): `text` = text + edits + errors;
`tools` (default) = everything except read-only tools and `shell` with
`hasSideEffect: false`. P2 reads the column; the `/verbosity` command is P6.

**Tests**

- unit `markdown.test.ts`: inline snapshots of `renderMarkdown()` for: GFM table with
  links and inline code; `<callout>` in each shape of the section 8 table; code block in
  a list; 3000-char code block (split into valid fences); headings `####`; mixed text +
  table + callout; backticks inside code
- unit `format-parts.test.ts`: one snapshot per tool shape above, both verbosities
- unit `thread-reducer.fixtures.test.ts` (29.3): `tools`, `task-subagent`,
  `task-parallel`, `abort` fixtures → effects snapshots
- e2e `renderer.e2e.test.ts` with deterministic matchers that emit real tool calls:
  1. turn with `shell` (side effect), `read`, `edit` → snapshot shows shell + edit lines,
     no read line
  2. long answer with a table and a callout → components message + split text
  3. `subagent` foreground call with child `glob` → child line labelled with the agent,
     footer once at the end
  4. channel verbosity `text` → only text and edit lines

**Done when:** all four fixture snapshots are reviewed and match the rules in 29.2 and
29.2.1; the e2e snapshots read like a real Kimaki thread.

**Not in P2:** interrupt, queue, questions, permissions, shell command (`!cmd`), slash
commands.

### Phase 3: interrupt and queue

**Goal:** the core concurrency behavior.

- `routes.ts`: `. queue` suffix, `/queue`
- `actions.send`: `steer` + `interrupt({ resume: true })` when `view.busy`; `queue` →
  `delivery: 'queue'` with `id: msg_discord_<messageId>`
- `queue.ts` feature file: `inbox.*` reducer slice, "Queued (position N)" ack, Remove
  button (`inbox.cancel`), `» user: text` echo on `inbox.delivered`, Discord message
  delete → cancel, edit → cancel + re-enqueue
- `/abort`, `/clear-queue`, `/queue`
- startup seeding: `session.active`, `inbox.list`

E2E: message during a long run interrupts it; `. queue` runs after; Remove works;
`/abort` stops and clears; bot restart mid-queue keeps the queue (native inbox).

### Phase 4: questions and permissions

- `questions.ts`: `form.created` (`metadata.kind === 'question'`), dropdowns, multi
  select, "Other" modal, `session.form.reply`, disable on replied/cancelled
- `permissions.ts`: Accept / Always / Deny, `permission.reply`, disable on replied;
  child session requests shown in the parent thread
- ingress: a new message cancels pending forms/permissions, then steers
- startup seeding: `form.list`, `permission.list`, custom IDs carry native IDs

E2E: question answered by dropdown and by modal; permission accept/deny; new message
while a question is pending; restart with a pending question still answerable.

### Phase 5: shell, attachments, voice

- `!cmd` and `/run-shell-command` → `session.shell`; render `shell.started/ended`
  (output once at the end); `!cmd` in a channel creates the thread first
- attachments: save to `<dir>/uploads/`, `files: [{ uri: 'file://…' }]`
- `voice.ts`: transcription providers, tool schema `{ transcription, route, agent? }`,
  `parseVoiceMessage` → same `Route` as text
- `routes.ts`: `/cmd args` → `session.command`

E2E: `!echo hi` while a run is busy (not interrupted, output in context); image
attachment reaches the model; voice message with the deterministic transcriber routes
to `queue` / `btw` / `new-session`.

### Phase 6: btw, fork, commands

- `. btw` and `/btw` → `session.fork` + new thread + prompt
- `/fork` (before a message), `/resume` (moves the binding), `/new-session`
- `/agent` and `/command` with autocomplete (`agent.list`, `command.list`)
- `/model` (session: `switchModel`; channel: `channels` columns), `/verbosity`,
  `/compact`, `/undo`, `/redo`, `/diff`, `/context-usage`, `/session-id`

E2E: btw thread answers while the source keeps running; fork before a message;
`/model` mid-session applies to the next step; `/command review`.

### Phase 7: CLI and lock server

- `lock-server.ts`: `/health` (single instance), `POST /kimaki/send`,
  agent UI routes; token file
- `actions.ts` registry exposed to the CLI
- `cli/*.ts` goke commands from section 23 (help text snapshot-tested)
- `agent-ui.ts`: `kimaki buttons`, `kimaki upload-request` (ordering wait on the bash
  `tool.called`)
- `~/.kimaki/bin/kimaki` shim
- remote-send envelope for channels of another machine
- plugin `plugin/index.ts`: bash schema, context hook (git branch), guarded by
  `metadata.kimaki`

E2E: `kimaki send --channel` returns thread + session IDs; `--thread` with `. queue`;
agent runs `kimaki buttons` → buttons render after preceding text; click sends
`User clicked: X`; `upload-request` round trip; second bot process sees `/health` and
takes over.

### Phase 8: worktrees and projects

- `/new-worktree`, `send --worktree`, channel auto-worktree: session created with
  `location: { directory: worktreePath }` via V2 `worktree.*`
- `/worktrees` (direct components, no `<button>` markdown), `/merge-worktree`
- `/add-project`, `/create-new-project`, `/remove-project`, `kimaki project *`

E2E: worktree thread edits a file in the worktree, not the project root; merge
worktree; add project creates a channel.

### Phase 9: scheduling and sleep

- `scheduler.ts`: cron and one-shot tasks, `--pre-run`, `--allow-concurrency`
  (busy check via `session.active`), task ID in session metadata
- sleep as a one-shot `wake` task; new user prompt deletes it
- `/tasks`, `kimaki task *`, `kimaki sleep`

E2E (fake clock injected into the scheduler, no real waits): one-shot task starts a
thread; cron fires twice; sleep wakes the same thread; a user message cancels the sleep.

#### Fake clock

Scheduling tests must not wait for real time, and must not use `vi.useFakeTimers()`:
it also freezes discord.js, the digital twin, the OpenCode client, and HTTP timeouts in
the same process.

Design: time is an **input** of the scheduler, not something it reads.

```ts
type Clock = {
  now(): number                      // ms since epoch
}

// pure: which tasks are due at `now`, and their next run time
function dueTasks({ tasks, now }: { tasks: Task[]; now: number }): Array<{ task: Task; nextRunAt: number | null }>

// side effects: run due tasks once, update rows. No timers inside.
async function runDueTasks({ clock, db, actions }): Promise<void>

// production loop only: calls runDueTasks every 5s with the real clock
function startScheduler({ clock = systemClock, intervalMs = 5_000 }): () => void
```

- `dueTasks` (cron parsing, one-shot, next run, sleep wakes) is unit-tested with plain
  numbers and inline snapshots
- the bot exposes `runDueTasks` through its startup handle. E2E tests start the bot with
  a **manual clock** and **no interval** (`intervalMs: null`), then drive it:

```ts
const clock = manualClock(Date.parse('2026-01-01T09:00:00Z'))
const bot = await startTestBot({ clock, schedulerIntervalMs: null })

await discord.user(user).runSlashCommand(...)        // or kimaki send --send-at …
clock.set(Date.parse('2026-01-01T10:00:00Z'))
await bot.scheduler.runDueTasks()                    // task fires now, deterministically
await discord.waitForThread(...)
```

- the same `Clock` is used for everything time-based in Kimaki core: task scheduling,
  sleep wake times, footer duration (from event timestamps, so no clock needed there).
  Typing refresh and Discord rate limits keep real timers; tests never assert on them
- `kimaki sleep --duration 2h` resolves `wakeAt = clock.now() + 2h` in the bot (the CLI
  sends the duration, not an absolute time), so the manual clock controls it too
- cron expressions are evaluated in UTC with the clock's time, never `new Date()`


### Phase 10: onboarding, gateway, import, analytics

- `onboarding.ts`: credentials wizard (gateway + self-hosted), guild pick, category
  `Kimaki <machine>`, project channels, default channel
- gateway mode through the proxy (REST safety rules unchanged)
- legacy compatibility: V2 starts on a V1 `discord-sessions.db` fixture and V1 starts on
  a database last written by V2 (downgrade)
- analytics subscriber (`tokens_used` from `session.usage.updated`), `kimaki status`,
  `kimaki logs`

E2E: onboarding in non-interactive mode against the twin; bot starts on a V1 database
and answers in an old thread.

### Phase 11: swap

- run the full cli2 e2e suite; compare against the V1 suite for missing behaviors
- move `cli2/` → `cli/`, update root scripts, skills sync, publish pipeline
- changeset describing the rebuild and the removed features (section 25)

### Size and ordering notes

| Phase | Relative size | Main risk |
|---|---|---|
| P0 | S | test server + registration file + deterministic provider wiring |
| P1 | M | event routing and effect ordering |
| P2 | L | markdown pipeline and formatting parity |
| P3 | M | interrupt + queue semantics of V2 inbox |
| P4 | M | forms API shape, restart seeding |
| P5 | M | voice fixtures |
| P6 | M | many small commands |
| P7 | L | CLI surface + lock server + plugin |
| P8 | M | V2 worktree API |
| P9 | S | fake clock design |
| P10 | L | onboarding flows, legacy import |
| P11 | S | packaging |

If a phase does not fit one session, split it along its feature files (for example P2
into renderer and markdown), never across the event loop.
