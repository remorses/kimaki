---
title: OpenCode v2 runtime simplification plan
description: >
  Detailed implementation plan for reducing prompt, projection, pagination,
  and server lifecycle complexity after the native OpenCode v2 migration.
---

# OpenCode v2 runtime simplification

Simplify the native OpenCode v2 integration without removing correctness around queueing, aborts,
forms, reconnects, subagents, worktrees, permissions, or server ownership.

The work uses incremental extraction. Each phase starts with tests, preserves public behavior, and
leaves the full CLI suite green before the next phase begins.

## Implementation status

The planned admission, projection, pagination, lifecycle, subagent, and runtime-state changes are
implemented in the working tree. `thread-session-runtime.ts` is 1,364 lines smaller than the
baseline and live plus captured events now use the same projection path.

Native `session.log()` replay remains limited by OpenCode 2.0.2. The core supports durable event
persistence, but `opencode serve` does not expose the option through its CLI or project config.
The subagent E2E therefore executes a real child session, captures native events from Kimaki's raw
event log, and replays them. Remove this limitation note when the native server exposes event
persistence.

## Goals

- Use one implementation to prepare and submit prompt admissions.
- Compute Discord rendering decisions with pure functions.
- Keep Discord API calls and mutable resources at the runtime edge.
- Use one correct cursor-pagination implementation for complete history reads.
- Represent the OpenCode server lifecycle with one discriminated state value.
- Replace deleted v1 task fixtures with native v2 subagent execution and replay coverage.
- Reduce `thread-session-runtime.ts` by at least 1,000 lines without creating many tiny files.

## Non-goals

- Do not rewrite the complete runtime in one change.
- Do not remove queue ordering, abort recovery, durable replay, or form retry behavior.
- Do not restore unsupported v1 features such as public session sharing.
- Do not add compatibility adapters for old OpenCode event shapes.
- Do not change the public `ThreadSessionRuntime.enqueueIncoming()` contract.
- Do not move feature-local process and timer state into the global Zustand store.

## Invariants

Every phase must preserve these behaviors:

1. Discord, voice, CLI, scheduled, retry, and slash-command input use the same session preferences.
2. Local queue items drain one at a time and keep their text, files, source, model, agent, and variant.
3. Context-only messages use native synthetic admission with `resume: false`.
4. Main and child session events remain isolated from unrelated runtimes.
5. Reconnect recovery reads durable logs for the full subagent session tree without duplicate output.
6. Failed and interrupted runs never show a successful completion footer.
7. Pending forms and permissions stop queue drain until they settle.
8. A stopped or stopping OpenCode process is never returned as a usable server.
9. Full-history readers follow opaque cursors and never send `order` with a cursor.
10. Tests use native OpenCode v2 events and real local servers. They do not mock modules.

# Phase 1: Native subagent coverage

## Purpose

Restore the high-value task coverage removed with the old v1 JSONL fixtures before changing runtime
boundaries.

## Files

- Add `cli/src/subagent-rendering.e2e.test.ts`.
- Update `opencode-deterministic-provider/src/deterministic-provider.ts` only if native subagent tool
  execution needs a more precise deterministic matcher.
- Update `opencode-deterministic-provider/src/deterministic-provider.test.ts` for matcher behavior.
- Add a stable fixture under `cli/src/session-handler/event-stream-fixtures/` only when the captured
  native durable log is deterministic and useful for replay tests.

## Test flow

1. Start Digital Discord and the real native OpenCode server.
2. Send a deterministic user prompt that invokes the native `subagent` tool.
3. Let the child session emit text and a real harmless tool call.
4. Assert the visible Discord thread snapshot before inspecting internal details.
5. Read the main and child durable logs through `session.log()`.
6. Replay the captured events through the pure derivation path.
7. Assert that replay produces the same task labels, ordering, and completed output.

## Cases

- One successful child.
- Two parallel children with stable indexes.
- Child tool output.
- Failed child.
- Interrupted child.
- Reconnect after child completion does not duplicate Discord messages.

## Completion

- The test proves real native child creation and routing.
- A failure appears within four seconds after server startup.
- The test file remains below the repository's approximate ten-second split threshold.

