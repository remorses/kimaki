after every change always run tsc inside cli to validate your changes. try to never use as any

do not use spawnSync. use our util execAsync. which uses spawn under the hood

the important package in this repo is cli. it contains the discord bot code.

after making important changes to queueing or message handling always run the full test suite inside cli to make sure our changes did not break anything. also run with -u and see snapshots updates in git diff if needed. `pnpm test -u --run`

# repo architecture

kimaki is a monorepo with three main packages that communicate via a shared Postgres database hosted on PlanetScale.

```
┌─────────────────────────────────────────────────────────────┐
│  User's machine                                             │
│  cli/ (TypeScript CLI + Discord bot)                        │
│  ├── src/cli.ts        main CLI, onboarding wizard          │
│  ├── src/discord-bot.ts  event loop, session routing        │
│  └── SQLite (~/.kimaki/discord-sessions.db)                 │
│         local state: bot tokens, channels, threads, models  │
└────────┬──────────────────────────┬─────────────────────────┘
         │ REST + WebSocket         │ polls /api/onboarding/status
         │ (clientId:secret)        │ during first-time setup
         ▼                          ▼
┌─────────────────────┐   ┌──────────────────────────────────┐
│  gateway-proxy/      │   │  website/                        │
│  (Rust, fly.io)      │   │  (Cloudflare Worker, Hono)       │
│                      │   │  https://kimaki.dev           │
│  Sits between the    │   │                                  │
│  CLI and Discord.    │   │  GET /oauth/callback              │
│  One shared bot for  │   │    → upserts gateway_clients row │
│  all users — users   │   │    → website/src/routes/          │
│  don't create their  │   │      oauth-callback.tsx           │
│  own Discord bot.    │   │                                  │
│                      │   │  GET /api/onboarding/status       │
│  Multi-tenant:       │   │    → CLI polls every 2s           │
│  filters events per  │   │    → website/src/routes/          │
│  client_id + guild   │   │      onboarding-status.ts         │
│                      │   │                                  │
│  wss://kimaki-       │   └──────────┬───────────────────────┘
│  gateway-production  │              │
│  .fly.dev            │              │
└──────────┬───────────┘              │
           │                          │
           ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Shared Postgres (PlanetScale)                               │
│  db/schema.prisma                                            │
│                                                              │
│  gateway_clients table:                                      │
│    client_id  TEXT   ── identifies the kimaki user            │
│    secret     TEXT   ── authenticates gateway connections     │
│    guild_id   TEXT   ── guild the user installed the bot in   │
│    @@id([client_id, guild_id])                               │
│                                                              │
│  Written by: website (on OAuth callback)                     │
│  Read by: gateway-proxy (polls every 1s via db_config.rs)    │
│  Read by: website (onboarding status check)                  │
└──────────────────────────────────────────────────────────────┘
```

## gateway-proxy (Rust)

`gateway-proxy/` is a Rust service that proxies both Discord Gateway (WebSocket) and REST traffic. it lets multiple users share a single Discord bot instead of each user creating their own.

key files:

- `src/main.rs` — entry point, shard setup, HTTP server, DB polling
- `src/auth.rs` — authenticates `client_id:secret` tokens
- `src/db_config.rs` — polls Postgres `gateway_clients` table every 1s, atomically swaps the in-memory client map. stale protection: rejects auth if DB unreachable >30s
- `src/server.rs` — HTTP+WS server. REST proxy at `/api/v10/*`, WebSocket upgrade for gateway
- `src/dispatch.rs` — per-shard event fanout, filters events by `authorized_guilds`
- `src/cache.rs` — builds synthetic READY payloads filtered to authorized guilds
- `src/rest_proxy.rs` — forwards REST calls, rewrites Authorization header to real bot token, scopes guild/channel routes

auth flow: client sends IDENTIFY with token `client_id:client_secret` → proxy validates against the CLIENTS map (from DB) → returns `SessionPrincipal::Client(id)` + `authorized_guilds` → only forwards events for those guilds.

gateway REST rule for cli package code: when running with `client_id:secret`
through gateway-proxy, Discord REST calls must be guild-scoped or explicitly
allowlisted by the proxy (`/gateway/bot`, `/users/@me`, etc). avoid global
application routes like `/applications/{app_id}/commands`; use
`/applications/{app_id}/guilds/{guild_id}/commands` instead so auth can resolve
scope and allow the request.

multi-tenant REST safety invariant:

