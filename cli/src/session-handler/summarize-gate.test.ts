// Regression tests for ticket #55: prompts submitted while /compact's
// summarize call is in flight must wait in kimaki's local queue and drain
// exactly once against the compacted context.
//
// Reproduction being guarded against:
// - Path A: an ordinary Discord message during compaction reached OpenCode
//   (promptAsync) and the opencode-side interrupt plugin aborted the running
//   compaction (cancel).
// - Path B: a /queue prompt drained immediately because event-derived
//   isSessionBusy() was still false (compaction's busy events race the drain),
//   appended the user message mid-compaction, and no assistant turn ever ran
//   for it (stranded).

import { describe, expect, test, vi } from 'vitest'

vi.mock('../discord-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discord-utils.js')>()
  return {
    ...actual,
    sendThreadMessage: vi.fn(async () => ({ id: 'msg_mock' })),
  }
})

import {
  ThreadSessionRuntime,
  beginManualCompaction,
  endManualCompaction,
  isManualCompactionActive,
} from './thread-session-runtime.js'
import * as threadState from './thread-runtime-state.js'
import { store } from '../store.js'

const THREAD_ID = 'thread_summarize_gate'
const SESSION_ID = 'ses_main'

// Private members exercised by these tests, accessed via asInternals().
type RuntimeInternals = {
  threadId: string
  thread: { id: string }
  sdkDirectory: string
  projectDirectory: string
  channelId: string
  disposed: boolean
  eventBuffer: unknown[]
  nextEventIndex: number
  actionQueue: Array<() => Promise<void>>
  processingAction: boolean
  preprocessChain: Promise<unknown>
  persistEventBufferDebounced: { trigger: () => void }
  state?: { sessionId: string; parentSessionId?: string }
  compactionSessionId: string | undefined
  dispatchPrompt: (input: unknown) => Promise<void>
  submitViaOpencodeQueue: (input: unknown) => Promise<{ queued: boolean }>
  isMainSessionBusy: () => boolean
  tryDrainQueue: (opts?: { showIndicator?: boolean }) => Promise<void>
}

