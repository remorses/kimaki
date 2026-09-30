// The only mutable in-memory state of the bot (spec 27.4). One zustand atom.
// Only event-loop.ts writes it; everything else reads.

import { createStore } from 'zustand/vanilla'

import type { ThreadView } from './thread-reducer.ts'

export type State = {
  threads: Readonly<Record<string, ThreadView>> // threadId -> view
  sessionThreads: Readonly<Record<string, string>> // sessionId (root and children) -> threadId
}

export function createBotStore() {
  return createStore<State>(() => ({ threads: {}, sessionThreads: {} }))
}

export type BotStore = ReturnType<typeof createBotStore>
