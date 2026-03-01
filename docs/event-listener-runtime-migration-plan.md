---
title: Event Listener Runtime Migration Plan
description: >-
  Detailed migration blueprint for moving Kimaki Discord session handling
  to one long-lived OpenCode event listener per thread runtime with
  centralized Zustand state updates. Hardened with feasibility review,
  concrete code snippets, file-by-file refactor map, and staged
  acceptance criteria.
prompt: |
  [38m since last message | UTC: 2026-03-01 15:39:12 UTC | Local
  (Europe/Rome): 03/01/2026, 16:39]create a detailed plan markdown file
  of how the new architecture should work. reference opencode files to
  take inspiration from. make it detailed enough so that new agents will
  be able to do this migration. then ask oracle for a review of the plan.
  ---
  Hardened by feasibility review: read session-handler.ts (2668 lines),
  state.ts (232 lines), discord-bot.ts (1228 lines), and all 9 command
  modules. Identified blockers, added concrete TypeScript snippets,
  file-by-file refactor map, and staged acceptance criteria.
references:
  - @discord/src/session-handler.ts
  - @discord/src/session-handler/state.ts
  - @discord/src/discord-bot.ts
  - @discord/src/commands/queue.ts
  - @discord/src/commands/abort.ts
  - @discord/src/commands/action-buttons.ts
  - @discord/src/commands/merge-worktree.ts
  - @discord/src/commands/restart-opencode-server.ts
  - @discord/src/commands/model.ts
  - @discord/src/commands/unset-model.ts
  - @discord/src/commands/permissions.ts
  - @discord/src/commands/ask-question.ts
  - @discord/src/commands/file-upload.ts
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

## 4. Feasibility assessment

### 4.1 Verdict: feasible with six identified blockers

After reading the full source (`session-handler.ts` 2668 lines, `state.ts`
232 lines, `discord-bot.ts` 1228 lines, and 9 command modules), the migration
is **feasible**. No architectural show-stopper exists. The blockers below are
all solvable within the staged plan.

### 4.2 Blockers and resolutions

**B1: Monolithic handleOpencodeSession (2668 lines)**

The function owns both event listener AND prompt dispatch in a single scope.
All local variables (partBuffer, sentPartIds, typingInterval, subtaskSessions,
usedModel, etc.) are closures over the function scope.

Resolution: Extract into a ThreadSessionRuntime class where:
- Event listener loop is a long-lived method (`startEventListener`)
- Prompt dispatch is a separate method (`dispatchNextQueueItem`)
- Closure state becomes instance fields and runtime-owned refs

**B2: Queue drain via recursive handleOpencodeSession calls**

Lines 2330-2374 (after run completion) and 2018-2067 (after question shown
with queued messages) call `handleOpencodeSession` recursively via
`setImmediate`. Each recursive call creates a NEW event listener.

Resolution: Queue drain becomes a state transition. When run ends or blocker
resolves, the runtime checks `canDispatchNext` and calls `dispatchNextQueueItem`
which sends the prompt through the existing listener — no recursion, no new
event subscription.

**B3: Single AbortController for both listener and run**

Current code (line 1186-1189) passes the run abort controller to
`event.subscribe()`. Aborting the run kills the listener.

Resolution: Two separate AbortControllers:
- `listenerController`: only aborted on runtime dispose or reconnect
- `runController`: aborted on run interrupt/finish, does NOT affect listener

The prompt/command call passes `runController.signal`. The event.subscribe
call passes `listenerController.signal`.

**B4: activeEventHandlers serialization map**

`activeEventHandlers` (line 274) ensures overlapping per-message handlers
don't collide. In the new model, there is exactly one listener per thread
runtime — this map becomes unnecessary.

Resolution: Delete the map. The runtime IS the single handler.

**B5: pendingPermissions is a module-level global**

`pendingPermissions` (line 213-226) is used inside the event handler AND
by the ingress code that auto-rejects permissions on new messages (lines
971-1011). It needs to be per-runtime, not global.

Resolution: Move to runtime refs (not Zustand — it's operational context,
not domain state). The runtime exposes `getPendingPermissions()` and
`clearPendingPermissions()` methods.

**B6: threadMessageQueue vs messageQueue dual-queue confusion**

`threadMessageQueue` in discord-bot.ts (line 123) serializes Discord message
arrival order. `messageQueue` in session-handler.ts (line 272)
is the /queue backlog. Both exist because the current model needs arrival-order
serialization OUTSIDE of the session handler.

Resolution: Keep `threadMessageQueue` as the ingress serialization layer in
discord-bot.ts during the migration. After Phase 3, it can optionally be folded
into the runtime's ingress. The `messageQueue` global becomes `queueItems` in
the runtime store.

### 4.3 Non-blockers (confirmed compatible)

