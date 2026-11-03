// Thread commands that act on the session history and project: /diff,
// /context-usage, /compact, /undo and /redo.

import fs from 'node:fs'
import path from 'node:path'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  scriptedTurn,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitFor,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  // OpenCode rejects a summary without the template headings.
  {
    id: 'compaction-summary',
    priority: 900,
    when: { latestUserTextIncludes: 'You MUST use this format for your response' },
    then: { parts: textParts('## Objective\n- Test compaction') },
  },
  { id: 'usage', priority: 500, when: { latestUserTextIncludes: 'usage-marker' }, then: { parts: textParts('counted') } },
  // A reasoning block that stays open long enough to run /context-usage inside it.
  {
    id: 'slow-thinking',
    priority: 500,
    when: { latestUserTextIncludes: 'thinking-marker' },
    then: {
      parts: [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'pondering' },
        { type: 'reasoning-end', id: 'r1' },
        ...textParts('thought it through'),
      ],
      partDelaysMs: [0, 0, 2_500, 0, 0, 0, 0],
    },
  },
  ...scriptedTurn({
    marker: 'write-marker',
    steps: [{ id: 'call-write-1', tool: 'write', input: { path: 'undo.txt', content: 'written by the agent\n' } }],
    finalText: 'wrote undo.txt',
  }),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function newThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  await waitForFooter({ discord, threadId: thread.id })
  return thread
}

// Runs a slash command in the thread and waits for its (deferred) reply text.
async function command(threadId: string, name: string, text: string) {
  const { id } = await twin.discord.thread(threadId).user(TEST_USER_ID).runSlashCommand({ name })
  await twin.discord.thread(threadId).waitForInteractionAck({ interactionId: id })
  return waitForBotMessageContaining({ discord: twin.discord, threadId, text })
}

// /context-usage status durations depend on timing.
function stableDurations(text: string) {
  return text.replace(/<1s|\b\d+m \d+s\b|\b\d+s\b/g, 'Ns')
}

test('/diff with a clean working tree and /context-usage after a turn', async () => {
  const thread = await newThread('Hello usage-marker')
  await command(thread.id, 'diff', 'No changes')
  await command(thread.id, 'context-usage', 'Context usage')
  expect(stableDurations(await twin.discord.thread(thread.id).text())).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Hello usage-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    counted
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    No changes to show
    **Context usage:** 0%, 2 / 200,000 tokens
    **Model:** deterministic-provider/deterministic-v2
    **Status:** idle for Ns"
  `)
})

test('/context-usage while the model thinks shows the run and what it does', async () => {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Ponder this thinking-marker' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  const client = await server.client()
  await waitFor({
    label: 'open reasoning block',
    check: async () => {
      const sessionId = bot.store.getState().roots[thread.id]
      if (!sessionId) return null
      const messages = await client.message.list({ sessionID: sessionId, type: 'assistant', order: 'desc', limit: 1 })
      return messages.data.some((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'reasoning')) || null
    },
  })
  await command(thread.id, 'context-usage', 'Status:')
  await waitForFooter({ discord, threadId: thread.id })
  expect(stableDurations(await discord.thread(thread.id).text())).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Ponder this thinking-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Token usage not available for this session yet
    **Status:** running for Ns, thinking for Ns
    **Last activity:** Ns ago, thinking
    thought it through
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('/compact summarizes the history without a footer', async () => {
  const thread = await newThread('Something to compact')
  await command(thread.id, 'compact', 'Compacting')
  const sessionId = bot.store.getState().roots[thread.id]!
  const client = await server.client()
  await waitFor({
    label: 'compaction message',
    check: async () => (await client.message.list({ sessionID: sessionId, order: 'asc' })).data.some((message) => message.type === 'compaction') || null,
  })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Something to compact
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *main ⋅ Ns ⋅ deterministic-v2*
    Compacting the session context"
  `)
})

test('/undo hides the last turn but keeps its files, /redo restores the turn', async () => {
  const file = path.join(server.projectDirectory, 'undo.txt')
  const thread = await newThread('Create a file write-marker')
  expect(fs.readFileSync(file, 'utf8')).toBe('written by the agent\n')
  const sessionId = bot.store.getState().roots[thread.id]!
  const opencode = await server.client()

  await command(thread.id, 'undo', 'Undone')
  expect((await opencode.session.get({ sessionID: sessionId })).revert?.messageID).toBeDefined()
  expect(fs.readFileSync(file, 'utf8')).toBe('written by the agent\n')
  await command(thread.id, 'redo', 'Restored')
  expect((await opencode.session.get({ sessionID: sessionId })).revert).toBeUndefined()
  expect(fs.readFileSync(file, 'utf8')).toBe('written by the agent\n')
  await command(thread.id, 'redo', 'Nothing to redo')
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Create a file write-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ◼︎ write *undo.txt* (2 lines)

    wrote undo.txt
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    Undone - removed the last turn from the session. File changes were kept
    Restored - session fully back to its previous state
    Nothing to redo - no previous undo found"
  `)
})