- never allow client-authenticated requests to hit unscoped bot-token routes.
- only tokenized interaction/webhook routes are allowed without auth
  (`/interactions/{id}/{token}/...`, `/webhooks/{id}/{token}/...`).
- never treat `/webhooks/{id}` as allowlisted.
- for `AllowedWithoutAuth` routes, do not inject bot `Authorization` upstream.
- fail closed (`403`/`401`) when route scope cannot be proven as guild-scoped or
  token-scoped.

## gateway onboarding flow (gateway mode)

the gateway mode onboarding (in `cli/src/cli.ts`, the `run()` function) works as follows:

1. CLI generates `clientId` (UUID) + `clientSecret` (32-byte hex)
2. builds Discord OAuth URL with `state=JSON({clientId, clientSecret})` and `redirect_uri=https://kimaki.dev/api/auth/callback/discord`
3. opens browser to the Discord install URL
4. user authorizes the shared Kimaki bot in their server
5. Discord redirects to `website/src/routes/oauth-callback.tsx` with `guild_id` + `state` — website upserts `gateway_clients` row in Postgres
6. CLI polls `website/src/routes/onboarding-status.ts` every 2s until it finds the `client_id` + `secret` row, gets back `guild_id`
7. CLI stores credentials locally via `setBotMode()` in SQLite with `bot_mode='gateway'`, `proxy_url` pointing to the gateway
8. bot connects with `clientId:clientSecret` as the Discord token — discord.js hits the gateway proxy which routes events for authorized guilds only

use `--gateway` to force gateway mode even if self-hosted credentials are already saved. this skips saved self-hosted creds and enters the gateway onboarding flow.

## db package

`db` is a devDependency of `cli`. this means cli can only import **types** from `db`, not runtime values. use `import type { ... } from 'db/...'` in cli code. website has `db` as a normal dependency so it can import runtime values (functions, classes, etc.).

## opencode SDK

always import from `@opencode-ai/sdk/v2`, never from `@opencode-ai/sdk` (v1). the v2 SDK uses flat parameters instead of nested `path`/`query`/`body` objects. for example:

- `session.get({ sessionID: id })` not `session.get({ path: { id } })`
- `session.messages({ sessionID: id, directory })` not `session.messages({ path: { id }, query: { directory } })`
- `session.create({ title, directory })` not `session.create({ body: { title }, query: { directory } })`
- `provider.list({ directory })` not `provider.list({ query: { directory } })`

## ai sdk provider stream protocol (v2)

when editing deterministic provider matchers or debugging stream behavior, always
confirm the protocol from both docs and installed types:

- docs: `content/docs/07-reference/01-ai-sdk-core/02-stream-text.mdx`
- installed types: `node_modules/.pnpm/@ai-sdk+provider@*/node_modules/@ai-sdk/provider/src/language-model/v2/language-model-v2-stream-part.ts`
- built types: `node_modules/.pnpm/@ai-sdk+provider@*/node_modules/@ai-sdk/provider/dist/index.d.ts`

use these shapes for realistic assistant output:

- text assistant message: `stream-start` → `text-start` → one or more
  `text-delta` → `text-end` → `finish`
- tool-invoking assistant message: `stream-start` → `tool-call` → `finish`
  (`finishReason: "tool-calls"`)

for opencode-style tool calls in deterministic matchers, represent tool usage via
`tool-call` parts with `toolName` and JSON `input` (for example `read`, `edit`,
`write`, `bash`, `task`). do not fake these as plain text when the test is about
tool execution or tool routing.

# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it.

To restart the discord bot process so it uses the new code, send a SIGUSR2 signal to it.

1. Find the process ID (PID) of the kimaki discord bot (e.g., using `ps aux | grep kimaki` or searching for "kimaki" in process list).
2. Send the signal: `kill -SIGUSR2 <PID>`

The bot will wait 1000ms and then restart itself with the same arguments.

## running parallel kimaki processes

if you need to run another kimaki process while one is already running (for example testing the npm-installed kimaki), ALWAYS set a different `KIMAKI_LOCK_PORT` for the extra process.

otherwise the new process can take over the lock port, stop the main kimaki process, and kill active sessions.

use a free port and a separate data dir, for example:

```bash
KIMAKI_LOCK_PORT=31001 npx -y kimaki@latest --data-dir ~/.kimaki-test
```

> KIMAKI_LOCK_PORT is required only for the root kimaki command, which is the one that starts the kimaki bot. subcommands dont' need it.

