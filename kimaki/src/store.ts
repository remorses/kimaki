// The only shared mutable in-memory state of the bot (spec 27.4). One zustand
// atom. The event loop writes bindings and views; /verbosity writes verbosity.
// State private to one module (held events, wizard picks, upload waits) stays
// in that module's closure.

import { createStore } from 'zustand/vanilla'

import type { Verbosity } from './db.ts'
import type { ThreadView } from './thread-reducer.ts'

export type State = {
  // threadId -> root session, from thread_sessions (SQLite) and new bindings.
  roots: Readonly<Record<string, string>>
  // sessionId (roots and their subagent children) -> threadId, for routing.
  sessionThreads: Readonly<Record<string, string>>
  // threadId -> view, created at bind or when a thread of an earlier run gets its first event.
  threads: Readonly<Record<string, ThreadView>>
  // channelId -> verbosity, from channel_verbosity (SQLite). Missing: the default.
  verbosity: Readonly<Record<string, Verbosity>>
}

export function createBotStore() {
  return createStore<State>(() => ({ roots: {}, sessionThreads: {}, threads: {}, verbosity: {} }))
}

export type BotStore = ReturnType<typeof createBotStore>
