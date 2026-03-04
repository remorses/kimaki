---
title: Event-driven state simplification plan
description: |
  Remove kimaki's local phase state machine and derive all run lifecycle
  state from the OpenCode SSE event buffer. Fixes footer suppression bugs
  caused by divergence between kimaki's local state and opencode's actual
  session state.
prompt: |
  This plan was produced from a deep analysis of thread-session-runtime.ts,
  thread-runtime-state.ts, and state.ts. The conversation traced the full
  footer flow from session.idle SSE event through handleSessionIdle →
  runCompletedNormally → finishRun → emitFooter, identifying three bug
  sites where the footer is incorrectly suppressed. Reviewed by oracle
  agent which found critical bugs in the initial plan (wasRecentlyAborted
  scan order, subtask idle ordering, lastDispatchTime for rapid messages,
  event buffer size for lifecycle events, missing file list).
  Key files read:
  - discord/src/session-handler/thread-session-runtime.ts
  - discord/src/session-handler/thread-runtime-state.ts
  - discord/src/session-handler/state.ts
  - discord/src/store.ts
  - discord/src/opencode-plugin.ts
  - discord/src/commands/abort.ts
  - @opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts
  Also read the zustand-centralized-state skill (discord/skills/).
---

# Event-Driven State Simplification

## Problem

Kimaki maintains a **local phase state machine** (`'idle'` / `'running'` in
`MainRunState`) that mirrors opencode's session state. This mirror diverges
from opencode's actual state, causing the footer to be suppressed on normal
message completions. Four bug sites were identified:

**Bug 1: `phase !== 'running'` when `session.idle` arrives.**
`submitViaOpencodeQueue` marks `running` optimistically, but when a second
message is sent while already running, `shouldMarkRunning` is false. If the
first run's idle already set phase to `'idle'`, and the auto-promotion in
`handleMessageUpdated` (line 1039) doesn't fire because `partBuffer` already
has the message ID, then `handleSessionIdle` hits `phase !== 'running'` and
returns early — no footer.

**Bug 2: `runCompletedNormally()` returns false.**
This function scans the event buffer for a `step-finish` part whose messageID
is in `assistantMessageIds`. But the auto-promotion path calls
`pureMarkRunning`, which resets `assistantMessageIds` to an empty set. If the
assistant message was already registered before the promotion, the new empty
set doesn't contain it. `runCompletedNormally` finds no match → footer
suppressed.

**Bug 3: `expectedRunId` mismatch in `finishRun`.**
If the auto-promotion path bumps `lastRunId`, the `expectedRunId` captured
before the async `finishRun` call doesn't match the new `activeRunId`. Stale
finish → footer skipped.

**Bug 4: `runCompletedNormally()` requires `step-finish` but promptAsync
paths can have sparse `message.part.updated` events.** The promptAsync path
can complete normally with parts delivered only via `message.updated` (not
individual `message.part.updated` events). In this case there is no
`step-finish` event in the buffer, and `runCompletedNormally` returns false
even though the run completed normally → footer suppressed.

All four bugs trace to the same root cause: **duplicating opencode's session
state locally** instead of using the event stream as the single source of
truth.

## Solution

Make the OpenCode event stream the sole run-lifecycle source of truth.
Remove all per-run mirrors from both store and runtime class. Runtime/store
should keep only what cannot be derived from events (session identity,
queue/blockers, listener handles, output dedup). All run decisions (busy/idle,
abort classification, footer timing, model/provider/agent/tokens, subtask
routing) must be derived from event history.

## Changes

### 1. Remove state fields from `ThreadRunState`

**File: `discord/src/session-handler/thread-runtime-state.ts`**

Remove from `ThreadRunState`:

| Field | Reason for removal |
|---|---|
| `runState` (phase, assistantMessageIds, latestAssistantMessageId) | Derive from event buffer |
| `lastRunId` | No longer needed without runId guards |
| `currentRun` (entire object) | Split: footer-related info moves to class, rest derived |
| `runController` | Eliminated by switching to promptAsync |