## sqlite

this project uses sqlite to preserve state between runs. the database should never have breaking changes, new kimaki versions should keep working with old sqlite databases created by an older kimaki version. if this happens specifically ask the user how to proceed, asking if it is ok adding migration in startup so users with existing db can still use kimaki and will not break.

you should prefer never deleting or adding new fields. we rely in a schema.sql generated inside src to initialize an update the database schema for users.

if we added new fields on the schema then we would also need to update db.ts with manual sql migration code to keep existing users databases working.

## prisma

we use prisma to write type safe queries. the database schema is defined in `cli/schema.prisma`.

`cli/src/schema.sql` is **generated** from the prisma schema — never edit it directly. to regenerate it after modifying schema.prisma:

```bash
cd cli && pnpm generate
```

this runs `prisma generate` (for the client) and `pnpm generate:sql` (which creates a temp sqlite db, pushes the prisma schema, and extracts the CREATE TABLE statements). the resulting `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so it creates tables for new users automatically on startup.

### how schema changes work

**new tables**: schema.sql handles them automatically. `CREATE TABLE IF NOT EXISTS` runs on every startup via `migrateSchema()` in `db.ts`, so new tables appear without any manual migration.

**new columns on existing tables**: schema.sql won't add columns to tables that already exist (`IF NOT EXISTS` skips the whole CREATE). add a migration in `db.ts` `migrateSchema()` using:

```ts
try {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE table_name ADD COLUMN column_name TEXT',
  )
} catch {
  // Column already exists
}
```

this is the only migration pattern needed. ALTER TABLE ADD COLUMN silently fails if the column exists. never recreate tables to change column types or nullability — it's too complex and risky for a user-facing sqlite database.

**workflow for adding a new column:**

1. add the field to `cli/schema.prisma`
2. run `pnpm generate` inside cli folder (regenerates prisma client + schema.sql)
3. add `ALTER TABLE ... ADD COLUMN` in `db.ts` `migrateSchema()` with try/catch
4. schema.sql handles new installs, the ALTER handles existing installs

when adding new tables:

1. add the model to `cli/schema.prisma`
2. run `pnpm generate` inside cli folder
3. add getter/setter functions in `database.ts` only if the query is complex or reused in many places

do NOT add simple prisma query wrappers to database.ts. if a query is a straightforward `findMany`, `findUnique`, `create`, etc. with no complex logic, inline the prisma call directly at the call site. database.ts is not a repository layer — it only exists for queries that are genuinely complex (multi-step transactions, migrations) or called from 3+ places. when in doubt, inline it.

prisma version in package.json MUST be pinned. no ^. this makes sure the generated prisma code is compatible with the prisma client used in the npm package

## libsql in-memory gotcha

when using `@prisma/adapter-libsql` with `file::memory:`, always use `file::memory:?cache=shared`. without `cache=shared`, libsql's `transaction()` method sets its internal `#db = null` and lazily creates a `new Database("file::memory:")` on the next operation -- which gives a **separate empty in-memory database**. this silently breaks any Prisma operation that uses transactions internally (`upsert`, `$transaction`, etc.) while simple `create`/`findMany` keep working, making the bug hard to diagnose.

## errore

errore is a submodule. should always be in main. make sure it is never in detached state.

it is a package for using errors as values in ts.

this whole codebase uses errore.org conventions. ALWAYS read the errore skill before editing any code.

## opencode

if I ask you questions about opencode you can opensrc it from anomalyco/opencode

## discord bot messages

try to not use emojis in messages

when creating system messages like replies to commands never add new line spaces between paragraphs or lines. put one line next to the one before.

## discord typing indicator

discord typing indicators come from `POST /channels/{id}/typing` / `sendTyping()`. one pulse only lasts about 10 seconds in the Discord UI, so long-running work must refresh it periodically (we usually pulse every ~7 seconds).

Discord typically stops showing the indicator once the bot sends a visible message, so runs that emit multiple bot messages may need an immediate fresh pulse after each non-final message while the session is still busy.

user messages do not automatically make the bot appear typing again. do not show typing just because a user sent a message; only start it when OpenCode events show the session is actually processing (for example `session.status: busy` or `step-start`).

do not remove the typing interval to fix stuck typing; instead fix lifecycle bugs by clearing both the active interval and any scheduled restart timeout when a session ends, aborts, or pauses for permission/question prompts.