function asInternals(runtime: ThreadSessionRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeRuntime(): ThreadSessionRuntime {
  // Fresh global store slice per test so queueItems never leak between tests.
  store.setState((s) => {
    const threads = new Map(s.threads)
    threads.delete(THREAD_ID)
    return { threads }
  })
  threadState.ensureThread(THREAD_ID)

  const runtime = Object.create(
    ThreadSessionRuntime.prototype,
  ) as ThreadSessionRuntime
  const internal = asInternals(runtime)
  internal.threadId = THREAD_ID
  internal.thread = { id: THREAD_ID }
  internal.sdkDirectory = '/test'
  internal.projectDirectory = '/test'
  internal.channelId = 'channel_test'
  internal.disposed = false
  internal.eventBuffer = []
  internal.nextEventIndex = 0
  internal.actionQueue = []
  internal.processingAction = false
  internal.preprocessChain = Promise.resolve()
  internal.persistEventBufferDebounced = { trigger: () => {} }
  internal.compactionSessionId = undefined
  Object.defineProperty(runtime, 'state', {
    value: {
      sessionId: SESSION_ID,
      parentSessionId: 'ses_parent',
    },
    configurable: true,
  })
  return runtime
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function seedQueueLength(): number {
  return threadState.getThreadState(THREAD_ID)?.queueItems.length ?? 0
}

describe('manual compaction fence (ticket #55)', () => {
  test('fence begin/end bookkeeping', () => {
    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
    expect(beginManualCompaction(THREAD_ID)).toBe(true)
    expect(beginManualCompaction(THREAD_ID)).toBe(false)
    expect(isManualCompactionActive(THREAD_ID)).toBe(true)
    expect(endManualCompaction(THREAD_ID)).toBe(true)
    expect(endManualCompaction(THREAD_ID)).toBe(false)
    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
  })

  test('/queue prompt arriving mid-compaction is held, then dispatched exactly once after summarize resolves', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    const dispatched: string[] = []
    internal.dispatchPrompt = async (input) => {
      dispatched.push((input as { prompt: string }).prompt)
    }

    const summarize = makeDeferred<void>()
    const compaction = runtime.runCompaction({
      sessionId: SESSION_ID,
      compact: () => summarize.promise,
    })
    await flushAsync()
    expect(isManualCompactionActive(THREAD_ID)).toBe(true)

    // /queue sends mode 'local-queue'; while summarize is in flight the
    // prompt must only sit in the local queue — not dispatch.
    const enqueueResult = await runtime.enqueueIncoming({
      mode: 'local-queue',
      prompt: 'continue ticket 55 after compact',
      userId: 'user_1',
      username: 'cody',
    })
    expect(enqueueResult.queued).toBe(true)
    expect(dispatched).toEqual([])

    await flushAsync()
    // Still held while summarize is in flight, even though the event buffer
    // has no busy status beyond the synthetic one (the Path B race).
    expect(dispatched).toEqual([])
    expect(seedQueueLength()).toBe(1)

    summarize.resolve(undefined)
    await compaction
    await flushAsync()

    expect(dispatched).toEqual(['continue ticket 55 after compact'])
    expect(seedQueueLength()).toBe(0)
    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
  })

  test('ordinary Discord message arriving mid-compaction is queued, not sent to OpenCode (Path A: no cancel)', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    const dispatched: string[] = []
    internal.dispatchPrompt = async (input) => {
      dispatched.push((input as { prompt: string }).prompt)
    }
    const submitViaOpencode = vi.fn(
      async () => ({ queued: false }) as { queued: boolean },
    )
    internal.submitViaOpencodeQueue = submitViaOpencode

    const summarize = makeDeferred<void>()
    const compaction = runtime.runCompaction({
      sessionId: SESSION_ID,
      compact: () => summarize.promise,
    })
    await flushAsync()

    // Ordinary Discord messages use mode 'opencode' with a preprocess step.
    const enqueueResult = await runtime.enqueueIncoming({
      mode: 'opencode',
      prompt: 'ordinary message during compact',
      userId: 'user_1',
      username: 'cody',
      preprocess: async () => ({
        prompt: 'ordinary message during compact',
        images: [],
        mode: 'opencode' as const,
        repliedMessage: undefined,
      }),
    })
    expect(enqueueResult.queued).toBe(true)
    expect(submitViaOpencode).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])

    summarize.resolve(undefined)
    await compaction
    await flushAsync()

    // Held prompt drained exactly once against the compacted context.
    expect(dispatched).toEqual(['ordinary message during compact'])
    expect(submitViaOpencode).not.toHaveBeenCalled()
  })

  test('noReply messages during compaction keep the opencode path (local queue cannot carry noReply)', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    internal.dispatchPrompt = async () => {}
    const submitViaOpencode = vi.fn(
      async () => ({ queued: false }) as { queued: boolean },
    )
    internal.submitViaOpencodeQueue = submitViaOpencode

    expect(beginManualCompaction(THREAD_ID)).toBe(true)
    try {
      await runtime.enqueueIncoming({
        mode: 'opencode',
        prompt: 'context-only mention during compact',
        userId: 'user_1',
        username: 'cody',
        noReply: true,
      })
      expect(submitViaOpencode).toHaveBeenCalledTimes(1)
      expect(seedQueueLength()).toBe(0)
    } finally {
      endManualCompaction(THREAD_ID)
    }
  })

  test('prompt that arrived during compaction stays queued even if the fence releases before routing', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    const dispatched: string[] = []
    internal.dispatchPrompt = async (input) => {
      dispatched.push((input as { prompt: string }).prompt)
    }
    const submitViaOpencode = vi.fn(
      async () => ({ queued: false }) as { queued: boolean },
    )
    internal.submitViaOpencodeQueue = submitViaOpencode

    expect(beginManualCompaction(THREAD_ID)).toBe(true)
    // Start ingress while the fence is active, then release before the
    // promise resolves — the arrival capture must keep it off the opencode
    // path (it queues and, with nothing blocking anymore, drains at once).
    const enqueuePromise = runtime.enqueueIncoming({
      mode: 'opencode',
      prompt: 'arrived during compaction',
      userId: 'user_1',
      username: 'cody',
    })
    endManualCompaction(THREAD_ID)

    await enqueuePromise
    expect(submitViaOpencode).not.toHaveBeenCalled()

    await flushAsync()
    expect(dispatched).toEqual(['arrived during compaction'])
    expect(seedQueueLength()).toBe(0)
  })

  test('without compaction, ordinary messages still go straight to OpenCode (no behavior change)', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    internal.dispatchPrompt = async () => {}
    const submitViaOpencode = vi.fn(
      async () => ({ queued: false }) as { queued: boolean },
    )
    internal.submitViaOpencodeQueue = submitViaOpencode

    await runtime.enqueueIncoming({
      mode: 'opencode',
      prompt: 'normal message',
      userId: 'user_1',
      username: 'cody',
    })

    expect(submitViaOpencode).toHaveBeenCalledTimes(1)
    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
  })

  test('queue drain stays blocked for the whole compaction window and drains after release even when events report idle', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    const dispatched: string[] = []
    internal.dispatchPrompt = async (input) => {
      dispatched.push((input as { prompt: string }).prompt)
    }

    // Event-derived state says idle: exactly the Path B precondition where
    // the old code drained mid-compaction and stranded the prompt.
    expect(internal.isMainSessionBusy()).toBe(false)

    const summarize = makeDeferred<void>()
    const compaction = runtime.runCompaction({
      sessionId: SESSION_ID,
      compact: () => summarize.promise,
    })
    await flushAsync()
    // Synthetic busy (markQueueDispatchBusy inside runCompaction) holds
    // event-derived gates closed for the whole compaction window.
    expect(internal.isMainSessionBusy()).toBe(true)

    await runtime.enqueueIncoming({
      mode: 'local-queue',
      prompt: 'queued while idle-looking',
      userId: 'user_1',
      username: 'cody',
    })
    await flushAsync()
    expect(dispatched).toEqual([])

    // Direct drain attempts (idle handler path) stay blocked too.
    await internal.tryDrainQueue({ showIndicator: true })
    await flushAsync()
    expect(dispatched).toEqual([])
    expect(seedQueueLength()).toBe(1)

    summarize.resolve(undefined)
    await compaction
    await flushAsync()
    expect(dispatched).toEqual(['queued while idle-looking'])
    expect(internal.isMainSessionBusy()).toBe(false)
  })

  test('a second compaction on the same runtime is rejected', async () => {
    const runtime = makeRuntime()

    const summarize = makeDeferred<void>()
    const compaction = runtime.runCompaction({
      sessionId: SESSION_ID,
      compact: () => summarize.promise,
    })
    await flushAsync()

    // dispatchAction wraps rejection causes in OpenCodeSdkError, so the
    // surfacing marker is the operation name; the cause carries the message.
    await expect(
      runtime.runCompaction({
        sessionId: SESSION_ID,
        compact: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/dispatchAction/)

    summarize.resolve(undefined)
    await compaction
    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
  })

  test('summarize rejection still releases the fence and drains held prompts', async () => {
    const runtime = makeRuntime()
    const internal = asInternals(runtime)
    const dispatched: string[] = []
    internal.dispatchPrompt = async (input) => {
      dispatched.push((input as { prompt: string }).prompt)
    }

    const summarize = makeDeferred<void>()
    const compaction = runtime.runCompaction({
      sessionId: SESSION_ID,
      compact: () => summarize.promise as Promise<void>,
    })
    await flushAsync()

    await runtime.enqueueIncoming({
      mode: 'local-queue',
      prompt: 'must survive compact failure',
      userId: 'user_1',
      username: 'cody',
    })
    expect(dispatched).toEqual([])

    // The summarize call fails (e.g. SDK error) — the fence must still
    // release and the held prompt must still dispatch exactly once.
    summarize.reject(new Error('summarize failed'))
    await expect(compaction).rejects.toThrow(/summarize failed/)
    await flushAsync()

    expect(isManualCompactionActive(THREAD_ID)).toBe(false)
    expect(internal.compactionSessionId).toBeUndefined()
    expect(dispatched).toEqual(['must survive compact failure'])
  })
})
