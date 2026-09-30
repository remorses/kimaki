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

test('/diff with a clean working tree and /context-usage after a turn', async () => {
  const thread = await newThread('Hello usage-marker')
  await command(thread.id, 'diff', 'No changes')
  await command(thread.id, 'context-usage', 'Context usage')
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Hello usage-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    counted
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    No changes to show
    **Context usage:** 0%, 2 / 200,000 tokens
    **Model:** deterministic-provider/deterministic-v2"
  `)
})

test('/compact summarizes the history without a footer', async () => {
  const thread = await newThread('Something to compact')
  await command(thread.id, 'compact', 'Compacting')
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'context compacted' })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Something to compact
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    Compacting the session context
    -# ⬦ context compacted"
  `)
  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId, order: 'asc' })
  expect(messages.data.map((message) => message.type)).toContain('compaction')
})

test('/undo reverts the last turn and its files, /redo restores them', async () => {
  const file = path.join(server.projectDirectory, 'undo.txt')
  const thread = await newThread('Create a file write-marker')
  expect(fs.readFileSync(file, 'utf8')).toBe('written by the agent\n')

  await command(thread.id, 'undo', 'Undone')
  expect(fs.existsSync(file)).toBe(false)
  await command(thread.id, 'redo', 'Restored')
  await waitFor({ label: 'file restored', check: async () => fs.existsSync(file) })
  await command(thread.id, 'redo', 'Nothing to redo')
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Create a file write-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ◼︎ write *undo.txt* (2 lines)

    wrote undo.txt
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    Undone - reverted the last turn
    Reverted 1 file(s)
    Restored - session fully back to its previous state
    Nothing to redo - no previous undo found"
  `)
})
