---
title: Centralize Global State with Zustand Store
description: |
  Plan to replace scattered module-level mutable variables, process.env
  mutations, and parallel Maps with a single zustand/vanilla store.
  Follows the zustand-centralized-state skill pattern: minimal state,
  derive over cache, centralize transitions and side effects.
prompt: |
  Voice messages from Tommy asking to centralize all global state into a
  zustand store. Find all global fields used as state (config toggles,
  process.env mutations, module-level Maps). The state is mutated by
  the CLI entry point and optionally by Discord commands (e.g. verbosity).
  Create a plan with a shape of the new zustand state with minimal state
  and what should be derived. Follow the zustand-centralized-state skill.
  @discord/src/config.ts @discord/src/discord-urls.ts
  @discord/src/session-handler.ts @discord/src/discord-bot.ts
  @discord/src/opencode.ts @discord/src/commands/action-buttons.ts
  @discord/src/commands/model.ts @discord/src/commands/agent.ts
  @discord/src/commands/login.ts @discord/src/ipc-polling.ts
  @discord/src/session-handler/state.ts
  @discord/skills/zustand-centralized-state/SKILL.md
---

# Centralize Global State with Zustand Store

## Problem

Global state is scattered across 10+ files as module-level `let`
variables, mutable Maps, mutable arrays, and `process.env` mutations.
This makes it impossible to answer "what does the bot look like right
now?" without reading every file. Side effects of state changes (like
REST routing) are scattered across call sites.

## Current global state audit

### Category 1: CLI config (config.ts) — 5 `let` variables + 1 mutable array

```
let dataDir: string | null                        # set by CLI --data-dir
let defaultVerbosity: VerbosityLevel              # set by CLI --verbosity
let defaultMentionMode: boolean                   # set by CLI --mention-mode
let critiqueEnabled: boolean                      # set by CLI --no-critique
let verboseOpencodeServer: boolean                # set by CLI --verbose-opencode-server
const registeredUserCommands: RegisteredUserCommand[]  # pushed to during init
```

Each has a getter/setter pair. Consumers import getters from config.ts.

### Category 2: Discord REST routing (discord-urls.ts) — env var mutation

```
process.env['DISCORD_REST_BASE_URL']              # set by enableBuiltInModeRouting()
```

Worst kind of global state — a process.env mutation acting as a config
toggle. All URL functions read it lazily.

### Category 3: Session operational state (session-handler.ts) — 3 Maps

```
pendingPermissions: Map<threadId, Map<permId, data>>   # per-thread permissions
messageQueue: Map<threadId, QueuedMessage[]>            # per-thread message queue
activeEventHandlers: Map<threadId, Promise<void>>       # per-thread handler locks
```

### Category 4: OpenCode server registry (opencode.ts) — 2 Maps

```
opencodeServers: Map<dir, { process, client, port, initOptions }>
serverRetryCount: Map<dir, number>                      # PARALLEL MAP anti-pattern
```

`serverRetryCount` is keyed identically to `opencodeServers`. Classic
split-state bug risk: forget to delete retry count when server is removed.

### Category 5: Discord bot runtime (discord-bot.ts) — 1 Map

```
threadMessageQueue: Map<threadId, Promise<void>>        # serial promise queue
```

### Category 6: Command pending contexts — 5 scattered Maps

```
pendingActionButtonRequests: Map<hash, request>         # action-buttons.ts
pendingActionButtonRequestWaiters: Map<hash, waiter>    # action-buttons.ts
pendingModelContexts: Map<id, context>                  # model.ts
pendingAgentContexts: Map<id, context>                  # agent.ts
pendingLoginContexts: Map<id, context>                  # login.ts
```

## Proposed store shape