when adding delayed typing restarts (for example after `step-finish`), always guard them with session closed/aborted checks so they cannot restart typing after cleanup.

## AGENTS.md

AGENTS.md is generated. only edit KIMAKI_AGENTS.md instead. pnpm agents.md will generate the file again.

## discord object shapes

never use typescript assertions/casts on discord interaction objects just to force a cached shape (for example `as GuildMember`). many discord values can arrive as either hydrated cached classes or raw api payload shapes depending on cache/event path.

for member/role/permission checks, always handle both shapes explicitly with a union type and runtime narrowing (`instanceof GuildMember`, guarded `Array.isArray(member.roles)`, etc). if required context is missing for permission checks, fail closed instead of assuming access.

this avoids bugs where code works for cached users but fails for uncached interaction payloads with errors like `member.roles.cache` being undefined.

## resolving project directories in commands

use `resolveWorkingDirectory({ channel })` from `discord-utils.ts` to get directory paths in slash commands. it returns:

- `projectDirectory`: base project dir, used for `initializeOpencodeForDirectory` (server is keyed by this)
- `workingDirectory`: worktree dir if thread has an active worktree, otherwise same as `projectDirectory`. use this for `cwd` in shell commands and for SDK `directory` params
- `channelAppId`: optional app ID from channel metadata

never call `getKimakiMetadata` + manual `getThreadWorktree` check in commands. the util handles both. if you need to encode a directory in a discord customId for later use with `initializeOpencodeForDirectory`, always use `projectDirectory` not `workingDirectory`.

## discord component custom ids

discord message components (buttons, select menus, modals) enforce a strict `custom_id` max length of **100 chars**.

never embed long strings in `custom_id` (absolute paths, base64 of paths, serialized json, session transcripts, etc) or the builder will throw errors like `Invalid string length`.

instead:

- store only short identifiers in `custom_id` (eg `contextHash`, a db id, or a session id)
- resolve anything else at interaction time (eg call `resolveWorkingDirectory({ channel })` from the thread)
- if you need extra context, store it server-side keyed by the short hash/id rather than encoding it into `custom_id`

## discord components v2 limits

when editing Discord Components V2 (`IS_COMPONENTS_V2`) messages, always check the official docs first:

- overview: `https://discord.com/developers/docs/components/overview`
- reference: `https://discord.com/developers/docs/components/reference`

important limits and rules to keep in mind:

- components v2 messages cannot use normal `content` or `embeds`; send everything through `components`
- messages allow up to **40 total components**, and nested children count toward that budget
- `Section` is only for **1 to 3** text/content children plus at most one accessory (`button` or `thumbnail`)
- do **not** use `Section` for wide table rows with many columns; this causes `BASE_TYPE_BAD_LENGTH` validation errors
- `Button` can live inside an `Action Row` or in `Section.accessory`
- `Action Row` can contain up to **5 buttons** or a single select menu
- `Container` can hold `Action Row`, `Text Display`, `Section`, `Media Gallery`, `Separator`, and `File`

for kimaki table rendering specifically: plain rows should stay as a single `TextDisplay`, and rows with actions should usually render as `TextDisplay` + `ActionRow` inside the `Container` instead of using `Section` for the whole row.

## heap snapshots and memory debugging

kimaki has a built-in heap monitor that runs every 30s and checks V8 heap usage.

- **85% heap used**: writes a `.heapsnapshot` file to `~/.kimaki/heap-snapshots/`

to manually trigger a heap snapshot at any time:

```bash
kill -SIGUSR1 <PID>
```

snapshots are saved as `heap-<date>-<sizeMB>MB.heapsnapshot` in `~/.kimaki/heap-snapshots/`.
open them in Chrome DevTools (Memory tab > Load) to inspect what is holding memory.
there is a 5 minute cooldown between automatic snapshots to avoid disk spam.

signal summary:

- `SIGUSR1`: write heap snapshot to disk
- `SIGUSR2`: graceful restart (existing)

the implementation is in `cli/src/heap-monitor.ts`.

## cpu profiling tests

set `VITEST_CPU_PROF=1` to generate `.cpuprofile` files when running vitest. profiles land in `cli/tmp/cpu-profiles/`. always run a single test file to avoid hanging the machine — the config forces `maxForks: 1` when profiling.

```bash
# run one test file with profiling
cd cli
VITEST_CPU_PROF=1 pnpm test --run src/some-file.e2e.test.ts
```

