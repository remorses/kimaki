---
title: OpenCode v2 Kimaki architecture
description: >
  Kimaki as OpenCode v2 plugins. Real PluginTestLayer and Plugin.define.
  No fake host. Inbox steer/queue. Discord once via globalThis.
---

# OpenCode v2 Kimaki architecture

Kimaki v2 is an **OpenCode plugin**, not a bot that spawns OpenCode. One `opencode2` process. Discord, queue, render, btw, permissions, commands are `Plugin.define` plugins. The CLI is a thin RPC client.

**Tests run on real OpenCode v2.** Use the v2 plugin tester (`PluginTestLayer` + `host()`), or load plugins into `opencode2`. Do not invent a fake `KimakiPluginContext`. Delete `kimaki2/src/test-host.ts` and `kimaki2/src/fake-session.ts`.

This file is the source of truth for the rewrite in this worktree:
`/Users/morse/.kimaki/worktrees/8f21a809/opncd-v2-kmk-plgn-mgrtn`

## Gist

```
  kimaki CLI  ── client.rpc(Kimaki) ──►  opencode2
                                              │
                         Plugin.define plugins (per location setup)
                                              │
                         Discord Client once (globalThis + refcount)
                                              │
                         session.prompt({ delivery: "steer" | "queue" })
                                              │
                         ctx.event.subscribe()  (process bus, filter by session)
                                              │
                         kimaki.render  →  Discord messages
```

V1 interrupt (abort, wait 3s, `promptAsync` replay) is **deleted**. Inbox `steer` / `queue` is the replacement.

## Docs (read these first)

Beta warning: API can still change. Pin `@opencode-ai/plugin`, `@opencode-ai/client`, `@opencode-ai/cli` (`opencode2`).

| Topic | URL |
|---|---|
| Migrate v1 | https://opencode.ai/v2/docs/migrate-v1/ |
| Plugins (user) | https://opencode.ai/v2/docs/plugins |
| Plugin API | https://opencode.ai/v2/docs/build/plugins |
| Plugin RPC | https://opencode.ai/v2/docs/build/plugins/rpc |
| JS client | https://opencode.ai/v2/docs/build/client |
| Permissions | https://opencode.ai/v2/docs/permissions |
| CLI | https://opencode.ai/v2/docs/cli |

V1 plugins **do not work** in V2. Config key is `plugins` (not `plugin`). Configured plugin path must be a **directory**, not `./probe.ts`. Local discovery: `.opencode/plugins/`.

Quote from migrate-v1: "The config entry can be translated automatically, but plugin implementation code must be ported to the new API."

## V2 source (branch `v2`)

Repo: https://github.com/anomalyco/opencode/tree/v2

Add it as a **git submodule** at `opencode-v2/` tracking branch `v2`. That is how Kimaki imports unpublished tester code (`packages/core/test/plugin/`). npm `@opencode-ai/core` ships **runtime only**. The tarball has no `test/` files.

| What | Path on v2 |
|---|---|
| Promise `Plugin.define` | `packages/plugin/src/promise/plugin.ts` |
| Effect plugin | `packages/plugin/src/effect/` |
| Host / supervisor | `packages/core/src/plugin/host.ts`, `supervisor.ts` |
| Builtin plugin boot order | `packages/core/src/plugin/internal.ts` |
| SDK-registered plugins | `packages/core/src/plugin/sdk.ts` |
| Module load | `packages/core/src/plugin/module.ts` |
| Location (per folder) | `packages/core/src/location.ts`, `instance.ts` |
| Bus (process-global events) | `packages/core/src/bus.ts` |
| Inbox `steer` / `queue` | `packages/schema/src/session-inbox.ts` |
| Session events | `packages/schema/src/session-event.ts` |
| Prompt input + delivery | `packages/schema/src/prompt-input.ts` |
| Fake plugin `host()` | `packages/core/test/plugin/host.ts` |
| Full `PluginTestLayer` | `packages/core/test/plugin/fixture.ts` |
| Effect test helper | `packages/core/test/lib/effect.ts` |
| Isolated env for tests | `packages/core/script/test.ts` |
| Core plugin tests | `packages/core/test/plugin.test.ts` |
| Serve | `packages/cli/src/commands/handlers/serve.ts` |
| Client | `packages/client/` |

GitHub file links (same paths):

- https://github.com/anomalyco/opencode/blob/v2/packages/core/test/plugin/host.ts
- https://github.com/anomalyco/opencode/blob/v2/packages/core/test/plugin/fixture.ts
- https://github.com/anomalyco/opencode/blob/v2/packages/core/src/plugin/internal.ts
- https://github.com/anomalyco/opencode/blob/v2/packages/schema/src/session-inbox.ts
- https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/plugin.ts