Keep in `ThreadRunState`:

| Field | Why kept |
|---|---|
| `sessionId` | Can't derive — set by ensureSession |
| `queueItems` | Can't derive — local queue state |
| `blockers` | Can't derive — tracks pending interactive UI |
| `listenerController` | Can't derive — runtime lifecycle handle |
| `sentPartIds` | Can't derive — dedup state built from DB + sends |

Remove from store entirely:

- `updateRunState()` function
- `pureMarkRunning` / `pureMarkIdle` / `pureRegisterAssistantMessage` from `state.ts`
- `initialCurrentRunInfo()` and `CurrentRunInfo` type
- `lastRunId` field and all increment/read sites

### 2. Delete `state.ts`

**File: `discord/src/session-handler/state.ts`**

This file becomes empty after removing `MainRunState`, `MainRunPhase`, and
the pure transition functions. Delete it.

### 3. Remove per-run mechanism state from the class

**File: `discord/src/session-handler/thread-session-runtime.ts`**

Do not move `currentRun` fields into class fields. Remove them instead.
Avoid replacing store state with equivalent class caches.

Use event-derived helpers instead:

- Footer duration: derive from lifecycle sequence (`busy` timestamp preceding
  the idle currently being handled), not from `dispatchTimeQueue`.
- Subtask routing/labels: derive from task tool events in the event history
  (for example `message.part.updated` tool `task` metadata), not from a
  persistent `subtaskSessions` map.
- UI throttle state from `currentRun` should be removed or rewritten as
  event-derived logic; do not keep per-run counters in mutable runtime state.

This keeps the runtime class as an event interpreter instead of a second run
state machine.

### 4. Increase event buffer to 1000 (single ring)

**File: `discord/src/session-handler/thread-session-runtime.ts`**

The current 100-event buffer can lose lifecycle events (`session.idle`,
`session.status`, `session.error`) during long runs with many tool/part
events. Increase the single event ring to 1000 so lifecycle derivation stays
reliable without adding another state structure.

Use one bounded buffer:

```ts
// All events — used for lifecycle derivation, part routing,
// subtask detection, and footer metadata queries.
private static EVENT_BUFFER_MAX = 1000
private eventBuffer: Array<{ event: OpenCodeEvent; timestamp: number }> = []
```

On each event:
- Push to `eventBuffer`.
- If length exceeds 1000, drop oldest entries.

The derivation functions (`isSessionBusy`, `wasRecentlyAborted`) scan
`eventBuffer` directly.

**Important:** remove `clearEventBuffer()` from dispatch paths after migrating
`handleSessionIdle` off `runCompletedNormally()`. In the current code,
`clearEventBuffer()` is called at each dispatch start and can erase evidence
needed for a prior run's footer when promptAsync turns overlap. Once lifecycle
derivation is authoritative, keeping bounded rings is safer than clearing.

### 5. Add pure derivation functions over event buffers

**File: `discord/src/session-handler/thread-session-runtime.ts`** (private methods)