- `state.ts` MainRunStore is already Zustand-based — reuse directly
- `event.subscribe` returns an async iterable, can be kept alive indefinitely
- SDK types support `{ signal: AbortSignal }` option separately for subscribe
  and for prompt/command calls
- permissions.ts, ask-question.ts, file-upload.ts have their own context maps
  and do NOT import session-handler globals — no migration needed for them
- model.ts only calls `abortAndRetrySession` — easily adapted to runtime API

## 5. Target architecture

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

## 6. Runtime modules to introduce

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

4. `runtime-effects.ts` (optional — can inline effects in event handlers)
   - subscribe reactor that performs Discord/OpenCode side effects
   - typing timer lifecycle
   - permission/question/action rendering triggers
   - NOTE: a separate effects file with `store.subscribe()` is optional.
     Effects can be called directly from event handlers after state
     transitions if that is simpler. Only extract to a subscribe reactor
     if debugging or testability demands it.

5. `runtime-types.ts`
   - shared types for ingress items, run reason enums, lifecycle enums

`session-handler.ts` remains public adapter for backward compatibility, but most
logic moves into runtime modules.

## 7. Concrete code snippets

### 7.1 Runtime registry shape and API

```ts
// discord/src/session-handler/runtime-registry.ts
import type { ThreadChannel } from 'discord.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const runtimes = new Map<string, ThreadSessionRuntime>()

export function getRuntime(threadId: string): ThreadSessionRuntime | undefined {
  return runtimes.get(threadId)
}

export function getOrCreateRuntime({
  threadId,
  thread,
  projectDirectory,
  sdkDirectory,
  channelId,
  appId,
}: {
  threadId: string
  thread: ThreadChannel
  projectDirectory: string
  sdkDirectory: string
  channelId?: string
  appId?: string
}): ThreadSessionRuntime {
  const existing = runtimes.get(threadId)
  if (existing) {
    return existing
  }
  const runtime = new ThreadSessionRuntime({
    threadId,
    thread,
    projectDirectory,
    sdkDirectory,
    channelId,
    appId,
  })
  runtimes.set(threadId, runtime)
  return runtime
}

export function disposeRuntime(threadId: string): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) {
    return
  }
  runtime.dispose()
  runtimes.delete(threadId)
}

/** Dispose runtimes matching directory AND optional channelId scope.
 *  When channelId is provided, only runtimes in that channel are disposed.
 *  This prevents restart-opencode-server in one channel from killing
 *  runtimes in other channels that share the same projectDirectory. */
export function disposeRuntimesForDirectory({
  directory,
  channelId,
}: {
  directory: string
  channelId?: string
}): void {
  for (const [threadId, runtime] of runtimes) {
    if (runtime.projectDirectory !== directory) {
      continue
    }
    if (channelId && runtime.channelId !== channelId) {
      continue
    }
    runtime.dispose()
    runtimes.delete(threadId)
  }
}

export function getAllRuntimes(): ReadonlyMap<string, ThreadSessionRuntime> {
  return runtimes
}
```

### 7.2 Per-thread runtime store shape (derived-first)

