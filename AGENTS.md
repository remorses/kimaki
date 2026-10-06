the important package in this repo is `kimaki/`: the Kimaki Discord bot and `kimaki` CLI (npm package `kimaki`), built on OpenCode V2. it replaced the V1 `cli/` package; `kimaki/CHANGELOG.md` keeps the V1 release history.

after every change run `pnpm build` (tsc) inside `kimaki` to validate it. try to never use `as any`.

always load the `changesets` skill before fixing bugs or adding features. User-facing fixes and features usually need a `.changeset/*.md` entry, and the skill explains package selection, issue references, descriptive filenames, and `.changeset/readme.md` expectations.

never use `spawnSync` or `execSync`. use async `execFile` (`promisify(execFile)`) or `spawn` from `node:child_process`, with a timeout.

after changes to message handling, queueing or the reducer run the full test suite inside `kimaki`: `pnpm run test --run -u`, then inspect snapshot updates in git diff. for one file, use `pnpm run test --run src/example.test.ts`. always include `run` after `pnpm`; `pnpm test --run` makes pnpm consume the flag, and `pnpm run test -- --run` passes a literal `--` that can make vitest ignore the filter.

each kimaki e2e test file starts its own OpenCode server (~400 MB). `kimaki/vitest.config.ts` caps parallel files at a third of the CPUs; override with `KIMAKI_TEST_WORKERS`. other agents may run suites at the same time, so run single files while iterating and the full suite once at the end. timeouts in a full run on a loaded machine may be load-related: rerun the failing file alone before debugging.

kimaki CLI startup must stay light (~0.06s, ~70 MB): agents and tests call `kimaki` many times. `kimaki/src/cli/*.ts` must not import SQLite (`db.ts`, `schema.ts`, `credentials.ts`, `project.ts`, `voice.ts`) or `discord.js` at top level; `await import()` them inside the actions that need them. use `discord-api-types/v10` for enums like `ChannelType`.

for checkout validation requests, prefer non-recursive checks unless the user asks otherwise.

## task-specific docs

read the matching doc **before** starting these tasks. they hold the full procedures and are not repeated here.

| task                                                                               | read first                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------- |
| any larger kimaki feature: why it works the way it does, what was dropped from V1     | `docs/kimaki-v2-rebuild-spec.md`          |
| gateway-proxy, website onboarding, `gateway_clients`, `--gateway`, bot credentials  | `docs/gateway-architecture.md`            |
| publish, release notes, #changelog post, website deploy, kimaki-demo deploy         | `docs/release-process.md`                 |
| editing `discord-slack-bridge/` (Slack API links, ID encoding, KV auth cache)       | `discord-slack-bridge/AGENTS.md`          |
| Strada events, DAU/WAU/MAU, funnels, retention SQL                                  | `docs/strada-product-analytics.md`        |
| event sourcing patterns and examples                                                | `docs/event-sourcing-for-application-state.md` |
| reducer fixtures (recorded OpenCode V2 event streams)                               | `docs/opencode-v2-events/`                |

# repo architecture

```
kimaki/ (bot + CLI, local SQLite) ──REST+WS (clientId:secret)──▶ gateway-proxy/ (Rust, fly.io) ──▶ Discord
   │    │                                                             ▲ polls every 1s
   │    └─ polls /api/onboarding/status ──▶ website/ (CF Worker) ──▶ shared Postgres (db/)
   │
   └── one /api/event stream + HTTP client ──▶ user's shared OpenCode V2 service (not a bot-owned server)
```

kimaki bot, in order of the data flow:

```
Discord message ──▶ ingress.ts ──▶ prompt.ts / sessions.ts ──▶ OpenCode (session.prompt, create, interrupt)
OpenCode events ──▶ opencode-server.ts ──▶ event-loop.ts ──▶ thread-reducer.ts (pure) ──▶ effects.ts ──▶ Discord
```

