after every change always run tsc inside cli to validate your changes. try to never use as any

always load the `changesets` skill before fixing bugs or adding features. User-facing fixes and features usually need a `.changeset/*.md` entry, and the skill explains package selection, issue references, descriptive filenames, and `.changeset/readme.md` expectations.

do not use spawnSync. use our util execAsync. which uses spawn under the hood

the important package in this repo is cli. it contains the discord bot code.

after making important changes to queueing or message handling always run the full test suite inside cli to make sure our changes did not break anything. use `pnpm run test --run -u`, then inspect snapshot updates in git diff. for one file, use `pnpm run test --run src/example.test.ts`. always include `run` after `pnpm`; `pnpm test --run` makes pnpm consume the flag, and `pnpm run test -- --run` passes a literal `--` that can make vitest ignore the filter.

for checkout validation requests, prefer non-recursive checks unless the user asks otherwise.

## task-specific docs

read the matching doc **before** starting these tasks. they hold the full procedures and are not repeated here.

| task                                                                               | read first                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------- |
| gateway-proxy, website onboarding, `gateway_clients`, `--gateway`, bot credentials  | `docs/gateway-architecture.md`            |
| publish, release notes, #changelog post, website deploy, kimaki-demo deploy         | `docs/release-process.md`                 |
| logs, session event jsonl, jq, heap snapshots, cpu profiling, `~/.kimaki/bin` shim  | `docs/debugging-kimaki.md`                |
| editing `discord-slack-bridge/` (Slack API links, ID encoding, KV auth cache)       | `discord-slack-bridge/AGENTS.md`          |
| Strada events, DAU/WAU/MAU, funnels, retention SQL                                  | `docs/strada-product-analytics.md`        |
| event sourcing patterns and examples                                                | `docs/event-sourcing-for-application-state.md` |

# repo architecture

```
cli/ (bot + CLI, local SQLite) ──REST+WS (clientId:secret)──▶ gateway-proxy/ (Rust, fly.io) ──▶ Discord
   │                                                                 ▲ polls every 1s
   └─ polls /api/onboarding/status ──▶ website/ (CF Worker) ──▶ shared Postgres (db/, gateway_clients)
```

- `cli/`: TypeScript CLI + Discord bot. `src/cli.ts` main CLI and onboarding, `src/discord-bot.ts` event loop and session routing, SQLite at `~/.kimaki/discord-sessions.db`.
- `gateway-proxy/`: multi-tenant Discord Gateway + REST proxy. one shared bot for all users.
- `website/`: https://kimaki.dev, OAuth callback and onboarding status routes.
- `db/`: shared Postgres schema (`db/schema.prisma`).

full diagram, gateway-proxy key files, auth flow, and the 8-step onboarding flow: `docs/gateway-architecture.md`.

## gateway REST safety

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

## db package

`db` is a devDependency of `cli`. this means cli can only import **types** from `db`, not runtime values. use `import type { ... } from 'db/...'` in cli code. website has `db` as a normal dependency so it can import runtime values (functions, classes, etc.).

## opencode SDK

always import from `@opencode-ai/sdk/v2`, never from `@opencode-ai/sdk` (v1). the v2 SDK uses flat parameters instead of nested `path`/`query`/`body` objects. for example:

- `session.get({ sessionID: id })` not `session.get({ path: { id } })`
- `session.messages({ sessionID: id, directory })` not `session.messages({ path: { id }, query: { directory } })`
- `session.create({ title, directory })` not `session.create({ body: { title }, query: { directory } })`
- `provider.list({ directory })` not `provider.list({ query: { directory } })`

if I ask you questions about opencode you can opensrc it from anomalyco/opencode (not opencode-ai/opencode, which is an unrelated repo).

# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it. to restart it with new code, find the PID (for example `ps aux | grep kimaki`) and run `kill -SIGUSR2 <PID>`. the bot waits 1000ms and restarts itself with the same arguments. `SIGUSR1` writes a heap snapshot instead (see `docs/debugging-kimaki.md`).