```ts
// discord/src/session-handler/runtime-store.ts
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { QueuedMessage } from './runtime-types.js'
import type { MainRunState } from './state.js'

// NOTE: MainRunStore (from state.ts) is kept as a SEPARATE runtime field,
// not embedded in RuntimeState. This avoids adapter glue — existing
// transition helpers (beginPromptCycle, markDispatching, etc.) require
// StoreApi<MainRunState> directly.
//
// The runtime class holds:
//   this.store: RuntimeStore      (queue + blockers + sessionId)
//   this.mainRunStore: MainRunStore  (run lifecycle, reused as-is)

export type RuntimeState = {
  // Mutable identity needed for event demux.
  // Set when session is created/discovered, stable across runs.
  sessionId: string | undefined

  // Ingress backlog — the /queue items.
  queueItems: QueuedMessage[]

  // Queue blocking policy state — counts of pending interactive prompts.
  blockers: {
    permissionCount: number
    questionCount: number
    actionButtonsPending: boolean
    fileUploadPending: boolean
  }
}

export type RuntimeStore = StoreApi<RuntimeState>

// ── Derived selectors (never store these) ────────────────────────
// These take both stores since run phase lives in MainRunStore.

export function isRunActive(runState: MainRunState): boolean {
  const phase = runState.phase
  return (
    phase === 'collecting-baseline' ||
    phase === 'dispatching' ||
    phase === 'prompt-resolved'
  )
}

export function hasQueue(state: RuntimeState): boolean {
  return state.queueItems.length > 0
}

export function hasBlockers(state: RuntimeState): boolean {
  const b = state.blockers
  return (
    b.permissionCount > 0 ||
    b.questionCount > 0 ||
    b.actionButtonsPending ||
    b.fileUploadPending
  )
}

export function canDispatchNext({
  state,
  runState,
}: {
  state: RuntimeState
  runState: MainRunState
}): boolean {
  return (
    state.sessionId !== undefined &&
    hasQueue(state) &&
    !isRunActive(runState) &&
    !hasBlockers(state)
  )
}

export function isBusy({
  state,
  runState,
}: {
  state: RuntimeState
  runState: MainRunState
}): boolean {
  return isRunActive(runState) || hasQueue(state)
}

// ── Store factory ────────────────────────────────────────────────

function initialRuntimeState(): RuntimeState {
  return {
    sessionId: undefined,
    queueItems: [],
    blockers: {
      permissionCount: 0,
      questionCount: 0,
      actionButtonsPending: false,
      fileUploadPending: false,
    },
  }
}

export function createRuntimeStore(): RuntimeStore {
  return createStore<RuntimeState>(() => {
    return initialRuntimeState()
  })
}

// ── Pure transition functions ────────────────────────────────────

export function enqueueItem(
  store: RuntimeStore,
  item: QueuedMessage,
): void {
  store.setState((s) => {
    return {
      ...s,
      queueItems: [...s.queueItems, item],
    }
  })
}

export function dequeueItem(
  store: RuntimeStore,
): QueuedMessage | undefined {
  const state = store.getState()
  if (state.queueItems.length === 0) {
    return undefined
  }
  const [next, ...rest] = state.queueItems
  store.setState((s) => {
    return { ...s, queueItems: rest }
  })
  return next
}

export function clearQueueItems(store: RuntimeStore): void {
  store.setState((s) => {
    return { ...s, queueItems: [] }
  })
}

export function setSessionId(
  store: RuntimeStore,
  sessionId: string,
): void {
  store.setState((s) => {
    return { ...s, sessionId }
  })
}

export function incrementBlocker(
  store: RuntimeStore,
  blocker: 'permissionCount' | 'questionCount',
): void {
  store.setState((s) => {
    return {
      ...s,
      blockers: {
        ...s.blockers,
        [blocker]: s.blockers[blocker] + 1,
      },
    }
  })
}

export function decrementBlocker(
  store: RuntimeStore,
  blocker: 'permissionCount' | 'questionCount',
): void {
  store.setState((s) => {
    return {
      ...s,
      blockers: {
        ...s.blockers,
        [blocker]: Math.max(0, s.blockers[blocker] - 1),
      },
    }
  })
}

export function setBlockerFlag(
  store: RuntimeStore,
  flag: 'actionButtonsPending' | 'fileUploadPending',
  value: boolean,
): void {
  store.setState((s) => {
    return {
      ...s,
      blockers: { ...s.blockers, [flag]: value },
    }
  })
}
```

### 7.3 Event listener loop + sessionID demux guard

```ts
// Inside ThreadSessionRuntime class
// discord/src/session-handler/thread-session-runtime.ts

private listenerController = new AbortController()
private runController: AbortController | null = null

async startEventListener(): Promise<void> {
  const client = getOpencodeClient(this.projectDirectory)
  if (!client) {
    throw new Error(
      `No OpenCode client for directory: ${this.projectDirectory}`,
    )
  }

  // Reconnect loop with backoff
  let backoffMs = 500
  const maxBackoffMs = 30_000

  while (!this.listenerController.signal.aborted) {
    const subscribeResult = await errore.tryAsync(() => {
      return client.event.subscribe(
        { directory: this.sdkDirectory },
        { signal: this.listenerController.signal },
      )
    })

    if (subscribeResult instanceof Error) {
      if (isAbortError(subscribeResult)) {
        return // disposed
      }
      logger.warn(
        `[LISTENER] Subscribe failed, retrying in ${backoffMs}ms:`,
        subscribeResult.message,
      )
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    backoffMs = 500 // reset on success
    const events = subscribeResult.stream

    const iterResult = await errore.tryAsync(async () => {
      for await (const event of events) {
        await this.handleEvent(event)
      }
    })

    if (iterResult instanceof Error) {
      if (isAbortError(iterResult)) {
        return // disposed
      }
      logger.warn(
        `[LISTENER] Stream broke, reconnecting in ${backoffMs}ms:`,
        iterResult.message,
      )
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
  }
}

private async handleEvent(event: OpenCodeEvent): Promise<void> {
  const sessionId = this.store.getState().sessionId

  // ── Session demux guard ──────────────────────────────────────
  // Events scoped to a session must match the current session.
  // Global events (tui.toast.show) bypass the guard.
  // IMPORTANT: sessionID lives at different paths per event type:
  //   message.updated     → event.properties.info.sessionID
  //   message.part.updated → event.properties.part.sessionID
  //   session.*            → event.properties.sessionID
  //   permission.*         → event.properties.sessionID
  //   question.*           → event.properties.sessionID
  const eventSessionId = (() => {
    switch (event.type) {
      case 'message.updated':
        return event.properties.info?.sessionID as string | undefined
      case 'message.part.updated':
        return event.properties.part?.sessionID as string | undefined
      default:
        return event.properties?.sessionID as string | undefined
    }
  })()
  const isGlobalEvent = event.type === 'tui.toast.show'

  if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
    // Check subtask sessions before discarding
    if (!this.subtaskSessions.has(eventSessionId)) {
      return // stale event from previous session
    }
  }

  switch (event.type) {
    case 'message.updated':
      await this.handleMessageUpdated(event.properties.info)
      break
    case 'message.part.updated':
      await this.handlePartUpdated(event.properties.part)
      break
    case 'session.idle':
      this.handleSessionIdle(event.properties.sessionID)
      break
    case 'session.error':
      await this.handleSessionError(event.properties)
      break
    case 'permission.asked':
      await this.handlePermissionAsked(event.properties)
      break
    case 'permission.replied':
      this.handlePermissionReplied(event.properties)
      break
    case 'question.asked':
      await this.handleQuestionAsked(event.properties)
      break
    case 'session.status':
      await this.handleSessionStatus(event.properties)
      break
    case 'tui.toast.show':
      await this.handleTuiToast(event.properties)
      break
    default:
      break
  }
}
```

