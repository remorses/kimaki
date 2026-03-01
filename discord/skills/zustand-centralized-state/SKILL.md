---
name: zustand-centralized-state
description: >
  Centralized state management pattern using Zustand vanilla stores. One immutable
  state atom, functional transitions via setState(), and a single subscribe() for
  all reactive side effects. Based on Rich Hickey's "Simple Made Easy" principles:
  prefer values over mutable state, derive instead of cache, centralize transitions,
  and push side effects to the edges. Resource co-location in the same store is
  also valid when lifecycle management is safer that way. Use this skill when
  building any stateful TypeScript application (servers, extensions, CLIs, relays)
  to keep state simple, testable, and easy to reason about. ALWAYS read this skill
  when a project uses zustand/vanilla for state management outside of React.
version: 0.2.1
---

# Centralized State Management

A pattern for managing application state that keeps programs simple, testable, and
easy to reason about. Uses Zustand vanilla stores as the mechanism, but the
principles apply to any state management approach.

## Background

Rich Hickey's talk **"Simple Made Easy"** (2011) argues that most program complexity
comes from **complecting** (interleaving) things that should be independent. Mutable
state is one of the worst offenders: it interleaves *identity* (what thing are we
talking about), *state* (what is its current value), and *time* (when did it change).

When you mutate a Map in place, you lose the previous value, every reader is coupled
to every writer, and you can't reason about what the state was at any point in time.
State scattered across multiple mutable variables in different scopes makes it
impossible to answer "what does the program look like right now?"

The solution is not "never have state" -- that's impossible for real programs. The
solution is to **manage state explicitly**: one place it lives, controlled transitions,
immutable values, and side effects derived from state rather than scattered across
handlers.

This makes programs:
- **Simpler to reason about** -- one place to look for all state
- **Easier to test** -- pure state transitions, no I/O needed
- **Less buggy** -- impossible to have half-updated inconsistent state
- **Easier to debug** -- you can log/snapshot state at any transition

## Core Principles

### 1. Prefer values over mutable state

Use immutable data. When state changes, produce a new value instead of mutating in
place. In TypeScript with Zustand, this means `setState()` with functional updates
that return new objects/Maps rather than mutating existing ones.

```ts
// BAD: mutation scattered in handler
connectedTabs.set(tabId, { ...info, state: 'connected' })
connectionState = 'connected'

// GOOD: single atomic transition producing new values
store.setState((state) => {
  const newTabs = new Map(state.tabs)
  newTabs.set(tabId, { ...info, state: 'connected' })
  return { tabs: newTabs, connectionState: 'connected' }
})
```

The second version is atomic -- both `tabs` and `connectionState` update together
or not at all. There's no intermediate state where tabs shows connected but
connectionState is still idle.

### 2. Derive instead of cache

If a value can be computed from existing state, compute it on demand instead of
maintaining a separate cache that must stay in sync.

```ts
// BAD: separate index that can get out of sync
const extensionKeyIndex = new Map<string, string>()  // stableKey -> connectionId

// must remember to update on every add/remove:
extensionKeyIndex.set(ext.stableKey, ext.id)
// forgot to delete on disconnect? now you have a stale entry

// GOOD: derive it when needed
function findExtensionByKey(state: RelayState, key: string) {
  for (const ext of state.extensions.values()) {
    if (ext.stableKey === key) return ext
  }
}
```

At small scales (dozens of entries, not millions), the linear scan is free and you've
eliminated an entire class of consistency bugs.

**Anti-pattern: parallel maps for the same entity.** A common mistake is splitting
one entity across two maps to "separate state from I/O" — e.g. a `clients` map for
domain fields and a `clientIO` map for WebSocket handles, keyed by the same ID.
This forces every add/remove to touch both maps and inevitably one gets forgotten
(leaking stale handles or leaving orphaned state). Instead, co-locate I/O handles
on the entity type itself:

```ts
// BAD: two maps that must stay in sync
type ClientState = { id: string; extensionId: string }
type ClientIO = { id: string; ws: WSContext }
type State = {
  clients: Map<string, ClientState>
  clientIO: Map<string, ClientIO>     // same keys, always
}

// GOOD: one map, one entity, one add/remove
type Client = { id: string; extensionId: string; ws: WSContext }
type State = {
  clients: Map<string, Client>
}
```

