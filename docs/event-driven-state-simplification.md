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

Remove the local phase state machine. Derive all run lifecycle decisions from
the SSE event buffer using pure functions. Switch the local-queue dispatch
path from blocking `session.prompt()` to fire-and-forget `session.promptAsync()`
to unify both paths and eliminate `runController`.

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

### 3. Move per-run mechanism state to the class

**File: `discord/src/session-handler/thread-session-runtime.ts`**

Add to class fields (single-owner mechanism, not shared state):

```ts
// Per-dispatch tracking — set on each promptAsync call, read on footer.
// Stored as a queue so rapid A/B dispatches each get correct durations.
// Dequeued on each session.idle to produce the footer for that response.
private dispatchTimeQueue: number[] = []
// Subtask routing — maps child sessionId → label + Discord message ID
private subtaskSessions = new Map<string, SubtaskInfo>()
// Subtask naming — counts spawns per agent type
private agentSpawnCounts: Record<string, number> = {}
// UI throttle: context usage percentage last shown
private lastDisplayedContextPercentage = 0
// UI throttle: last rate-limit message timestamp
private lastRateLimitDisplayTime = 0
```

These were in `CurrentRunInfo` in the store. They move to the class because
they have a single owner (the runtime instance) and are never read by external
code.

**NOTE: `lastDispatchTime` is a queue, not a single scalar.** When messages
A and B are dispatched via promptAsync in rapid succession, each pushes its
`Date.now()` onto `dispatchTimeQueue`. When `session.idle` fires for A's
completion, the queue head is dequeued for A's footer. Then B's idle dequeues
the next entry. This ensures each footer shows the correct duration.

### 4. Split event buffer: lifecycle ring + general ring

**File: `discord/src/session-handler/thread-session-runtime.ts`**

The current 100-event buffer can lose lifecycle events (`session.idle`,
`session.status`, `session.error`) during long runs with many tool/part
events. The derivation functions depend on lifecycle events being present.

Split into two bounded buffers:

```ts
// All events — used for part routing, subtask detection, general queries
private static EVENT_BUFFER_MAX = 100
private eventBuffer: Array<{ event: OpenCodeEvent; timestamp: number }> = []

// Lifecycle events only (session.idle, session.status, session.error)
// Smaller set, never evicted by part events. 50 is more than enough since
// each run produces ~3 lifecycle events (busy, idle, maybe error).
private static LIFECYCLE_BUFFER_MAX = 50
private lifecycleBuffer: Array<{ event: OpenCodeEvent; timestamp: number }> = []
```

On each event:
- Always push to `eventBuffer` (cap at 100)
- If event is `session.idle`, `session.status`, or `session.error`: also
  push to `lifecycleBuffer` (cap at 50)

The derivation functions (`isSessionBusy`, `wasRecentlyAborted`) scan
`lifecycleBuffer` instead of `eventBuffer`. This guarantees lifecycle events
are never lost, regardless of how many tool/part events arrive.

### 5. Add pure derivation functions over event buffers

**File: `discord/src/session-handler/thread-session-runtime.ts`** (private methods)