## running parallel kimaki processes

if you need to run another kimaki process while one is already running (for example testing the npm-installed kimaki), ALWAYS set a different `KIMAKI_LOCK_PORT` for the extra process. otherwise the new process can take over the lock port, stop the main kimaki process, and kill active sessions. use a free port and a separate data dir:

```bash
KIMAKI_LOCK_PORT=31001 npx -y kimaki@latest --data-dir ~/.kimaki-test
```

KIMAKI_LOCK_PORT is required only for the root kimaki command, which starts the bot. subcommands don't need it.

## sqlite

sqlite preserves state between runs. the database must never have breaking changes: new kimaki versions must keep working with sqlite databases created by older versions. if a change would break this, ask the user whether it is ok to add a startup migration so users with existing dbs are not broken.

prefer never deleting or adding fields. `cli/src/schema.sql` (generated) initializes and updates the schema for users.

`CREATE TABLE IF NOT EXISTS` does not change an existing table. `schema.sql` still runs `CREATE INDEX` against that old shape. if a new index or unique constraint needs a new column or a new primary key, rebuild the table in `migrateSchema()` **before** executing `schema.sql`. otherwise existing DBs crash on startup, for example `SQLITE_ERROR: no such column: id`. always add a `db.test.ts` case that opens a legacy-shaped sqlite file and calls `getDb()`.

## cli SQLite schema (Drizzle)

the local database schema is defined in `cli/src/schema.ts` with Drizzle. `cli/src/schema.sql` is generated by `drizzle-kit export` through `cli/scripts/generate-schema-sql.ts`; never edit it directly. regenerate after modifying `schema.ts`:

```bash
cd cli && pnpm generate
```

this runs `pnpm generate:sql`. `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so it creates tables for new users on startup via `migrateSchema()` in `cli/src/db.ts`. `getDb()` returns a Drizzle client backed by libSQL.

**new tables**: schema.sql handles them automatically.

1. add the table to `cli/src/schema.ts`
2. run `pnpm generate` inside cli
3. add helpers in `cli/src/database.ts` only if the query is complex or reused in many places

**new columns on existing tables**: schema.sql won't add them (`IF NOT EXISTS` skips the whole CREATE).

1. add the column to `cli/src/schema.ts`
2. run `pnpm generate` inside cli
3. add an `ALTER TABLE` migration in `cli/src/db.ts` `migrateSchema()`, following the existing `alterStatements` pattern:

```ts
await client.execute('ALTER TABLE table_name ADD COLUMN column_name TEXT')
  .catch(() => undefined)
```

schema.sql handles new installs, the ALTER handles existing installs. if a generated index refers to the new column, migrate the existing table **before** executing `schema.sql` (see the SQLite section above); otherwise startup fails before the ALTER runs. keep legacy database compatibility and add a `db.test.ts` case for the old shape.

do NOT add simple Drizzle query wrappers to `database.ts`. inline straightforward `db.query.*.findFirst/findMany`, `db.insert`, `db.update`, etc. at the call site. `database.ts` holds genuinely complex or widely reused queries, not a repository layer.

Prisma still belongs to the separate `db/` Postgres package and some test-support packages. Do not remove their Prisma dependencies or schemas when working on the cli SQLite database.

## publishing

before any publish, read `docs/release-process.md`. it covers `pnpm sync-skills` first, the #changelog notification via sigillo with the demo bot token, the website production deploy, and kimaki-demo deploys.

## github issues

never suggest installing kimaki from git (e.g. `npm i -g remorses/kimaki#main`). it does not work because the package needs a build step. always point users to the next npm release instead.

the user-facing bug report workflow (export jsonl, share evidence in a gist, issue vs PR) lives in `website/src/docs/docs/guides/report-bugs.mdx` and at https://kimaki.dev/docs/guides/report-bugs. keep that page in sync when these debug commands change.