"Separate state from I/O" means keep `setState()` callbacks pure (no side effects) —
it does NOT mean store I/O handles in a separate map. Co-locating handles with their
entity prevents consistency bugs and makes cleanup trivial.

### 3. Centralize all state in one store

All application state lives in a single Zustand store. There should be one place to
look to understand the full state of the program.

```ts
import { createStore } from 'zustand/vanilla'

type AppState = {
  connections: Map<string, Connection>
  clients: Map<string, Client>
  connectionState: 'idle' | 'connected' | 'error'
  errorText: string | undefined
}

const store = createStore<AppState>(() => ({
  connections: new Map(),
  clients: new Map(),
  connectionState: 'idle',
  errorText: undefined,
}))
```

This is the single source of truth. No separate variables, no state scattered across
closures, no Maps defined in different scopes.

**One store, not many.** A common temptation is to create separate stores for each
domain (one for connections, one for clients, one for config). This splits state
across multiple sources of truth, makes cross-domain transitions non-atomic, and
forces you to coordinate subscribes across stores. A single store avoids all of
this. If you worry about subscribe callbacks firing too often when unrelated state
changes, use `subscribeWithSelector` to watch only the slice you care about (see
"Subscribing to nested state with selectors" below). This gives you the performance
of multiple stores with the simplicity of one.

### 4. State transitions use only current state and event data

Every `setState()` call should be a pure function of the current state and the
incoming event data. No reading from external variables, no side effects inside
`setState()`.

```ts
// the transition only uses `state` (current) and `event` (incoming data)
store.setState((state) => {
  const newTabs = new Map(state.tabs)
  newTabs.set(event.tabId, {
    sessionId: event.sessionId,
    state: 'connected',
  })
  return { tabs: newTabs }
})
```

This makes every transition testable: given this state and this event, the new state
should be X. No mocks needed, no I/O setup, just data in and data out.

### 5. Resource co-location is allowed when it improves lifecycle safety

Putting runtime resources in Zustand is valid when keeping them outside the store
would create split-brain lifecycle management (state in one place, resources in
another) and increase leak risk.

Examples of colocated resources:
- WebSocket handles
- timers/interval handles
- pending request callback maps
- abort controllers

If resources live in the store:
- transitions still must be deterministic and side-effect free
- store references, don't execute effects inside transitions
- cleanup effects (close sockets, clear intervals) still run in handlers/subscribe
  based on state transitions

Rule of thumb:
- Prefer plain-data state for maximal testability
- Co-locate resources when one centralized store materially improves cleanup and
  ownership tracking

### 6. Mutable resources are state too

If a runtime resource has mutable lifecycle state, treat it as state and keep it in
the centralized store alongside the data it controls.

`AbortController` is the clearest example:
- it has mutable lifecycle (`signal.aborted` flips from `false` to `true`)
- that lifecycle controls behavior (whether work should continue)
- ownership and cleanup matter (who creates, replaces, aborts, and clears it)

In practice, an abort controller is often equivalent to a state bit with a handle.
Keeping it in a local variable while related domain state lives in Zustand creates
split-brain state and leak risk.

```ts
// BAD: split state (store + local mutable resource)
let requestController: AbortController | undefined

requestController = new AbortController()

// GOOD: one source of truth
type State = {
  requestController: AbortController | undefined
}

store.setState((state) => {
  return {
    ...state,
    requestController: new AbortController(),
  }
})
```

This keeps lifecycle ownership explicit: transitions decide when controller
references appear/disappear; handlers/subscribe perform side effects like
`controller.abort()` based on state transitions.

### 7. Centralize side effects in subscribe

Side effects (I/O, UI updates, cleanup, logging) go in a single `subscribe()`
callback that reacts to state changes. Side effects are **derived from state**, not
scattered across handlers.