# Phase 2: One admission pipeline

## Current duplication

`cli/src/session-handler/thread-session-runtime.ts` prepares a turn twice:

- `submitViaOpencodeQueue()` handles direct native admission.
- `dispatchPrompt()` handles items drained from the Kimaki local queue.

Both paths resolve sessions, agents, models, variants, instructions, worktree context, channel context,
images, synthetic Discord context, banners, errors, and analytics.

## Design

Keep the implementation in `thread-session-runtime.ts` during this phase. Do not create a small
single-purpose file before the shared behavior is stable.

Add a value type:

```ts
type PreparedAdmission = {
  client: OpencodeClient
  sessionId: string
  createdNewSession: boolean
  text: string
  images: DiscordFileAttachment[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  delivery: 'steer' | 'queue'
  inputKind: 'prompt' | 'command'
  source: AnalyticsTurnSource
}
```

Add two methods:

```ts
prepareAdmission(input): Promise<PreparedAdmission | Error>
submitPreparedAdmission(admission): Promise<null | Error>
```

`prepareAdmission()` owns:

- Session creation and reuse.
- Session agent and model preference snapshots.
- Explicit model validation.
- Agent validation.
- Thinking variant resolution.
- Kimaki instruction entry persistence.
- Worktree and channel context lookup.
- Image annotation and file preparation.
- Synthetic Discord user context.
- New-session model banner data.

`submitPreparedAdmission()` owns:

- Native session selection.
- `session.prompt()` or `session.synthetic()` admission.
- Delivery selection.
- Busy-before-admission marker ordering.
- Busy steer interruption when the native protocol requires it.
- Scheduled run session attachment.
- Turn-start analytics.

The command endpoint remains a separate branch because `session.command()` has a different request
shape and timeout behavior. It should reuse the prepared session, context, and preference result.

## Callers

Keep these callers unchanged at the public boundary:

- `cli/src/discord-bot.ts`
- `cli/src/message-preprocessing.ts`
- `cli/src/voice-handler.ts`
- CLI send paths
- Scheduled task paths
- Retry paths

The local queue stores `IngressInput`, waits for eligibility, then calls the same preparation and
submission methods as direct input.

## Tests

- Direct and local admission produce identical native prompt text.
- Direct and local admission preserve the same images.
- Model, agent, variant, permissions, parent session, and analytics source match.
- Context-only input does not create or resume a session.
- New-session instructions are persisted once.
- Setup failure sends one Discord error and drains the next local item once.
- Busy steer preserves existing interrupt-and-continue behavior.

## Completion

- Remove duplicate preference, prompt, image, worktree, and channel-context blocks.
- `dispatchPrompt()` becomes local-queue orchestration, not a second admission implementation.
- The runtime loses several hundred lines.

# Phase 3: Shared cursor pagination

## Purpose

Remove repeated and fragile assumptions around default limits, message order, and opaque cursors.

## Files

- Add `cli/src/opencode-pagination.ts`.
- Add `cli/src/opencode-pagination.test.ts`.
- Update full-history consumers in commands, markdown export, external sync, and reconnect recovery.

The implementation and tests should make the new file substantial. Do not split message and session
pagination into separate tiny files.

## API

```ts
listAllMessages({ client, sessionId, order, type, stopWhen })
listAllSessions({ client, directory, parentId, order, stopWhen })
```

## Rules

- Send `order` on the first request only.
- Send `cursor` on later requests only.
- Preserve the order returned by the server.
- Treat cursors as opaque strings.
- Detect a repeated cursor and return a typed error.
- Allow early termination when the caller needs only one matching item.
- Keep bounded preview requests direct and explicit.

## Full-history consumers

- Undo and redo boundaries.
- Markdown export when it promises complete history.
- External session synchronization.
- Durable reconnect session-tree traversal.
- Any context-usage calculation that needs a complete turn.

## Bounded consumers

Do not replace intentional preview requests in:

- `/fork` menus.
- `/resume` menus.
- Recent-session lists.
- One-message existence checks.

## Tests

