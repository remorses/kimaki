---
name: event-sourcing-state
description: >
  Event-sourced application state pattern for TypeScript apps. Prefer bounded
  event logs plus pure derivation functions over mirrored mutable lifecycle
  flags. Use when state transitions are driven by events and bugs can be
  reproduced from a saved event stream.
version: 0.1.0
---

<!-- Skill for event-sourced state and fixture-driven debugging. -->

# Event-Sourcing State

Use this skill when an app keeps adding mutable fields to track lifecycle,
phase, status, or UI state that could instead be derived from an event log.

## Core idea

Do not store the answer when you can store the evidence.

Instead of fields like:

```ts
let isRunning = false
let lastModel: string | undefined
let footerVisible = false
let wasAborted = false
```

store a bounded event stream and derive what you need:

```ts
type Event =
  | { type: 'session.status'; status: 'busy' | 'idle' }
  | { type: 'message.completed'; model: string; tokensUsed: number }
  | { type: 'session.aborted' }
```

Then compute state with pure functions.

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

## Pattern

```ts
type EventBufferEntry<TEvent> = {
  event: TEvent
  timestamp: number
}

function isBusy(events: EventBufferEntry<Event>[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event) {
      continue
    }
    if (event.type === 'session.status') {
      return event.status === 'busy'
    }
  }
  return false
}
```

## Testing workflow

1. export a failing event stream from production or local runtime
2. save it as a fixture
3. write a pure test around the derivation function
4. fix the derivation code
5. keep the fixture so the bug stays dead

## State minimization rule

The next best thing after no state is state you do not care about because it
is encapsulated. If something must stay mutable, hide it inside a tiny closure
or helper instead of exposing it to the whole app.