```ts
store.subscribe((state, prevState) => {
  // logging
  logger.log('state changed:', state)

  // UI update derived purely from current state
  updateIcon(state.connectionState, state.tabs)

  // cleanup: if a connection was removed, close its resources
  for (const [id, conn] of prevState.connections) {
    if (!state.connections.has(id)) {
      conn.socket.close()
    }
  }
})
```

## The Pattern

The architecture has three layers:

```
  Event handlers          State store             Subscribe
  (imperative shell)      (centralized atom)      (reactive side effects)
  ~~~~~~~~~~~~~~~~~~~~    ~~~~~~~~~~~~~~~~~~~     ~~~~~~~~~~~~~~~~~~~~~~~~

  onMessage(data) ------> store.setState(        store.subscribe(
  onConnect(ws)              (state) => {           (state, prev) => {
  onDisconnect(id)             // pure                // side effects
  onTimer()                    // transition           // derived from
                               // no I/O               // state shape
                            }                       }
                          )                       )
```

**Event handlers** parse incoming events and call `setState()`.
They may also do direct I/O that needs event data (like forwarding a message).

**State store** holds the single immutable state atom. Transitions are pure functions.

**Subscribe** reacts to state changes and performs side effects that are purely
derived from the current state shape (not from specific events).

## Rules

1. Use `zustand/vanilla` for non-React applications (servers, extensions, CLIs) --
   it has no React dependency and works in any JS runtime
2. Define all state in a single `createStore()` call with a typed state interface
3. Never mutate state directly -- always use `store.setState()` with functional
   updates that return new objects
4. Keep `setState()` callbacks deterministic -- no external effects, only compute
   new state from current state + event data
5. Use a single `subscribe()` for all reactive side effects -- not multiple
   subscribes scattered across the codebase
6. Side effects in subscribe should be derived from state shape, not from specific
   events -- ask "given this state, what should the world look like?" not "what
   event just happened?"
7. Derive computed values instead of caching them in separate state -- if it can be
   computed from existing state, compute it
8. Use `(state, prevState)` diffing in subscribe when you need to react to specific
   changes (e.g. "a connection was removed")
9. Keep the state interface minimal -- only store what you can't derive
10. For state transitions that are complex or reused, extract them as pure
    functions that take state + event data and return new state
11. Resource co-location is acceptable: storing sockets/timers/callback maps in
    Zustand is fine when it prevents lifecycle drift. Keep side effects out of
    transitions.
12. Treat mutable runtime resources as state (e.g. `AbortController`) -- if a
    resource has lifecycle state that drives behavior, keep its reference in the
    same centralized store as related domain state.

## When subscribe does NOT fit

Not all side effects belong in subscribe. The subscribe callback gets
`(newState, prevState)` but doesn't know **what event caused the change**. This
matters for message routing:

```ts
// this does NOT fit subscribe -- you need the actual message, not just state diff
function onCdpEvent(extensionId: string, message: CdpMessage) {
  // 1. state transition -> subscribe
  store.setState((s) => addTarget(s, extensionId, message.params))
  // 2. forward the exact message -> stays in handler (needs event data)
  forwardToPlaywright(extensionId, message)
}
```

