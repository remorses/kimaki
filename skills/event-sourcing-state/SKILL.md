---
name: event-sourcing-state
description: >
  Event-sourced application state pattern for TypeScript apps. Prefer bounded
  event logs plus pure derivation functions over mirrored mutable lifecycle
  flags. Use when state transitions are driven by events and bugs can be
  reproduced from a saved event stream.
version: 0.2.0
---

<!-- Skill for event-sourced state and fixture-driven debugging. -->

# Event-Sourcing State

Use this skill when an app keeps adding mutable fields to track lifecycle,
phase, status, or UI state that could instead be derived from an event log.

## Core idea

Do not store the answer when you can store the evidence.

Coding agents overproduce state. Every bug looks like it wants one more flag,
one more cached answer, one more special case. Every field feels locally
justified. Globally you are building a machine nobody can hold in their head.

Every boolean you add:

1. doubles your app's possible states
2. doubles your bugs
3. doubles the coverage you need in the worst case

The fix is not a better set of flags. The fix is deleting the flags.

Stop storing conclusions and store evidence instead. If a decision depends on
what actually happened, keep the events and derive the answer from them.

## Anti-pattern: mirrored flags

To answer one yes/no UI question ("should the footer show?"), an agent will
mirror facts into state:

```ts
type ThreadState = {
  wasInterrupted: boolean
  didAssistantFinish: boolean
  didAssistantError: boolean
  wasToolCallOnly: boolean
}

function shouldShowFooter(state: ThreadState): boolean {
  return state.didAssistantFinish
    && !state.wasInterrupted
    && !state.didAssistantError
    && !state.wasToolCallOnly
}
```

Four flags to answer one question. Each flag caches a fact already present in
the event that produced it. Then a function recombines them back into one
boolean. None of these fields looks insane on its own — that is the trap.

## Pattern: derive from events

Keep the raw events and compute the answer when needed:

```ts
type SessionEvent =
  | { type: 'session.status'; status: 'busy' | 'idle' }
  | { type: 'session.aborted' }
  | {
      type: 'message.updated'
      role: 'assistant'
      completed: boolean
      error: boolean
      finish: 'stop' | 'tool-calls'
    }

function getLatestAssistantMessage(events: SessionEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'message.updated' && event.role === 'assistant') {
      return event
    }
  }
  return undefined
}

function isNaturalCompletion(message: {
  completed: boolean
  error: boolean
  finish: 'stop' | 'tool-calls'
}): boolean {
  if (!message.completed) {
    return false
  }
  if (message.error) {
    return false
  }
  return message.finish !== 'tool-calls'
}

function shouldShowFooter(events: SessionEvent[]): boolean {
  const msg = getLatestAssistantMessage(events)
  if (!msg) {
    return false
  }
  return isNaturalCompletion(msg)
}
```

Notice what disappeared:

1. no interruption flag
2. no finished flag
3. no special footer state
4. no extra state machine to explain another state machine

You keep the raw thing that happened, then compute the answer when needed.

## Rules

1. Keep events immutable and versioned.
2. Prefer one bounded event buffer over many mirrored flags.
3. Derive lifecycle state with pure functions.
4. Persist the event stream when it helps reproduce bugs.
5. Write tests against fixtures, not against live mutable runtime state.

## Good fit

- session lifecycle state
- workflow engines
- chat or agent runtimes
- typing/idle/footer decisions
- retry and interruption logic

## Bad fit

- raw high-volume telemetry that is never read back
- tiny local state better kept inside a closure
- data that is already a stable source of truth elsewhere

## Testing workflow

1. Export a failing event stream from production or local runtime.
2. Save it as a fixture (jsonl file).
3. Write a pure test around the derivation function.
4. Fix the derivation code.
5. Keep the fixture so the bug stays dead.

Any model can one-shot these problems because the feedback loop is obvious:
events in, answer out.

```ts
import fs from 'node:fs'

function loadEvents(file: string): SessionEvent[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as SessionEvent
    })
}

test('footer is hidden for aborted runs', () => {
  const events = loadEvents('./fixtures/aborted-session.jsonl')
  expect(shouldShowFooter(events)).toBe(false)
})
```

The reproduction artifact is just data:

1. no mocking the runtime
2. no mocking timers
3. no begging the runtime to reproduce the exact bad interleaving again
4. just events in, answer out

## Persistency

If you want persistence you just store the events. Events are easily versioned
and type-safe.

The trade is this:

- **Storing cached state**: if a user hits a broken state and you persist it,
  the project is gone. Opening it crashes the app. To fix it you need migration
  code that patches the corrupted state. Tedious and fragile.
- **Storing the event stream**: you fix the derivation functions, release a new
  version, the user opens the project, and it works again. What matters is
  keeping events immutable and versioned so derivation functions are guaranteed
  to process events from older app versions and return valid state.

State is cached conclusions. Events are stored evidence. Evidence ages better.

If you can derive it, don't store it.

## State encapsulation

The next best thing after no state is state you don't care about because it is
encapsulated.

Not everything needs event sourcing. The second-best option is state you
successfully hide. A good example is React `useState`: state can only be
written in event handlers within the component subtree and can only be read in
the current component. It is local and easy to reason about.

The same applies to backend code. Instead of promoting a timer or counter into
a class field visible to all methods, encapsulate it in a closure:

```ts
// bad: timer is a class field, visible to all methods, agents will touch it
class MessageWriter {
  private debounceTimeout: ReturnType<typeof setTimeout> | null = null

  queueSend(text: string): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
    }
    this.debounceTimeout = setTimeout(() => {
      this.write(text)
    }, 300)
  }
}

// good: timer is trapped in a tiny box, no other consumer can touch it
function createDebouncedAction(callback: () => void, delayMs = 300) {
  let timeout: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (!timeout) {
      return
    }
    clearTimeout(timeout)
    timeout = null
  }

  function trigger(): void {
    clear()
    timeout = setTimeout(() => {
      timeout = null
      callback()
    }, delayMs)
  }

  return { trigger, clear }
}
```

A global variable has the potential of doubling your app state. An encapsulated
closure can only double the states of that tiny function. Given it is so small
you don't care — spotting a bug inside it is easy for you and agents.