## git submodules

submodules: `errore`, `gateway-proxy`, `traforo`, `opencode-injection-guard`. their configured branches are in `.gitmodules`.

**never rewrite or force-push a submodule branch in a way that drops commits kimaki still points at.** if the superproject gitlink references a SHA the remote no longer advertises, fresh clones and CI fail with `not our ref` / `did not contain <sha>` before any tests run.

workflow when changing a submodule:

1. commit and **push** the submodule branch first so GitHub has the objects
2. only then bump the gitlink in kimaki (`git add gateway-proxy` etc.) and commit that pointer update
3. before changing a gitlink, prove the remote has the target SHA, e.g. `gh api repos/remorses/gateway-proxy/commits/<sha> --jq .sha` (must not 422)

when pulling submodules and they jump to a new commit, commit that pointer update right away before other work. otherwise critique diffs later include the noisy submodule jump along with the real changes.

if a submodule tip was lost on the remote but still exists in a local checkout, restore it by fast-forwarding (or cherry-picking) the branch back onto the missing tip and pushing. do not "fix" kimaki by pointing at an older reachable commit unless those tip commits are intentionally abandoned.

## errore

errore is a submodule for using errors as values in ts. it should always be on main, never in detached state. this whole codebase uses errore.org conventions. ALWAYS read the errore skill before editing any code.

## goke cli

this project uses goke (not cac) for CLI parsing. goke auto-infers option types from `.option()` calls. never add manual type annotations to `.action()` callback options. just use `.action(async (options) => { ... })`.

## logging

always use logger instead of console so cli logs look uniform, with short log prefixes. logs go to `<dataDir>/kimaki.log` (default `~/.kimaki/kimaki.log`), reset on every bot startup. event jsonl env vars, jq recipes, and profiling: `docs/debugging-kimaki.md`.

## product analytics (Strada)

anonymous install-level product events go to Strada via `cli/src/analytics.ts` (`bot_started`, `project_registered`, `session_created`, `turn_started`, `turn_completed`, `tokens_used`). no Discord IDs, paths, prompts, or secrets. metrics are **active installs**, not people. `tokens_used` fires on `session.idle` (each turn end, including abort and subagents) with billed token breakdowns so total Kimaki token usage can be summed.

- prod project slug: `kimaki`
- local/dev bot (this repo `cli/.env`): `kimaki-local`
- disable: `kimaki --no-analytics` or `KIMAKI_STRADA_ENABLED=0`
- query with `strada` CLI; login as the org owner (t.de Google account)

full event schema, DAU/WAU/MAU, funnels, retention, completion rate, and copy-paste SQL: `docs/strada-product-analytics.md`.

## opencode plugin and env vars

the opencode plugin (`cli/src/kimaki-opencode-plugin.ts`) runs inside the **opencode server process**, not the kimaki bot process. `config.ts` state (like `getDataDir()`) is not available there.

**CRITICAL: never export utility functions from `kimaki-opencode-plugin.ts`.** opencode's plugin loader calls every exported function in the module as a plugin initializer. an exported helper like `condenseMemoryMd(content: string)` gets called with a PluginInput object instead of a string and crashes. only export plugin entrypoints; move utilities to separate files (e.g. `condense-memory.ts`) and import them. structure plugins as many separate small plugins; every export is a different plugin.

to pass bot-process state to the plugin, set `KIMAKI_*` env vars in `opencode.ts` when spawning the server and read `process.env.KIMAKI_*` in the plugin. never import config.ts getters in the plugin. current env vars:

- `KIMAKI_DATA_DIR`: data directory path
- `KIMAKI_LOCK_PORT`: lock server port for bot communication

the plugin does NOT receive `KIMAKI_BOT_TOKEN`. discord REST operations (user listing, thread archiving) are handled by CLI commands (`kimaki user list`, `kimaki session archive`) that resolve credentials from the database via `resolveBotCredentials()`. this avoids leaking gateway credentials into child process environments.