- `main.ts`: wiring. lock port, then SQLite migration, then OpenCode and Discord login in parallel.
- `bot.ts`: the `Bot` context passed to every module. `store.ts`: the one zustand store.
- `ingress.ts`: Discord messages, attachments, voice. `slash-commands.ts` + `commands/*`: slash commands and components.
- `opencode-server.ts`: finds the OpenCode service, owns the event subscription, installs the plugin shim.
- `event-loop.ts`: routes events to threads, hydrates after a (re)connect. `thread-reducer.ts`: pure fold of events into a thread view plus effects.
- `effects.ts`: the only Discord writer for session output. `format-parts.ts`, `markdown/`: formatting.
- `lock-server.ts`, `lock-routes.ts`: single-instance lock and the local HTTP API used by CLI subcommands.
- `cli.ts`, `cli/*.ts`: goke CLI. `plugin/`: code that runs inside the OpenCode process.
- `gateway-proxy/`: multi-tenant Discord Gateway + REST proxy. one shared bot for all users.
- `website/`: https://kimaki.dev, OAuth callback and onboarding status routes.
- `db/`: shared Postgres schema (`db/schema.prisma`) for website and gateway. kimaki does not use it.

full gateway diagram, auth flow and onboarding flow: `docs/gateway-architecture.md`.

## gateway REST safety

gateway REST rule for kimaki code: when running with `client_id:secret`
through gateway-proxy, Discord REST calls must be guild-scoped or explicitly
allowlisted by the proxy (`/gateway/bot`, `/users/@me`, etc). avoid global
application routes like `/applications/{app_id}/commands`; use
`/applications/{app_id}/guilds/{guild_id}/commands` instead so auth can resolve
scope and allow the request. kimaki registers slash commands per guild (`registerGuild` in `slash-commands.ts`).

multi-tenant REST safety invariant:

- never allow client-authenticated requests to hit unscoped bot-token routes.
- only tokenized interaction/webhook routes are allowed without auth
  (`/interactions/{id}/{token}/...`, `/webhooks/{id}/{token}/...`).
- never treat `/webhooks/{id}` as allowlisted.
- for `AllowedWithoutAuth` routes, do not inject bot `Authorization` upstream.
- fail closed (`403`/`401`) when route scope cannot be proven as guild-scoped or
  token-scoped.

## opencode SDK

kimaki runs on native OpenCode V2. import the client from `@opencode/client` and plugin types from `@opencode/plugin`. never import `@opencode-ai/sdk` (v1, including its `/v2` export). calls use flat inputs and return endpoint results or reject; there is no V1 `.data` / `.error` wrapper. paginated results contain `data` and `cursor`.

- `session.create({ location: { directory }, permissions })`
- `session.prompt({ sessionID, text, files, delivery })` returns the inbox item, not the reply
- `session.interrupt({ sessionID })` instead of `session.abort`
- `message.list({ sessionID, order, cursor, limit })` and `session.list(...)` are paginated

in the bot, call OpenCode through `oc(bot, 'operation.name', (client) => ...)`, which turns rejections into `OpenCodeError` values.

Kimaki uses the user's shared OpenCode service, not a bot-owned server. `opencode-server.ts` discovers it or starts it through `Service.ensure()` when none is running (`findOpencodeBinary`: `OPENCODE_PATH` if set, else `opencode2`, `opencode`, `~/.opencode/bin/opencode`; minimum version `MIN_OPENCODE_VERSION`). OpenCode is not bundled. before Discord onboarding `ensureOpencode()` in `onboarding.ts` checks it: an OpenCode 1 or an old V2 is an error with install instructions and is never replaced; no OpenCode at all is installed with `curl -fsSL https://opencode.ai/v2/install | bash` (asks first in a terminal). it never pins a version, because that would replace the running server and kill the user's TUI sessions.

if I ask you questions about opencode you can opensrc it from anomalyco/opencode (not opencode-ai/opencode, which is an unrelated repo).

## prompt cache and system prompt changes

OpenCode V2 keeps the system prompt stable until compaction starts a new instruction epoch, so the provider prompt cache keeps hitting:

```
session start ──▶ instructions (AGENTS.md, skills, entries, env) frozen as the system prompt baseline
later change  ──▶ session.instructions.updated ──▶ appended to history as a system message (delta only)
```

source: `packages/core/src/session/instruction-state.ts` and `message-updater.ts` in opencode v2. so put session-level text in **instruction entries**, never in the plugin `context` hook. Kimaki's system prompt (`system-prompt.ts`) is one instruction entry, written with `session.instructions.entry.put` in `sessions.ts`. `event.system.push(...)` in `session.hook('context')` runs on every request and sits before all messages: any change to that text (for example the git branch line) invalidates the whole cached prompt. only push text there that stays the same during a session.

kimaki posts `-# ⬦ prompt cache miss: ...` in the thread when the cached prefix of a root step shrinks (`thread-reducer.ts`, `session.step.ended`). causes: changed prefix, model switch, or provider cache TTL expiry (about 5 minutes idle on Anthropic).

# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it. run `kimaki restart`: the root `kimaki` process supervises the bot as a child and spawns it again with the code on disk. sessions keep running in OpenCode. `kimaki profile cpu` and `kimaki profile heap` write profiles to `<dataDir>/profiles/`.

## running parallel kimaki processes

the bot holds a single-instance lock on `KIMAKI_LOCK_PORT` (default 29988). a second bot on the same port **stops the running one** (V1 or V2: SIGTERM to its wrapper from `/health`, SIGKILL after 20s) and takes the port, before migration and onboarding (`evictRunningBot` in `lock-server.ts`). to run another bot next to the main one (for example a test install), use a free port and a separate data dir:

```bash
KIMAKI_LOCK_PORT=31001 kimaki --data-dir ~/.kimaki-test
```

CLI subcommands talk to the bot through this port, so they need the same `KIMAKI_LOCK_PORT` as the bot they target. inside agent shells the plugin sets it.

## sqlite

sqlite preserves state between runs. the database must never have breaking changes: new kimaki versions must keep working with sqlite databases created by older versions. if a change would break this, ask the user whether it is ok to add a startup migration.

- file: `<dataDir>/kimaki.db` (libSQL + Drizzle, `db.ts`). only the bot start migrates (`openDb({ migrate: true })`); subcommands never do.
- schema: `kimaki/src/schema.ts`. `pnpm generate` inside kimaki writes `src/schema-sql.ts` (idempotent `CREATE ... IF NOT EXISTS`). never edit it by hand.
- all migrations live in `kimaki/src/migrations.ts`. on first start it imports the V1 `discord-sessions.db` read-only into `kimaki.db`; the V1 file is never changed. `PRAGMA user_version` (`DB_VERSION`) marks a kimaki-made `kimaki.db`; an unmarked one next to a V1 file is renamed aside so it cannot block the import.

**new tables**: add to `schema.ts`, run `pnpm generate`. schema-sql handles new and existing installs.

**new columns on existing tables**: `IF NOT EXISTS` skips the whole CREATE, so also add an `ALTER TABLE ... ADD COLUMN` in `migrateSchema()` in `migrations.ts`, ignoring the "duplicate column" error. if a generated index uses the new column, run the ALTER **before** the schema statements, otherwise existing DBs crash on startup (`SQLITE_ERROR: no such column`). add a `db.test.ts` case that opens an old-shaped database (see `fixtures/v1-schema.sql`).

inline straightforward Drizzle queries (`db.query.*.findFirst`, `db.insert`, `db.update`) at the call site. no repository layer of query wrappers.

## publishing

before any publish, read `docs/release-process.md`. it covers the #changelog notification via sigillo with the demo bot token, the website production deploy, and kimaki-demo deploys.

## github issues

never suggest installing kimaki from git (e.g. `npm i -g remorses/kimaki#main`). it does not work because the package needs a build step. always point users to the next npm release instead.

