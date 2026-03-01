---
title: Event Listener Runtime Migration Plan
description: >-
  Detailed migration blueprint for moving Kimaki Discord session handling
  to one long-lived OpenCode event listener per thread runtime with
  centralized Zustand state updates.
prompt: |
  [38m since last message | UTC: 2026-03-01 15:39:12 UTC | Local
  (Europe/Rome): 03/01/2026, 16:39]create a detailed plan markdown file
  of how the new architecture should work. reference opencode files to
  take inspiration from. make it detailed enough so that new agents will
  be able to do this migration. then ask oracle for a review of the plan
references:
  - @discord/src/session-handler.ts
  - @discord/src/session-handler/state.ts
  - @discord/src/discord-bot.ts
  - @discord/src/commands/queue.ts
  - @discord/src/commands/abort.ts
  - @discord/src/commands/action-buttons.ts
  - @discord/src/commands/merge-worktree.ts
  - @discord/src/commands/restart-opencode-server.ts
  - @discord/src/thread-message-queue.e2e.test.ts
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/
    tui/context/sdk.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/
    tui/context/sync.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/
    tui/component/prompt/index.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/
    tui/routes/session/index.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/
    tui/worker.ts
---

# Event Listener Runtime Migration Plan

## 1. Goal

Move Kimaki session orchestration from a per-message listener model to a
per-thread runtime model:

- exactly one long-lived OpenCode `event.subscribe` stream per thread runtime
- one centralized Zustand state atom per runtime
- Discord handlers become ingress only (fire-and-forget)
- all state transitions come from OpenCode events, not Discord-side guesses
- keep current behavior: abort active run on normal new user message
- keep queue behavior for `/queue` and queue-command flows

## 2. Why the current model is fragile

Today `handleOpencodeSession` in `@discord/src/session-handler.ts` owns:

- prompt dispatch
- event stream lifecycle
- queue drain recursion
- typing timers
- permission/question/action side effects
- run completion and footer emission

Because each message can create/abort/replace an event handler, the code has
to coordinate overlapping lifecycles with global mutable maps:

- `abortControllers`
- `messageQueue`
- `activeEventHandlers`
- `pendingPermissions`
- plus `threadMessageQueue` in `@discord/src/discord-bot.ts`

This makes ordering and race behavior hard to reason about and hard to evolve.

## 3. OpenCode inspiration (architecture copy, not code copy)

OpenCode TUI keeps a long-lived event pipeline and derives UI state from events:

- `@.../tui/context/sdk.tsx`
  - starts a persistent event subscription
  - batches event emission
  - reconnects in loop
- `@.../tui/context/sync.tsx`
  - single centralized store
  - event handlers update normalized state maps
- `@.../tui/component/prompt/index.tsx`
  - prompt submit only dispatches calls
  - stream ownership does not belong to submit call
- `@.../tui/routes/session/index.tsx`
  - reads derived session state (`session_status`, messages, parts)

Kimaki should adopt the same principle:

> Dispatch requests from ingress, but derive lifecycle truth from one always-on
> event stream per runtime.

## 4. Target architecture

```text
Discord Message / Slash Command
  -> runtime-registry.getOrCreate(threadId)
  -> runtime.enqueueIncoming(input, policy)
  -> return immediately

ThreadSessionRuntime (one per thread)
  -> ensureEventListenerStarted() [once]
  -> dispatchLoop() [run-level abort + prompt/command dispatch]
  -> onEvent(event) => setState(transition)
  -> subscribe(effect reactor) => Discord side effects
```

### Hard invariants

These invariants are required for correctness during migration:

1. **Session demux invariant**
   - run-scoped events must be ignored unless
     `event.sessionID === state.identity.sessionId`
   - only explicitly global events bypass this guard

2. **Serialized mutation invariant**
   - all ingress actions and OpenCode events must flow through one internal
     runtime action queue (`dispatchAction`) to prevent interleaving writes