**NEVER use `console.*` in plugin code.** opencode captures plugin stdout/stderr and it breaks structured server logging. plugins must be silent: fail gracefully and return null/undefined on errors.

plugin files must also not import `cli/src/logger.ts`. it pulls in `@clack/prompts` / `picocolors`, which can fail under the plugin loader's ESM/CJS interop. use a separate plugin-safe logger that only appends to the kimaki log file.

agent sessions call `kimaki` through the `~/.kimaki/bin/kimaki` shim that is prepended to the opencode server `PATH` (details in `docs/debugging-kimaki.md`).

## skills folder

skills live at the repository root in `skills/`. build and publish scripts copy them into `cli/skills/` so the npm package ships the bundled skills. some skills are synced from github repos (see `cli/scripts/sync-skills.ts`). never manually update synced copies; start kimaki threads on their source projects instead (find them via `kimaki project list`).

# discord

## discord bot messages

try to not use emojis in messages.

when creating system messages like replies to commands never add blank lines between paragraphs or lines. put one line right after the one before.

## discord typing indicator

typing comes from `POST /channels/{id}/typing` / `sendTyping()`. one pulse only lasts about 10 seconds in the Discord UI and stops at the next bot message, so long-running work refreshes it every ~7 seconds and stops before the final bot message.

- runs that emit multiple bot messages may need an immediate fresh pulse after each non-final message while the session is still busy.
- user messages do not make the bot typing again. only start typing when OpenCode events show the session is processing (for example `session.status: busy` or `step-start`).
- do not remove the typing interval to fix stuck typing. fix lifecycle bugs by clearing both the active interval and any scheduled restart timeout when a session ends, aborts, or pauses for permission/question prompts.
- guard delayed typing restarts (for example after `step-finish`) with session closed/aborted checks so they cannot restart typing after cleanup.

## discord rate limits

docs: https://docs.discord.com/developers/topics/rate-limits. Discord says never hardcode limits; discord.js reads the `X-RateLimit-*` headers and queues requests on 429. still design streaming UIs around these observed numbers so the queue does not lag behind:

| scope | limit (observed) | notes |
| --- | --- | --- |
| global | 50 requests/s per bot | interaction endpoints do not count |
| send message (`POST /channels/{id}/messages`) | ~5 per 5s per channel | bucket keyed by channel id |
| edit message (`PATCH /channels/{id}/messages/{id}`) | ~5 per 5s per channel | shares the channel budget with sends in practice |
| thread rename (`PATCH /channels/{id}` name) | 2 per 10 min per thread | see MEMORY.md |
| invalid requests (401/403/429) | 10,000 per 10 min per IP | exceeding it causes a temporary Cloudflare ban |
| interaction token | valid 15 min | `editReply`/`followUp` fail after that |

- for live output (for example `!` shell commands in `cli/src/commands/run-command.ts`), edit one message in place and throttle edits to at most ~1 per second. start a new message only when content passes 2000 chars.
- throttle, do not debounce: a debounce that resets on every chunk never fires while output is continuous.
- serialize edits of the same message and keep at most one pending sync that reads the latest state when it starts.

## discord object shapes

never use typescript assertions/casts on discord interaction objects to force a cached shape (for example `as GuildMember`). many discord values arrive as either hydrated cached classes or raw api payloads depending on cache/event path.

for member/role/permission checks, handle both shapes with a union type and runtime narrowing (`instanceof GuildMember`, guarded `Array.isArray(member.roles)`, etc). if required context is missing for permission checks, fail closed. this avoids errors like `member.roles.cache` being undefined for uncached interaction payloads.

## resolving project directories in commands

use `resolveWorkingDirectory({ channel })` from `discord-utils.ts` to get directory paths in slash commands. it returns:

- `projectDirectory`: base project dir, used for `initializeOpencodeForDirectory` (server is keyed by this)
- `workingDirectory`: worktree dir if thread has an active worktree, otherwise same as `projectDirectory`. use this for `cwd` in shell commands and for SDK `directory` params
- `channelAppId`: optional app ID from channel metadata

never call `getKimakiMetadata` + manual `getThreadWorktree` check in commands. the util handles both. if you need to encode a directory in a discord customId for later use with `initializeOpencodeForDirectory`, always use `projectDirectory` not `workingDirectory`.

## discord component custom ids

buttons, select menus, and modals enforce a strict `custom_id` max length of **100 chars**. never embed long strings (absolute paths, base64 of paths, serialized json, session transcripts) or the builder throws errors like `Invalid string length`. instead:

- store only short identifiers in `custom_id` (eg `contextHash`, a db id, or a session id)
- resolve anything else at interaction time (eg call `resolveWorkingDirectory({ channel })` from the thread)
- if you need extra context, store it server-side keyed by the short hash/id

## discord message nonces

Discord message `nonce` values have a strict maximum length of **25 characters**. never send a UUID directly as a nonce; Discord rejects it with `nonce[NONCE_TYPE_TOO_LONG]`.

for durable delivery, keep the full delivery id in storage or message metadata and derive a stable nonce of at most 25 characters. add a regression test that asserts the nonce length before changing any message retry or deduplication flow.

## discord components v2 limits

when editing Components V2 (`IS_COMPONENTS_V2`) messages, always check the official docs first:

- overview: https://discord.com/developers/docs/components/overview
- reference: https://discord.com/developers/docs/components/reference

limits and rules:

- components v2 messages cannot use normal `content` or `embeds`; send everything through `components`
- messages allow up to **40 total components**, and nested children count toward that budget
- `Section` is only for **1 to 3** text/content children plus at most one accessory (`button` or `thumbnail`)
- do **not** use `Section` for wide table rows with many columns; this causes `BASE_TYPE_BAD_LENGTH` validation errors
- `Button` can live inside an `Action Row` or in `Section.accessory`
- `Action Row` can contain up to **5 buttons** or a single select menu
- `Container` can hold `Action Row`, `Text Display`, `Section`, `Media Gallery`, `Separator`, and `File`

for kimaki table rendering: plain rows stay a single `TextDisplay`; rows with actions usually render as `TextDisplay` + `ActionRow` inside the `Container` instead of a `Section` for the whole row.

## how kimaki messages look like in Discord

use this to write tests that find messages matching specific patterns.

- Kimaki creates a thread on the first user message and replies in it. new sessions start with a silent banner like `-# *using anthropic/claude-sonnet-4 ⋅ plan*`.
- text parts have no prefix and use classic Discord content so they stay full width. short text in a turn (at most two lines, no callout) is quoted as soon as it completes. when the turn ends, the last text part is edited back to full width. longer text, callouts, and text flushed because of a question, sleep, or action-button tool stay full width.
- tool parts use classic Discord content too, prefixed with ┣ (or ◼︎ for file edits or writes). when the displayed part kind changes between text and tool, the next part starts with a blank line; consecutive same-kind parts have no extra blank line.
- the verbosity setting decides which tool parts show. the default skips `thinking` (┣), file reads, and bash parts without `sideEffect` (a param passed by the model).
- all non-text parts (tools, thinking, task titles) are wrapped in the `-# ` subtext prefix, e.g. `-# ┣ bash _ls_`. `formatPart()` in `cli/src/message-formatting.ts` does this via `asSubtext()`. bot status lines (banner, footer, context usage, queue notices) use plain `asSubtext()` with no glyph. only tool-related status lines (like `bash returned N tokens`) keep the `⬦ ` glyph so they line up with ┣.
- context usage is shown at 10% windows, prefixed with `-# `.
- on normal assistant completion a footer shows folder, branch, time, context used, model id: `-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6*`. never show it on interruptions or aborts.
- voice messages are transcribed with another model and sent with prefix `Transcribed message:`, shown by the bot.
- /queue queues a user message for the end of the current run. each queue confirmation has a Remove button. when it is sent, the bot shows `» Tommy: content`.

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