```ts
// Derive whether the session is currently busy from the event buffer.
// Scans backward for the most recent session-scoped lifecycle event.
private isSessionBusy(): boolean {
  const sessionId = this.state?.sessionId
  if (!sessionId) return false
  for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
    const e = this.eventBuffer[i].event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) continue
    if (e.type === 'session.idle') return false
    if (e.type === 'session.status') {
      return e.properties.status.type === 'busy'
    }
  }
  return false
}

// Derive whether the most recent run ended due to abort.
// Called from handleSessionIdle AFTER the idle event has been pushed to the
// event buffer. So we must skip the current idle and look at what
// preceded it.
//
// Event order on abort: session.error(MessageAbortedError) → session.idle
// Event order on normal: step-finish → session.idle (no error)
//
// Scans backward from the second-to-last lifecycle event for our session.
private wasRecentlyAborted(): boolean {
  const sessionId = this.state?.sessionId
  if (!sessionId) return false
  let skippedCurrentIdle = false
  for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
    const e = this.eventBuffer[i].event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) continue
    // Skip the current session.idle that triggered this call
    if (!skippedCurrentIdle && e.type === 'session.idle') {
      skippedCurrentIdle = true
      continue
    }
    if (e.type === 'session.error') {
      return e.properties.error?.name === 'MessageAbortedError'
    }
    // Hit a previous idle or busy — no abort preceded the current idle
    if (e.type === 'session.idle') return false
    if (e.type === 'session.status' && e.properties.status.type === 'busy') {
      return false
    }
  }
  return false
}

// Derive model/provider/agent/tokens from the event buffer for the footer.
// Scans for the most recent message.updated with role=assistant.
private getLatestRunInfo(): {
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  tokensUsed: number
} {
  const sessionId = this.state?.sessionId
  const result = {
    model: undefined as string | undefined,
    providerID: undefined as string | undefined,
    agent: undefined as string | undefined,
    tokensUsed: 0,
  }
  if (!sessionId) return result
  for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
    const e = this.eventBuffer[i].event
    if (e.type !== 'message.updated') continue
    const msg = e.properties.info
    if (msg.sessionID !== sessionId || msg.role !== 'assistant') continue
    return {
      model: 'modelID' in msg ? msg.modelID : undefined,
      providerID: 'providerID' in msg ? msg.providerID : undefined,
      agent: 'mode' in msg ? msg.mode : undefined,
      tokensUsed: 'tokens' in msg && msg.tokens
        ? getTokenTotal(msg.tokens)
        : 0,
    }
  }
  return result
}
```

### 6. Simplify `handleSessionIdle`

**Before** (30+ lines, 4 bug sites):

```
check sessionId match
check phase === 'running'           ← bug 1
call runCompletedNormally()         ← bug 2 + bug 4
call finishRun(expectedRunId)       ← bug 3
  check expectedRunId match
  check phase === 'running' again
  pureMarkIdle
  flush parts
  if !suppressFooter → emitFooter
  drain queue
```

**After** (~20 lines, 0 bug sites):

```ts
private async handleSessionIdle(idleSessionId: string): Promise<void> {
  const sessionId = this.state?.sessionId

  // ── Subtask idle ────────────────────────────────────────
  // Check subtask BEFORE main session. Subtask identity is derived from
  // event history, not mutable maps.
  if (this.isDerivedSubtaskSession(idleSessionId)) {
    return
  }

  // ── Main session idle ───────────────────────────────────
  if (idleSessionId !== sessionId) return

  const aborted = this.wasRecentlyAborted()
  this.stopTyping()
  await this.flushAllBufferedParts()

  const runStartTime = this.getRunStartTimeForCurrentIdle()
  if (!aborted && runStartTime) {
    await this.emitFooter({ dispatchTime: runStartTime })
  }

  await this.tryDrainQueue({ showIndicator: true })
}
```

**Key fix from oracle review:** Subtask idle is checked first because subtask
session IDs are always different from the main `sessionId`. The original plan
had `idleSessionId !== sessionId` first, which would catch subtask idles in
the wrong branch and return before the subtask cleanup.

### 7. Simplify `canDispatchNext`

**File: `discord/src/session-handler/thread-runtime-state.ts`**

`canDispatchNext` can no longer check phase since it only has access to
`ThreadRunState` (store data), not the event buffer (class data).

Move the busy check to the runtime class:

```ts
// In ThreadSessionRuntime
private canDispatchNext(): boolean {
  const t = this.state
  if (!t) return false
  return threadState.hasQueue(t)
    && !this.isSessionBusy()
    && !threadState.hasBlockers(t)
}
```

Remove `isRunActive`, `canDispatchNext`, `isBusy` from `thread-runtime-state.ts`
since they depended on `runState.phase`.

### 8. Unify dispatch paths — switch `dispatchPrompt` to `promptAsync`