3. **Idempotent output invariant**
   - Discord output dedupe keys are namespaced by session/run
   - reconnect or stale events must not re-emit already-sent parts

4. **Listener continuity invariant**
   - run abort never destroys listener
   - listener reconnect is independent from run lifecycle

### Ownership rules

- `discord-bot.ts` and command handlers do not inspect run internals
- command handlers call runtime APIs only (`isBusy`, `abortActiveRun`, `enqueue`)
- runtime store is single source of truth for run and queue state
- side effects happen after transitions, not inside transition functions

## 5. Runtime modules to introduce

Create a small runtime package under `discord/src/session-handler/`:

1. `thread-session-runtime.ts`
   - runtime class/factory
   - event listener loop
   - ingress methods
   - dispatch loop

2. `runtime-store.ts`
   - Zustand state shape
   - pure transition functions
   - selectors

3. `runtime-registry.ts`
   - `Map<threadId, runtime>`
   - get/create/dispose

4. `runtime-effects.ts`
   - single subscribe reactor that performs Discord/OpenCode side effects
   - typing timer lifecycle
   - permission/question/action rendering triggers

5. `runtime-types.ts`
   - shared types for ingress items, run reason enums, lifecycle enums

`session-handler.ts` remains public adapter for backward compatibility, but most
logic moves into runtime modules.

## 6. Minimal centralized runtime state

Keep only irreducible state. If a value can be derived from existing state,
event payloads, or an on-demand API read, do not store it.

```ts
type RuntimeState = {
  // mutable identity needed for event demux
  sessionId?: string

  // canonical run lifecycle (reuses existing deferred-idle/evidence logic)
  runState: MainRunState

  // ingress backlog
  queueItems: QueuedMessage[]

  // queue blocking policy state
  blockers: {
    permissionCount: number
    questionCount: number
    actionButtonsPending: boolean
    fileUploadPending: boolean
  }
}
```

### Runtime-owned refs/caches (not in Zustand)

Keep non-reactive implementation details as runtime fields (not store state):

- immutable thread metadata (`threadId`, `projectDirectory`, `sdkDirectory`)
- listener abort controller and reconnect backoff counters
- run abort controller
- typing interval/restart timeout handles
- part buffer and dedupe sets (`sentPartIds`, `partBuffer`)
- transient subtask label/session maps

These are operational resources, not domain state transitions.

### Derived selectors (do not store)

- `isRunActive`: derived from `runState.phase`
- `hasQueue`: `queueItems.length > 0`
- `hasBlockers`: derived from `blockers`
- `canDispatchNext`: `sessionId && hasQueue && !isRunActive && !hasBlockers`
- `isBusy`: `isRunActive || hasQueue`

### Explicitly remove from state model

Do not persist these in Zustand:

- `processing` booleans for queue/dispatch (derived)
- run start timestamps used only for footer formatting (derive from message/event)
- `usedModel`, `usedProviderID`, `usedAgent`, `tokensUsed` counters
  (derive from last assistant message and provider metadata when needed)
- listener status/retry counters unless required for user-visible behavior
  (prefer logs/metrics)
- typing status flags (derive from run + blocker state; keep only timer handles as refs)

### State to delete from globals

- `abortControllers` map
- `messageQueue` map
- `activeEventHandlers` map
- `pendingPermissions` map
- `threadMessageQueue` map in `discord-bot.ts`

## 7. Runtime APIs (used by Discord handlers)

Expose these methods from runtime instance:

- `enqueueIncoming(input, options)`
  - `options.interruptActive: boolean`
  - normal messages use `true`
  - `/queue` uses `false`
- `isBusy()`
- `abortActiveRun(reason)`
- `retryLastUserPrompt(options)` for model-change flow
- `getQueueLength()`
- `clearQueue()`
- `dispose()`

This replaces direct map usage in all command modules.

## 8. Event pipeline behavior