### 7.4 dispatchAction serialization queue pattern

```ts
// Inside ThreadSessionRuntime class
// Ensures all mutations (ingress + events) are serialized.

private actionQueue: Array<() => Promise<void>> = []
private processingAction = false

async dispatchAction(action: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    this.actionQueue.push(async () => {
      const result = await errore.tryAsync(action)
      if (result instanceof Error) {
        reject(result)
        return
      }
      resolve()
    })
    void this.processActionQueue()
  })
}

private async processActionQueue(): Promise<void> {
  if (this.processingAction) {
    return
  }
  this.processingAction = true
  while (this.actionQueue.length > 0) {
    const next = this.actionQueue.shift()!
    await next()
  }
  this.processingAction = false
}
```

### 7.5 Ingress adapter calls from discord-bot / commands

```ts
// discord/src/discord-bot.ts — thread message handler
// BEFORE (current):
//   signalThreadInterrupt({ threadId, serverDirectory, sdkDirectory })
//   handleOpencodeSession({ prompt, thread, ... })
//
// AFTER:
import { getOrCreateRuntime } from './session-handler/runtime-registry.js'

async function processThreadMessage() {
  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    return
  }
  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: parent?.id,
    appId: currentAppId,
  })

  // Normal message: interrupt active run, then enqueue
  await runtime.enqueueIncoming({
    prompt: messageContent,
    userId: message.author.id,
    username: message.member?.displayName || message.author.displayName,
    images: fileAttachments,
    appId: currentAppId,
    interruptActive: true,
  })
}

// discord/src/commands/queue.ts — /queue command
// BEFORE: abortControllers.get(sessionId), addToQueue(...)
// AFTER:
import { getRuntime } from '../session-handler/runtime-registry.js'

const runtime = getRuntime(thread.id)
if (!runtime) {
  // No runtime = no active session, start one
  // ...existing fallback to handleOpencodeSession or
  //    getOrCreateRuntime + enqueue
}
runtime.enqueueIncoming({
  prompt,
  userId,
  username,
  interruptActive: false, // /queue does NOT interrupt
})

// discord/src/commands/abort.ts — /abort command
// BEFORE: abortControllers.get(sessionId)?.abort(...)
// AFTER:
const runtime = getRuntime(thread.id)
if (!runtime) {
  await interaction.followUp({ content: 'No active session' })
  return
}
runtime.abortActiveRun('user-abort')

// discord/src/commands/model.ts — model change mid-run
// BEFORE: abortAndRetrySession({ sessionId, thread, ... })
// AFTER:
const runtime = getRuntime(thread.id)
if (runtime) {
  await runtime.retryLastUserPrompt()
}

// discord/src/commands/restart-opencode-server.ts
// BEFORE: iterate abortControllers, find matching sessions
// AFTER:
import { disposeRuntimesForDirectory } from
  '../session-handler/runtime-registry.js'

// Pass channelId to scope disposal — don't kill runtimes in other channels
disposeRuntimesForDirectory({ directory: projectDirectory, channelId })
await restartOpencodeServer(projectDirectory)
```

### 7.6 Queue drain + blocker guard logic