```ts
import { createStore } from 'zustand/vanilla'

type KimakiState = {
  // ── Minimal config state (set once at startup by CLI) ──
  dataDir: string
  defaultVerbosity: VerbosityLevel
  defaultMentionMode: boolean
  critiqueEnabled: boolean
  verboseOpencodeServer: boolean
  botMode: BotMode
  restBaseUrl: string               // replaces process.env mutation
  registeredUserCommands: RegisteredUserCommand[]

  // ── Runtime resources (co-located per skill) ──
  opencodeServers: Map<string, {
    process: ChildProcess
    client: OpencodeClient
    port: number
    retryCount: number              // folded in from serverRetryCount
    initOptions?: ServerInitOptions
  }>

  // ── Per-thread operational state ──
  threadMessageQueue: Map<string, Promise<void>>
  messageQueue: Map<string, QueuedMessage[]>
  activeEventHandlers: Map<string, Promise<void>>
  pendingPermissions: Map<string, Map<string, PendingPermission>>

  // ── Command pending contexts ──
  pendingActionButtons: Map<string, ActionButtonsRequest>
  pendingActionButtonWaiters: Map<string, ActionButtonWaiter>
  pendingModelContexts: Map<string, ModelContext>
  pendingAgentContexts: Map<string, AgentContext>
  pendingLoginContexts: Map<string, LoginContext>
}

const store = createStore<KimakiState>(() => ({
  dataDir: '',
  defaultVerbosity: 'text-and-essential-tools',
  defaultMentionMode: false,
  critiqueEnabled: true,
  verboseOpencodeServer: false,
  botMode: 'self-hosted',
  restBaseUrl: 'https://discord.com',
  registeredUserCommands: [],

  opencodeServers: new Map(),
  threadMessageQueue: new Map(),
  messageQueue: new Map(),
  activeEventHandlers: new Map(),
  pendingPermissions: new Map(),

  pendingActionButtons: new Map(),
  pendingActionButtonWaiters: new Map(),
  pendingModelContexts: new Map(),
  pendingAgentContexts: new Map(),
  pendingLoginContexts: new Map(),
}))
```

## Derived values (not stored)

| Currently cached/stored           | Derive from                                     |
|-----------------------------------|-------------------------------------------------|
| `getProjectsDir()`               | `path.join(state.dataDir, 'projects')`          |
| `getLockPort()`                   | computed from `state.dataDir` + env var          |
| `getDiscordRestBaseUrl()`         | `state.restBaseUrl`                              |
| `getDiscordRestApiUrl()`          | `new URL('/api', state.restBaseUrl).toString()`  |
| `discordApiUrl(path)`             | `new URL('/api/v10'+path, state.restBaseUrl)`    |
| `getQueueLength(threadId)`        | `state.messageQueue.get(id)?.length ?? 0`        |
| `serverRetryCount` parallel Map   | `server.retryCount` field on each server entry   |

## What stays outside the store

These are infrastructure singletons or static config, not application
state:

| Variable                              | Why excluded                          |
|---------------------------------------|---------------------------------------|
| `prismaInstance` / `initPromise`      | DB connection lifecycle               |
| hrana-server db/server/url            | Infra layer, initialized once         |
| `logFilePath` (logger.ts)             | Derived from dataDir, set once        |
| `sentry.ts initialized`              | Init guard, not domain state          |
| `image-utils.ts` lazy module loads    | Module cache                          |
| `genai-worker.ts` session/interval    | Worker-scoped, not global bot state   |
| `heap-monitor.ts` interval/timestamp  | Infrastructure monitoring             |
| `forum-sync/watchers.ts` maps         | Forum-specific, can be phase 2        |
| `NON_ESSENTIAL_TOOLS` Set             | Static constant                       |
| `MainRunStore` (state.ts)             | Already zustand, per-session scoped   |

## Migration phases

### Phase 1: Config state (smallest, safest)

**Files**: `config.ts`, `discord-urls.ts`, `cli.ts`

