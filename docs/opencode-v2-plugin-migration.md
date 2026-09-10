---
title: OpenCode v2 Kimaki plugin migration
description: >
  Greenfield kimaki2 package. Test harness first. Then port features as
  OpenCode v2 plugins. Delete interrupt/abort-replay. Use inbox steer/queue.
---

# OpenCode v2 Kimaki plugin migration

Kimaki v1 is a Discord bot process plus an OpenCode child. Kimaki v2 is an **OpenCode plugin**. The CLI is a thin client.

Do this in a new package, `kimaki2/`. Do not rewrite `cli/` in place. Keep v1 shipping until v2 can replace it.

**Tests come first.** Do not port Discord until a plugin can load, run `setup`, subscribe to events, and fail a unit test without Discord.

Measured on `opencode2 v0.0.0-beta-19271` in `/Users/morse/Documents/GitHub/opencodev2experiments`. See that folder's README.

## Gist

```
  kimaki2 CLI  ── RPC ──►  opencode2 process
                                │
                                ▼
                         kimaki.* plugins
                                │
                    Discord Client (globalThis, once)
```

- One OpenCode server. Many project folders.
- `Plugin.define({ id, setup })`. One plugin = one feature + its state.
- OpenCode session events are the source of truth.
- Inbox `steer` / `queue` replace the interrupt plugin and most of the local queue.
- Discord starts once via `globalThis`. `setup()` still runs per folder.

## Why a new folder

`cli/src/session-handler/thread-session-runtime.ts` is 5k lines on v1 snapshots (`message.part.updated`). V2 events are facts (`session.text.delta`, `session.tool.*`). A rewrite inside that file will keep the old shape.

`kimaki2/` lets tests lock the v2 host before any Discord code exists. `cli/` stays the published bot.

Do not copy files and "fix types". Port one feature per phase. Delete what v2 already does.

## What v2 already does (do not port)

| V1 Kimaki | V2 OpenCode | Action |
|---|---|---|
| Interrupt plugin: abort, wait 3s, `promptAsync` replay | Inbox `delivery: "steer"` | **Delete** |
| Zustand `queueItems` for normal messages | Inbox `delivery: "queue"` | **Delete** the queue. Keep Discord Remove UI as a view |
| `session.abort` + empty `promptAsync([])` | `session.interrupt({ continue })` | **Delete** |
| Per-directory OpenCode child + `x-opencode-directory` | One server. `location[directory]` | **Delete** spawn in `opencode.ts` |
| Hrana / `ipc_requests` JSON to the bot | `Rpc.define` + `client.rpc(Kimaki)` | **Replace** |
| Plugin-local `createPluginClient` because v1 `ctx.client` no-ops | `ctx` is the server client | **Delete** `plugin-opencode-client.ts` |
| `question.asked` | `form.created` / `form.replied` | **Rewrite** UI only |

Normal Discord messages become `session.prompt({ delivery: "steer" })`. `/queue` and queue-suffix messages become `delivery: "queue"`. No timer. No abort. No replay.

## Hard facts from the live probe

These are not guesses. They are from one `opencode2 serve` PID and two folders.

1. **`setup()` runs per location.** Same plugin, two folders, two `setup` calls in one PID.
2. **Module eval also ran twice.** `globalThis` still shared the counter (`setups` went 1 then 2). Use `globalThis` for Discord, SQLite, RPC, the task runner.
3. **`ctx.event.subscribe()` is the process bus.** `session.created` in project-a was delivered to project-a **and** project-b. Filter by `event.location` / `sessionID`.
4. **`plugins: ["./probe.ts"]` is rejected.** Configured plugin path must be a **directory**. Use `./probe` or `.opencode/plugins/probe.ts`.
5. **`GET /api/plugin` is empty until `POST /api/plugin/await-activation`.**
6. **Kimaki `OPENCODE_CONFIG` leaks into child env.** Isolation must set `OPENCODE_CONFIG` explicitly.

```
  opencode2 process
        │
        ├─ Location A  ── setup(kimaki.probe) ── subscribe()
        └─ Location B  ── setup(kimaki.probe) ── subscribe()
                    │
                    ▼
              one Bus  (all events to all subscribers)
```

## Package layout

New workspace package. Add `kimaki2` to `pnpm-workspace.yaml` as `./*` already includes root folders.

