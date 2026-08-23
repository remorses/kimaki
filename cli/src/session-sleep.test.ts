// Tests for the durable session-sleep delivery protocol.
//
// The invariant under test: a wake is delivered at least once and turned into a
// session turn at most once. A row therefore stays `planned` until ingress
// consumes it, and every delivery write is guarded on delivery_id so a stale
// in-flight wake can never touch a newer sleep occurrence.

import { afterAll, describe, expect, test } from 'vitest'
import {
  cancelSessionSleepForThread,
  claimSessionSleepAttempt,
  consumeSessionSleepWake,
  getDueSessionSleeps,
  getSessionSleep,
  getThreadIdBySessionId,
  markSessionSleepFailed,
  setThreadSession,
  upsertSessionSleep,
} from './database.js'
import { closeDb } from './db.js'

const RETRY_AFTER_MS = 30_000
const NOW = new Date('2026-08-19T12:00:00Z')
const DUE = new Date('2026-08-19T11:00:00Z')

async function createSleep({
  sessionId,
  threadId,
  wakeAt = DUE,
  reason = null,
}: {
  sessionId: string
  threadId: string
  wakeAt?: Date
  reason?: string | null
}) {
  await setThreadSession(threadId, sessionId)
  return upsertSessionSleep({ sessionId, wakeAt, reason })
}