to get a top-down self-time report without opening a browser, use profano:

```bash
bunx profano tmp/cpu-profiles/CPU.*.cpuprofile
```

for an interactive flame chart in the browser, use cpupro:

```bash
npx cpupro tmp/cpu-profiles/CPU.*.cpuprofile
```

## goke cli

this project uses goke (not cac) for CLI parsing. goke auto-infers option types from `.option()` calls. never add manual type annotations to `.action()` callback options. just use `.action(async (options) => { ... })` and let goke infer the types.

## logging

always try to use logger instead of console. so logs in the cli look uniform and pretty

for the log prefixes always use short names

kimaki writes logs to `<dataDir>/kimaki.log` (default `~/.kimaki/kimaki.log`). the log file is reset on every bot startup, so it only contains logs from the current run. file logging works in all environments (dev and production).

to debug opencode event ordering, set `KIMAKI_LOG_OPENCODE_SESSION_EVENTS=1`. this writes jsonl files under `<dataDir>/opencode-session-events/` (one file per session id, like `ses_xxx.jsonl`). use `KIMAKI_OPENCODE_SESSION_EVENTS_DIR` to override the output directory.

For example when running a test to debug events: `KIMAKI_OPENCODE_SESSION_EVENTS_DIR=./tmp/kimaki-test-3423 KIMAKI_LOG_OPENCODE_SESSION_EVENTS=1 pnpm test test-file.test.ts -t test-name`

for live user-session debugging (without restarting with env vars), export the persisted session event buffer from sqlite with:

`kimaki session export-events-jsonl --session <session_id> --out ./tmp/session-events.jsonl`

use this when debugging session-state regressions (for example footer appearing after abort). the exported jsonl can be copied into `cli/src/session-handler/event-stream-fixtures/` and used to add/update `event-stream-state.test.ts` coverage for pure derivation helpers.

runtime note: `ThreadSessionRuntime` keeps the last 1000 opencode events in memory per thread (`eventBuffer`) for event-sourcing derivation and waiters. the buffer stores a compacted event shape to avoid memory spikes.

the compacted buffer strips/truncates these large fields:

- `message.updated` user events: strip `info.system`, `info.summary`, `info.tools`
- `message.part.updated` text/reasoning/snapshot: truncate long text fields
- `message.part.updated` `step-start.snapshot`: truncate
- `message.part.updated` tool states: replace `state.input` with `{}`
- `message.part.updated` completed tool output: truncate `state.output`
- `message.part.updated` completed tool attachments: strip `state.attachments`
- `message.part.updated` pending `state.raw` and error `state.error`: truncate

the jsonl line is intentionally minimal: `{ timestamp, threadId, projectDirectory, event }`.

use `jq` to inspect these files quickly:

```bash
# list event type counts for one session file
jq -r '.event.type' ~/.kimaki/opencode-session-events/ses_xxx.jsonl | sort | uniq -c

# show only session lifecycle events (status/idle/error)
jq -r 'select(.event.type=="session.status" or .event.type=="session.idle" or .event.type=="session.error") | [.timestamp, .event.type, (.event.properties.status.type // ""), (.event.properties.error.name // "")] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# filter by a specific event type (example: message.part.updated)
jq -r 'select(.event.type=="message.part.updated")' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# filter by event subtype (example: session.status idle)
jq -r 'select(.event.type=="session.status" and .event.properties.status.type=="idle")' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# show timestamps + event types
jq -r '[.timestamp, .event.type] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl
```

for checkout validation requests, prefer non-recursive checks unless the user asks otherwise.

## opencode plugin and env vars

the opencode plugin (`cli/src/kimaki-opencode-plugin.ts`) runs inside the **opencode server process**, not the kimaki bot process. this means `config.ts` state (like `getDataDir()`, etc.) is not available there.

**CRITICAL: never export utility functions from `kimaki-opencode-plugin.ts`.** opencode's plugin loader calls every exported function in the module as a plugin initializer. if you export a helper like `condenseMemoryMd(content: string)`, it will be called with a PluginInput object instead of a string and crash. only the plugin entrypoint function should be exported. move any utilities to separate files (e.g. `condense-memory.ts`) and import them.

we should architecture our opencode plugins as many separate plugins to make them readable and easy to understand. every export will be interpreted as a different plugin.

to pass bot-process state to the plugin, use `KIMAKI_*` env vars set in `opencode.ts` when spawning the server process. current env vars:

- `KIMAKI_DATA_DIR`: data directory path
- `KIMAKI_LOCK_PORT`: lock server port for bot communication

the plugin does NOT receive `KIMAKI_BOT_TOKEN`. discord REST operations (user listing, thread archiving) are handled by CLI commands (`kimaki user list`, `kimaki session archive`) which resolve credentials from the database via `resolveBotCredentials()`. this avoids leaking gateway credentials into child process environments.

when adding new bot-side config that the plugin needs, add it as a `KIMAKI_*` env var in `opencode.ts` spawn env and read `process.env.KIMAKI_*` in the plugin. never import config.ts getters in the plugin.

**NEVER use `console.log`, `console.error`, or any `console.*` in plugin code.** opencode captures plugin stdout/stderr and it pollutes the opencode server output, breaking structured logging. plugins must be silent — fail gracefully and return null/undefined on errors instead of logging.

OpenCode plugin files must also avoid importing `cli/src/logger.ts`. That logger pulls in `@clack/prompts` / `picocolors`, which can fail under the plugin loader's ESM/CJS interop. For plugin code, use a separate plugin-safe logger module that only appends to the kimaki log file and never writes to stdout/stderr.

## skills folder

skills is a symlink to cli/skills. this is a folder of skills for kimaki. loaded by all kimaki users. some skills are synced from github repos. see cli/scripts/sync-skills.ts. so never manually update them. instead if need to updaste them start kimaki threads on those project, found via kimaki cli.

## discord-digital-twin e2e style

when writing discord e2e tests, prefer adding reusable automation methods to `DigitalDiscord` instead of creating per-test helper functions in kimaki.

always import from `discord-digital-twin/src` so we dont need to compile that package before using it.

aim for a playwright-like style in tests:

- actor methods for actions: `discord.user(userId).sendMessage(...)`, `runSlashCommand(...)`, `clickButton(...)`, etc
- separate wait methods for assertions: `discord.waitForThread(...)`, `discord.waitForBotReply(...)`, `discord.waitForInteractionAck(...)`

if a kimaki test needs a new interaction primitive, first add it to `discord-digital-twin/src/index.ts` and cover it in `discord-digital-twin/tests/*` so future tests can reuse it.

always add `expect(await th.text()).toMatchInlineSnapshot()` (or `discord.channel(id).text()` / `discord.thread(id).text()`) in every test that creates or modifies messages. place it **before** other expects so it updates even when a test fails. this gives both agents and humans a quick textual snapshot of what happened in Discord during the test, making failures easy to diagnose. use deterministic message content (no `Date.now()` or random values) so snapshots stay stable across runs. for tests that don't create messages (metadata, typing, guild routes), the snapshot can be skipped.

## e2e testing learnings

see `docs/e2e-testing-learnings.md` for detailed lessons. key points:

- **always assert on Discord messages (what the user sees), not internal state or logs.** use digital-discord helpers like `th.getMessages()`, `waitForBotReply`, `waitForBotReplyAfterUserMessage`, `waitForBotMessageContaining` to verify actual Discord thread content. never use `getLogEntriesSince` + string matching for test expectations — logs are brittle, can bleed across sequential tests, and don't verify actual behavior. use `getLogEntriesSince` only in `onTestFailed` for diagnostics.
- e2e tests use `opencode-deterministic-provider` which returns canned responses instantly (no real LLM). poll timeouts should be **4s max** and polling interval **100ms**. the only real latency is opencode server startup (`beforeAll`, 60s is fine) and intentional `partDelaysMs` in matchers.
- deterministic provider matchers can still trigger **real tool execution** when they emit `tool-call` parts (for example `bash` + `sleep`). do not use long sleeps (`sleep 500` means 500 seconds). prefer `partDelaysMs` for timing windows in tests.
- avoid broad matchers like only `lastMessageRole: 'tool'` in shared e2e matcher lists. always scope with an explicit marker (`rawPromptIncludes`, exact latest user text, etc.) or they can cascade across unrelated turns and create flaky tests.
- prefer `latestUserTextIncludes` over `rawPromptIncludes` for deterministic matcher markers that should only trigger once. `rawPromptIncludes` scans full session history, so after abort+retry in the same session the old marker re-fires and causes deadlocks or timeouts. `latestUserTextIncludes` only checks the most recent user message.
- prefer content-aware polling ("does this user message have a bot reply after it?") over count-based polling (`waitForBotMessageCount`). count-based is fragile when sessions get interrupted/aborted because error messages satisfy the count early.
- bot replies can be error messages, not just LLM content. verify ordering by position, not content matching.
- test logs are suppressed by default (`KIMAKI_VITEST=1` in vitest.config.ts). to debug a failing test, rerun with `KIMAKI_TEST_LOGS=1` to see all kimaki logger output in the terminal. example: `KIMAKI_TEST_LOGS=1 pnpm test --run src/thread-message-queue.e2e.test.ts`. only run one test at a time with logs enabled to see clear logs and save context window.
- if total duration of an e2e test file exceeds **~10 seconds**, split into a new file so vitest parallelizes across files.
- `afterAll` should clean up opencode sessions via `session.list()` + `session.delete()` to avoid accumulation across runs.
- to assert something doesn't appear in Discord (e.g. no footer after abort), poll `th.getMessages()` in a loop: sleep 20ms, max 10 iterations. everything is deterministic so 200ms total is enough. fail immediately if the unwanted message appears.