```
kimaki2/
  package.json              name: kimaki2, private until cutover
  AGENTS.md                 v2-only rules (not generated)
  src/
    bin.ts                  thin CLI: Service.ensure + rpc
    rpc.ts                  Kimaki Rpc.define contract
    host.ts                 globalThis singleton (Discord, db, tasks)
    plugins/
      probe.ts              harness canary (phase 0 only)
      discord.ts            gateway, once
      threads.ts            thread ↔ session ↔ directory
      render.ts             events → Discord messages
      queue.ts              inbox.queue Discord UI
      btw.ts                fork + side thread
      permissions.ts        form / permission Discord buttons
      commands.ts           slash commands that call ctx.session
      voice.ts
      tasks.ts              scheduled send, sleep
      worktrees.ts
      context.ts            port of context-awareness-plugin
      memory.ts             port of memory-overview-plugin
    derive/
      event-stream-state.ts rewrite of cli/src/session-handler/event-stream-state.ts
  test/
    harness.ts              boot plugin host, no Discord
    plugins/
    fixtures/               v2 jsonl fact streams
```

Do not create empty plugin stubs. Add a plugin file when that phase starts. Keep files over ~100 lines by grouping only if two features share one state atom. Prefer one file per plugin id.

`cli/` is frozen for v2 work. Bugfixes on v1 still go there.

## Test system (phase 0, first work)

Goal: a vitest file can load a `Plugin.define` plugin, run `setup`, feed events, assert state. No real LLM. Digital Twin stays for Discord UX, same as v1. Do not use it as the only layer for plugin internals.

Do **not** build a fake OpenCode from scratch. Do **not** go e2e-only. Do **not** import unpublished `PluginTestLayer` (it boots the whole Effect server).

### What npm actually publishes

Checked on `0.0.0-beta-19271`:

| Package | Published | Useful for tests |
|---|---|---|
| `@opencode-ai/plugin` | yes | `Plugin.define`, `Context` types |
| `@opencode-ai/client` | yes | HTTP + RPC after a real server exists |
| `@opencode-ai/cli` (`opencode2`) | yes | real `serve` for load tests |
| `@opencode-ai/core` | yes, **runtime only** | `dist/plugin/host.js` is the live host. **No tests in the tarball** |
| `@opencode-ai/simulation` | yes, empty placeholder | unused |

The fake plugin host OpenCode uses is **not published**. It lives only in the v2 repo:

- `packages/core/test/plugin/host.ts` (~500 lines). Fake `Plugin.Context`. Unused methods `Effect.die`. Override `session` / `event` / `storage` per test.
- `packages/core/test/plugin/fixture.ts` `PluginTestLayer`. Full Effect graph. Do not take this.