- More than 200 messages.
- More than 100 sessions.
- Empty first and later pages.
- Opaque cursors with punctuation.
- Repeated cursor rejection.
- Ascending and descending order.
- Early termination.

# Phase 4: Pure Discord event projection

## Purpose

Separate decisions derived from OpenCode events from Discord API effects.

## Files

- Add `cli/src/session-handler/discord-event-projection.ts`.
- Add `cli/src/session-handler/discord-event-projection.test.ts`.
- Update `cli/src/session-handler/event-stream-state.ts` for shared pure derivations only.
- Reduce `cli/src/session-handler/thread-session-runtime.ts` to routing and effects.

Keep text, reasoning, tools, execution terminals, and forms in one substantial projection module.
Do not create one file per event type.

## Action model

```ts
type DiscordAction =
  | { type: 'store-part'; part: DiscordSessionPart }
  | { type: 'send-part'; partId: string }
  | { type: 'show-form'; formId: string }
  | { type: 'settle-form'; formId: string }
  | { type: 'start-typing' }
  | { type: 'stop-typing' }
  | { type: 'show-context-usage'; sessionId: string }
  | { type: 'send-footer'; completedAt: number; startedAt: number }
  | { type: 'send-error'; message: string }
  | { type: 'record-terminal-analytics'; outcome: 'succeeded' | 'failed' | 'interrupted' }
  | { type: 'drain-queue' }
```

The projector accepts immutable values:

```ts
projectDiscordActions({
  event,
  events,
  projectedParts,
  mainSessionId,
  deliveredPartIds,
})
```

It must not receive Discord channels, OpenCode clients, database clients, timers, or loggers.

## Extraction order

### Text and reasoning

Move decisions from the native text and reasoning handlers first:

- Start part.
- Apply delta.
- Complete part.
- Route main versus child output.

### Tools and subagents

Move:

- Tool name and input folding.
- Running, completed, and failed part construction.
- Native subagent metadata normalization.
- Main versus child routing.

### Execution terminals

Move decisions for:

- Final flush.
- Footer eligibility.
- Failure display.
- Typing stop.
- Queue drain.
- Analytics outcome and usage.

### Forms

Move decisions for:

- Pending question display.
- Settled question cleanup.
- Duplicate prevention.
- Local queue handoff.

## Effect executor

Add one runtime method:

```ts
executeDiscordActions(actions): Promise<void>
```

It owns:

- Discord send, edit, and delete calls.
- Database delivery mappings.
- Typing timers.
- Form components.
- Analytics delivery.
- Queue dispatch.

## Reconnect

Reconnect must read durable logs and feed them through the same projection used by live events.
Do not maintain a separate reconnect renderer.

## Tests

Use native event arrays and inline action snapshots for:

- Short and long text.
- Reasoning.
- Tool start, completion, and failure.
- Consecutive text and tool spacing.
- Successful, failed, and interrupted executions.
- Footer suppression.
- One and multiple subagents.
- Pending, replied, and cancelled forms.
- Live versus replay equivalence.

# Phase 5: Explicit server lifecycle

## Purpose

Replace related nullable variables and ownership sets with one state value owned by one manager.

## Files

- Refactor `cli/src/opencode.ts`.
- Extend `cli/src/opencode-server-lifecycle.test.ts`.
- Keep `cli/src/session-handler/global-event-listener.ts` as a lifecycle subscriber.

Do not move server state into the global Zustand store. Only `opencode.ts` owns server transitions.

## State

```ts
type ServerState =
  | { type: 'stopped' }
  | { type: 'starting'; process: ChildProcess | null; result: Promise<ServerStartError | SingleServer> }
  | { type: 'running'; server: SingleServer }
  | { type: 'stopping'; server: SingleServer; result: Promise<boolean> }
```

Create a closure-owned manager:

```ts
function createOpencodeServerManager() {
  let state: ServerState = { type: 'stopped' }
  return { ensure, stop, restart, connection, subscribe }
}
```

Keep existing exported functions as thin delegates so callers do not change together with the state
refactor.

## Resources

Co-locate these values with the owning state:

- Spawned child process.
- Startup promise.
- Stop promise.
- Server password and URL.
- Ownership information for discovered versus spawned servers.

