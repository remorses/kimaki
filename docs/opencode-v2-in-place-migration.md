---
title: OpenCode 2.0.2 in-place migration
description: >
  The stable OpenCode 2.0.2 architecture used by Kimaki, including native
  inbox, execution, forms, instructions, event folding, reconciliation, and
  the checks required to complete a v1 integration migration.
---

# OpenCode 2.0.2 in-place migration

Kimaki now runs the stable OpenCode **2.0.2** stack in `cli/`. The Discord bot remains the host process, but its session runtime, server manager, and built plugin use the native v2 protocol.

The pinned packages are:

- `@opencode/client@2.0.2`
- `@opencode/plugin@2.0.2`
- `@opencode/cli@2.0.2`

The installed `@opencode/cli` package maps both command aliases, `opencode` and `opencode2`, to the same native file: **`bin/opencode.exe`**. Kimaki resolves and spawns that file directly so process signals reach the server instead of a shell wrapper.

References:

- [OpenCode v2 migration guide](https://opencode.ai/v2/docs/migrate-v1/)
- [OpenCode client guide](https://opencode.ai/v2/docs/build/client)
- [OpenCode permission guide](https://opencode.ai/v2/docs/permissions)
- [OpenCode v2 source](https://github.com/anomalyco/opencode/tree/v2)

## SDK migration from OpenCode 1

Do not confuse OpenCode 1's `@opencode-ai/sdk/v2` export with the OpenCode 2 SDK. That export was a transitional client over a mix of legacy and v2 routes. Changing only the import from `@opencode-ai/sdk` to `@opencode-ai/sdk/v2` does not migrate an integration to OpenCode 2.

OpenCode 2 uses new package names and contracts:

| Role | OpenCode 1 | OpenCode 2 |
|---|---|---|
| Network client | `@opencode-ai/sdk`, including its `/v2` export | `@opencode/client` |
| Embedded host | `@opencode-ai/sdk` | `@opencode/sdk` |
| Plugin API | `@opencode-ai/plugin` | `@opencode/plugin` |
| Native CLI | `opencode-ai` | `@opencode/cli` |

The OpenCode 2 Promise client uses flat generated inputs, returns unwrapped success values, and rejects with declared errors or `ClientError`. Remove v1 `.data`, `.error`, nested `path`/`query`/`body`, and `throwOnError` handling while migrating each call.

```ts
import { OpenCode } from '@opencode/client'

const client = OpenCode.make({ baseUrl, headers })
const session = await client.session.create({
  title: 'Review the current changes',
  location: { directory },
  permissions: [
    { action: 'edit', resource: `${directory}/**`, effect: 'allow' },
  ],
})
```

Session migration is not a one-to-one method rename:

| OpenCode 1 behavior | OpenCode 2 replacement |
|---|---|
| `session.create({ directory, permission })` | `session.create({ location: { directory }, permissions })` |
| `session.promptAsync({ parts })` | `session.prompt({ sessionID, text, files, delivery })` |
| `promptAsync({ noReply: true })` for a user message | `session.prompt({ sessionID, text, resume: false })` |
| Synthetic model context without a reply | `session.synthetic({ sessionID, text, resume: false })` |
| `promptAsync({ system })` | `session.instructions.entry.put({ sessionID, key, value })` |
| `session.abort(...)` | `session.interrupt({ sessionID, continue? })` |
| `session.update({ permission })` | `permission.rules({ sessionID, permissions })` |
| Question request APIs and events | Session forms and `form.*` events |
| `message.part.*` snapshots | `session.text.*`, `session.reasoning.*`, and `session.tool.*` facts |

`session.prompt` returns the accepted inbox item, not the assistant response. Observe `session.execution.*` and content events, or read projected messages, to determine the final result. Event subscriptions are lazy `AsyncIterable` streams and do not reconnect automatically.

The most useful upstream migration records are the [client migration tracker](https://github.com/anomalyco/opencode/issues/34359), the [removed internal API checklist](https://github.com/anomalyco/opencode/blob/5d351406a1ed0ac93975dfcff55b7764f159375a/packages/app/V1_API_MIGRATION.md), and the [Promise-first embedded SDK design](https://github.com/anomalyco/opencode/pull/44746). The internal checklist explicitly calls `@opencode-ai/sdk/v2` a legacy client despite its package export name.

## Architecture

```text
Discord events
      │
      ▼
Kimaki CLI and Discord runtime
      │  @opencode/client
      ▼
one OpenCode server process  ──► many project locations
      │
      ├─ native inbox and execution
      ├─ native forms and permission requests
      ├─ native instruction entries
      ├─ Subrouter provider and route affinity
      └─ built Kimaki plugin directory
             ├─ Discord tools
             ├─ context and memory instructions
             ├─ injection guard
             └─ file-edit tracking
```

`cli/src/opencode.ts` starts one authenticated server and reuses it for all project directories. Clients select a location with `x-opencode-directory`; sessions store their own location after creation.

The generated OpenCode config loads the built `dist/kimaki-opencode-plugin` directory. It also installs Subrouter as the provider. Project `opencode.json` files load after Kimaki's generated defaults, so project permissions and provider settings can override those defaults.

## Protocol model

OpenCode v2 emits **facts**, not mutable v1 part snapshots. Live events contain deltas. Durable terminal events and projected messages contain complete values.

```text
session.prompt
      │
      ├─ session.inbox.enqueued
      ├─ session.execution.started
      ├─ session.inbox.delivered
      │
      ├─ session.text.* / reasoning.* / tool.*
      │
      └─ session.execution.succeeded | failed | interrupted
```

A successful `session.prompt` call means that the inbox accepted the item. The prompt becomes visible session history when `session.inbox.delivered` occurs. One inbox item can produce multiple logical steps while tools and retries run.

### Live and durable content

| Live event | Live value | Durable boundary |
|---|---|---|
| `session.text.delta` | `data.delta` chunk | `session.text.ended` with full `data.text` |
| `session.reasoning.delta` | `data.delta` chunk | `session.reasoning.ended` with full `data.text` |
| `session.tool.input.delta` | raw JSON chunk | `session.tool.input.ended` with full raw input |
| `session.tool.progress` | replacement progress metadata | `session.tool.success` or `session.tool.failed` |
| `session.compaction.delta` | text chunk | `session.compaction.ended` with full text |

Kimaki folds text and reasoning by `sessionID + assistantMessageID + ordinal`. It folds tools by `sessionID + assistantMessageID + tool id`. Concurrent tool and producer fibers can interleave events, so global event order is not a part identity.

On an ended, success, or failed event, Kimaki replaces the live buffer with the complete terminal value. Tool success content is an array of content items, not a single `state.output` string.

### Inbox and execution

Native inbox delivery replaces the old abort-and-replay mechanism:

- `delivery: "steer"` admits work for the next safe step boundary.
- `delivery: "queue"` leaves work queued until the current execution drains.
- `resume: false` admits an item without waking execution.
- `session.inbox.list`, `cancel`, `steer`, and `queue` manage pending work.

`session_inbox` contains pending work only. Delivery removes the inbox row in the same transaction that creates the visible user message. Kimaki tracks `inboxID` from enqueue to delivery so queued Discord messages can show at the correct time.

Execution lifecycle is separate from inbox admission:

- `session.execution.started` starts duration and typing state.
- `session.execution.succeeded` flushes output and can emit the footer.
- `session.execution.failed` emits the execution error.
- `session.execution.interrupted` stops without a completion footer.

`session.status` is useful for live UI state. It is not the completion boundary. `session.idle` is deprecated and can also follow an interruption.

### Forms and permissions

The native question tool creates a form with `metadata.kind = "question"`. Kimaki handles `form.created`, renders Discord controls, and replies through the form API. After an SSE reconnect, it lists forms and restores only pending questions.

Permission requests use `permission.asked` and `permission.replied`. A reply uses the ask event's `data.id` as `requestID`; valid replies are `once`, `always`, and `reject`.

### Instruction entries

Kimaki writes its system prompt through `session.instructions.entry.put` with a stable entry key before the first prompt. This preserves OpenCode's instruction epochs across normal turns, compaction, moves, forks, and reverts.

The built plugin adds per-request context through the native `context` hook. It supplies branch or detached-head state, working-directory changes, onboarding instructions, and a condensed `MEMORY.md` overview without replacing the durable Kimaki instruction entry.

## Plugin integration

OpenCode loads plugin **directories**. Kimaki supplies `dist/kimaki-opencode-plugin`, built from `cli/src/kimaki-opencode-plugin/index.ts` by TypeScript.

The plugin currently implements:

- Subrouter request affinity and routed-model disclosure.
- Prompt-injection scanning for selected tool outputs.
- File-edit tracking after `edit`, `write`, and `apply_patch` tool execution.
- Shell input metadata used by Discord tool rendering.
- Native Kimaki tools for file upload, action buttons, and sleep.
- Branch, directory, onboarding, and memory context.

`setup()` can run once per location in one server process. Process-wide resources use `globalThis` symbols where shared initialization is required. The plugin filters or keys state by session and location instead of treating its event subscription as location-local.

## SSE and reconciliation

Kimaki uses one global SSE connection and broadcasts each event to registered thread runtimes. Each runtime filters by session ID.

SSE deltas are volatile. There is no cursor that can recreate missed token chunks. On reconnect, Kimaki replays each session's durable log, including nested subagents, then lists forms and restores pending question forms. This recovers completed text, tools, execution outcomes, and usage without pretending to replay live token chunks.

The event buffer keeps lifecycle facts and compact representations. It must not fill with unbounded live deltas because terminal execution events control typing, queue draining, analytics, and footers.

## Client calls

```ts
import { OpenCode } from '@opencode/client'

const client = OpenCode.make({
  baseUrl,
  headers: {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  },
})
```

The server uses Basic authentication with user `opencode` and `OPENCODE_PASSWORD`. Kimaki creates a random password when the user did not configure one.

| Operation | Stable v2 call |
|---|---|
| Create a session | `session.create({ location, permissions })` |
| Admit a user prompt | `session.prompt({ sessionID, text, files?, delivery? })` |
| Admit synthetic context | `session.synthetic({ sessionID, text, delivery, resume })` |
| Interrupt execution | `session.interrupt({ sessionID, continue? })` |
| Persist Kimaki instructions | `session.instructions.entry.put({ sessionID, key, value })` |
| Change agent or model | `session.switchAgent(...)` / `session.switchModel(...)` |
| Answer a question | form reply API with `sessionID` and `formID` |

Location belongs in `session.create`. Later session calls use `sessionID`; the server resolves the stored location. Location-scoped non-session routes use the directory header or location query supported by the client.

## Migration invariants

A migration is complete only when these invariants hold. Passing TypeScript while old behavior is disabled or routed through dead compatibility code is not sufficient.

### One submission path

All user, queued, voice, command, and synthetic inputs must share one native submission boundary. Resolve the session, agent, model, variant, instructions, text, files, delivery, and error handling once, then select the native operation:

| Input | Native operation |
|---|---|
| Normal user turn | `session.prompt` with `delivery: "steer"` |
| Explicit queued turn | `session.prompt` with `delivery: "queue"` |
| Context-only message | `session.synthetic` with `resume: false` |
| Command | Native command or inbox API for that command |

Do not maintain separate direct and local-queue prompt builders. Parallel builders drift. Typical failures are queued images disappearing, one path omitting instructions, or one path ignoring model-switch errors.

Agent and model selection is session-wide in OpenCode 2.0.2. A failed `switchAgent` or `switchModel` must stop submission with a visible error. Do not continue with the previous model. Until selection can be bound to an inbox item, serialize selection and admission for each session.

### Native events only

Production runtime types and tests must use `V2Event`. Remove compatibility handlers for these v1-only events after their behavior has native coverage:

- `message.updated`
- `message.part.*`
- `question.*`
- `session.error` as the primary completion channel
- `session.idle` as a successful-turn signal

Do not convert v2 events into fake SDK `Part` objects. A small Discord display model is valid, but its fields must be folded directly from native delta and terminal facts.

Filter an event by the owning session before appending it to a thread runtime's bounded buffer. Broadcasting every process event into every runtime causes `O(active threads)` work and lets unrelated sessions evict lifecycle evidence.

### Parent and subagent routing

Native v2 subagents use different names from v1:

| Meaning | Native v2 field |
|---|---|
| Tool name | `subagent` |
| Selected agent input | `agent` |
| Child session metadata | `sessionID` |
| Parent on session creation | `session.created.data.parentID` |

Use these facts to build parent-child ownership before applying the runtime session filter. Cover child text, tool output, labels, completion, interruption, and token usage in native event tests.

### Durable completion and analytics

Use `session.execution.succeeded` as the successful run boundary. Cleanup and queue draining must run even when Discord output, including the footer, fails to send.

Emit turn and token analytics from native facts:

- `turn_completed` from `session.execution.succeeded`
- failed or interrupted outcomes from their matching execution events
- token deltas from `session.usage.updated` or settled step usage

Do not leave analytics attached to unreachable v1 `session.idle` or `message.updated` handlers.

### Ordered and scoped reads

Verify the default ordering of every list API. OpenCode 2 message lists can be newest-first. Normalize to chronological order before rendering markdown, selecting the latest user turn, or mirroring external sessions.

Every `session.list` call must include the intended directory or project unless the feature explicitly requests all projects. An all-project search must deduplicate session IDs. `/resume` must not attach a session owned by another project.

External synchronization must apply its startup cutoff locally when the native API has no `start` filter. Never mirror historical sessions merely because the server returns them in its first page.

### Reconnect recovery

An SSE reconnect is not recovery by itself. After connection loss:

1. Read projected messages for owned active sessions.
2. Fold completed content into the Discord display projection.
3. List forms and restore pending interactive questions.
4. Recheck inbox and execution state before restarting typing or draining local work.

Do not replay a missed typewriter animation. Restore the final durable value once. Test a disconnect during output, not only a server restart followed by a new prompt.

## Server and authentication migration

The shared server password is part of server discovery. A second Kimaki CLI process that discovers only a port cannot authenticate to a server started with a random password. Publish the authentication material through the protected local discovery channel, or use one durable credential that both processes can resolve.

Readiness probes must require a successful authenticated response. A `401` or `403` means the client is not ready; it must not be accepted because its status is below `500`.

Never write the server password to normal logs, Discord messages, project files, or command output.

## Command migration checks

Commands need behavioral migration, not only renamed client methods.

### Provider login

Preserve the native integration method model:

- `oauth`
- `key`
- `command`
- `env`

Do not coerce command or environment methods into API-key forms. Render each method's declared form fields. Start OAuth with `integration.oauth.connect`, pass the selected `methodID`, retain the returned unique `attemptID`, and use that ID for status or completion. A provider ID is not an OAuth attempt ID.

### Worktrees and workspaces

An OpenCode worktree directory is not a workspace resource ID. `worktree.create` returns a directory. Do not invent a `wrk_<uuid>` value and pass it to workspace APIs.

Store the returned directory with Kimaki's thread mapping. Remove it through `worktree.remove`. Use `workspace.move` or `workspace.destroy` only for a workspace that OpenCode actually created and identified.

### Revert, wait, forms, and sharing

- Stage `/undo` at the selected **user message** boundary used by the native revert API.
- Treat only a successful, natural assistant completion as satisfying `--wait`. Errors and tool-call-only intermediate steps are not completion.
- Cancel only the form selected by the Discord interaction. Keep the interaction context until the API confirms cancellation.
- Do not keep registered commands that always reply “not available.” Port the command, or remove its registration and document the intentional breaking change.
- Voice-created and fresh sessions must apply the requested model and the same durable Kimaki instructions as text-created sessions.

## Plugin parity audit

Before removing the v1 aggregate plugin, inventory every hook and assign one explicit result:

| Previous behavior | Required result |
|---|---|
| Subrouter | Load the native provider/plugin and test activation |
| Injection guard | Port scanning hooks or remove the user option with a clear error |
| File-edit tracking | Record native edit/write/apply-patch success facts |
| Image optimization | Port before file admission or document removal |
| Cache-drift detection | Port to native hooks or document removal |
| Worktree adaptation | Replace with native location/worktree behavior |
| Provider auth rotation | Use native integration support or document removal |
| Kitty image output | Preserve only where the host still supports it |

No feature may remain as a silent no-op. A configuration writer without an active reader is a migration bug.

The production plugin must be a normal TypeScript build input. Load the built plugin directory in packaged output. Do not exclude the main plugin from `tsc`, export a raw `.ts` entry, or depend on the OpenCode runtime to transpile Kimaki source as a fallback.

Validate tool schemas at the model boundary. Kimaki file upload must enforce `maxFiles` as an integer from 1 through 10. Action buttons must enforce 1 through 3 buttons, labels from 1 through 80 characters, and the supported color set.

## Completion test matrix

Use native v2 events and real OpenCode 2 APIs. Do not use mocks or v1 fixtures to prove migrated behavior.

| Area | Required regression coverage |
|---|---|
| Submission | Direct text, queued text, queued image, voice model, context-only synthetic |
| Execution | Success footer, failure, interruption without footer, tool continuation |
| Routing | Two active thread runtimes, native subagent child output, child usage |
| Recovery | SSE loss during output, projected-message recovery, pending-form recovery |
| Ordering | Chronological markdown and external synchronization |
| Scope | Project session list, all-project deduplication, safe `/resume` |
| Login | OAuth attempt ID, key form, command form, environment form |
| Worktrees | Create, move/fork, remove, fresh-clone behavior |
| Permissions | Alias conversion and native session rules |
| Plugins | Subrouter, injection guard, edit tracking, upload, buttons, sleep |
| Commands | Undo, redo, wait success/error/tool-only, form cancellation |

Also validate a fresh clone. Dirty submodule checkouts can hide a recorded gitlink that points backward. The superproject must reference the exact remote commit used by local tests.

## Current limitations

- SSE reconnect restores durable projected output, but it cannot replay the missed typewriter animation.
- `usage.recorded` is internal. Kimaki derives user-visible usage from public execution and step facts.
- Context percentage is omitted when the model context limit is unavailable.
- Plugin `SessionDomain` does not expose every HTTP operation, so some commands use `@opencode/client` directly.
- OpenCode execution recovery is at-least-once. A process crash can repeat a tool side effect.

These are runtime constraints, not unfinished migration phases.