the user-facing bug report workflow (export events, share evidence in a gist, issue vs PR) lives in `website/src/docs/docs/guides/report-bugs.mdx` and at https://kimaki.dev/docs/guides/report-bugs. keep that page in sync when the debug commands change.

## git submodules

submodules: `errore`, `gateway-proxy`, `traforo`, `opencode-injection-guard`, `subrouter`. their configured branches are in `.gitmodules`.

**never rewrite or force-push a submodule branch in a way that drops commits kimaki still points at.** if the superproject gitlink references a SHA the remote no longer advertises, fresh clones and CI fail with `not our ref` / `did not contain <sha>` before any tests run.

workflow when changing a submodule:

1. commit and **push** the submodule branch first so GitHub has the objects
2. only then bump the gitlink in kimaki (`git add gateway-proxy` etc.) and commit that pointer update
3. before changing a gitlink, prove the remote has the target SHA, e.g. `gh api repos/remorses/gateway-proxy/commits/<sha> --jq .sha` (must not 422)

when pulling submodules and they jump to a new commit, commit that pointer update right away before other work. otherwise critique diffs later include the noisy submodule jump along with the real changes.

if a submodule tip was lost on the remote but still exists in a local checkout, restore it by fast-forwarding (or cherry-picking) the branch back onto the missing tip and pushing. do not "fix" kimaki by pointing at an older reachable commit unless those tip commits are intentionally abandoned.

## errore

errore is a submodule for using errors as values in ts. it should always be on main, never in detached state. this whole codebase uses errore.org conventions. ALWAYS read the errore skill before editing any code. shared tagged errors live in `kimaki/src/errors.ts`.

## goke cli

this project uses goke (not cac) for CLI parsing. goke auto-infers option types from `.option()` calls. never add manual type annotations to `.action()` callback options. just use `.action(async (options) => { ... })`.

## logging

always use `createLogger('PREFIX')` from `logger.ts` instead of console so logs look uniform, with short prefixes.

**logs go to stderr, never stdout.** stdout is only for command results: CLI subcommand output (`--json`, tables, markdown), onboarding prompts and install URLs, and the programmatic `data: {...}` events. anything else on stdout breaks piped commands and shows up inside the OpenCode TUI. plugin code (`kimaki/src/plugin/`) writes nothing to stdout or stderr.

logs also go to `<dataDir>/kimaki.log` (default `~/.kimaki/kimaki.log`), reset on every bot start. `kimaki logs` prints the path; `kimaki logs --follow` prints the log and follows new lines.

## debugging a session

when the user mentions a specific kimaki session while reporting a bug, read its recorded events first, before guessing about runtime state:

```bash
kimaki session events <sessionId|threadId> > ./tmp/events.jsonl
jq -r .event.type ./tmp/events.jsonl | sort | uniq -c
```

thread events (root, subagents and `kimaki.*` internal events) are recorded in `<dataDir>/session-events/<threadId>.jsonl` (`session-events.ts`). streaming deltas and `session.step.streamed` are skipped, long strings are truncated, and files restart at 20 MiB. the file can be replayed with `test/replay.ts` to reproduce a bug; a recording without `session.created` needs an explicit initial `view`. `kimaki session read <id>` prints the messages as markdown.

## product analytics (Strada)

anonymous install-level product events go to Strada via `kimaki/src/analytics.ts` (`bot_started`, `project_registered`, `session_created`, `turn_started`, `turn_completed`, `tokens_used`). no Discord IDs, paths, prompts, or secrets. metrics are **active installs**, not people. `tokens_used` sums `session.step.ended` and `session.step.failed` usage per execution (root and subagents), then emits on success, failure or interruption. executions not observed from their start are skipped after a bot restart.

- prod project slug: `kimaki`
- disable: `kimaki --no-analytics` or `KIMAKI_STRADA_ENABLED=0`. off under vitest.
- query with `strada` CLI; login as the org owner (t.de Google account)

full event schema, DAU/WAU/MAU, funnels, retention, completion rate, and copy-paste SQL: `docs/strada-product-analytics.md`.

