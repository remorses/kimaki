// Ticket #55 diagnostic repro — DEPLOYED dist (installed kimaki 0.27.0 +
// local compact-queue patch) manual-compaction fence.
//
// Drives the real deployed tryDrainQueue through the prototype with a real
// threadState entry, verifying:
//   P1: while manual compaction is active the local queue does NOT drain
//       (the fix for the B1/B2 races documented in compact-queue-repro-stock)
//   P2: once the fence releases, drain proceeds (negative control)
//
// Diagnostic only; no live systems are touched (threadState is in-memory).
import { describe, expect, test } from 'vitest'
import { pathToFileURL } from 'node:url'

const liveDistDir =
  'C:/Users/Cody/AppData/Roaming/npm/node_modules/kimaki/dist/session-handler'
const runtimeMod = await import(
  pathToFileURL(`${liveDistDir}/thread-session-runtime.js`).href
)
const stateMod = await import(pathToFileURL(`${liveDistDir}/thread-runtime-state.js`).href)

const { ThreadSessionRuntime, beginManualCompaction, endManualCompaction, isManualCompactionActive } =
  runtimeMod as any
const { ensureThread, enqueueItem, clearQueueItems, getThreadState } = stateMod as any

const THREAD = 'repro-thread-55'

function makeRuntime(sessionId?: string) {
  const runtime = Object.create(ThreadSessionRuntime.prototype)
  runtime.threadId = THREAD
  // `state` is a getter on the prototype; define an own property instead.
  Object.defineProperty(runtime, 'state', {
    value: sessionId ? { sessionId } : undefined,
    configurable: true,
  })
  runtime.eventBuffer = []
  runtime.dispatchPrompt = async () => {}
  return runtime
}

function seedQueue() {
  clearQueueItems(THREAD)
  enqueueItem(THREAD, {
    queueId: 'q1',
    prompt: 'next ticket instruction queued during /compact',
    userId: 'u1',
    username: 'tester',
  })
}

describe('#55 deployed patch — manual compaction fence', () => {
  test('P1: tryDrainQueue is a no-op while manual compaction is active (queue survives)', async () => {
    ensureThread(THREAD)
    seedQueue()
    beginManualCompaction(THREAD)
    expect(isManualCompactionActive(THREAD)).toBe(true)

    try {
      const runtime = makeRuntime('ses_live')
      // Stock behavior (no fence) would dequeue here: isSessionBusy is false on
      // the empty buffer. The deployed guard must return before dequeueItem.
      await runtime.tryDrainQueue()

      expect(getThreadState(THREAD).queueItems.length).toBe(1)
    } finally {
      endManualCompaction(THREAD)
    }
  })

  test('P2: after the fence releases, tryDrainQueue dequeues (drain path intact)', async () => {
    endManualCompaction(THREAD) // defensive: never inherit a leaked fence
    ensureThread(THREAD)
    seedQueue()
    expect(isManualCompactionActive(THREAD)).toBe(false)

    const runtime = makeRuntime('ses_live')
    await runtime.tryDrainQueue()

    expect(getThreadState(THREAD).queueItems.length).toBe(0)
    clearQueueItems(THREAD)
  })
})