## Hard facts (measured, do not re-guess)

Live `opencode2 v0.0.0-beta-19271`, two folders, one PID. Experiment notes also live conceptually in `/Users/morse/Documents/GitHub/opencodev2experiments`.

1. **`setup()` runs per location.** Same plugin, two directories, two `setup` calls in one PID.
2. **Module eval also ran twice.** `globalThis` still shared the counter. Use it for Discord, sqlite, task runner.
3. **`ctx.event.subscribe()` is the process bus.** `session.created` in A was delivered to A **and** B. Filter by `event.location` / `sessionID`.
4. **`plugins: ["./probe.ts"]` is rejected.** Path must be a directory. Use `./probe` or `.opencode/plugins/probe.ts`.
5. **`GET /api/plugin` is empty until `POST /api/plugin/await-activation`.** Activation returns **204**.
6. **Kimaki `OPENCODE_CONFIG` leaks into child env.** Tests must set `OPENCODE_CONFIG` and unset `OPENCODE_CONFIG_CONTENT`.
7. Serve log format: `server listening on http://127.0.0.1:PORT` and `server password TOKEN`. Basic auth user is `opencode`.

This worktree already has a passing real-server load test: `kimaki2/src/opencode2-load.e2e.test.ts` + `kimaki2/opencode-plugins/probe/`. Keep that. Do not replace it with a fake host.

## Tester (mandatory)

**Do not write `createTestHost`.** OpenCode already has two testers. Use them.

### 1. `host()` (unit, no full server)

https://github.com/anomalyco/opencode/blob/v2/packages/core/test/plugin/host.ts

- Returns a full **Effect** `Plugin.Context`.
- Unused methods `Effect.die("unused …")`.
- Override `session`, `event`, `storage` per test.
- Promise plugins go through `fromPromise` in `@opencode-ai/plugin/promise/adapter` (see `plugin.test.ts`).

Kimaki Promise plugins should stay Promise (`Plugin.define` from `@opencode-ai/plugin`). Tests can wrap with `fromPromise` or call `setup` with a Promise context built from the same override pattern.

If Effect `host()` is too heavy for Promise plugins: **copy that file into the submodule usage**, keep unused-die, switch only the Effect vs Promise surface. Do not shrink `Context` to `{ location, storage, event, session.hook }`. That is how the current fake host drifted from OpenCode.

### 2. `PluginTestLayer` (real plugin graph)

https://github.com/anomalyco/opencode/blob/v2/packages/core/test/plugin/fixture.ts

- Boots the real location plugin supervisor, bus, session, storage.
- Use `testEffect(PluginTestLayer)` from `packages/core/test/lib/effect.ts`.
- Isolated `HOME` / XDG like `packages/core/script/test.ts` (strips API keys, sets `OPENCODE_CONFIG` undefined).
- Network is refused except loopback.

Prefer this for inbox `steer`/`queue`, event subscribe, `session.prompt`, `session.fork`.

### 3. `opencode2 serve` (load + Digital Twin)

Last resort for Discord UX. Isolated XDG. Plugin **directory**. `await-activation`. Deterministic provider or a tiny local model. Digital Twin talks to discord.js; plugins talk to **real** `ctx.session`.

`kimaki2/src/opencode2-load.e2e.test.ts` is the template for isolation.

### Submodule

```sh
git submodule add -b v2 https://github.com/anomalyco/opencode.git opencode-v2
```

Then import:

```ts
import { host } from '../../opencode-v2/packages/core/test/plugin/host.ts'
import { PluginTestLayer } from '../../opencode-v2/packages/core/test/plugin/fixture.ts'
```

If package exports block that, **patch the submodule** (export the test helpers, or add a tiny `exports` map). Do not vendor a 200-line fake Context. Patch upstream-shaped code so Kimaki tests look like `packages/core/test/plugin.test.ts`.

`@opencode-ai/core` on npm: `files: ["dist"]`, no tests. Submodule is required.

## Plugin API (how to write Kimaki plugins)

```ts
import { Plugin } from '@opencode-ai/plugin'

export default Plugin.define({
  id: 'kimaki.queue',
  async setup(ctx) {
    await ctx.session.hook('prompt', (event) => {
      event.delivery = 'steer'
    })
    const sub = ctx.event.subscribe()
    void (async () => {
      for await (const event of sub) {
        if (event.location?.directory !== ctx.location.directory) continue
        // ...
      }
    })()
    return () => { /* cleanup */ }
  },
})
```