## opencode plugin

`kimaki/src/plugin/` runs inside the **OpenCode server process**, not the bot. on start the bot writes a shim per plugin into `<opencode config dir>/plugins/<name>/index.js` that re-exports the module of the running Kimaki install (`installPluginShim` in `opencode-server.ts`). no opencode.json edit. writing the shim only when its content changes matters: any change in that folder reloads every location and cancels pending forms.

- `plugin/index.ts` (`kimaki`): context lines, extra `description` / `hasSideEffect` tool inputs, shell env, file edit log.
- `plugin/anthropic/index.ts` (`kimaki-anthropic`): Claude Pro/Max OAuth for every session, TUI included.

each plugin is a directory loaded through its `index` module. OpenCode only accepts directories in opencode.json `plugins`, so plain OpenCode users can list `<kimaki>/src/plugin/anthropic` there. OpenCode keeps one plugin per ID and reports a second one as failed (`Duplicate plugin ID`), so `installPluginShim` removes a shim when the global `opencode.json`/`opencode.jsonc` already lists the same plugin directory of any Kimaki install. the `anthropic` directory must import nothing from Kimaki outside itself except npm packages.

each module has one `export default Plugin.define(...)`. keep utilities in separate files and import them.

**the `kimaki` plugin must only act on Kimaki sessions.** OpenCode loads it for every session, including the user's own TUI sessions. every hook must first check the session's `metadata.kimaki` marker (or the parent chain for subagents, see `marker()` in `plugin/index.ts`) and return without changes when it is missing. the bot writes the marker at `session.create` and when it adopts a V1 session. never add a hook that changes prompts, tools, shell commands or files for unmarked sessions.

the plugin gets bot state from the marker, not from env vars: `dataDir` and `lockPort`. its `execute.before` hook prefixes each shell command with `PATH=<dataDir>/bin:$PATH`, `KIMAKI_DATA_DIR`, `KIMAKI_LOCK_PORT` and `KIMAKI_TOOL_CALL`, so agents call the `<dataDir>/bin/kimaki` shim (`installShim` in `lock-server.ts`) and reach the right bot.

the plugin never gets the bot token. `kimaki user list` reads `KIMAKI_BOT_TOKEN` or saved credentials and calls Discord REST directly. `kimaki send` with no local bot (CI) posts a remote-send envelope with that token; the bot that owns the channel runs it (`remote-send.ts`). `kimaki session archive`, `kimaki buttons`, `kimaki upload-request` and `kimaki sleep` call the bot through the lock port.

plugin files must not import `logger.ts`, `db.ts` or anything that pulls in discord.js or SQLite, and must never write to stdout or stderr. fail silently and return.

# discord

## discord bot messages

try to not use emojis in messages.

when creating system messages like replies to commands never add blank lines between paragraphs or lines. put one line right after the one before.

## discord typing indicator

typing comes from `POST /channels/{id}/typing` / `sendTyping()`. one pulse only lasts about 10 seconds in the Discord UI and stops at the next bot message.

- the reducer decides: it emits `{ type: 'typing', on }` when `isTyping(view)` changes. typing is on while the root execution or a child runs, and off while a question or permission waits for the user.
- `effects.ts` runs one 7s interval per thread and clears it on `typing: false`, on stop, and before the footer.
- user messages never start typing. only OpenCode events do.

## discord rate limits

docs: https://docs.discord.com/developers/topics/rate-limits. Discord says never hardcode limits; discord.js reads the `X-RateLimit-*` headers and queues requests on 429. still design streaming UIs around these observed numbers so the queue does not lag behind:

| scope | limit (observed) | notes |
| --- | --- | --- |
| global | 50 requests/s per bot | interaction endpoints do not count |
| send message (`POST /channels/{id}/messages`) | ~5 per 5s per channel | bucket keyed by channel id |
| edit message (`PATCH /channels/{id}/messages/{id}`) | ~5 per 5s per channel | shares the channel budget with sends in practice |
| thread rename (`PATCH /channels/{id}` name) | 2 per 10 min per thread | only `kimaki session title` renames threads |
| invalid requests (401/403/429) | 10,000 per 10 min per IP | exceeding it causes a temporary Cloudflare ban |
| interaction token | valid 15 min | `editReply`/`followUp` fail after that |