```ts
// Inside ThreadSessionRuntime class

/** Called after run finishes OR after a blocker resolves. */
private async tryDrainQueue(): Promise<void> {
  const state = this.store.getState()
  if (!canDispatchNext(state)) {
    return
  }

  const next = dequeueItem(this.store)
  if (!next) {
    return
  }

  logger.log(
    `[QUEUE DRAIN] Processing queued message from ${next.username}`,
  )

  // Show queued message indicator
  const displayText = next.command
    ? `/${next.command.name}`
    : `${next.prompt.slice(0, 150)}${next.prompt.length > 150 ? '...' : ''}`
  await sendThreadMessage(
    this.thread,
    `» **${next.username}:** ${displayText}`,
  )

  // Dispatch through the existing listener — NO new event.subscribe
  await this.dispatchPrompt({
    prompt: next.prompt,
    images: next.images,
    username: next.username,
    userId: next.userId,
    appId: next.appId,
    command: next.command,
  })
}

/** Called from event handler when session.idle arrives and run finishes. */
private onRunFinished(): void {
  // Emit footer first, then try to drain queue
  void this.emitFooter().then(() => {
    return this.tryDrainQueue()
  })
}

/** Called when a permission/question blocker resolves. */
private onBlockerResolved(): void {
  void this.tryDrainQueue()
}
```

## 8. File-by-file refactor map

### Files to CREATE

| New file | What goes in it | Extracted from |
|---|---|---|
| `discord/src/session-handler/runtime-registry.ts` | Runtime Map, get/create/dispose | new code |
| `discord/src/session-handler/runtime-store.ts` | RuntimeState, selectors, transitions | new + state.ts concepts |
| `discord/src/session-handler/thread-session-runtime.ts` | Runtime class: listener loop, dispatch, event handlers | session-handler.ts lines 1186-2382 |
| `discord/src/session-handler/runtime-effects.ts` | Subscribe reactor: typing, parts, footer, UI triggers | session-handler.ts lines 1234-1370, 2231-2327 |
| `discord/src/session-handler/runtime-types.ts` | QueuedMessage, IngressOptions, RunFinishInfo types | session-handler.ts lines 259-268 |

### Files to MODIFY

| File | What changes | Lines affected |
|---|---|---|
| `session-handler.ts` | Remove: `abortControllers`, `messageQueue`, `activeEventHandlers`, `pendingPermissions` globals. `handleOpencodeSession` becomes thin adapter calling runtime. Keep exported API signatures (`queueOrSendMessage`, `abortAndRetrySession`, `signalThreadInterrupt`) as wrappers over runtime-registry calls. | Lines 86, 213-226, 272-274 (globals), lines 783-2668 (main function) |
| `session-handler/state.ts` | No changes. `MainRunStore` is reused as-is inside `RuntimeState.runState`. | None |
| `discord-bot.ts` | Replace `handleOpencodeSession` calls with `getOrCreateRuntime` + `enqueueIncoming`. Remove `signalThreadInterrupt` calls (runtime handles interrupt internally). Keep `threadMessageQueue` as ingress serializer through Phase 3.5. | Lines 468-496 (thread queue), 551-565 (first session), 653-669 (existing session), 833-843 (channel message) |
| `commands/abort.ts` | Replace `abortControllers.get(sessionId)` with `getRuntime(threadId)?.abortActiveRun()`. | ~5 lines |
| `commands/queue.ts` | Replace `abortControllers`, `addToQueue`, `getQueueLength`, `clearQueue`, `queueOrSendMessage` with runtime API calls. | ~40 lines |
| `commands/action-buttons.ts` | Replace `abortControllers.get(sessionId)` + `addToQueue` + `handleOpencodeSession` with `getRuntime` + `enqueueIncoming`. | ~15 lines |
| `commands/merge-worktree.ts` | Replace `abortControllers.get(sessionId)` + `addToQueue` + `handleOpencodeSession` with `getRuntime` + `enqueueIncoming`. | ~15 lines |
| `commands/restart-opencode-server.ts` | Replace `abortControllers` iteration with `disposeRuntimesForDirectory()`. | ~20 lines |
| `commands/model.ts` | Replace `abortAndRetrySession` with `getRuntime(threadId)?.retryLastUserPrompt()`. | ~5 lines |
| `commands/unset-model.ts` | Replace `abortAndRetrySession` with `getRuntime(threadId)?.retryLastUserPrompt()`. | ~5 lines |
| `commands/permissions.ts` | No changes needed (self-contained with own context maps). | None |
| `commands/ask-question.ts` | No changes needed (self-contained). | None |
| `commands/file-upload.ts` | No changes needed (self-contained). | None |

### Files to DELETE (content moved)

No files are deleted. `session-handler.ts` shrinks dramatically but keeps its
exported API surface as thin wrappers.