1. Create `discord/src/store.ts` with `createStore<KimakiState>()`
2. Move all 5 `let` variables from config.ts into store
3. Replace getter/setter pairs:
   - `getDataDir()` → `store.getState().dataDir`
   - `setDataDir(dir)` → `store.setState({ dataDir: dir })`
   - Same for verbosity, mentionMode, critiqueEnabled, verboseOpencodeServer
4. Move `registeredUserCommands` array into store
5. Move `restBaseUrl` into store, replace `process.env` mutation:
   - `enableBuiltInModeRouting()` becomes `store.setState({ restBaseUrl })`
   - `getDiscordRestBaseUrl()` reads `store.getState().restBaseUrl`
   - Delete `process.env['DISCORD_REST_BASE_URL']` usage entirely
6. Keep `getProjectsDir()` and `getLockPort()` as derived functions
   that read from `store.getState().dataDir`
7. config.ts becomes a thin re-export layer for backwards compat
   during migration (getter functions that read from store)

**Validation**: `pnpm tsc` in discord/

### Phase 2: Server registry

**Files**: `opencode.ts`

1. Move `opencodeServers` Map into store
2. Fold `serverRetryCount` into server entry as `retryCount` field
   (eliminates parallel map anti-pattern)
3. All mutations become `store.setState()` with functional updates:
   ```ts
   store.setState((state) => {
     const servers = new Map(state.opencodeServers)
     servers.set(dir, { ...entry, retryCount: 0 })
     return { opencodeServers: servers }
   })
   ```
4. Server cleanup in subscribe: when a server entry is removed,
   close its process

**Validation**: `pnpm tsc` in discord/, manually test `kimaki`
startup

### Phase 3: Session operational state

**Files**: `session-handler.ts`, `discord-bot.ts`

1. Move `pendingPermissions`, `messageQueue`, `activeEventHandlers`
   into store
2. Move `threadMessageQueue` from discord-bot.ts into store
3. Replace direct Map mutations with `store.setState()`:
   ```ts
   // before
   messageQueue.set(threadId, queue)
   // after
   store.setState((state) => {
     const mq = new Map(state.messageQueue)
     mq.set(threadId, queue)
     return { messageQueue: mq }
   })
   ```
4. `addToQueue`, `clearQueue`, `getQueueLength` become thin
   wrappers over store transitions
5. Add single `subscribe()` for debug logging of state transitions

**Validation**: `pnpm tsc`, run e2e tests

### Phase 4: Command contexts

**Files**: `commands/action-buttons.ts`, `commands/model.ts`,
`commands/agent.ts`, `commands/login.ts`

1. Move all `pending*` Maps into store
2. Each command file imports store and does setState for
   add/remove operations
3. This is low-risk — each map is self-contained

**Validation**: `pnpm tsc`, test slash commands manually

## Key design decisions

1. **`restBaseUrl` replaces process.env mutation** — The env var hack
   is the worst global state. Store it as a field, read it directly.
   `getBotTokenWithMode()` sets it via `setState()` instead of mutating
   `process.env`.

2. **`serverRetryCount` folded into server entry** — Per the skill:
   "parallel maps for the same entity" is an anti-pattern. The retry
   count belongs on the server entry. One add, one remove, one map.

3. **Per-thread state as Maps in the store** — Thread-level state
   (queues, permissions, handlers) fits as `Map<threadId, ...>` fields.
   Not as separate stores per thread.

4. **`MainRunStore` stays separate** — Already a well-designed
   per-session zustand store with proper transitions. It's scoped to a
   single session lifecycle, not global bot state. No change needed.

5. **Phase 1 first** — Config state is the safest because it's set
   once at startup and only read afterwards. No concurrent mutations,
   no race conditions. Perfect for validating the pattern works.

6. **config.ts becomes a re-export layer** — During migration, keep
   the getter functions but have them read from store. This avoids a
   big-bang rewrite of all import sites. Can gradually switch importers
   to read from store directly.
