// Ticket #55 diagnostic repro — BUILT dist (tsc output of this branch's
// source) manual-compaction fence.
//
// Originally targeted the deployed npm dist's patch, but kimaki's background
// auto-update wipes dist patches within hours (observed 2026-09-12), so the
// fence now lives in source and this file validates the built artifact.
//
// Drives the built tryDrainQueue through the prototype with a real
// threadState entry, verifying:
//   P1: while manual compaction is active the local queue does NOT drain
//       (the fix for the B1/B2 races documented in compact-queue-repro-stock)
//   P2: once the fence releases, drain proceeds (negative control)
//
// Diagnostic only; no live systems are touched (threadState is in-memory).
// Skips when cli/dist is not built (e.g. upstream CI on a fresh checkout) so
// test discovery never fails on the missing artifact.
import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const liveDistDir = fileURLToPath(
  new URL('../../dist/session-handler/', import.meta.url),
)
const runtimePath = pathToFileURL(`${liveDistDir}/thread-session-runtime.js`).href
const runtimeMod = existsSync(fileURLToPath(runtimePath))
  ? await import(runtimePath)
  : undefined
const stateMod = existsSync(fileURLToPath(runtimePath))
  ? await import(pathToFileURL(`${liveDistDir}/thread-runtime-state.js`).href)
  : undefined

const { ThreadSessionRuntime, beginManualCompaction, endManualCompaction, isManualCompactionActive } =
  (runtimeMod ?? {}) as any
const { ensureThread, enqueueItem, clearQueueItems, getThreadState } =
  (stateMod ?? {}) as any

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
  runtime.actionQueue = []
  runtime.processingAction = false
  runtime.dispatchPrompt = async () => {}
  return runtime
}

function seedQueue() {
  clearQueueItems(THREAD)
  enqueueItem(THREAD, {
    // No queueId: the deployed dist's dispatch finally-block calls
    // cancelAgentRestartWork against its production sqlite db whenever a
    // drained item carries one, which fails outside the bot process
    // (unhandled rejection). The fence assertions don't need a queueId.
    prompt: 'next ticket instruction queued during /compact',
    userId: 'u1',
    username: 'tester',
  })
}

describe.skipIf(!runtimeMod)('#55 built dist — manual compaction fence', () => {
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