## 9. Minimal centralized runtime state

Keep only irreducible state. If a value can be derived from existing state,
event payloads, or an on-demand API read, do not store it.

```ts
// RuntimeStore (Zustand) — queue + blockers + sessionId
type RuntimeState = {
  sessionId?: string
  queueItems: QueuedMessage[]
  blockers: {
    permissionCount: number
    questionCount: number
    actionButtonsPending: boolean
    fileUploadPending: boolean
  }
}

// MainRunStore (Zustand, separate) — run lifecycle
// Reused as-is from state.ts via createMainRunStore().
// Kept as a separate store field on the runtime class so existing
// transition helpers (beginPromptCycle, markDispatching, etc.) work
// without adapter glue.
```

### Runtime-owned refs/caches (not in Zustand)

Keep non-reactive implementation details as runtime fields (not store state):

- immutable thread metadata (`threadId`, `projectDirectory`, `sdkDirectory`)
- `mainRunStore: MainRunStore` (separate Zustand store for run lifecycle)
- listener abort controller and reconnect backoff counters
- run abort controller
- typing interval/restart timeout handles
- part buffer and dedupe sets (`sentPartIds`, `partBuffer`)
- transient subtask label/session maps
- `usedModel`, `usedProviderID`, `usedAgent`, `tokensUsedInSession`
  (per-run caches, reset on each new prompt dispatch)
- `lastDisplayedContextPercentage`, `lastRateLimitDisplayTime` (per-run)
- early-resolved agent/model snapshots (per-dispatch)

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

## 10. Runtime APIs (used by Discord handlers)

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

## 11. Event pipeline behavior

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

**Behavior change note:** Current code in `handleQuestionAsked` (session-handler.ts
line 2018) immediately drains the next queued message when a question is shown
(aborting the question). The plan changes this to block dispatch during blockers.
This is an intentional simplification — the current behavior is surprising (user
sees question, then it gets auto-dismissed by queue drain). Freeze this decision
before Phase 3 to avoid ambiguous regressions.

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

## 12. Event-to-state transition map

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

## 13. Migration phases

### Phase 0 - Baseline tests

Files:

- `@discord/src/thread-message-queue.e2e.test.ts`

Tasks:

- run existing queue/interrupt e2e tests to confirm green baseline
- document current behavior as reference for parity checks

Acceptance criteria:

- [ ] `pnpm tsc` passes inside `discord/`
- [ ] existing e2e tests green: `pnpm vitest --run src/thread-message-queue.e2e.test.ts`

### Phase 1 - Runtime skeleton and registry

Files:

- new `@discord/src/session-handler/runtime-registry.ts`
- new `@discord/src/session-handler/thread-session-runtime.ts`
- new `@discord/src/session-handler/runtime-store.ts`
- new `@discord/src/session-handler/runtime-types.ts`
- `@discord/src/session-handler.ts`

Tasks:

- add `runtime-types.ts` first — move `QueuedMessage` type there to avoid
  coupling runtime-store.ts back to session-handler.ts
- add runtime get/create registry (code from §7.1)
- add RuntimeStore with state shape and selectors (code from §7.2)
- add skeleton ThreadSessionRuntime class with empty method stubs, holding
  both `store: RuntimeStore` and `mainRunStore: MainRunStore` as fields
- add thin adapter in `handleOpencodeSession` that can route to runtime
- keep old flow behind compatibility switch while wiring APIs
- enforce state budget rule: every store field must document why it cannot be
  derived; reject fields that are only cache/telemetry

Acceptance criteria:

- [ ] `pnpm tsc` passes inside `discord/`
- [ ] `runtime-store.test.ts` covers: enqueue/dequeue, selector derivation,
  blocker increment/decrement, canDispatchNext edge cases
- [ ] no behavior change — old path still used