## live cpu profiling

to capture a CPU profile from a **running** kimaki bot without restarting, type this in the same terminal and press Enter:

```
cpuprof
```

type `cpuprof` again to stop, or wait **20 seconds** for auto-stop. the profile is written to `<dataDir>/cpu-profiles/cpu-<date>.cpuprofile` (default `~/.kimaki/cpu-profiles/`).

open the file in Chrome DevTools (Performance tab > Load) or:

```bash
bunx profano ~/.kimaki/cpu-profiles/cpu-*.cpuprofile
```

this uses `node:inspector` `Profiler.start` / `Profiler.stop` inside the bot process. it does not use SIGUSR1 (that remains heap snapshots). stdin must be a TTY; piped stdin is ignored.

the implementation is in `cli/src/cpu-profiler.ts`.

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

runtime note: `ThreadSessionRuntime` keeps the last 1000 opencode events in memory per thread (`eventBuffer`) for event-sourcing derivation and waiters. long string values are truncated before storage to avoid memory spikes, but the native OpenCode event shape is preserved.

each jsonl line is one raw OpenCode event. do not wrap events with Kimaki metadata.

use `jq` to inspect these files quickly:

```bash
# list event type counts for one session file
jq -r '.type' ~/.kimaki/opencode-session-events/ses_xxx.jsonl | sort | uniq -c

# show execution lifecycle events
jq -r 'select(.type | startswith("session.execution.")) | [.created, .type, .data.sessionID, .data.executionID] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# filter by a specific event type
jq -r 'select(.type=="session.tool.called")' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# show timestamps + event types
jq -r '[.created, .type] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl
```

for checkout validation requests, prefer non-recursive checks unless the user asks otherwise.

## product analytics (Strada)

anonymous install-level product events go to Strada via `cli/src/analytics.ts` (`bot_started`, `project_registered`, `session_created`, `turn_started`, `turn_completed`, `tokens_used`). no Discord IDs, paths, prompts, or secrets. metrics are **active installs**, not people. `tokens_used` fires on `session.idle` (each turn end, including abort and subagents) with billed token breakdowns so total Kimaki token usage can be summed.

- prod project slug: `kimaki`
- local/dev bot (this repo `cli/.env`): `kimaki-local`
- disable: `kimaki --no-analytics` or `KIMAKI_STRADA_ENABLED=0`
- query with `strada` CLI; login as the org owner (t.de Google account)

full event schema, DAU/WAU/MAU, funnels, retention, completion rate, and copy-paste SQL: see `docs/strada-product-analytics.md`.

## kimaki command shim (`~/.kimaki/bin/kimaki`)

`ensureKimakiCommandShim()` in `cli/src/opencode-command.ts` generates a shell script at `~/.kimaki/bin/kimaki` (or `kimaki.cmd` on Windows) every time the bot starts. it captures `process.execPath`, `process.execArgv`, and `process.argv[1]` into an `exec` one-liner so the shim always mirrors the current process.

the shim directory is prepended to `PATH` in the env passed to the opencode server process (`cli/src/opencode.ts`). this lets AI agent sessions run `kimaki send`, `kimaki upload-to-discord`, `kimaki tunnel`, etc. as regular shell commands via the bash tool, regardless of how kimaki was installed (npx, global install, local dev).

in local dev the shim contains tsx loader flags (`--require` / `--import`) because the bot was launched with tsx against the raw `.ts` entry point. in production (npm package) there are no tsx flags and the entry script is the compiled `bin.js`. the shim just reflects however the current process was started; there is no special-casing.

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