**File: `discord/src/session-handler/thread-session-runtime.ts`**

Replace the blocking `session.prompt()` call in `dispatchPrompt` with
`session.promptAsync()`. This eliminates:

- `runController` creation and passing
- `runController` abort signal handling
- The `.catch(AbortError)` path
- The abort response detection (`errMessage.includes('aborted')`)
- ~60 lines of error handling specific to the blocking call

The abort flow simplifies to just `session.abort()` API call, which
`abortActiveRunInternal` already does.

**For `session.command()`:** The SDK has no `commandAsync` variant. Keep the
blocking `session.command()` call for the `/queue-command` edge case, but
add a **30-second timeout** via `AbortSignal.timeout(30_000)` to prevent
indefinite stalls. If the timeout fires, send an error message to the thread
and drain the queue. This is scoped only to the command path — the
`runController` in the store is still removed.

### 9. Remove `runController` from `ThreadRunState`

After step 8, `runController` is no longer needed for the prompt path.
The command path uses a local `AbortSignal.timeout()` instead.

**File: `discord/src/session-handler/thread-runtime-state.ts`**

Remove `runController` field, `setRunController()`, and all read sites.

**File: `discord/src/commands/abort.ts`**

`/abort` currently calls `runtime.abortActiveRun()` which aborts the
runController and calls `session.abort()`. After this change, it only calls
`session.abort()`.

**No setup-phase abort guard needed.** The action queue (`dispatchAction`)
serializes all mutations. The dispatch runs inside `dispatchAction`, so an
abort request is queued after the current dispatch completes. By then
`promptAsync` has already been called and `session.abort()` cancels it
normally. The setup phase (ensureSession + model resolution) is <100ms —
even if abort fires during that window via the non-queued
`abortActiveRunInternal`, `session.abort()` on a non-busy session is a no-op,
the prompt fires, and the user can abort again.

### 10. Remove auto-promotion in `handleMessageUpdated`

**File: `discord/src/session-handler/thread-session-runtime.ts`** (lines 1039-1053)

Delete the block that promotes `'idle'` → `'running'` when a new assistant
message arrives. This was a band-aid for the phase desync with `promptAsync`.
Without phase tracking, there's nothing to promote.

### 11. Simplify `handleMainPart`

**File: `discord/src/session-handler/thread-session-runtime.ts`**