### Phase 2 - Long-lived listener + demux foundation

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/session-handler/runtime-store.ts`
- `@discord/src/session-handler/state.ts` (reuse transition logic)

Tasks:

- start one persistent `event.subscribe` loop per runtime (code from §7.3)
- add strict session demux guards for all run-scoped events
- implement internal serialized action queue (`dispatchAction`, code from §7.4)
- separate run abort controller from listener controller (blocker B3)
- move event handler logic from `session-handler.ts` eventHandler closure
  into runtime methods (handleMessageUpdated, handlePartUpdated, etc.)
- add reconnect reconciliation: after listener reconnect, fetch session
  status/messages snapshot to repair run state if events were missed

Key implementation detail — two abort controllers:
```ts
// listenerController: lives for runtime lifetime
// runController: per-prompt, aborted on interrupt/finish
this.runController = new AbortController()
// prompt call passes runController.signal
await client.session.prompt({...}, { signal: this.runController.signal })
// event.subscribe passes listenerController.signal
await client.event.subscribe({...}, { signal: this.listenerController.signal })
```

Acceptance criteria:

- [ ] `pnpm tsc` passes
- [ ] runtime unit test: start listener, send 2 prompts, listener stays alive
- [ ] runtime unit test: event with wrong sessionID is dropped (demux guard)
- [ ] no overlapping per-message handlers
- [ ] new message no longer restarts listener

### Phase 3 - Move ingress ownership to runtime

Files:

- `@discord/src/discord-bot.ts`
- `@discord/src/commands/queue.ts`
- `@discord/src/commands/action-buttons.ts`
- `@discord/src/commands/merge-worktree.ts`
- `@discord/src/session-handler.ts`

Tasks:

- route thread messages and queue-command through `runtime.enqueueIncoming`
  (code from §7.5)
- route interrupt path through `runtime.abortActiveRun`
- implement queue drain logic in runtime (code from §7.6)
- keep `threadMessageQueue` as temporary guard until parity gate passes

Acceptance criteria:

- [ ] `pnpm tsc` passes
- [ ] ingress paths use runtime APIs without behavior regressions
- [ ] e2e test: rapid B/C/D messages preserve order guarantees
- [ ] e2e test: `/queue` adds without interrupt

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

Acceptance criteria:

- [ ] parity suite green with runtime-only ingress
- [ ] counters show no duplicate listener starts per run
- [ ] `threadMessageQueue` removed from discord-bot.ts

### Phase 4 - Move command dependencies to runtime APIs

Files:

- `@discord/src/commands/abort.ts`
- `@discord/src/commands/restart-opencode-server.ts`
- `@discord/src/commands/queue.ts`
- `@discord/src/commands/model.ts`
- `@discord/src/commands/unset-model.ts`
- `@discord/src/commands/action-buttons.ts`
- `@discord/src/commands/merge-worktree.ts`

Tasks:

- replace global map reads with runtime calls (code from §7.5)
- migrate `abortAndRetrySession` to runtime retry API

Command-to-runtime API mapping:

| Command | Current global | Runtime API call |
|---|---|---|
| `/abort` | `abortControllers.get(sessionId)` | `getRuntime(threadId)?.abortActiveRun('user-abort')` |
| `/queue` | `abortControllers`, `addToQueue`, `getQueueLength`, `clearQueue` | `runtime.enqueueIncoming(...)`, `runtime.getQueueLength()`, `runtime.clearQueue()` |
| `/queue-command` | `addToQueue`, `handleOpencodeSession` | `runtime.enqueueIncoming({ command: {...} })` |
| action-buttons click | `abortControllers.get(sessionId)`, `addToQueue` | `runtime.enqueueIncoming({ interruptActive: false })` |
| merge-worktree conflict | `abortControllers.get(sessionId)`, `addToQueue`, `handleOpencodeSession` | `runtime.enqueueIncoming({ interruptActive: false })` |
| model change | `abortAndRetrySession(...)` | `runtime.retryLastUserPrompt()` |
| unset-model | `abortAndRetrySession(...)` | `runtime.retryLastUserPrompt()` |
| restart-opencode-server | iterate `abortControllers` | `disposeRuntimesForDirectory({ directory, channelId })` |

Acceptance criteria:

- [ ] `pnpm tsc` passes
- [ ] commands no longer import global mutable maps
- [ ] grep for `abortControllers` in commands/ returns 0 results
- [ ] grep for `messageQueue` in commands/ returns 0 results

### Phase 5 - Remove legacy globals and recursion

Files:

- `@discord/src/session-handler.ts`
- `@discord/src/discord-bot.ts`

Tasks:

- delete legacy maps (`abortControllers`, `messageQueue`, `activeEventHandlers`,
  `pendingPermissions`)
- delete recursive queue drain calls to `handleOpencodeSession`
- keep exported API signatures stable where possible (wrappers over registry)

Acceptance criteria:

- [ ] `pnpm tsc` passes
- [ ] runtime is sole owner of queue/run/listener state
- [ ] grep for `new Map` in session-handler.ts returns 0 module-level Maps
- [ ] all e2e tests green

### Phase 6 - Hardening and cleanup

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
Tasks:

- ensure typing interval + restart timeout cleanup in all terminal paths
- add reconnect backoff and stale runtime diagnostics
- implement mandatory runtime disposal on:
  - thread archive/delete
  - restart-opencode-server channel scope
  - bot shutdown (iterate registry, dispose all)
- remove temporary parity counters unless they're useful as permanent metrics

Acceptance criteria:

- [ ] no stuck typing
- [ ] listener survives multiple runs in same thread
- [ ] no leaked listeners/timers/controllers after dispose paths
- [ ] `handleShutdown` in discord-bot.ts disposes all runtimes

## 14. Side-effect reactor responsibilities

Side effects can be triggered directly from event handlers after state
transitions (simplest approach). A separate `store.subscribe()` reactor is
optional — only introduce it if testing or debugging requires decoupling
state transitions from effects. Either way, these responsibilities exist:

- Discord chunk sends for parts
- context usage notices and retry notices
- permission/question/action UI rendering
- final footer emission
- queue dequeue trigger when run transitions to terminal state
- typing indicator lifecycle

Avoid side effects in ingress handlers except initial ack messages.

## 15. Test plan

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
- action button click while busy queues correctly
- thread archive/delete disposes runtime cleanly

## 16. Risks and mitigation

### Migration-specific risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Listener reconnect storm** under provider outage | Medium | High — floods provider with subscribe calls | Bounded exponential backoff (500ms → 30s), max 3 reconnects per minute, log counter per runtime |
| **Stale runtimes** accumulating over long bot uptime | Low | Medium — memory/connection leak | Add optional TTL-based cleanup; dispose on thread archive event; log runtime count periodically |
| **Duplicate Discord output** from replayed parts after reconnect | Medium | High — confusing UX | Preserve `sentPartIds` across reconnects (it's a runtime ref, not reset); idempotent part flush |
| **Interaction deadlocks** (question pending + queue grows) | Low | High — session stuck forever | Blocker guard in `canDispatchNext`; ingress with `interruptActive: true` always aborts+enqueues regardless of blockers |
| **Regression during Phase 3** when ingress switches to runtime | High | High — broken queue ordering | Keep `threadMessageQueue` as safety net until Phase 3.5 parity gate passes with counters proving correctness |
| **handleOpencodeSession callers outside session-handler.ts** | Medium | Medium — compilation errors | Phase 1 keeps `handleOpencodeSession` as thin wrapper; callers migrated file-by-file in Phases 3-4 |
| **Two-controller abort race** (run controller fires, listener still open, events arrive for aborted run) | Medium | Medium — unexpected events processed | Session demux guard (§7.3) drops events for non-current sessionID. Mark runState as aborted/finished before aborting run controller. |
| **Session creation race** (two ingress arrive before session exists) | Low | Medium — double session creation | `dispatchAction` serialization (§7.4) ensures session create+set is atomic within the runtime |
| **Footer emission race** with queue drain | Low | Low — footer appears after next prompt starts | Footer emission is awaited in `onRunFinished` before calling `tryDrainQueue` |
| **Connection budget exhaustion** from long-lived SSE listeners | Medium | High — undici pool blocks regular HTTP calls | Monitor active listener count; undici pool is set to 500 connections (discord-bot.ts:113). Add runtime count metric; dispose stale runtimes proactively |
| **Channel-scope restart regression** | High | High — kills runtimes in wrong channels | `disposeRuntimesForDirectory` takes optional `channelId` to scope disposal (fixed in §7.1) |
| **Worktree/directory drift** — runtime retains stale sdkDirectory | Low | Medium — commands run in wrong directory | On each dispatch, re-resolve sdkDirectory from DB worktree metadata instead of caching at creation time |
| **Unbounded queue growth** under long blockers/outages | Low | Medium — memory + latency degradation | Add configurable max queue size (e.g. 50); reject with user message when exceeded |

### Pre-existing risks (unchanged)

- listener reconnect storm
  - use bounded backoff and log counters per runtime
- stale runtimes over long uptime
  - keep alive by design now; add optional stale cleanup later
- duplicate Discord output from replayed parts
  - preserve `sentPartIds` and idempotent part flush checks
- interaction deadlocks (question/permission + queued message)
  - queue decisions come from runtime transitions only

## 17. Open questions

1. **Should `threadMessageQueue` be absorbed into the runtime?**
   The plan keeps it as an external serialization layer through Phase 3.5.
   After parity, decide: keep it permanently (simpler, proven for arrival
   ordering) or move all pre-processing into runtime so serialization has
   one owner. Recommendation: keep external — it's simple and proven.

2. **Runtime lifecycle for notify-only threads.**
   Should a runtime be created for threads that only receive notification
   messages (no session)? No — only create runtimes lazily on first
   actionable session ingress.

3. **Queue policy on question.asked — block or drain?**
   Current code immediately drains the queue when question is shown,
   dismissing the question. The plan changes to blocking dispatch during
   pending blockers. This is an intentional behavior change that should
   be confirmed before Phase 3.

## 18. Final end-state checklist

- one long-lived event listener per thread runtime
- no per-message event subscribe in `handleOpencodeSession`
- no global queue/abort/handler maps
- commands use runtime APIs only
- e2e queue + interrupt behaviors unchanged
- code reads as: ingress -> transition -> effects