## event handler architecture

our event handler should follow closely what opencode tui does. you can find opencode source code in opensrc folder. opensrc anomalyco/opencode. notice opencode-ai/opencode is a different unrelated repo. ignore that

see `packages/app/src/components/prompt-input/submit.ts` for where opencode tui calls promptAsync

opencode uses the event subscription (sdk call `event.subscribe`) as single source of truth for everything displayed in the tui. we should follow similar architecture. using opencode event stream as source of truth, and not setting state in discord message handlers. instead we should trigger opencode sdk calls, and then listen for the event stream as single source of truth.

## event sourcing first

prefer event sourcing over mirrored mutable run state.

always read the `event-sourcing-state` skill before updating code in `cli/src/session-handler/thread-session-runtime.ts`.

why this is preferred:

- one source of truth: the event stream. no duplicated "phase" or "current run" state that can desync.
- easier debugging: read the jsonl stream and replay decisions from history.
- easier testing: derivation logic is pure and deterministic with fixture inputs.
- fewer race bugs: state is derived from observed events, not guessed from local transitions.

when the user mentions a specific kimaki session while reporting a bug, always export its jsonl first with `kimaki session export-events-jsonl --session <id> --out ./tmp/<id>.jsonl` and inspect that stream before guessing about runtime state.

write derivation as pure functions that accept events and return computed state.
prefer existing derivation helpers from `event-stream-state.ts` (for example
`wasRecentlyAborted`) over new mirrored flags:

```ts

export function deriveRunOutcome({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): RunOutcome {
  const isBusy = isSessionBusy({
    events,
    sessionId,
    upToIndex: idleEventIndex,
  })
  const wasAbort = wasRecentlyAborted({
    events,
    sessionId,
    idleEventIndex,
  })
  return {
    isBusy,
    wasAbort,
    shouldShowFooter: !isBusy && !wasAbort,
  }
}
```

this function is isolated, side-effect free, deterministic, and easy to test
with fixture jsonl streams and inline snapshots.

## state minimization and centralization

if mutable state is really needed, centralize it.

- use `cli/src/store.ts` for global shared state so every read/write path is visible.
- keep global state at a minimum. every new field multiplies the number of possible app states and increases bug surface.
- prefer deriving values from events/existing state instead of storing mirrored flags.
- if state is local-only, keep it local and encapsulated (for example a local `let count = 0` in one function/loop). do not promote temporary local state to global store.

## aborting and resuming opencode session

currently we queue user messages in opencode via `session.promptAsync` sdk method. opencode will run these messages on the next step (when current part finishes, things like tool calls, etc).

we also have a /queue command to queue messages for next message finish. this state is tracked in our own state instead of opencode.

sometimes we need to interrupt the opencode session and restart it. for example /model Discord command does this. the best way to implement this is to

1. call `session.abort` sdk method to abort current session.
2. call `session.promptAsync({ parts: [] })` to resume session

## how kimaki messages look like in Discord

Kimaki works by creating threads on the first user message. The bot will then reply messages there for text parts, prefixing them with ⬥

tool parts are also displayed in Discord as messages, either prefixed with ┣ or ◼︎ for file edits or writes. we also display context usage info like percentage of context used at 10% windows, prefixed with ⬦. the tool calls displayed depend on the verbosity parameter. the default skips tool parts for parts like `thinking`, file reads and non `sideEffect` bash parts (sideEffect is a param passed by the model).