- `ctx` **is** the server client. No `createPluginClient`. No `plugin-opencode-client.ts`.
- `ctx.location.directory` is **this instance's folder**, not every session.
- Transforms (`ctx.tool.transform`, `ctx.command.transform`) are cheap and repeatable.
- Hooks: `session.prompt`, `session.context`, `tool.execute.*`.
- Storage: `ctx.storage` is plugin-scoped KV. Thread maps that must survive restart can stay in Kimaki sqlite **behind one plugin** (`kimaki.threads`).
- RPC: `Rpc.define` then `ctx.rpc.register(Kimaki)` and `client.rpc(Kimaki)`. Docs: https://opencode.ai/v2/docs/build/plugins/rpc

Discord **must not** `new Client()` in every `setup()`:

```ts
const g = globalThis as { __kimakiDiscord?: { refs: number; stop: () => void } }

export default Plugin.define({
  id: 'kimaki.discord',
  async setup(ctx) {
    if (!g.__kimakiDiscord) {
      g.__kimakiDiscord = { refs: 0, stop: await startDiscord() }
    }
    g.__kimakiDiscord.refs++
    g.__kimakiDiscord.attachLocation?.(ctx.location)
    return () => {
      const host = g.__kimakiDiscord
      if (!host) return
      host.refs--
      if (host.refs === 0) {
        host.stop()
        g.__kimakiDiscord = undefined
      }
    }
  },
})
```

## Inbox (delete interrupt)

https://github.com/anomalyco/opencode/blob/v2/packages/schema/src/session-inbox.ts

`Delivery = "steer" | "queue"`.

- Normal Discord message → `session.prompt({ delivery: "steer" })` (or hook sets it).
- `/queue` and `. queue` suffix → `delivery: "queue"`.
- Drain Discord line `» **user:** text` from `session.inbox.delivered` / equivalent inbox events.
- **No** abort. **No** 3s timer. **No** `promptAsync([])` replay.

V1 file to delete, not port: `cli/src/opencode-interrupt-plugin.ts`.

## Events (source of truth)

V2 events are **facts**, not v1 snapshots (`message.part.updated`).

See `packages/schema/src/session-event.ts`. Renderer should listen for:

- `session.created`
- `session.status` / `session.execution.started|succeeded|failed|interrupted`
- `session.text.*` (accumulate deltas, commit on ended)
- `session.tool.*`
- `session.inbox.enqueued|cancelled|delivered`
- `form.created` / `form.replied` (replaces `question.asked`)
- `permission.asked`

Footer **only** on `session.execution.succeeded`. Never on interrupt.

Filter the bus. Unfiltered subscribe duplicates Discord messages across projects.

Rewrite `cli/src/session-handler/event-stream-state.ts` against v2 facts. Keep derive-not-store. Do not move `thread-session-runtime.ts` (5k lines, v1 snapshots).

## Target plugins

One plugin = one feature + its state. Testable without Discord when the behavior is OpenCode-side.

| ID | Job | State |
|---|---|---|
| `kimaki.discord` | Gateway once, MessageCreate, slash register | `globalThis` Client + refcount |
| `kimaki.threads` | thread ↔ session ↔ directory ↔ worktree | sqlite or `ctx.storage` + cache |
| `kimaki.render` | facts → Discord messages, typing, footer | none beyond derive |
| `kimaki.queue` | prompt hook sets delivery; drain UI | none; inbox is source |
| `kimaki.btw` | `. btw` / `/btw` → `session.fork` + new thread | fork session → thread |
| `kimaki.permissions` | permission/form → Discord buttons | none |
| `kimaki.commands` | slash → `ctx.session.*` / RPC | none |
| `kimaki.voice` | voice → prompt | ephemeral |
| `kimaki.tasks` | scheduled send, sleep | sqlite |
| `kimaki.worktrees` | `ctx.worktree.transform` | none |
| `kimaki.context` | branch, cwd, memory reminder | none |
| `kimaki.memory` | MEMORY.md overview | none |

Do not stuff Discord + render + queue into one plugin. That recreates `thread-session-runtime.ts`.

Do not put a second `host.ts` god object that owns Client, thread map, fake session, and prompt hooks. Thread map belongs in `kimaki.threads`. Session belongs to OpenCode. Discord belongs in `kimaki.discord`.

## What to delete (do not port)

- Two processes (bot + OpenCode child) as the destination
- Interrupt plugin (3s abort + replay)
- Local Zustand `queueItems` for ordinary messages
- Hrana `ipc_requests` JSON IPC (typed RPC instead)
- `plugin-opencode-client.ts` / fake v2 client inside plugins
- Per-directory OpenCode child + `x-opencode-directory` hacks
- Toast-text sessionID markers
- `KIMAKI_*` env spray into the OpenCode child (plugin options + `ctx.storage`)
- Mirrored busy/phase flags
- Current `kimaki2/src/test-host.ts` and `kimaki2/src/fake-session.ts`
- Current `KimakiPlugin` type that is not `Plugin.define`