- `effects.ts` keeps one FIFO worker per thread so Discord order equals event order. when Discord is slower than the stream, consecutive bot lines are merged into one message instead of queueing many sends.
- if you add live-edited output, throttle edits to at most ~1 per second (throttle, not debounce: a debounce that resets on every chunk never fires while output is continuous), serialize edits of the same message, and start a new message only past 2000 chars.

## discord object shapes

never use typescript assertions/casts on discord interaction objects to force a cached shape (for example `as GuildMember`). many discord values arrive as either hydrated cached classes or raw api payloads depending on cache/event path.

for member/role/permission checks, handle both shapes with runtime narrowing, or fetch the member like `canUseKimaki()` in `ingress.ts` does (`instanceof GuildMember`). if required context is missing for permission checks, fail closed.

## resolving project directories in commands

use `resolveTarget(bot, channelId)` from `interaction-context.ts` in slash commands and components. it returns:

- `projectDirectory`: the project folder of the channel (`channel_directories` row)
- `directory`: the current working directory of the thread's root session (a worktree or `kimaki session cwd` changes it), otherwise the project folder. use this for shell `cwd` and OpenCode `location`
- `thread`, `sessionId`: set when the interaction happens in a session thread

never read the session location or channel row by hand in commands. if you need a directory later from a custom ID, store a short ID and call `resolveTarget` again.

## discord component custom ids

buttons, select menus, and modals enforce a strict `custom_id` max length of **100 chars**. never embed long strings (absolute paths, base64 of paths, serialized json, session transcripts) or the builder throws errors like `Invalid string length`. instead:

- store only short identifiers in `custom_id` (eg a db id, a form id, or a session id)
- resolve anything else at interaction time (eg `resolveTarget()` from the thread)
- if you need extra context, store it server-side keyed by the short id

## discord message nonces

Discord message `nonce` values have a strict maximum length of **25 characters**. never send a UUID directly as a nonce; Discord rejects it with `nonce[NONCE_TYPE_TOO_LONG]`. if you add durable delivery, derive a stable nonce of at most 25 characters and add a test that asserts its length.

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

markdown tables and callouts render as a Components V2 `Container` (`markdown/components.ts`). rows render as `TextDisplay` and `Separator` children.

## how kimaki messages look like in Discord

use this to write tests that find messages matching specific patterns. formatting lives in `format-parts.ts`.

- Kimaki creates a thread on the first user message and replies in it. sessions the bot created start with a banner: `-# *using anthropic/claude-sonnet-4 ⋅ build*` (`formatBanner`).
- assistant text is plain Discord markdown, full width, **never quoted**. reasoning is never shown.
- tool lines are subtext: `-# ┣ shell _ls_`, file edits and writes use `◼︎`: `-# ◼︎ edit *file.ts* (+3-1)` (`formatToolLine`). subagent lines carry the agent: `-# ┣ general ⋅ glob _*.md_`. when the kind changes between text and tool, the next block starts with a blank line.
- verbosity per channel is `tools` (default) or `text` (`isToolVisible`). `tools` hides read-only tools and shells with `hasSideEffect: false`. file edits always show.
- status lines use the `⬦` glyph: `⬦ retrying in 5s (attempt 2): ...`, `⬦ general finished: ...`, `⬦ context compacted`, `⬦ prompt cache miss: ...`. errors start with `✗ `.
- on a successful turn a footer shows folder, branch, duration, context percent, model and agent (agent omitted when `build`): `-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6*`. never after an interrupt or failure, and not while a subagent still runs.
- `!cmd` in a thread runs a user shell: a start line, then one output message from `session.shell.*` events.
- queued messages (`/queue`, or a message sent while busy with queue delivery) get `-# Queued at position N...`. when delivered, the bot posts `» **Tommy:** content` and edits the ack to `Queued message sent`. remove one by deleting the Discord message or with `/clear-queue`.
- voice messages are transcribed (`voice.ts`) and the transcription decides the route (steer, queue, new session, agent).