### Listener lifecycle

- listener starts once when runtime is created or first ingress arrives
- listener remains alive across multiple runs
- listener reconnects on transient disconnects with backoff
- listener never restarts because a new user message arrived

### Run lifecycle

- on ingress with `interruptActive=true`:
  - abort run controller
  - call OpenCode `session.abort` best-effort
  - enqueue message
- dispatch loop sends next queued message when run is idle
- completion comes from event timeline and deferred-idle state machine

### Queue policy during interactive blockers

Use one explicit policy and keep it stable across migration:

- default policy: **block dispatch while question/permission is pending**
- interrupting ingress can still abort active run and enqueue
- queue drains only when blocker is resolved or cancelled by policy action

This policy must be implemented via transition guards, not ad-hoc checks.

### Reconnect recovery behavior

After listener reconnect, runtime must reconcile with authoritative APIs:

- fetch session status/messages snapshot
- repair run state if stream events were missed
- if recovery cannot prove progress, move run to terminal error path and
  continue queue processing

### Interactive events

- `permission.asked` / `permission.replied`
- `question.asked`
- `action-buttons` request from IPC queue
- these update runtime interaction state first, then effect layer renders UI

## 9. Event-to-state transition map

Use pure transitions per event type:

- `message.updated`
  - update message evidence for current run
  - update model/provider/agent/tokens
- `message.part.updated`
  - buffer part
  - mark run evidence
- `session.status`
  - store retry status metadata (for throttled notices)
- `session.idle`
  - pass through deferred-idle decision flow
  - mark run finished only when evidence constraints are satisfied
- `session.error`
  - mark run error, preserve payload for side-effect reporting

All side effects (Discord sends, button rendering, footer) happen in the
subscribe reactor after transition commits.

## 10. Migration phases

### Phase 0 - Baseline tests and invariants

Files:

- `@discord/src/thread-message-queue.e2e.test.ts`
- new `@discord/src/session-handler/runtime-store.test.ts`
- new `@discord/src/session-handler/thread-session-runtime.test.ts`

Tasks:

- keep existing queue/interrupt e2e tests as regression baseline
- add unit tests for deferred idle/evidence transitions
- add runtime-level tests for listener non-overlap and queue drain

Acceptance:

- current tests green before architecture edits

### Phase 1 - Runtime skeleton and registry

Files:

- new `@discord/src/session-handler/runtime-registry.ts`
- new `@discord/src/session-handler/thread-session-runtime.ts`
- new `@discord/src/session-handler/runtime-store.ts`
- `@discord/src/session-handler.ts`

Tasks:

- add runtime get/create registry
- add thin adapter in `handleOpencodeSession` that can route to runtime
- keep old flow behind compatibility switch while wiring APIs
- enforce state budget rule: every store field must document why it cannot be
  derived; reject fields that are only cache/telemetry

Acceptance:

- no behavior change yet

### Phase 2 - Long-lived listener + demux foundation

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/session-handler/runtime-store.ts`
- `@discord/src/session-handler/state.ts` (reuse transition logic)

Tasks:

- start one persistent `event.subscribe` loop per runtime
- add strict session demux guards for all run-scoped events
- implement internal serialized action queue (`dispatchAction`)
- separate run abort controller from listener controller

Acceptance:

- no overlapping per-message handlers
- new message no longer restarts listener

### Phase 3 - Move ingress ownership to runtime

Files:

- `@discord/src/discord-bot.ts`
- `@discord/src/commands/queue.ts`
- `@discord/src/commands/action-buttons.ts`
- `@discord/src/commands/merge-worktree.ts`
- `@discord/src/session-handler.ts`

Tasks:

- route thread messages and queue-command through `runtime.enqueueIncoming`
- route interrupt path through `runtime.abortActiveRun`
- keep `threadMessageQueue` as temporary guard until parity gate passes

Acceptance:

- ingress paths use runtime APIs without behavior regressions

### Phase 3.5 - Parity gate + observability

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/thread-message-queue.e2e.test.ts`