skills lives at the repository root in `skills/`. build and publish scripts copy it into `cli/skills/` so the npm package still ships the bundled skills. some skills are synced from github repos. see cli/scripts/sync-skills.ts. so never manually update synced copies. instead if need to update them start kimaki threads on those project, found via kimaki cli.

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
- e2e tests use `opencode-deterministic-provider` which returns canned responses instantly (no real LLM). write poll timeouts as **4s** and polling interval **100ms**. the only real latency is opencode server startup (`beforeAll`, 60s is fine) and intentional `partDelaysMs` in matchers.
- the wait helpers in `test-utils.ts` clamp every timeout into **8s..10s** under vitest. the first turn against a fresh opencode server costs 2-4s (session create, config and agent discovery, provider load, kimaki plugin load), so a literal 4s budget made the first assertion of a file fail randomly. a wait only burns its full budget when the test is already failing, so the floor costs nothing on green runs. tests asserting something never appears must use their own polling loop instead of these helpers.
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

our event handler should closely follow what the opencode tui does (source: `opensrc anomalyco/opencode`; see `packages/app/src/components/prompt-input/submit.ts` for where the tui calls promptAsync).

opencode uses the event subscription (`event.subscribe`) as the single source of truth for everything displayed. do the same: do not set state in discord message handlers. trigger opencode sdk calls, then react to the event stream.

## event sourcing first

prefer event sourcing over mirrored mutable run state. always read the `event-sourcing-state` skill before updating `cli/src/session-handler/thread-session-runtime.ts`.

- one source of truth: the event stream. no duplicated "phase" or "current run" state that can desync.
- easier debugging: read the jsonl stream and replay decisions from history.
- easier testing: derivation logic is pure and deterministic with fixture inputs.
- fewer race bugs: state is derived from observed events, not guessed from local transitions.

when the user mentions a specific kimaki session while reporting a bug, always export its jsonl first with `kimaki session export-events-jsonl --session <id> --out ./tmp/<id>.jsonl` and inspect that stream before guessing about runtime state.