Remove the `assistantMessageIds.has(part.messageID)` filter (line 1170).
This check drops parts when `message.updated` arrives after
`message.part.updated` (because the message isn't registered yet).

Replace with the simpler check that already exists: `part.sessionID === sessionId`
(done at line 1157) + `sentPartIds` dedup. Parts are processed if they belong
to our session and haven't been sent yet.

### 12. Simplify `submitViaOpencodeQueue`

Remove all `shouldMarkRunning` logic:
- No `pureMarkRunning` call
- No `initialCurrentRunInfo` setup
- No `cleanupOnError` calling `pureMarkIdle`

Just: ensure session → resolve model/agent → build parts → call `promptAsync`.

The event listener handles everything from there — `session.status busy`
confirms the run started, SSE events stream parts, `session.idle` triggers
footer + queue drain.

### 13. Merge `dispatchPrompt` and `submitViaOpencodeQueue`

After steps 8 and 12, both methods do the same thing:
1. `ensureSession()`
2. Resolve model/agent/variant
3. Build system message and parts
4. Call `promptAsync()`

Merge into a single private method. The `enqueueIncoming` entry point becomes:
- `mode === 'local-queue'` or has `command` → enqueue in `queueItems`, drain
  calls the unified dispatch
- `mode === 'opencode'` (default) → call the unified dispatch directly

**Risk note:** this merge should be done last, not bundled with state-field
deletions. The current methods differ in serialization boundaries,
error-recovery behavior, and command execution semantics:

- `dispatchPrompt` is detached from the action queue and currently supports
  blocking `session.prompt()` / `session.command()` behavior.
- `submitViaOpencodeQueue` runs entirely inside `dispatchAction` and uses
  `promptAsync` acceptance semantics.
- Merging too early can regress queue-drain behavior or stall event handling on
  long command execution.

### 14. Update typing restart guard

**File: `discord/src/session-handler/thread-session-runtime.ts`** (line 797)

The `scheduleTypingRestart` method currently checks `runState.phase !== 'running'`
to avoid restarting typing after a run ends. Replace with:

```ts
if (!this.isSessionBusy()) return
```

## Event buffer considerations

- **Single larger ring:** Increase `EVENT_BUFFER_MAX` from 100 to 1000 and
  keep one buffer. Lifecycle derivation (`isSessionBusy`,
  `wasRecentlyAborted`) scans this single buffer.

- **SSE reconnect:** On reconnect, events may have been missed. This is an
  existing risk that affects the current architecture equally. The existing
  TODO (line 540) for reconnect reconciliation applies to both approaches.
  After reconnect, the event buffer may be incomplete. A conservative fallback:
  if `isSessionBusy()` returns false, call `session.get()` to check actual
  session status before draining the queue.

- **Multiple idle events:** If opencode processes queued prompts back-to-back,
  each completed response emits its own `session.idle`. Footer duration is
  derived from each idle's corresponding lifecycle `busy` transition.

## Implementation sequence and safeguards

Apply this plan incrementally (not as one atomic refactor):

1. Add lifecycle derivation helpers over the single 1000-entry event buffer
   while keeping existing fields in place.
2. Move non-critical read sites to derivation (`canDispatchNext` busy checks,
   typing-restart guard) with fallback behavior.
3. Add lifecycle-derived footer timing (derive start time from lifecycle
   events), then verify rapid promptAsync A/B turns each emit correct durations.
4. Switch idle/footer gating to lifecycle derivation and remove
   `runCompletedNormally` / `finishRun(expectedRunId)` dependency.
5. Migrate tests/helpers away from `runState.phase` / `setRunController`
   assertions.
6. Delete `runState`, `runController`, `lastRunId`, `currentRun`, and
   `state.ts` only after no remaining reads.
7. Merge `dispatchPrompt` + `submitViaOpencodeQueue` in a follow-up step.

## Execution phases (explicit)

Use these phases as the implementation contract. Do not start a later phase
until the current phase has passing checks.

### Phase 0 — Fixture baseline and pure API contract

**Goal:** lock deterministic event-stream inputs and pure function signatures
before touching runtime behavior.

**Steps:**
1. Keep committed fixtures under
   `discord/src/session-handler/event-stream-fixtures/*.jsonl`.
2. Define pure function API in a new module (for example
   `event-stream-state.ts`) that accepts only data args (`events`,
   `sessionId`, indexes/options).
3. Define fixture test matrix (fixture -> function -> expected output shape).

**Done when:** fixture files are committed, pure function signatures are fixed,
and there is no runtime-class dependency in function inputs.

### Phase 1 — Pure derivation implementation + fixture tests

**Goal:** compute lifecycle decisions from event arrays only.

**Steps:**
1. Implement pure derivation functions (`isSessionBusy`,
   `wasRecentlyAborted`, `getRunStartTimeForIdle`, `getLatestRunInfo`,
   `shouldEmitFooter`, `isDerivedSubtaskSession`) in the pure module.
2. Add fixture-driven unit tests that parse JSONL fixtures and assert derived
   values for hardcoded scenario checkpoints.
3. Keep runtime unchanged except optional temporary wrappers.

**Done when:** pure tests pass using only fixture input; no class/store access.

### Phase 2 — Runtime reads switched to pure helpers (no deletions yet)

**Goal:** route runtime decisions through pure helpers while preserving current
state fields as fallback.

**Steps:**
1. Replace runtime methods that read mirrored state (`isSessionBusy`,
   abort/footer decision, latest run info) with calls to pure helpers.
2. Remove `clearEventBuffer()` from dispatch path once idle/footer no longer
   depends on `runCompletedNormally()`.
3. Keep `runState`/`runController` fields present but not authoritative.

**Done when:** runtime behavior matches fixture expectations in e2e tests with
no regressions in footer/abort ordering.

### Phase 3 — State deletion from store/runtime

**Goal:** remove mirrored run lifecycle state from store.

**Steps:**
1. Remove `runState`, `lastRunId`, `currentRun`, `runController` from
   `ThreadRunState`.
2. Delete `session-handler/state.ts` and `state.test.ts`.
3. Remove store helpers tied to deleted fields (`updateRunState`,
   `setRunController`, phase selectors).

**Done when:** repo has zero references to removed fields/types.

### Phase 4 — Abort/dispatch simplification and command safety

**Goal:** make abort semantics rely on opencode events + `session.abort()`.

**Steps:**
1. Simplify `/abort` and runtime abort paths to API abort behavior.
2. Keep `session.command()` blocking path with explicit timeout guard.
3. Merge `dispatchPrompt` and `submitViaOpencodeQueue` only after parity is
   proven in previous phases.

**Done when:** abort scenarios and queue drain pass without run-controller
dependencies.

### Phase 5 — Logging schema + test harness cleanup

**Goal:** align debug logs and tests with event-sourced model.

**Steps:**
1. Remove mirrored-state fields from event-log payload (`runPhase`,
   `latestAssistantMessageId`, `assistantMessageCount`).
2. Update test helpers/e2e assertions to avoid `runState.phase` checks.
3. Add missing `session-with-tasks.jsonl` fixture and corresponding pure tests
   for subtask classification.

**Done when:** test suite references event-derived assertions only.

Required guardrails before deleting state fields:

- Replace remaining `runState.phase` reads in retry/abort/error paths
  (notably `retryLastUserPrompt()`).
- Replace `runController`-based abort classification in `handleSessionError()`
  and cleanup in `dispose()`.
- Replace assistant-message-ID-based flush targeting in `showInteractiveUi()`
  with event-derived/latest-message behavior.
- Do not introduce `dispatchTimeQueue`; derive footer time from lifecycle
  events to avoid new mutable per-run state.
- Keep command-path behavior safe (no action-queue starvation) while
  `session.command()` remains blocking.
- Update session event logging payload/type to remove
  `runPhase`/`latestAssistantMessageId`/`assistantMessageCount` coupling.

Expected scenario behavior that the plan must preserve:

- Normal single message completion shows footer.
- Two rapid promptAsync turns both show footers with per-turn durations.
- Abort mid-run shows no footer.
- Abort during setup does not stall queue draining.
- Permission pause/resume still produces footer when run resolves.
- Subtask idle never triggers false main-session footer.
- SSE reconnect remains best-effort until explicit reconciliation is added.

## Files changed

| File | Change |
|---|---|
| `session-handler/state.ts` | **Delete** |
| `session-handler/state.test.ts` | **Delete** (tests pure transition functions that no longer exist) |
| `session-handler/thread-runtime-state.ts` | Remove `runState`, `lastRunId`, `currentRun`, `runController`. Remove `isRunActive`, `canDispatchNext`, `isBusy`, `updateRunState`, `setRunController`. Remove `CurrentRunInfo`, `SubtaskInfo` types (move to runtime). |
| `session-handler/thread-session-runtime.ts` | Add derivation methods + lifecycle buffer. Simplify `handleSessionIdle`, `handleMainPart`, `handleMessageUpdated`, `submitViaOpencodeQueue`, `dispatchPrompt`. Remove auto-promotion. Remove `runController` usage. Merge dispatch paths. Update typing restart guard. |
| `commands/abort.ts` | Simplify to `session.abort()` + clear dispatch flag |
| `commands/model.ts` | Update `ensureSessionPreferencesSnapshot` — remove `runState` reads if any |
| `commands/queue.ts` | Update queue display — no `isRunActive` check |
| `test-utils.ts` | Remove `waitForThreadPhase`, `MainRunPhase` imports, `runState.phase` reads |
| `thread-queue-advanced.e2e.test.ts` | Update: remove `setRunController` refs, `runState.phase` assertions. Replace with content-based assertions (wait for footer message). |
| `thread-message-queue.e2e.test.ts` | Update: remove `runState.phase` assertions |
| `voice-message.e2e.test.ts` | Update: remove `runState.phase` assertions |
| `session-handler/opencode-session-event-log.ts` | Update: remove `runPhase`, `latestAssistantMessageId`, `assistantMessageCount` fields from event log payload (or derive from lifecycle buffer) |
| `session-handler/event-stream-fixtures/*.jsonl` | New committed event-stream fixtures captured from deterministic e2e runs; used as stable inputs for pure state-derivation tests. |

## Testing

**Existing tests requiring update:**
- `thread-queue-advanced.e2e.test.ts` — Remove `runState.phase` assertions.
  Replace with content-based assertions (e.g. wait for footer message in
  thread). Remove `setRunController` references.
- `thread-message-queue.e2e.test.ts` — Same phase assertion removal.
- `voice-message.e2e.test.ts` — Same phase assertion removal.
- `state.test.ts` — Delete alongside `state.ts`.

**Event-stream fixture baseline (generated and committed):**

- `session-normal-completion.jsonl`
  - source: `runtime-lifecycle.e2e.test.ts` (`footer includes context percentage and model id`)
  - validates: busy/idle derivation, latest run info derivation, footer allowed.
- `session-two-completions-same-session.jsonl`
  - source: `queue-advanced-footer.e2e.test.ts` (`footer appears after second message in same session`)
  - validates: two consecutive run windows in same session, per-idle footer decision.
- `session-user-interruption.jsonl`
  - source: `queue-advanced-footer.e2e.test.ts` (`interrupted run has no footer, completed follow-up has footer`)
  - validates: interrupted run suppresses footer, follow-up run emits footer.
- `session-explicit-abort.jsonl`
  - source: `queue-advanced-abort.e2e.test.ts` (`explicit abort emits MessageAbortedError and does not emit footer`)
  - validates: `wasRecentlyAborted` derivation.
- `session-concurrent-messages-serialized.jsonl`
  - source: `runtime-lifecycle.e2e.test.ts` (`two near-simultaneous messages to same thread serialize correctly`)
  - validates: lifecycle derivation under near-concurrent prompts.
- `session-tool-call-noisy-stream.jsonl`
  - source: `thread-message-queue.e2e.test.ts` (`bash tool-call actually executes and creates file in project directory`)
  - validates: derivation robustness under dense tool/part event noise.
- `session-voice-queued-followup.jsonl`
  - source: `voice-message.e2e.test.ts` (`voice message with queueMessage=true queues behind running session`)
  - validates: queued follow-up run lifecycle and footer decision.

**Pure tests to add (built on fixtures, not class state):**

- Add pure module functions (no runtime class methods):
  - `isSessionBusy({ events, sessionId, upToIndex? })`
  - `wasRecentlyAborted({ events, sessionId, idleEventIndex })`
  - `getRunStartTimeForIdle({ events, sessionId, idleEventIndex })`
  - `getLatestRunInfo({ events, sessionId, upToIndex? })`
  - `shouldEmitFooter({ events, sessionId, idleEventIndex })`
  - `isDerivedSubtaskSession({ events, mainSessionId, candidateSessionId, upToIndex? })`
- Add fixture-driven tests that load `event-stream-fixtures/*.jsonl`, pass hardcoded
  params (session alias + idle index), and assert deterministic results via
  inline snapshots.

**Still needed fixture/test:**

- `session-with-tasks.jsonl` from a dedicated deterministic e2e scenario that
  actually emits Task-subagent session events. This is required to verify
  subtask detection is derived purely from event history.