Tasks:

- add temporary runtime counters/logs:
  - listener start/restart count
  - stale-event drop count
  - queued/dequeued counts
  - interrupt counts
- run full queue/interrupt parity suite
- only after parity: remove `threadMessageQueue`

Acceptance:

- parity suite green with runtime-only ingress
- counters show no duplicate listener starts per run

### Phase 4 - Move command dependencies to runtime APIs

Files:

- `@discord/src/commands/abort.ts`
- `@discord/src/commands/restart-opencode-server.ts`
- `@discord/src/commands/queue.ts`
- `@discord/src/commands/model.ts`
- `@discord/src/commands/action-buttons.ts`
- `@discord/src/commands/merge-worktree.ts`

Tasks:

- replace global map reads with runtime calls
- migrate `abortAndRetrySession` to runtime retry API

Acceptance:

- commands no longer import global mutable maps

### Phase 5 - Remove legacy globals and recursion

Files:

- `@discord/src/session-handler.ts`
- `@discord/src/discord-bot.ts`

Tasks:

- delete legacy maps
- delete recursive queue drain calls to `handleOpencodeSession`
- keep exported API signatures stable where possible

Acceptance:

- runtime is sole owner of queue/run/listener state

### Phase 6 - Hardening and cleanup

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/voice-handler.ts` (queue comments/integration)

Tasks:

- ensure typing interval + restart timeout cleanup in all terminal paths
- add reconnect backoff and stale runtime diagnostics
- implement mandatory runtime disposal on:
  - thread archive/delete
  - restart-opencode-server channel scope
  - bot shutdown

Acceptance:

- no stuck typing
- listener survives multiple runs in same thread
- no leaked listeners/timers/controllers after dispose paths

## 11. Side-effect reactor responsibilities

Single subscribe effect layer should own:

- Discord chunk sends for parts
- context usage notices and retry notices
- permission/question/action UI rendering
- final footer emission
- queue dequeue trigger when run transitions to terminal state
- typing indicator lifecycle

Avoid side effects in ingress handlers except initial ack messages.

## 12. Test plan

Run during each phase:

1. `pnpm tsc` (inside `discord/`)
2. `pnpm vitest --run src/thread-message-queue.e2e.test.ts`
3. runtime unit tests once added:
   - `pnpm vitest --run src/session-handler/runtime-store.test.ts`
   - `pnpm vitest --run src/session-handler/thread-session-runtime.test.ts`

Key scenarios:

- rapid B/C/D messages preserve order guarantees
- interrupt during tool run (`sleep 500`) still lets next message complete
- deferred idle cannot prematurely finish a new run
- `/queue` adds without interrupt
- `/abort` cancels active run without killing listener
- model change mid-run aborts and retries using same runtime
- reconnect during active run does not duplicate outputs and does not deadlock
- stale old-session events are ignored after new run starts
- question/permission pending + queued message follows explicit blocker policy
- restart-opencode-server aborts all matching runtimes in channel scope
- voice + text near-simultaneous ingress keeps deterministic order
- action button click while busy queues correctly
- thread archive/delete disposes runtime cleanly

## 13. Risks and mitigation

- listener reconnect storm
  - use bounded backoff and log counters per runtime
- stale runtimes over long uptime
  - keep alive by design now; add optional stale cleanup later
- duplicate Discord output from replayed parts
  - preserve `sentPartIds` and idempotent part flush checks
- interaction deadlocks (question/permission + queued message)
  - queue decisions come from runtime transitions only

## 14. Final end-state checklist

- one long-lived event listener per thread runtime
- no per-message event subscribe in `handleOpencodeSession`
- no global queue/abort/handler maps
- commands use runtime APIs only
- e2e queue + interrupt behaviors unchanged
- code reads as: ingress -> transition -> effects