# session runtime

## event handler architecture

our event handling should closely follow what the opencode tui does (source: `opensrc anomalyco/opencode@v2`).

OpenCode events are the single source of truth for everything displayed. do not set display state in Discord handlers: call OpenCode (`prompt.ts`, `sessions.ts`), then react to the native V2 event stream (`session.execution.*`, `session.step.*`, `session.text.*`, `session.tool.*`, `session.inbox.*`, `form.*`, `permission.*`).

```
event ──▶ event-loop.ts (route by sessionID, hold while hydrating)
      ──▶ reduce({ view, event, prefs }) in thread-reducer.ts ──▶ { view, effects }
      ──▶ effects.ts (send, markdown, typing, footer, show, edit)
```

`reduce()` never touches Discord, OpenCode, SQLite or the clock: timestamps come from event envelopes. after a (re)connect the event loop folds a `kimaki.snapshot` event (active sessions, inbox, forms, permissions) through the same path.

## event sourcing first

prefer event sourcing over mirrored mutable run state. always read the `event-sourcing-state` skill before changing `thread-reducer.ts` or `event-loop.ts`.

- one source of truth: the event stream. no duplicated "phase" or "current run" state that can desync.
- easier debugging: read the recorded jsonl and replay decisions from history.
- easier testing: the reducer is pure and deterministic with fixture inputs.
- fewer race bugs: state is derived from observed events, not guessed from local transitions.

new rendering logic goes into the reducer (or a slice it calls, like `queue.ts`, `questions.ts`, `permissions.ts`) and gets a fixture test:

```ts
test('footer after a text-only turn', () => {
  const events = loadFixture('tools.events.jsonl').filter((event) => !event.type.startsWith('session.tool.'))
  const { view, effects } = replay({ events })
  expect(effectLines(effects)).toMatchInlineSnapshot()
  expect(view.turn).toBe(null)
})
```

## state minimization and centralization

if mutable state is really needed, centralize it.

- `kimaki/src/store.ts` holds the only shared in-memory state: thread bindings, thread views, verbosity. one zustand atom.
- keep global state at a minimum. every new field multiplies the number of possible app states and increases bug surface.
- prefer deriving values from events/existing state instead of storing mirrored flags.
- state private to one module (held events, wizard picks, upload waits) stays in that module's closure. do not promote it to the store.

## sending, queueing and interrupting

- a plain user message cancels pending questions and permissions, interrupts the current run with `resume: false`, then sends `session.prompt({ delivery: 'steer' })` (`steer()` in `prompt.ts`).
- `/queue` sends with `delivery: 'queue'`: OpenCode runs it after the current run. Kimaki keeps no queue of its own; `queue.ts` only renders inbox events.
- native `session.interrupt` does not stop user shells (`!cmd`). `/abort` also clears the queue, cancels pending questions and permissions, and kills running user shells.

# testing

## discord-digital-twin e2e style

prefer adding reusable automation methods to `DigitalDiscord` over per-test helper functions in kimaki. always import from `discord-digital-twin/src` so that package does not need to be compiled first.

aim for a playwright-like style:

- actor methods for actions: `discord.user(userId).sendMessage(...)`, `runSlashCommand(...)`, `clickButton(...)`, etc
- separate wait methods for assertions: `discord.waitForThread(...)`, `discord.waitForBotReply(...)`, `discord.waitForInteractionAck(...)`

if a kimaki test needs a new interaction primitive, first add it to `discord-digital-twin/src/index.ts` and cover it in `discord-digital-twin/tests/*`.