at assistant message normal completion we also display a footer message like `kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6`. with folder, branch, time, context used, model id. we should not show this message on interruptions or aborts.

we also support voice user messages, these are transcribed with another model and sent with prefix `Transcribed message:`, shown by the bot.

we also support a /queue command to queue user messages to be sent at current session end. and a /clear-queue command to clear the queue. when the message ends we will display a message by the bot with content like `» Tommy: content` for the queued user message being sent.

this information is useful for your tests. you can use this knowledge to write tests, tests should use expect and find messages that match a specific pattern.

## discord bot typing indicator

discord.js has a startTyping method. this method will show a typing indicator in discord for the next 7 seconds. it will also stop at the next bot message. so we need to continuously call startTyping while the bot is working, at an interval of 7 seconds. we simply stop calling when the bot is done, before the last bot message is sent, and Discord will stop showing it.

## discord-slack-bridge

`discord-slack-bridge/` is a package that lets discord.js bots (like kimaki)
control a Slack workspace without code changes. it translates Discord REST
calls to Slack Web API calls and Slack webhook events to Discord Gateway
dispatches. see `slop/discord-slack-bridge-spec.md` for the full spec.

key design: stateless ID mapping (no database). thread IDs encoded as
`THR_{channel}_{ts}`, message IDs as `MSG_{channel}_{ts}`.

reference implementation: `opensrc/repos/github.com/vercel/chat/packages/adapter-slack/`
(opensrc vercel/chat) — shows how to handle Slack events, post messages,
manage threads, convert markdown, and handle Block Kit.

### slack API references

when working on the slack bridge, consult these docs:

**core concepts:**
- Slack API overview: https://api.slack.com/docs
- Bot user tokens (xoxb): https://api.slack.com/authentication/token-types
- Event subscriptions (webhook mode): https://api.slack.com/events
- Block Kit overview: https://api.slack.com/block-kit
- Block Kit reference (all block types): https://api.slack.com/reference/block-kit/blocks
- Block Kit elements (buttons, selects, etc.): https://api.slack.com/reference/block-kit/block-elements
- Block Kit composition objects (text, option, etc.): https://api.slack.com/reference/block-kit/composition-objects
- Block Kit Builder (interactive playground): https://app.slack.com/block-kit-builder

**web API methods we use:**
- chat.postMessage: https://api.slack.com/methods/chat.postMessage
- chat.update: https://api.slack.com/methods/chat.update
- chat.delete: https://api.slack.com/methods/chat.delete
- conversations.history: https://api.slack.com/methods/conversations.history
- conversations.replies: https://api.slack.com/methods/conversations.replies
- conversations.info: https://api.slack.com/methods/conversations.info
- conversations.list: https://api.slack.com/methods/conversations.list
- conversations.create: https://api.slack.com/methods/conversations.create
- reactions.add: https://api.slack.com/methods/reactions.add
- reactions.remove: https://api.slack.com/methods/reactions.remove
- users.info: https://api.slack.com/methods/users.info
- users.list: https://api.slack.com/methods/users.list
- auth.test: https://api.slack.com/methods/auth.test
- views.open: https://api.slack.com/methods/views.open
- views.update: https://api.slack.com/methods/views.update
- files.getUploadURLExternal: https://api.slack.com/methods/files.getUploadURLExternal
- files.completeUploadExternal: https://api.slack.com/methods/files.completeUploadExternal

**threading model:**
- Slack threads use `thread_ts` (parent message timestamp), not separate IDs
- Creating a thread = posting a reply with `thread_ts` set to parent `ts`
- https://api.slack.com/messaging/managing#threading

**interactive components:**
- Handling user interaction (block_actions, view_submission): https://api.slack.com/interactivity/handling
- Slash commands: https://api.slack.com/interactivity/slash-commands
- Modals (views): https://api.slack.com/surfaces/modals
- Response URLs: https://api.slack.com/interactivity/handling#message_responses

**npm packages:**
- @slack/web-api: https://www.npmjs.com/package/@slack/web-api
- types are in opensrc: `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/`
- do NOT use @slack/socket-mode or @slack/bolt — we use webhook mode only

**slack mrkdwn format:**
- Slack uses `*bold*` (not `**bold**`), `~strike~` (not `~~strike~~`), `<url|text>` (not `[text](url)`)
- Full reference: https://api.slack.com/reference/surfaces/formatting
