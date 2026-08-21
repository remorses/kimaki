import * as orm from 'drizzle-orm'

import { getDb } from './db.js'
import * as schema from './schema.js'

export const ARCHIVE_AFTER_DAYS = 14
export const PURGE_EVENTS_AFTER_DAYS = 90

const millisecondsPerDay = 24 * 60 * 60 * 1000
const discordEpoch = 1_420_070_400_000n

export function getDiscordSnowflakeTimestamp(snowflake: string) {
  try {
    return Number((BigInt(snowflake) >> 22n) + discordEpoch)
  } catch {
    return null
  }
}

export function getHousekeepingCutoffs(now = Date.now()) {
  return {
    archiveBefore: now - ARCHIVE_AFTER_DAYS * millisecondsPerDay,
    purgeEventsBefore: now - PURGE_EVENTS_AFTER_DAYS * millisecondsPerDay,
  }
}

export async function getHousekeepingPlan({
  now = Date.now(),
}: {
  now?: number
} = {}) {
  const db = await getDb()
  const { archiveBefore, purgeEventsBefore } = getHousekeepingCutoffs(now)
  const lastActivityAt = orm.max(schema.session_events.timestamp)
  const archiveCandidates = await db
    .select({
      threadId: schema.thread_sessions.thread_id,
      sessionId: schema.thread_sessions.session_id,
      lastActivityAt,
    })
    .from(schema.thread_sessions)
    .innerJoin(
      schema.session_events,
      orm.eq(schema.session_events.thread_id, schema.thread_sessions.thread_id),
    )
    .groupBy(schema.thread_sessions.thread_id, schema.thread_sessions.session_id)
    .having(orm.lt(lastActivityAt, archiveBefore))

  const [purge] = await db
    .select({ count: orm.count() })
    .from(schema.session_events)
    .where(orm.lt(schema.session_events.timestamp, purgeEventsBefore))

  const candidateThreadIds = new Set(archiveCandidates.map((row) => row.threadId))
  const workspaces = await db.query.thread_workspaces.findMany({
    where: { workspace_type: 'kimaki-worktree' },
    columns: { thread_id: true, workspace_directory: true },
  })

  return {
    archiveBefore,
    purgeEventsBefore,
    archiveCandidates,
    purgeEventCount: purge?.count ?? 0,
    worktreeCandidates: workspaces.filter((workspace) =>
      candidateThreadIds.has(workspace.thread_id),
    ),
  }
}

export async function getThreadLastActivity(threadId: string) {
  const db = await getDb()
  const [row] = await db
    .select({ lastActivityAt: orm.max(schema.session_events.timestamp) })
    .from(schema.session_events)
    .where(orm.eq(schema.session_events.thread_id, threadId))
  return row?.lastActivityAt ?? null
}

export async function purgeSessionEventsBefore(
  timestamp: number,
  excludedThreadIds: string[] = [],
) {
  const db = await getDb()
  const conditions = [orm.lt(schema.session_events.timestamp, timestamp)]
  if (excludedThreadIds.length > 0) {
    conditions.push(orm.notInArray(schema.session_events.thread_id, excludedThreadIds))
  }
  const deleted = await db
    .delete(schema.session_events)
    .where(orm.and(...conditions))
    .returning({ id: schema.session_events.id })
  return deleted.length
}

export async function vacuumDatabase() {
  const db = await getDb()
  await db.run(orm.sql`VACUUM`)
}