always add `expect(await discord.thread(id).text()).toMatchInlineSnapshot()` (or `discord.channel(id).text()`) in every test that creates or modifies messages. place it **before** other expects so it updates even when a test fails. use deterministic message content (no `Date.now()` or random values) so snapshots stay stable. tests that don't create messages (metadata, typing, guild routes) can skip it.

## e2e harness (`kimaki/src/test/harness.ts`)

- `startOpencodeTestServer()`: each test file gets its own OpenCode service in a temp root with private XDG dirs, started with the same `serve --service` command as production, so the bot connects through service discovery like for a real user.
- `startTwin()`, `seedProjectChannel()`, `startTestBot()`: digital Discord and the bot, in-process.
- `warmUp({ server })` at the end of `beforeAll`: one throwaway turn so the first test does not pay the OpenCode cold start.
- `afterAll`: `bot.stop()`, `twin.stop()`, `server.stop()`, then delete the temp data dir.
- `manualClock()` and `schedulingKit()` for sleeps and scheduled tasks; `startFakeOpenAI()` / `startFakeGemini()` for voice.

## e2e testing learnings

- **always assert on Discord messages (what the user sees), not internal state or logs.** never match log text in expectations.
- e2e tests use `opencode-deterministic-provider` (model `deterministic-v2`), which returns canned responses instantly. build turns with `scriptedTurn`, `textParts`, `toolParts`, `slowTextMatcher` from the harness.
- `waitFor` clamps every timeout into **8s..10s** and polls every 100ms: the first turn on a fresh server costs 2-4s. `waitForFooter`, `waitForBotMessageContaining` and `waitForSelectMenu` build on it. tests asserting something never appears must use their own loop.
- snapshot a finished turn only after `waitForFooter`. never treat a `-# *using ...` banner as a footer (`isFooter` excludes it).
- to assert something doesn't appear (e.g. no footer after abort), poll the thread messages: sleep 20ms, max 10 iterations (200ms total is enough, everything is deterministic). fail immediately if the unwanted message appears.
- matchers that emit `tool-call` parts run **real tools** (for example `shell` + `sleep`). do not use long sleeps. prefer part delays for timing windows.
- scope every matcher with an explicit marker in the latest user text. broad matchers cascade across unrelated turns, and matching the full history re-fires old markers after an abort and retry.
- prefer content-aware polling ("does this user message have a bot reply after it?") over message counts. error messages from interrupted runs satisfy counts early.
- test logs are suppressed by default (`KIMAKI_VITEST=1` in vitest.config.ts). rerun one test with `KIMAKI_TEST_LOGS=1` to see logger output, e.g. `KIMAKI_TEST_LOGS=1 pnpm run test --run src/queue.e2e.test.ts`.
- if an e2e test file takes more than **~10 seconds**, split it so vitest parallelizes across files.

## ai sdk provider stream protocol (v3)

`opencode-deterministic-provider` implements `@ai-sdk/provider` v3. when editing matchers or debugging stream behavior, confirm the stream part shapes from the installed types:

- `node_modules/.pnpm/@ai-sdk+provider@3*/node_modules/@ai-sdk/provider/dist/index.d.ts` (`LanguageModelV3StreamPart`)

realistic assistant output shapes:

- text message: `stream-start` → `text-start` → one or more `text-delta` → `text-end` → `finish`
- tool-invoking message: `stream-start` → `tool-call` → `finish` (`finishReason: { unified: 'tool-calls', raw: 'tool-calls' }`; deterministic matchers also accept `'tool-calls'`)

represent opencode tool usage in matchers as `tool-call` parts with `toolName` and JSON `input` (for example `read`, `edit`, `write`, `shell`, `subagent`). do not fake them as plain text when the test is about tool execution or routing.

# not ported from V1 yet

these V1 features have no kimaki equivalent. do not document them as existing:

- self-upgrade (`kimaki upgrade`, `/upgrade-and-restart`)
- bundled skills (`skills/` copied into the npm package, `sync-skills`)
- image optimizer plugin (shrink images over 2000px / 4 MB before the model sees them)
- kitty graphics plugin (images printed by shell tools sent to Discord)
