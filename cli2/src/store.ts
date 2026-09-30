// The only mutable in-memory state of the bot (spec 27.4). One zustand atom.
// Only event-loop.ts writes it; everything else reads.

import { createStore } from 'zustand/vanilla'

import type { ThreadView } from './thread-reducer.ts'

export type State = {
  // threadId -> root session, from thread_sessions (SQLite) and new bindings.
  roots: Readonly<Record<string, string>>
  // sessionId (roots and their subagent children) -> threadId, for routing.
  sessionThreads: Readonly<Record<string, string>>
  // threadId -> view, created when the first event of the thread is folded.
  threads: Readonly<Record<string, ThreadView>>
}

export function createBotStore() {
  return createStore<State>(() => ({ roots: {}, sessionThreads: {}, threads: {} }))
}

export type BotStore = ReturnType<typeof createBotStore>
