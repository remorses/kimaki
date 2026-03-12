---
title: Event sourcing for application state
description: |
  Blog draft about minimizing application state, replacing mirrored mutable
  fields with event sourcing, and using event logs as the source of truth.
---

<!-- Blog draft copied from Tommy's draft, then filled with simple TypeScript examples inspired by Kimaki. -->

# event sourcing for application state

your clanker loves state

every time you ask codex to add a feature it will happily add a new field to your class. a new global variable. a new `useState`

this is bad. why? your application state is the multiplication of all possible state variable combinations

every boolean global variable you add doubles your final app state. it doubles your bugs. it doubles the coverage of your app. it doubles the tests you need to get to 100% coverage (at least in the worst case scenario)

here is a real-world example: I asked codex to make kimaki (a discord bot) show the footer only when the bot was not interrupted. here is his idea

```ts
type ThreadState = {
  wasInterrupted: boolean
  didAssistantFinish: boolean
  didAssistantError: boolean
  wasToolCallOnly: boolean
}

function startRun(): ThreadState {
  return {
    wasInterrupted: false,
    didAssistantFinish: false,
    didAssistantError: false,
    wasToolCallOnly: false,
  }
}

function onAssistantMessageUpdated(
  state: ThreadState,
  message: {
    completed: boolean
    error: boolean
    finish: 'stop' | 'tool-calls'
  },
): ThreadState {
  return {
    ...state,
    didAssistantFinish: message.completed,
    didAssistantError: message.error,
    wasToolCallOnly: message.finish === 'tool-calls',
  }
}

function onInterrupt(state: ThreadState): ThreadState {
  return {
    ...state,
    wasInterrupted: true,
  }
}

function shouldShowFooter(state: ThreadState): boolean {
  return state.didAssistantFinish
    && !state.wasInterrupted
    && !state.didAssistantError
    && !state.wasToolCallOnly
}
```

this is the whole vibe of the bad solution. even after simplifying it, you still end up caching facts that are already present in the assistant message itself. there is an interruption flag. a finished flag. an error flag. a tool-call-only flag. and then there is another function that tries to recombine all of that back into a simple answer like "should I show the footer?"

this kind of state machinery is exactly what agents love to build. every fix adds one more field. then another helper. then another branch. then another impossible combination appears.

## event sourcing

event sourcing is what will save you from agent state explosion

I removed all the state added by clankers. converted everything to use event sourcing

here is the example from before using the event sourcing approach:

```ts
type SessionEvent =
  | { type: 'message.updated'; role: 'assistant'; completed: boolean; error: boolean; finish: 'stop' | 'tool-calls' }

function getLatestAssistantMessage(events: SessionEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'message.updated' && event.role === 'assistant') {
      return event
    }
  }
  return undefined
}

function isAssistantMessageNaturalCompletion(message: {
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
```

every possible piece of state is now computed as a pure function that takes as input the last 1000 opencode session events

```ts
function shouldShowFooter(events: SessionEvent[]): boolean {
  const latestAssistantMessage = getLatestAssistantMessage(events)
  if (!latestAssistantMessage) {
    return false
  }
  return isAssistantMessageNaturalCompletion(latestAssistantMessage)
}
```

this increased stability, testability, and correctness by 10x.

I also added a command `kimaki session export-events-jsonl <id>` that lets you export the opencode events for a session

now every time I find a bug in kimaki in Discord I tell kimaki "export opencode events from session xxx, create a failing test, then fix it".

the agent then adds a new test using the event stream as input. then it calls a pure transformation that computes data from the event stream

I had to do this, for example, when I discovered there was a new way a session can end naturally in opencode. I just had to reference a session with this new behaviour to Opus and ask it to fix the bug. it just did so. one shot.

```bash
kimaki session export-events-jsonl --session ses_123 --out ./tmp/session.jsonl
```

```ts
import fs from 'node:fs'

function loadEvents(file: string): SessionEvent[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent)
}

test('footer is hidden for aborted runs', () => {
  const events = loadEvents('./tmp/session.jsonl')

  expect(shouldShowFooter(events)).toBe(false)
})
```

the bug is obvious. the test is simple. the transformation code is pure. it has referential transparency

any model is able to one-shot these problems because the feedback loop is obvious.

## state encapsulation

the next best thing after no state is state you don't care about: encapsulated state

a good example of this is React `useState`. `useState` cannot escape the component it is declared in.

state can only be written to in event handlers in the component subtree (which is usually small)

state can only be read in the current component

state is local. easy to reason about.

this same thing can be done in backend code.

imagine adding a feature to debounce the messages you write in kimaki.

one approach could be to add a timer and `setTimeout` in the class field.

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
    if (!this.debounceTimeout) {
      return
    }
    clearTimeout(this.debounceTimeout)
    this.debounceTimeout = null
  }

  private write(text: string): void {
    console.log(text)
  }
}
```

now this state is accessible by the full class methods. next time codex could see this field and decide to do weird shit with it.

you also now need to care about destroying the `setTimeout`

a better approach is to encapsulate this state in a closure. a generic debounce function

only this function has access to this state. there is no other consumer that can write to this state

```ts
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

  return {
    trigger,
    clear,
  }
}
```

this prevents an explosion of states in your app.

so if a global variable has the potential of doubling your app state, this function has none. it can only double the states of this encapsulated function. given it's so small we don't care about it. spotting a bug inside it is easy for you and agents

## easy persistency

if you want to make an event sourcing system persistent you just store the events. these are easily versionable

instead of storing the end state of your app you store the full event stream that created that state.

if a user has a bug, you just get that event stream, run your pure transformation on it, reproduce the bug. fix it

if a user manages to create a broken state of your app and you persist that, the user would be screwed. the project would be gone. if the user tries to open the project it would crash the app. this happens a lot with things like video editors and complex apps. some projects are simply gone. broken forever. to fix the user project you would need to create migration code that fixes the state. which is tedious.

if instead you store the event stream directly you can fix the state transformation functions, release a new version, the user opens the project, and it will just start working again. what matters is making events immutable and versioned. type-safe. so your transformation functions are guaranteed to process those events, even from older app versions, and return a valid working state.