describe('session sleep delivery', () => {
  test('claim reserves an attempt but stays planned so a crash retries', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-crash',
      threadId: 'thr-crash',
    })

    const claimed = await claimSessionSleepAttempt({
      sessionId: 'ses-crash',
      deliveryId,
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
    })

    expect(claimed?.status).toBe('planned')
    expect(claimed?.attempts).toBe(1)

    // Simulates the process dying before the Discord post: once the retry
    // window passes the row is due again rather than lost.
    const laterDue = await getDueSessionSleeps({
      now: new Date(NOW.getTime() + RETRY_AFTER_MS + 1),
      retryAfterMs: RETRY_AFTER_MS,
      limit: 10,
    })
    expect(laterDue.map((row) => row.session_id)).toContain('ses-crash')
  })

  test('a second claim inside the retry window is refused', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-window',
      threadId: 'thr-window',
    })

    const first = await claimSessionSleepAttempt({
      sessionId: 'ses-window',
      deliveryId,
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
    })
    const second = await claimSessionSleepAttempt({
      sessionId: 'ses-window',
      deliveryId,
      now: new Date(NOW.getTime() + 1_000),
      retryAfterMs: RETRY_AFTER_MS,
    })

    expect(first).not.toBe(null)
    expect(second).toBe(null)
  })

  test('a new sleep occurrence invalidates an in-flight delivery', async () => {
    const staleDeliveryId = await createSleep({
      sessionId: 'ses-generation',
      threadId: 'thr-generation',
    })
    const freshDeliveryId = await createSleep({
      sessionId: 'ses-generation',
      threadId: 'thr-generation',
      wakeAt: new Date('2026-08-19T11:30:00Z'),
    })
    expect(freshDeliveryId).not.toBe(staleDeliveryId)

    const staleClaim = await claimSessionSleepAttempt({
      sessionId: 'ses-generation',
      deliveryId: staleDeliveryId,
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
    })
    // The wake message already in flight for the old occurrence must not be
    // able to deliver against the new one.
    const staleConsume = await consumeSessionSleepWake({
      deliveryId: staleDeliveryId,
    })

    expect(staleClaim).toBe(null)
    expect(staleConsume).toBe(false)
    expect((await getSessionSleep({ sessionId: 'ses-generation' }))?.status).toBe(
      'planned',
    )
  })

  test('a wake becomes a turn at most once', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-once',
      threadId: 'thr-once',
    })

    // A retry can post the same wake twice; only the first delivery may win.
    const first = await consumeSessionSleepWake({ deliveryId })
    const second = await consumeSessionSleepWake({ deliveryId })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect((await getSessionSleep({ sessionId: 'ses-once' }))?.status).toBe(
      'consumed',
    )
  })

  test('a wake cancelled while posting is dropped instead of starting a turn', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-raced',
      threadId: 'thr-raced',
    })
    await claimSessionSleepAttempt({
      sessionId: 'ses-raced',
      deliveryId,
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
    })

    // User takes the conversation back while the post is in flight.
    await cancelSessionSleepForThread({ threadId: 'thr-raced' })

    expect(await consumeSessionSleepWake({ deliveryId })).toBe(false)
    expect((await getSessionSleep({ sessionId: 'ses-raced' }))?.status).toBe(
      'cancelled',
    )
  })

  test('cancel reaches the sleep from any thread bound to the session', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-rebound',
      threadId: 'thr-rebound-old',
    })
    // /resume binds the same session to a second thread. A sleep belongs to the
    // session, not to the thread it was created in, so either thread cancels it.
    await setThreadSession('thr-rebound-new', 'ses-rebound')

    const cancelled = await cancelSessionSleepForThread({
      threadId: 'thr-rebound-new',
    })

    expect(cancelled).toBe(true)
    expect(await consumeSessionSleepWake({ deliveryId })).toBe(false)
  })

  test('a wake nobody consumed stays due and is retried', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-stale',
      threadId: 'thr-stale',
    })

    // Posting does not change the status, so a wake that was delivered to
    // Discord but never reached ingress is simply due again after the retry
    // window. This is the same path that covers a crash before posting.
    await claimSessionSleepAttempt({
      sessionId: 'ses-stale',
      deliveryId,
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
    })
    expect((await getSessionSleep({ sessionId: 'ses-stale' }))?.status).toBe(
      'planned',
    )

    const retryDue = await getDueSessionSleeps({
      now: new Date(NOW.getTime() + RETRY_AFTER_MS + 1),
      retryAfterMs: RETRY_AFTER_MS,
      limit: 50,
    })
    expect(retryDue.map((row) => row.session_id)).toContain('ses-stale')
  })

  test('failing a delivery is also guarded by delivery_id', async () => {
    const deliveryId = await createSleep({
      sessionId: 'ses-failed',
      threadId: 'thr-failed',
    })

    expect(
      await markSessionSleepFailed({
        sessionId: 'ses-failed',
        deliveryId: 'some-other-delivery',
      }),
    ).toBe(false)
    expect(
      await markSessionSleepFailed({ sessionId: 'ses-failed', deliveryId }),
    ).toBe(true)
  })

  test('only planned rows that are due and not just attempted are returned', async () => {
    await createSleep({ sessionId: 'ses-due', threadId: 'thr-due' })
    await createSleep({
      sessionId: 'ses-future',
      threadId: 'thr-future',
      wakeAt: new Date('2026-08-19T13:00:00Z'),
    })

    const due = await getDueSessionSleeps({
      now: NOW,
      retryAfterMs: RETRY_AFTER_MS,
      limit: 50,
    })
    const ids = due.map((row) => row.session_id)

    expect(ids).toContain('ses-due')
    expect(ids).not.toContain('ses-future')
  })
})

describe('session to thread resolution', () => {
  test('resolves to the most recently bound thread, not an arbitrary one', async () => {
    // Bindings are ordered by wall-clock time, so space them enough to get
    // distinct millisecond stamps. Real /resume flows are seconds apart.
    const tick = async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }

    await setThreadSession('thr-first', 'ses-resume')
    await tick()
    // /resume maps the same session into a brand new thread without clearing
    // the old row. The newest binding must win, otherwise plugin tools post
    // into a dead conversation.
    await setThreadSession('thr-second', 'ses-resume')

    expect(await getThreadIdBySessionId('ses-resume')).toBe('thr-second')

    await tick()
    // Rebinding the older thread makes it current again. created_at ordering
    // would still answer thr-second here, which is why updated_at exists.
    await setThreadSession('thr-first', 'ses-resume')

    expect(await getThreadIdBySessionId('ses-resume')).toBe('thr-first')
  })
})

afterAll(async () => {
  await closeDb()
})
