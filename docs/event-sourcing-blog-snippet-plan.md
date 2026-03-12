---
title: Event sourcing blog snippet plan
description: |
  Concrete plan for replacing each `...` in the event sourcing blog draft
  with simple TypeScript snippets inspired by Kimaki's runtime migration.
prompt: |
  [current git branch is main]I want to write a blog post about event
  sourcing for application state

  here is the draft.

  write this to a .md file. adda new skills folder event-sourcing-state.

  then write my blog as is. only fixing grammar errors and issues

  then create a plan to fill in ... with code snippets. using the codebase
  as inspiration. examples should be easy to follow for readers. using
  typescript.

  you will need to see past git history for the bad examples. before or just
  after the migration to ThreadRuntime. which had a lot of state fields we
  removed. or the zustand state. which we removed a lot of state from

  Research notes used:
  - `git show f634a17:discord/src/session-handler/thread-runtime-state.ts`
  - `git show 94a26bf:discord/src/session-handler/state.ts`
  - `discord/src/session-handler/event-stream-state.ts`
  - `discord/src/session-handler/event-stream-state.test.ts`
  - `discord/src/debounce-timeout.ts`
  - `discord/src/cli.ts`
---

<!-- Plan for filling the blog's placeholder code snippets. -->

# event sourcing blog snippet plan

## goals

- keep every snippet small enough to fit in a blog post without scrolling
- use real kimaki ideas, but simplify names so readers can follow them fast
- show one bad mirrored-state example, one good event-derived example, one
  test example, and one encapsulation example
- preserve the tone of the draft: concrete, opinionated, and practical

## snippet 1: bad example after "here is his idea"

### source material

- `git show 94a26bf:discord/src/session-handler/state.ts`
- `git show f634a17:discord/src/session-handler/thread-runtime-state.ts`

### what to show

Use a condensed TypeScript snippet based on the old `MainRunState` and
`ThreadRunState` shape:

```ts
type RunState = {
  phase: 'waiting' | 'dispatching' | 'finished' | 'aborted'
  idleState: 'none' | 'deferred'
  currentAssistantMessageId?: string
  evidenceSeq?: number
  deferredIdleSeq?: number
}

type ThreadState = {
  blockers: {
    permissionCount: number
    questionCount: number
    actionButtonsPending: boolean
  }
  runState: RunState
  runController?: AbortController
  currentRun?: {
    model?: string
    tokensUsed: number
    lastDisplayedContextPercentage: number
  }
}
```

Then add a tiny function showing the bug-prone branching:

```ts
function shouldShowFooter(state: ThreadState): boolean {
  return state.runState.phase === 'finished'
    && state.blockers.permissionCount === 0
    && !state.blockers.actionButtonsPending
}
```

### why this works in the post

- it makes the state explosion visible immediately
- it is obviously fragile even if the reader does not know kimaki
- it matches your claim that each new field multiplies possible states

## snippet 2: good example after "here is the example from before using the event sourcing approach"

### source material

- `discord/src/session-handler/event-stream-state.ts`

### what to show

Use a simplified event buffer and two pure derivation helpers inspired by
`isSessionBusy()` and `getLatestRunInfo()`:

```ts
type SessionEvent =
  | { type: 'session.status'; status: 'busy' | 'idle' }
  | { type: 'message.completed'; model: string; tokensUsed: number }
  | { type: 'session.aborted' }

function isSessionBusy(events: SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'session.status') {
      return event.status === 'busy'
    }
  }
  return false
}

function getLatestRunInfo(events: SessionEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'message.completed') {
      return {
        model: event.model,
        tokensUsed: event.tokensUsed,
      }
    }
  }
  return { model: undefined, tokensUsed: 0 }
}
```

### follow-up snippet

Immediately after that, add a tiny pure composition function:

```ts
function deriveFooterState(events: SessionEvent[]) {
  const busy = isSessionBusy(events)
  const latestRun = getLatestRunInfo(events)

  return {
    shouldShowFooter: !busy && latestRun.model !== undefined,
    model: latestRun.model,
    tokensUsed: latestRun.tokensUsed,
  }
}
```

### why this works in the post

- it shows the same feature with less state
- the reader can see that nothing is cached or mirrored
- it supports the claim that the transformation is pure

## snippet 3: test example after "...test example"

### source material

- `discord/src/cli.ts`
- `discord/src/session-handler/event-stream-state.test.ts`

### what to show

Use one shell command plus one tiny fixture-driven test.

Command block:

```bash
kimaki session export-events-jsonl --session ses_123 --out ./tmp/session.jsonl
```

Test block:

```ts
import fs from 'node:fs'

function loadEvents(file: string) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('footer is shown only for natural completion', () => {
  const events = loadEvents('./tmp/session.jsonl')

  expect(deriveFooterState(events)).toEqual({
    shouldShowFooter: true,
    model: 'claude-opus',
    tokensUsed: 1240,
  })
})
```

### blog point to make right after the snippet

- the reproduction artifact is just data
- the test does not mock discord or the runtime
- once the fixture exists, any model can usually fix the bug in one shot

## snippet 4: bad encapsulation example after "one approach could be"

### source material

- historical runtime class-field style from old `thread-session-runtime.ts`

### what to show

```ts
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

  flushNow(): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
      this.debounceTimeout = null
    }
  }

  private write(text: string): void {
    console.log(text)
  }
}
```

### why this works in the post

- it makes the timer visible to every method on the class
- it gives you an easy line about future agents doing weird things with it

## snippet 5: good encapsulation example after "... debounce generic function"

### source material

- `discord/src/debounce-timeout.ts`

### what to show

Keep it very close to the real helper, just rename it to feel more general:

```ts
function createDebouncedAction({
  delayMs,
  callback,
}: {
  delayMs: number
  callback: () => void
}) {
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

### blog point to make right after the snippet

- the timer still exists, but it no longer pollutes application state
- only the closure can touch it
- if there is a bug, it is trapped inside a tiny surface area

## writing order

1. write snippet 1 and the paragraph about state multiplication
2. write snippet 2 and the paragraph about pure derivation
3. write snippet 3 and the paragraph about exportable event logs
4. write snippets 4 and 5 as the encapsulation contrast pair
5. do one final pass to keep identifiers consistent across all snippets

## style constraints for the final fill-in

- keep identifiers boring and literal: `events`, `isSessionBusy`,
  `deriveFooterState`, `createDebouncedAction`
- do not use discord-specific or kimaki-specific types in the blog snippets
- prefer arrays and plain unions over classes and frameworks
- keep each snippet under about 25 lines if possible
- avoid `as any`, generics, or advanced TypeScript tricks

## optional extra snippet if you want one more concrete example

Use the current `discord/src/store.ts` as a short contrast point: one central
store is already better than scattered globals, but event sourcing is even
better when lifecycle state can be derived instead of stored. That gives you a
nice progression:

1. scattered mutable fields
2. centralized mutable state
3. event-derived state