```ts
// Derive whether the session is currently busy from the lifecycle buffer.
// Scans backward for the most recent session-scoped lifecycle event.
private isSessionBusy(): boolean {
  const sessionId = this.state?.sessionId
  if (!sessionId) return false
  for (let i = this.lifecycleBuffer.length - 1; i >= 0; i--) {
    const e = this.lifecycleBuffer[i].event
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
// lifecycle buffer. So we must skip the current idle and look at what
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
  for (let i = this.lifecycleBuffer.length - 1; i >= 0; i--) {
    const e = this.lifecycleBuffer[i].event
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
  // Check subtask BEFORE main session — subtask sessions have different IDs
  // from the main sessionId, so this branch handles them first.
  if (this.subtaskSessions.has(idleSessionId)) {
    this.subtaskSessions.delete(idleSessionId)
    return
  }

  // ── Main session idle ───────────────────────────────────
  if (idleSessionId !== sessionId) return

  const aborted = this.wasRecentlyAborted()
  this.stopTyping()
  await this.flushAllBufferedParts()

  const dispatchTime = this.dispatchTimeQueue.shift()
  if (!aborted && dispatchTime) {
    await this.emitFooter({ dispatchTime })
  }

  // Reset per-run state
  this.lastDisplayedContextPercentage = 0
  this.lastRateLimitDisplayTime = 0
  this.subtaskSessions.clear()
  this.agentSpawnCounts = {}

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

Just: ensure session → resolve model/agent → build parts → push `Date.now()`
onto `dispatchTimeQueue` → call `promptAsync`.

The event listener handles everything from there — `session.status busy`
confirms the run started, SSE events stream parts, `session.idle` triggers
footer + queue drain.

### 13. Merge `dispatchPrompt` and `submitViaOpencodeQueue`

After steps 8 and 12, both methods do the same thing:
1. `ensureSession()`
2. Resolve model/agent/variant
3. Build system message and parts
4. Push dispatch time
5. Call `promptAsync()`

Merge into a single private method. The `enqueueIncoming` entry point becomes:
- `mode === 'local-queue'` or has `command` → enqueue in `queueItems`, drain
  calls the unified dispatch
- `mode === 'opencode'` (default) → call the unified dispatch directly

### 14. Update typing restart guard

**File: `discord/src/session-handler/thread-session-runtime.ts`** (line 797)

The `scheduleTypingRestart` method currently checks `runState.phase !== 'running'`
to avoid restarting typing after a run ends. Replace with:

```ts
if (!this.isSessionBusy()) return
```

## Event buffer considerations

- **Buffer split:** Lifecycle events are duplicated into a separate 50-entry
  ring buffer. This prevents `isSessionBusy` / `wasRecentlyAborted` from
  failing during long runs with many tool/part events that would evict
  lifecycle events from the general 100-entry buffer.

- **SSE reconnect:** On reconnect, events may have been missed. This is an
  existing risk that affects the current architecture equally. The existing
  TODO (line 540) for reconnect reconciliation applies to both approaches.
  After reconnect, the lifecycle buffer may be stale. A conservative fallback:
  if `isSessionBusy()` returns false (no lifecycle events in buffer), call
  `session.get()` to check actual session status before draining the queue.

- **Multiple idle events:** If opencode processes queued prompts back-to-back,
  each completed response emits its own `session.idle`. Each dequeues from
  `dispatchTimeQueue` and gets its own footer with the correct duration.

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

## Testing

**Existing tests requiring update:**
- `thread-queue-advanced.e2e.test.ts` — Remove `runState.phase` assertions.
  Replace with content-based assertions (e.g. wait for footer message in
  thread). Remove `setRunController` references.
- `thread-message-queue.e2e.test.ts` — Same phase assertion removal.
- `voice-message.e2e.test.ts` — Same phase assertion removal.
- `state.test.ts` — Delete alongside `state.ts`.

**New tests to add:**
- Unit tests for `isSessionBusy()`, `wasRecentlyAborted()`, `getLatestRunInfo()`
  with synthetic event arrays. Cover:
  - Normal completion: `[busy, idle]` → not aborted
  - Abort: `[busy, error(MessageAbortedError), idle]` → aborted
  - Non-abort error: `[busy, error(Other), idle]` → not aborted
  - Empty buffer → not busy, not aborted
  - Multiple sessions interleaved → only matches target session
- E2e test: send two messages rapidly via promptAsync, verify both get
  footers with correct ordering.
- E2e test: abort during session setup (before promptAsync), verify no
  footer and queue drains correctly.
- E2e test: long run with >100 tool call events, verify footer still appears
  (lifecycle buffer not evicted).
- E2e test: `session.command()` timeout — verify thread gets error message
  and queue is not permanently stalled.
- E2e test: subtask idle followed by main session idle — verify only main
  idle produces footer.
- E2e test: SSE reconnect during active run — verify run completes with
  footer after reconnect.