Copy `host.ts`. Rewrite it to the **Promise** `Context` from `@opencode-ai/plugin` (OpenCode's file is Effect). Keep the same shape: default stubs + overrides. That is the reuse. It is not a new engine.

V1 already did this for the interrupt plugin: a tiny HTTP stub in `cli/src/opencode-interrupt-plugin.test.ts`. Same idea. Use OpenCode's `host()` instead of inventing endpoints.

### Harness shape

```
  vitest
    │
    ├─ 1. Copied fake host     packages/core/test/plugin/host.ts → Promise Context
    │                          override session / event / storage
    │
    └─ 2. Real opencode2       isolated XDG, opencode2 serve
                               await-activation, plugin.list
                               only for load / setup / bus tests
```

`kimaki2/test/harness.ts`:

- start from OpenCode `host.ts`, Promise API
- in-memory `ctx.storage`
- in-memory bus: `publish(event)` + `ctx.event.subscribe()`
- `ctx.session.prompt` / `interrupt` / `fork` record calls
- `ctx.session.hook("prompt"|"context")` stores callbacks; tests invoke them
- `activate(plugin)` calls `setup`, returns cleanup
- **two locations in one process** to prove `globalThis` and event fanout

**Real opencode2 second.** Same as the experiment folder:

- isolated `HOME` / `XDG_*` / `OPENCODE_CONFIG`
- plugin as a **directory**
- `POST /api/plugin/await-activation`
- assert `kimaki.probe` is `active`
- assert two locations → two `setup` lines in jsonl

Depend on `@opencode-ai/plugin` and `@opencode-ai/client` from the beta tag. Do not depend on `@opencode-ai/core` just to get tests. That package has no test export.

Keep Digital Twin. It is fake Discord, same as v1. Measured on this machine (`pnpm run test --run`):

- `opencode-interrupt-plugin.test.ts` (HTTP stub, no Discord): 7 tests, **1.5s**
- `thread-message-queue.e2e.test.ts` (Digital Twin + real OpenCode): 10 tests, **26s**. First turn after a cold server **8.3s**. Later turns **0.8–3.5s**.

The 8–10s in `test-utils.ts` is a **wait-helper floor**, not a round trip. A green wait returns as soon as the assertion is true. Digital Twin itself is not slow.

Do not make Digital Twin the **only** layer. It cannot assert `setup()` twice, `globalThis` refcount, or inbox `delivery` without booting OpenCode. Use the copied fake host for plugin internals. Use Digital Twin for Discord UX, same as now, from phase 5.

### First tests (must exist before any feature plugin)

1. `setup` runs. Cleanup runs.
2. Two directories → two `setup` calls, one PID, shared `globalThis`.
3. Event published on the bus reaches both subscribers unless the plugin filters.
4. `ctx.session.hook("prompt")` can set `delivery` to `steer` or `queue`.
5. Plugin storage round-trip.

That is the gate. No Discord plugin until these pass.

## Plugin split

Rule: one plugin, one feature, state inside it. Derive from events. Do not mirror busy/phase flags.

### `kimaki.discord`

- `globalThis.__kimakiDiscord` + refcount
- `Client` login once
- slash command registration once
- forwards message/interaction to other plugins via in-process bus or RPC
- cleanup must not destroy Discord while other locations still exist

### `kimaki.threads`

- The mapping table: Discord thread ↔ session ↔ directory ↔ worktree
- SQLite or `ctx.storage` plus a process cache
- Everyone else asks this plugin. Do not copy the map.

### `kimaki.render`

- Only consumer of the session fact stream for Discord output
- Accumulate `session.text.delta`, commit on `session.text.ended`
- Tool messages from `session.tool.*`
- Footer from `session.execution.succeeded` (not on interrupt)
- Typing from `session.status` busy, pulse every ~7s
- Pure derivation lives in `derive/event-stream-state.ts`
- Tests: jsonl fixtures → derived Discord DTOs. No Discord.js

Port `cli/src/session-handler/event-stream-state.ts` here. Rewrite types to v2 facts. Keep the "derive, do not store" rule.

### `kimaki.queue`

- No `queueItems` array
- `/queue` and queue-suffix → `session.prompt({ delivery: "queue" })`
- Discord Remove button → inbox cancel
- Drain line `⺩Tommy: …` from `session.inbox.delivered`
- Tests: hook sets delivery; fake inbox events → Discord DTOs

### `kimaki.btw`

- On idle + `btw:` suffix or `/btw`: `session.fork`, new Discord thread, `session.prompt` in the fork
- State: forked session → thread in `kimaki.threads`

### `kimaki.permissions`

- `permission.asked` / `form.created` → Discord buttons
- Reply through `ctx.permission.reply` / form reply
- Keep GuildMember union narrowing. No `as GuildMember`

### `kimaki.commands`

- Slash commands call `ctx.session.*` / RPC
- Do not copy the 46-file `cli/src/commands/` tree. Port one command group per PR

### Ports of existing plugins (rewrite to `Plugin.define`)

- `kimaki.context` from `context-awareness-plugin.ts`
- `kimaki.memory` from `memory-overview-plugin.ts`
- `kimaki.bash-schema` via `ctx.tool.transform`
- `kimaki.images`, `kimaki.edits`, `kimaki.worktrees`
- Auth plugins only if Subrouter does not cover Anthropic OAuth

### Delete, do not port

- `opencode-interrupt-plugin.ts` (the 3s abort + replay)
- `plugin-opencode-client.ts`
- Lock-port Hrana IPC for tools (replace with RPC)
- Cache-drift plugin unless a v2 test still needs it
- Mirrored run-phase fields in `ThreadRunState`

Keep Discord limits: 100-char `custom_id`, 25-char nonce, Components V2 40-child budget, typing 10s pulse.

## RPC

```ts
export const Kimaki = Rpc.define({
  id: "kimaki",
  methods: {
    send: { input: SendInput, output: SendOutput },
    abort: { input: { sessionID: string } },
    archive: { input: { threadID: string } },
  },
  events: {
    threadCreated: { schema: ThreadCreated },
  },
})
```

CLI: `Service.ensure()` then `client.rpc(Kimaki)`. Plugins call `ctx.rpc(Kimaki)`. Sleep / file-upload / action-buttons become RPC methods, not SQLite `ipc_requests`.

## Phases

Each phase ends with tests green. Do not start the next phase with failing harness tests.

### Phase 0 — Harness

**Files:** `kimaki2/package.json`, `kimaki2/test/harness.ts` (copy of OpenCode `packages/core/test/plugin/host.ts`, Promise API), `kimaki2/src/plugins/probe.ts`, `kimaki2/test/harness.test.ts`

**Do not:** write a new fake OpenCode. **Do not:** depend on `@opencode-ai/core` for tests (no test export). **Do not:** skip the fake host and use Digital Twin as the only layer. Digital Twin is still the Discord e2e, same as v1.

**Tests:** the five first tests above, plus one real-`opencode2` load test behind an env flag (`KIMAKI2_REAL_OPENCODE=1`) so CI can skip the binary.

**Done when:** `pnpm --filter kimaki2 test --run` passes the fake host suite.

### Phase 1 — Derive from v2 facts

**Files:** `kimaki2/src/derive/event-stream-state.ts`, fixtures under `kimaki2/test/fixtures/`

**Port:** helpers from `cli/src/session-handler/event-stream-state.ts` that Kimaki still needs: busy, abort, footer, latest user turn.

**Tests:** jsonl of v2 facts → inline snapshots. Capture real streams from `opencode2` later with `export-events-jsonl`.

**Done when:** footer-on-complete and no-footer-on-interrupt are proven from fixtures.

### Phase 2 — Steer and queue (no Discord)

**Files:** `kimaki2/src/plugins/queue.ts`

**Behavior:** prompt hook sets `delivery`. Tests drive `session.prompt` recordings.

**Delete in v2:** interrupt plugin behavior. A test that waits 3s and expects abort must not exist.

**Done when:** steer vs queue is a unit test on the hook, not an e2e timer.

### Phase 3 — Threads + RPC

**Files:** `kimaki2/src/plugins/threads.ts`, `kimaki2/src/rpc.ts`, `kimaki2/src/bin.ts`

**Tests:** create mapping, resolve thread → session, `kimaki send` equivalent via RPC against the fake host.

### Phase 4 — Render DTOs

**Files:** `kimaki2/src/plugins/render.ts`

**Tests:** fact stream → list of `{ kind: "text"|"tool"|"footer"|"typing", content }` snapshots.

Do not call Discord.js yet.

### Phase 5 — Discord singleton

**Files:** `kimaki2/src/plugins/discord.ts`, `kimaki2/src/host.ts`

**Tests:** fake discord.js or a tiny stub Client. Two locations, one login. Refcount cleanup. Then one Digital Twin e2e: message in, text DTO out.

### Phase 6 — Feature plugins

One PR per plugin: btw, permissions, commands, voice, tasks, worktrees, context, memory.

Each PR: harness tests first, then optional Digital Twin.

### Phase 7 — Cutover

- `kimaki2` becomes the `kimaki` bin, or `kimaki` delegates to it
- Publish path, demo Dockerfile, website docs
- Keep `cli/` until v2 has been the default for a release

## What to copy vs rewrite

**Copy then rewrite types**

- `event-stream-state.ts` (pure)
- `btw-prefix-detection.ts`, queue-suffix detection
- Discord permission union narrowing
- Digital Twin helpers, after Discord exists

**Rewrite**

- `thread-session-runtime.ts` (do not move this file)
- `discord-bot.ts` event loop
- `opencode.ts` server spawn
- all v1 `Plugin = async (ctx) =>` plugins

**Leave in `cli/`**

- gateway-proxy, website, kimaki-demo, discord-slack-bridge
- v1 e2e suite until phase 5+

## Complexity to remove

- Two processes
- Interrupt timer (3s)
- Abort + replay to preserve parts
- Local FIFO for ordinary messages
- Fake v2 client inside plugins
- Toast-text session id markers
- `KIMAKI_*` env spray into the OpenCode child (use plugin options + storage)
- Per-project OpenCode server map in Zustand

Do not remove: event derivation, Discord API limits, SQLite thread durability, typing pulse, worktree directory vs branch name.

## Risks

- Plugin API is beta. Pin `@opencode-ai/plugin` / `@opencode-ai/cli` and re-run phase 0 after upgrades.
- Event subscribe is global. A render plugin that does not filter will duplicate Discord messages across projects.
- `session.fork` vs btw (no Discord replay, copy model/worktree) needs a real check in phase 6.
- Subrouter also needs a v2 plugin. Auth plugins may collapse into it.
- Isolation: always set `OPENCODE_CONFIG` in tests or Kimaki's env will leak.

## Out of scope for kimaki2 v0

- Slack bridge inside the plugin
- Website / OAuth / gateway-proxy changes beyond pointing docs at `opencode2`
- Perfect 1:1 port of every slash command on day one
- Keeping the 3s interrupt behavior "just in case"