Rule of thumb:
- **Subscribe**: side effects derived from state shape ("icon should show green
  because connectionState is 'connected'")
- **Handler**: side effects that need event data ("forward this specific CDP
  message to the playwright client")

## Real-World Example: Chrome Extension State

A Chrome extension that manages browser tab connections. Before: mutable variables
scattered across the background script. After: one Zustand store, one subscribe.

### State definition

```ts
import { createStore } from 'zustand/vanilla'

type ConnectionState = 'idle' | 'connected' | 'extension-replaced'
type TabState = 'connecting' | 'connected' | 'error'

interface TabInfo {
  sessionId?: string
  targetId?: string
  state: TabState
  errorText?: string
  pinnedCount?: number
  attachOrder?: number
  isRecording?: boolean
}

interface ExtensionState {
  tabs: Map<number, TabInfo>
  connectionState: ConnectionState
  currentTabId: number | undefined
  errorText: string | undefined
}

const store = createStore<ExtensionState>(() => ({
  tabs: new Map(),
  connectionState: 'idle',
  currentTabId: undefined,
  errorText: undefined,
}))
```

### State transitions in event handlers

```ts
// tab successfully attached
store.setState((state) => {
  const newTabs = new Map(state.tabs)
  newTabs.set(tabId, {
    sessionId,
    targetId,
    state: 'connected',
    attachOrder: newTabs.size,
  })
  return { tabs: newTabs, connectionState: 'connected' }
})

// tab detached
store.setState((state) => {
  const newTabs = new Map(state.tabs)
  newTabs.delete(tabId)
  return { tabs: newTabs }
})

// WebSocket disconnected
store.setState((state) => {
  const newTabs = new Map(state.tabs)
  for (const [id, tab] of newTabs) {
    newTabs.set(id, { ...tab, state: 'connecting' })
  }
  return { tabs: newTabs, connectionState: 'idle' }
})

// extension replaced (kicked by another instance)
store.setState({
  tabs: new Map(),
  connectionState: 'extension-replaced',
  errorText: 'Another instance took over this connection',
})
```

### All side effects in one subscribe

```ts
store.subscribe((state, prevState) => {
  // 1. log every state change
  logger.log(state)

  // 2. update extension icon based on current state
  //    purely derived from state -- doesn't care what event caused the change
  void updateIcons(state)

  // 3. show/hide context menu based on whether current tab is connected
  updateContextMenuVisibility(state)

  // 4. sync Chrome tab groups when tab list changes
  if (serializeTabs(state.tabs) !== serializeTabs(prevState.tabs)) {
    syncTabGroup(state.tabs)
  }
})
```

The `updateIcons` function reads `connectionState`, `tabs`, and `errorText` to decide
which icon to show. It doesn't know or care whether the state changed because a tab
was attached, a WebSocket reconnected, or an error happened. It just asks: **given
this state, what should the icon look like?**

This is the key insight: side effects are a **projection of current state**, not a
reaction to specific events.

### Why this is better

**Before** (scattered side effects):
```
onTabAttached()  -> update tabs Map, update icon, update badge, update tab group
onTabDetached()  -> update tabs Map, update icon, update badge, update tab group
onWsConnected()  -> update connectionState, update icon
onWsDisconnected() -> update tabs Map, update connectionState, update icon, clear badge
onError()        -> update errorText, update icon, update badge
```

Every handler has to remember to update every side effect. Add a new side effect
(e.g. "update status bar")? You must find and update every handler.

**After** (centralized):
```
onTabAttached()    -> store.setState(...)
onTabDetached()    -> store.setState(...)
onWsConnected()    -> store.setState(...)
onWsDisconnected() -> store.setState(...)
onError()          -> store.setState(...)

subscribe()        -> update icon, update badge, update tab group, update status bar
```

Handlers only update state. Subscribe handles all side effects. Add a new side
effect? Add one line in subscribe. Impossible to forget a handler.

## Testing

State transitions are pure functions, so testing requires no mocks, no WebSockets,
no I/O setup:

```ts
import { test, expect } from 'vitest'

test('attaching a tab updates state correctly', () => {
  const before: ExtensionState = {
    tabs: new Map(),
    connectionState: 'idle',
    currentTabId: undefined,
    errorText: undefined,
  }

  const after = attachTab(before, {
    tabId: 42,
    sessionId: 'session-1',
    targetId: 'target-1',
  })

  expect(after.tabs.size).toBe(1)
  expect(after.tabs.get(42)?.state).toBe('connected')
  expect(after.connectionState).toBe('connected')
  // previous state is unchanged (immutable)
  expect(before.tabs.size).toBe(0)
  expect(before.connectionState).toBe('idle')
})

test('disconnecting resets all tabs to connecting', () => {
  const before: ExtensionState = {
    tabs: new Map([
      [1, { state: 'connected', sessionId: 's1' }],
      [2, { state: 'connected', sessionId: 's2' }],
    ]),
    connectionState: 'connected',
    currentTabId: 1,
    errorText: undefined,
  }

  const after = onDisconnect(before)

  expect(after.connectionState).toBe('idle')
  for (const tab of after.tabs.values()) {
    expect(tab.state).toBe('connecting')
  }
  // original unchanged
  for (const tab of before.tabs.values()) {
    expect(tab.state).toBe('connected')
  }
})
```

No WebSocket mocks. No Chrome API stubs. No timers. Just data in, data out.

## Extracting reusable transition functions

When transitions are complex or reused across handlers, extract them as pure
functions:

```ts
// pure transition function -- takes state + event, returns new state
function attachTab(state: ExtensionState, event: {
  tabId: number
  sessionId: string
  targetId: string
}): ExtensionState {
  const newTabs = new Map(state.tabs)
  newTabs.set(event.tabId, {
    sessionId: event.sessionId,
    targetId: event.targetId,
    state: 'connected',
    attachOrder: newTabs.size,
  })
  return { ...state, tabs: newTabs, connectionState: 'connected' }
}

// used in handler
store.setState((state) => attachTab(state, { tabId, sessionId, targetId }))
```

This keeps handlers minimal and transitions testable.

## Zustand vanilla API reference

```ts
import { createStore } from 'zustand/vanilla'

// create store with initial state
const store = createStore<MyState>(() => initialState)

// read current state (snapshot, safe to hold)
const snapshot = store.getState()

// functional update (preferred -- derives from current state)
store.setState((state) => ({ ...state, count: state.count + 1 }))

// direct merge (for simple top-level updates)
store.setState({ connectionState: 'connected' })

// subscribe to all changes (returns unsubscribe function)
const unsub = store.subscribe((state, prevState) => { ... })

// subscribe with selector (fires only when selected value changes)
// requires subscribeWithSelector middleware -- see section below
const unsub = store.subscribe(
  (state) => state.connectionState,
  (connectionState, prevConnectionState) => { ... },
)
```

## Subscribing to nested state with selectors

By default, `store.subscribe()` fires on **every** state change with no selector
support. When your state contains Maps or nested objects and you only care about a
specific part, use the `subscribeWithSelector` middleware from `zustand/middleware`.
This adds a selector overload to `subscribe` so the callback only fires when the
selected value changes.

```ts
import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'

interface Session {
  userId: string
  status: 'active' | 'idle' | 'expired'
}

interface AppState {
  sessions: Map<string, Session>
  serverStatus: 'starting' | 'running' | 'stopping'
}

const store = createStore<AppState>()(
  subscribeWithSelector(() => ({
    sessions: new Map(),
    serverStatus: 'starting' as const,
  }))
)

// only fires when the sessions Map reference changes,
// NOT when serverStatus or other fields change
store.subscribe(
  (state) => state.sessions,
  (sessions, prevSessions) => {
    for (const [id] of sessions) {
      if (!prevSessions.has(id)) {
        logger.log(`new session: ${id}`)
      }
    }
    for (const [id] of prevSessions) {
      if (!sessions.has(id)) {
        logger.log(`session removed: ${id}`)
      }
    }
  },
)
```

The selector subscribe signature is:

```ts
store.subscribe(selector, listener, options?)
// options: { equalityFn?, fireImmediately? }
```

When the selector returns a new object each time (e.g. picking multiple fields),
use `shallow` from `zustand/shallow` as `equalityFn`. Without it, the default
`Object.is` compares by reference and would fire on every state change since the
selector always creates a fresh object:

```ts
import { shallow } from 'zustand/shallow'

store.subscribe(
  (state) => ({
    serverStatus: state.serverStatus,
    sessionCount: state.sessions.size,
  }),
  (picked, prevPicked) => {
    updateDashboard(picked)
  },
  { equalityFn: shallow },
)
```

## Summary

| Principle | Practice |
|---|---|
| Values over state | `setState()` returns new objects, never mutate in place |
| Derive over cache | Compute indexes and aggregates on demand |
| Centralize state | One `createStore()`, one state type, one source of truth |
| Pure transitions | `setState((state) => newState)` with no side effects |
| Centralize side effects | One `subscribe()` for all reactive effects |
| State vs I/O boundary | Prefer separation, but co-location is valid for safer cleanup |
| Test with data | State in -> state out, no mocks needed |
