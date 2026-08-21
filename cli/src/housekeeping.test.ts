import { afterAll, describe, expect, test } from 'vitest'
import * as orm from 'drizzle-orm'

import {
  ARCHIVE_AFTER_DAYS,
  PURGE_EVENTS_AFTER_DAYS,
  getDiscordSnowflakeTimestamp,
  getHousekeepingCutoffs,
  getHousekeepingPlan,
  purgeSessionEventsBefore,
} from './housekeeping.js'
import { closeDb, getDb } from './db.js'
import * as schema from './schema.js'

afterAll(async () => {
  await closeDb()
})

describe('getHousekeepingCutoffs', () => {
  test('uses fixed retention windows from one clock value', () => {
    const now = 1_800_000_000_000
    const day = 24 * 60 * 60 * 1000

    expect(getHousekeepingCutoffs(now)).toEqual({
      archiveBefore: now - ARCHIVE_AFTER_DAYS * day,
      purgeEventsBefore: now - PURGE_EVENTS_AFTER_DAYS * day,
    })
  })

  test('reads a Discord message Snowflake activity time', () => {
    expect(getDiscordSnowflakeTimestamp('175928847299117063')).toBe(1_462_015_105_796)
    expect(getDiscordSnowflakeTimestamp('not-a-snowflake')).toBeNull()
  })

  test('plans and purges only events older than the retention cutoff', async () => {
    const db = await getDb()
    const now = 1_800_000_000_000
    const { archiveBefore, purgeEventsBefore } = getHousekeepingCutoffs(now)
    const oldThreadId = 'housekeeping-old-thread'
    const recentThreadId = 'housekeeping-recent-thread'

    await db
      .delete(schema.thread_sessions)
      .where(orm.inArray(schema.thread_sessions.thread_id, [oldThreadId, recentThreadId]))
    await db.insert(schema.thread_sessions).values([
      { thread_id: oldThreadId, session_id: 'housekeeping-old-session' },
      { thread_id: recentThreadId, session_id: 'housekeeping-recent-session' },
    ])
    await db.insert(schema.session_events).values([
      {
        session_id: 'housekeeping-old-session',
        thread_id: oldThreadId,
        timestamp: purgeEventsBefore - 1,
        event_index: 0,
        event_json: '{}',
      },
      {
        session_id: 'housekeeping-recent-session',
        thread_id: recentThreadId,
        timestamp: archiveBefore + 1,
        event_index: 0,
        event_json: '{}',
      },
    ])

    const plan = await getHousekeepingPlan({ now })
    expect(plan.archiveCandidates.map((candidate) => candidate.threadId)).toContain(oldThreadId)
    expect(plan.archiveCandidates.map((candidate) => candidate.threadId)).not.toContain(
      recentThreadId,
    )
    expect(plan.purgeEventCount).toBeGreaterThanOrEqual(1)

    await expect(purgeSessionEventsBefore(purgeEventsBefore)).resolves.toBeGreaterThanOrEqual(1)
    await expect(
      db.query.session_events.findMany({
        where: { thread_id: recentThreadId },
      }),
    ).resolves.toHaveLength(1)

    await db
      .delete(schema.thread_sessions)
      .where(orm.inArray(schema.thread_sessions.thread_id, [oldThreadId, recentThreadId]))
  })

  test('keeps failed archive targets available for a future housekeeping retry', async () => {
    const db = await getDb()
    const threadId = 'housekeeping-retry-thread'
    const sessionId = 'housekeeping-retry-session'
    const { purgeEventsBefore } = getHousekeepingCutoffs(1_800_000_000_000)

    await db
      .delete(schema.thread_sessions)
      .where(orm.eq(schema.thread_sessions.thread_id, threadId))
    await db.insert(schema.thread_sessions).values({ thread_id: threadId, session_id: sessionId })
    await db.insert(schema.session_events).values({
      session_id: sessionId,
      thread_id: threadId,
      timestamp: purgeEventsBefore - 1,
      event_index: 0,
      event_json: '{}',
    })

    await expect(purgeSessionEventsBefore(purgeEventsBefore, [threadId])).resolves.toBe(0)
    await expect(
      db.query.session_events.findMany({ where: { thread_id: threadId } }),
    ).resolves.toHaveLength(1)

    await db
      .delete(schema.thread_sessions)
      .where(orm.eq(schema.thread_sessions.thread_id, threadId))
  })
})