write derivation as pure functions that accept events and return computed state. prefer existing helpers from `event-stream-state.ts` (for example `wasRecentlyAborted`) over new mirrored flags:

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
  const isBusy = isSessionBusy({ events, sessionId, upToIndex: idleEventIndex })
  const wasAbort = wasRecentlyAborted({ events, sessionId, idleEventIndex })
  return { isBusy, wasAbort, shouldShowFooter: !isBusy && !wasAbort }
}
```

this is isolated, side-effect free, deterministic, and easy to test with fixture jsonl streams and inline snapshots.

## state minimization and centralization

if mutable state is really needed, centralize it.

- use `cli/src/store.ts` for global shared state so every read/write path is visible.
- keep global state at a minimum. every new field multiplies the number of possible app states and increases bug surface.
- prefer deriving values from events/existing state instead of storing mirrored flags.
- if state is local-only, keep it local and encapsulated (for example a local `let count = 0` in one function/loop). do not promote temporary local state to the global store.

## aborting and resuming opencode session

user messages are queued in opencode via `session.promptAsync`; opencode runs them on the next step (when the current part, like a tool call, finishes). the /queue command instead waits for the run to finish; that state lives in our own store, not opencode.

to interrupt and restart a session (for example the /model command):

1. call `session.abort` to abort the current run.
2. call `session.promptAsync({ parts: [] })` to resume the session.

# testing

## discord-digital-twin e2e style

prefer adding reusable automation methods to `DigitalDiscord` over per-test helper functions in kimaki. always import from `discord-digital-twin/src` so that package does not need to be compiled first.

aim for a playwright-like style:

- actor methods for actions: `discord.user(userId).sendMessage(...)`, `runSlashCommand(...)`, `clickButton(...)`, etc
- separate wait methods for assertions: `discord.waitForThread(...)`, `discord.waitForBotReply(...)`, `discord.waitForInteractionAck(...)`

if a kimaki test needs a new interaction primitive, first add it to `discord-digital-twin/src/index.ts` and cover it in `discord-digital-twin/tests/*`.

always add `expect(await th.text()).toMatchInlineSnapshot()` (or `discord.channel(id).text()` / `discord.thread(id).text()`) in every test that creates or modifies messages. place it **before** other expects so it updates even when a test fails. use deterministic message content (no `Date.now()` or random values) so snapshots stay stable. tests that don't create messages (metadata, typing, guild routes) can skip it.

## e2e testing learnings

these points are current. `docs/e2e-testing-learnings.md` has older background (it predates the deterministic provider; prefer these rules where they differ).

- **always assert on Discord messages (what the user sees), not internal state or logs.** use `th.getMessages()`, `waitForBotReply`, `waitForBotReplyAfterUserMessage`, `waitForBotMessageContaining`. never use `getLogEntriesSince` + string matching for expectations; logs are brittle and bleed across sequential tests. use `getLogEntriesSince` only in `onTestFailed` for diagnostics.
- e2e tests use `opencode-deterministic-provider`, which returns canned responses instantly (no real LLM). write poll timeouts as **4s** and polling interval **100ms**. the only real latency is opencode server startup (`beforeAll`, 60s is fine) and intentional `partDelaysMs` in matchers.
- the wait helpers in `test-utils.ts` clamp every timeout into **8s..10s** under vitest. the first turn against a fresh opencode server costs 2-4s (session create, config and agent discovery, provider load, kimaki plugin load), so a literal 4s budget failed randomly. the floor costs nothing on green runs. tests asserting something never appears must use their own polling loop instead of these helpers.
- to assert something doesn't appear (e.g. no footer after abort), poll `th.getMessages()`: sleep 20ms, max 10 iterations (200ms total is enough, everything is deterministic). fail immediately if the unwanted message appears.
- matchers that emit `tool-call` parts run **real tools** (for example `bash` + `sleep`). do not use long sleeps (`sleep 500` means 500 seconds). prefer `partDelaysMs` for timing windows.
- avoid broad matchers like only `lastMessageRole: 'tool'` in shared matcher lists. always scope with an explicit marker or they cascade across unrelated turns.
- prefer `latestUserTextIncludes` over `rawPromptIncludes` for markers that should trigger once. `rawPromptIncludes` scans full history, so after abort+retry in the same session the old marker re-fires and causes deadlocks or timeouts.
- prefer content-aware polling ("does this user message have a bot reply after it?") over `waitForBotMessageCount`. error messages from interrupted runs satisfy counts early.
- bot replies can be error messages, not just LLM content. verify ordering by position, not content matching.
- test logs are suppressed by default (`KIMAKI_VITEST=1` in vitest.config.ts). rerun one test with `KIMAKI_TEST_LOGS=1` to see kimaki logger output, e.g. `KIMAKI_TEST_LOGS=1 pnpm run test --run src/thread-message-queue.e2e.test.ts`.
- if an e2e test file takes more than **~10 seconds**, split it so vitest parallelizes across files.
- `afterAll` should clean up opencode sessions via `session.list()` + `session.delete()`.

## ai sdk provider stream protocol (v2)

when editing deterministic provider matchers or debugging stream behavior, confirm the protocol from both docs and installed types:

- docs: `content/docs/07-reference/01-ai-sdk-core/02-stream-text.mdx`
- installed types: `node_modules/.pnpm/@ai-sdk+provider@*/node_modules/@ai-sdk/provider/src/language-model/v2/language-model-v2-stream-part.ts`
- built types: `node_modules/.pnpm/@ai-sdk+provider@*/node_modules/@ai-sdk/provider/dist/index.d.ts`

realistic assistant output shapes:

- text message: `stream-start` → `text-start` → one or more `text-delta` → `text-end` → `finish`
- tool-invoking message: `stream-start` → `tool-call` → `finish` (`finishReason: "tool-calls"`)

represent opencode tool usage in matchers as `tool-call` parts with `toolName` and JSON `input` (for example `read`, `edit`, `write`, `bash`, `task`). do not fake them as plain text when the test is about tool execution or routing.
