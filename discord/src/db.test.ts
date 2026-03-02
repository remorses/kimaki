// Tests for Prisma client initialization and schema migration.
// Auto-isolated via VITEST guards in config.ts (temp data dir) and db.ts (clears KIMAKI_DB_URL).

import crypto from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { getPrisma, closePrisma } from './db.js'
import {
  createPendingWorktree,
  setBotToken,
  setChannelDirectory,
} from './database.js'

const ORIGINAL_GUILD_ID = process.env.KIMAKI_GUILD_ID
const ORIGINAL_PRIVATE_KEY = process.env.KIMAKI_PRIVATE_KEY
const ORIGINAL_APP_ID = process.env.KIMAKI_APP_ID

afterAll(async () => {
  await closePrisma()
  process.env.KIMAKI_GUILD_ID = ORIGINAL_GUILD_ID
  process.env.KIMAKI_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY
  process.env.KIMAKI_APP_ID = ORIGINAL_APP_ID
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

  test('auth mode still seeds bot_tokens so channel directory upsert passes foreign key checks', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    const appId = `app-${Date.now()}`
    const channelId = `channel-${Date.now()}`

    process.env.KIMAKI_GUILD_ID = '1477130736841658398'
    process.env.KIMAKI_APP_ID = appId
    process.env.KIMAKI_PRIVATE_KEY = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()

    await setBotToken(appId, 'auth-mode-seed-token')
    await setChannelDirectory({
      channelId,
      directory: `./tmp/${channelId}`,
      channelType: 'text',
      appId,
    })

    const prisma = await getPrisma()
    const botRow = await prisma.bot_tokens.findUnique({
      where: { app_id: appId },
    })
    expect(botRow?.app_id).toBe(appId)

    const channelRow = await prisma.channel_directories.findUnique({
      where: { channel_id: channelId },
    })
    expect(channelRow?.app_id).toBe(appId)

    await prisma.channel_directories.deleteMany({
      where: { channel_id: channelId },
    })
    await prisma.bot_tokens.deleteMany({
      where: { app_id: appId },
    })
  })
})
