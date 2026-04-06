// Tests for Prisma client initialization and schema migration.
// Auto-isolated via VITEST guards in config.ts (temp data dir) and db.ts (clears KIMAKI_DB_URL).

import { afterAll, describe, expect, test } from 'vitest'
import { getPrisma, closePrisma } from './db.js'
import {
  appendSessionEventsSinceLastTimestamp,
  createPendingWorktree,
  getSessionEventSnapshot,
} from './database.js'

afterAll(async () => {
  await closePrisma()
})

describe('getPrisma', () => {
  test('creates sqlite file and migrates schema automatically', async () => {
    const prisma = await getPrisma()

    const session = await prisma.thread_sessions.create({
      data: { thread_id: 'test-thread-123', session_id: 'test-session-456' },
    })
    expect(session.thread_id).toBe('test-thread-123')
    expect(session.created_at).toBeInstanceOf(Date)

    const found = await prisma.thread_sessions.findUnique({
      where: { thread_id: session.thread_id },
    })
    expect(found?.session_id).toBe('test-session-456')

    // Cleanup test data
    await prisma.thread_sessions.delete({
      where: { thread_id: 'test-thread-123' },
    })
  })

  test('createPendingWorktree creates parent and child rows', async () => {
    const prisma = await getPrisma()
    const threadId = `test-worktree-${Date.now()}`

    await createPendingWorktree({
      threadId,
      worktreeName: 'regression-worktree',
      projectDirectory: '/tmp/regression-project',
    })

    const session = await prisma.thread_sessions.findUnique({
      where: { thread_id: threadId },
    })
    expect(session).toBeTruthy()
    expect(session?.session_id).toBe('')

    const worktree = await prisma.thread_worktrees.findUnique({
      where: { thread_id: threadId },
    })
    expect(worktree).toBeTruthy()
    expect(worktree?.worktree_name).toBe('regression-worktree')
    expect(worktree?.project_directory).toBe('/tmp/regression-project')
    expect(worktree?.status).toBe('pending')

    await prisma.thread_worktrees.delete({ where: { thread_id: threadId } })
    await prisma.thread_sessions.delete({ where: { thread_id: threadId } })
  })

  test('session event persistence uses (timestamp, event_index) ordering for deterministic same-ms replay', async () => {
    const prisma = await getPrisma()
    const threadId = 'test-session-events-thread'
    const sessionId = 'test-session-events-session'

    await prisma.session_events.deleteMany({ where: { session_id: sessionId } })
    await prisma.thread_sessions.deleteMany({ where: { thread_id: threadId } })

    await prisma.thread_sessions.create({
      data: { thread_id: threadId, session_id: sessionId },
    })

    const baseTimestamp = 1_700_000_000_000n

    const inserted1 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
      ],
    })

    const inserted2 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 3,
          event_json: JSON.stringify({ id: 'e3' }),
        },
      ],
    })

    const rows = await getSessionEventSnapshot({ sessionId })
    const orderedIds = rows.map((row) => {
      const parsed = JSON.parse(row.event_json) as { id: string }
      return parsed.id
    })

    expect({ inserted1, inserted2, orderedIds }).toMatchInlineSnapshot(`
      {
        "inserted1": 3,
        "inserted2": 1,
        "orderedIds": [
          "e0",
          "e1",
          "e2",
          "e3",
        ],
      }
    `)

    await prisma.session_events.deleteMany({ where: { session_id: sessionId } })
    await prisma.thread_sessions.deleteMany({ where: { thread_id: threadId } })
  })
})