Keep the per-directory OpenCode client cache next to the manager. Clear it only on a committed server
identity transition.

## Tests

- Concurrent ensure calls start one process.
- Ensure during stop waits for stop.
- Stop during startup terminates the starting process.
- Fixed-port restart waits for real exit.
- SIGTERM timeout escalates to SIGKILL.
- Old child exit cannot clear a replacement.
- A discovered server is never killed.
- Startup child failure returns stderr quickly.
- Lifecycle subscribers receive one event per committed transition.

# Phase 6: Reduce runtime mutable resources

## Shared Zustand state

Keep these fields in `thread-runtime-state.ts` because commands and recovery use them:

- Session ID.
- Stable session user identity.
- Parent session ID.
- Local queue items.
- Delivered part IDs.

## Event-derived values

Do not store separate mutable copies of:

- Busy state.
- Current execution.
- Completion outcome.
- Current assistant message IDs.
- Child-session membership.
- Pending permissions.
- Token usage.

Continue deriving them from `eventBuffer` through `event-stream-state.ts`.

## Local resources

Keep these resources private to the runtime or a substantial feature controller:

- Typing interval and delayed restart timeout.
- Preprocessing chain.
- Active abort promise.
- Discord message edit scheduling.
- Stream-only text and reasoning buffers.

Do not expose raw timers, promises, or Discord objects through the global store.

## Cleanup

- Every local resource has one owner.
- Every owner has one dispose path.
- Terminal events, aborts, forms, and runtime disposal cannot restart cleaned resources.
- Remove fields only after a derivation or owned resource replaces every read and write.

# Phase 7: Remove protocol workarounds carefully

Review each remaining special case after the common paths exist:

- Kimaki queue busy markers.
- `session.interrupt({ continue: true })` after busy steer.
- Question queue-handoff marker.
- Manual OpenCode error parsing.
- Duplicate model-list calls.
- Reconnect-specific branches.

For every candidate:

1. Add or identify a regression test.
2. Remove the special case.
3. Run the focused test.
4. Keep it removed only when native OpenCode behavior passes.
5. If the protocol still requires it, restore it with one short comment that explains the exact reason.

# Task execution

Run phases in order. Parallel work is allowed only when file ownership does not overlap.

## Task A: subagent coverage

Own the new subagent E2E, deterministic provider matcher, and optional native fixture. Do not edit the
runtime.

## Task B: pagination

Own `opencode-pagination.ts`, its test, and full-history callers. Do not edit admission or server
lifecycle code.

## Task C: admission

Start after Task A is green. Own the admission and queue-dispatch sections of
`thread-session-runtime.ts` plus focused queue tests.

## Task D: event projection

Start after Task C is green. Own the projection module, event derivations, runtime event handlers,
and focused rendering tests.

## Task E: server lifecycle

Can run in parallel with Task C because it owns `opencode.ts` and lifecycle tests only. It must not
edit global listener behavior unless the lifecycle event contract changes.

## Task F: final state cleanup

Start after projection and admission changes merge in the worktree. Remove obsolete fields, branches,
and comments. Do not introduce new abstractions.

# Verification

After each task:

1. Run its focused tests.
2. Run `pnpm tsc` inside `cli`.
3. Run `lintcn lint` inside `cli` and fix errors in changed files.

After admission, projection, queue, or message-handler changes:

```bash
cd cli
pnpm run test --run -u
```

Inspect every updated inline snapshot before accepting it.

Validate the deterministic provider separately when changed:

```bash
cd opencode-deterministic-provider
pnpm tsc
pnpm run test
```

# Final acceptance

- Native subagent execution and durable replay have E2E coverage.
- One admission implementation serves direct and local-queue prompts.
- Live and replayed native events use one Discord projection.
- Full-history reads use one cursor paginator.
- Server lifecycle uses one discriminated state value.
- `thread-session-runtime.ts` is at least 1,000 lines smaller.
- No v1 event or plugin compatibility layer returns.
- No new `as any` assertions are introduced.
- CLI TypeScript passes and emits current build artifacts.
- The complete CLI suite passes with reviewed snapshots.
- Lintcn reports no errors in changed files.