Keep: Discord limits (100-char `custom_id`, 25-char nonce, Components V2 40-child budget, typing ~7s pulse), sqlite thread durability, event derivation, worktree folder name ≠ branch name, GuildMember union narrowing (no `as GuildMember`).

## Current worktree (honest)

Already in `kimaki2/`:

- Real `opencode2` probe load test (keep)
- Digital Twin e2e for thread / follow-up / `. queue` / `. btw` **against `fake-session.ts`** (rewrite: same snapshots, real `ctx.session`)
- Queue suffix + btw suffix helpers (keep the regexes; wire to real inbox / fork)
- Derive helpers on a hand-rolled `{ type, data }` map (rewrite to schema types)
- `host.ts` process singleton that is too big (split)

`cli/` stays the published v1 bot until cutover. Do not rewrite `cli/` in place.

## CLI

Thin. `@opencode-ai/client` `Service.ensure()` then `client.rpc(Kimaki)`.

https://opencode.ai/v2/docs/build/client

```ts
const client = OpenCode.make({ baseUrl, headers: { authorization: `Basic …` } })
const kimaki = client.rpc(Kimaki)
await kimaki.send({ channelID, prompt, userID })
```

Location is first-class on RPC methods (`location: { directory }`). Do not send `x-opencode-directory` as a Kimaki invention if the client already has location.

## Digital Twin

Keep Digital Twin for Discord UX. It is fake Discord, not fake OpenCode.

v1 boot (do not copy the OpenCode child spawn): DigitalDiscord → discord.js `rest.api` → bot login.

v2 boot: DigitalDiscord → discord.js → plugins inside **real** `opencode2` (or PluginTestLayer for non-Discord). Footer snapshots use `⋅` and Digital Twin replaces duration/`%` with `Ns` / `N%`.

Do not make Digital Twin the only layer. Inbox `delivery` and per-location `setup` belong on the OpenCode tester.

## Isolation for any `opencode2` process

Copy `packages/core/script/test.ts` env:

- New `HOME`, `XDG_*`, `OPENCODE_CONFIG_DIR`
- `OPENCODE_CONFIG` set to the experiment json (or undefined)
- Unset `OPENCODE_CONFIG_CONTENT` (Kimaki leaks this)
- Strip provider API keys unless a test needs a real model
- Deterministic provider for Discord e2e that needs an LLM reply

## Phases (implementation session)

After each phase: tests green, then **Oracle review of that phase's diff**. Do not start the next phase on a failing tester.

0. **Submodule + tester.** `opencode-v2` submodule. One Kimaki plugin test using `host()` or `PluginTestLayer`. Delete `test-host.ts` from the success path.
1. **Probe on tester.** Two locations, one process, `globalThis` counter. Keep `opencode2-load.e2e.test.ts` as the serve-level check.
2. **Queue plugin as `Plugin.define`.** Hook sets `delivery`. Tests on real inbox, not `pending[]`.
3. **Threads + Discord singleton.** `Plugin.define`. Refcount. Filter events.
4. **Render from real facts.** Footer on succeeded only. Digital Twin snapshots for the four paths (new thread, follow-up, queue, btw) with **no fake-session**.
5. **Btw via `session.fork`** if the API matches; otherwise document the gap and use create+prompt without lying about fork.
6. **Permissions / form buttons.**
7. **Slash `/queue` and remaining commands**, one group per PR.
8. **RPC CLI.** Delete Hrana IPC from the v2 path.
9. **Cutover plan** (bin, demo, docs). Do not switch production `kimaki` until 4 is green on real OpenCode.

## Tips (do not rediscover)

- `Plugin.define` id like `kimaki.queue`. Builtin ids are `opencode.*`.
- Serve plugin list `state` is `{ status: "active" }`, not a string.
- Await-activation HTTP **204**.
- `features` on plugins is `server` / `tui` / `rpc`, not "run once".
- Warming plugin (`opencode.warming`) uses a Map inside `setup`. Fine for timers. Wrong for Discord.
- TUI plugin inspector exists (`opencode.plugins`). Server plugins show there. Use spans `plugin.id` plus `rpc.kimaki.*` for traces.
- `session.fork` vs Kimaki btw: btw must not replay Discord history; it copies model/worktree. Verify fork semantics before assuming 1:1.
- Footer mentions: skip when queue is draining (v1 `hasQueuedMessage`).
- Typing: pulse ~7s; start on busy/step-start, not on user message; clear on abort/end.
- Never embed paths in Discord `custom_id` (100 chars).
- Worktree folder name ≠ git branch name.

## Out of scope for v2 v0

- Slack bridge inside the plugin
- Website / gateway-proxy except docs
- Perfect 1:1 of every slash command on day one
- Keeping 3s interrupt "just in case"
