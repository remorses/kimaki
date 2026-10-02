// Commands that put a session in a new thread: /new-session, /resume,
// /fork and /fork-subagent. Resumed and forked threads replay the recent
// history, then continue the same OpenCode session.

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
  waitForFooter,
  waitForSelectMenu,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

function reply(marker: string, text: string, extra: DeterministicMatcher['when'] = {}, priority = 500): DeterministicMatcher {
  return { id: `${marker}-${priority}`, priority, when: { latestUserTextIncludes: marker, ...extra }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  reply('new-marker', 'saw the file', { rawPromptIncludes: 'file-body-marker' }),
  reply('first-marker', 'first answer'),
  reply('second-marker', 'second answer', {}, 510),
  reply('tui-marker', 'tui answer'),
  reply('resumed-marker', 'resumed answer'),
  // The fork ends before the second message: its history must not contain it.
  reply('fork-check', 'fork still has the second message', { rawPromptIncludes: 'second-marker' }, 600),
  reply('fork-check', 'fork has only the first message', {}, 550),
  ...scriptedTurn({
    marker: 'subagent-marker',
    steps: [{ id: 'call-subagent-1', tool: 'subagent', input: { agent: 'general', description: 'Count files', prompt: 'child-marker count' } }],
    finalText: 'The child counted.',
  }),
  reply('child-marker', 'child says three', {}, 700),
  reply('child-followup', 'child fork continues', {}, 800),
  ...scriptedTurn({
    marker: 'ask-resume',
    steps: [
      {
        id: 'call-ask-resume',
        tool: 'question',
        input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }] }] },
      },
    ],
    finalText: 'answered after resume',
  }),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  fs.writeFileSync(path.join(server.projectDirectory, 'notes.txt'), 'file-body-marker\n')
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

function hide(text: string): string {
  return text
    .replace(/<#\d+>/g, '<#THREAD>')
    .replace(/ses_\w+/g, 'ses_ID')
    .replace(/<t:\d+:f>/g, '<t:TIME:f>')
}

async function newThread(send: () => Promise<unknown>) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await send()
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

async function sessionThread(content: string) {
  const thread = await newThread(() => twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content }))
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  return thread
}

test('/new-session starts a thread with attached files and an agent', async () => {
  const { discord, channelId } = twin
  const user = discord.channel(channelId).user(TEST_USER_ID)
  expect(await user.autocomplete({ name: 'new-session', options: [{ name: 'files', type: 3, value: 'note' }], focused: 'files' }))
    .toMatchInlineSnapshot(`
      [
        {
          "name": "notes.txt",
          "value": "notes.txt",
        },
      ]
    `)
  expect(await user.autocomplete({ name: 'new-session', options: [{ name: 'agent', type: 3, value: 'pl' }], focused: 'agent' }))
    .toMatchInlineSnapshot(`
      [
        {
          "name": "Plan",
          "value": "plan",
        },
      ]
    `)
  const thread = await newThread(() =>
    user.runSlashCommand({
      name: 'new-session',
      options: [
        { name: 'prompt', type: 3, value: 'Read it new-marker' },
        { name: 'files', type: 3, value: 'notes.txt' },
        { name: 'agent', type: 3, value: 'plan' },
      ],
    }),
  )
  await waitForFooter({ discord, threadId: thread.id })
  expect(hide(await discord.channel(channelId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Created new session in <#THREAD>"
  `)
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **tommy:** Read it new-marker
    Files: notes.txt
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    saw the file
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
})

test('/resume binds an existing session to a new thread and moves the binding', async () => {
  const { discord, channelId } = twin
  // A session started outside Discord (for example in the TUI).
  const client = await server.client()
  const tui = await client.session.create({ location: { directory: server.projectDirectory }, title: 'TUI work' })
  await client.session.prompt({ sessionID: tui.id, text: 'Hello tui-marker' })
  await client.session.wait({ sessionID: tui.id })

  const user = discord.channel(channelId).user(TEST_USER_ID)
  const choices = await user.autocomplete({ name: 'resume', options: [{ name: 'session', type: 3, value: 'TUI' }], focused: 'session' })
  expect(choices.map((choice) => ({ ...choice, name: choice.name.replace(/\(.*\)/, '(DATE)') }))).toEqual([
    { name: 'TUI work (DATE)', value: tui.id },
  ])
  const resumed = await newThread(() => user.runSlashCommand({ name: 'resume', options: [{ name: 'session', type: 3, value: tui.id }] }))
  await waitFor({
    label: 'resume note',
    check: async () => (await discord.thread(resumed.id).text()).includes('Session resumed'),
  })
  await discord.thread(resumed.id).user(TEST_USER_ID).sendMessage({ content: 'Go on resumed-marker' })
  await waitForFooter({ discord, threadId: resumed.id })
  expect(hide(await discord.thread(resumed.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Resumed session:** TUI work
    **Created:** <t:TIME:f>
    tui answer
    **Session resumed!** You can now continue the conversation by sending messages in this thread.
    --- from: user (tommy)
    Go on resumed-marker
    --- from: assistant (TestBot)
    resumed answer
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)

  // Resuming again moves the session: the old thread stops following it.
  const moved = await newThread(() => user.runSlashCommand({ name: 'resume', options: [{ name: 'session', type: 3, value: tui.id }] }))
  await waitFor({ label: 'second resume note', check: async () => (await discord.thread(moved.id).text()).includes('Session resumed') })
  const { roots } = bot.store.getState()
  expect({ old: roots[resumed.id] ?? null, moved: roots[moved.id] === tui.id }).toEqual({ old: null, moved: true })
  const rows = await bot.db.db.query.thread_sessions.findMany({ where: { session_id: tui.id } })
  expect(rows.map((row) => row.thread_id)).toEqual([moved.id])
  expect(hide(await discord.channel(channelId).text())).toContain('Resumed session "TUI work" in <#THREAD>')
})

test('/fork forks before a user message into a new thread', async () => {
  const { discord } = twin
  const source = await sessionThread('Start first-marker')
  await discord.thread(source.id).user(TEST_USER_ID).sendMessage({ content: 'Then second-marker' })
  await waitForFooter({ discord, threadId: source.id, count: 2 })

  await discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork' })
  const { message, select } = await waitForSelectMenu({ discord: twin.discord, channelId: source.id, prefix: 'fork:' })
  expect(select.options.map((option) => option.label)).toMatchInlineSnapshot(`
    [
      "1. Start first-marker",
      "2. Then second-marker",
    ]
  `)
  const second = select.options[1]!
  const fork = await newThread(() =>
    discord.thread(source.id).user(TEST_USER_ID).selectMenu({ messageId: message.id, customId: select.custom_id, values: [second.value] }),
  )
  await waitFor({ label: 'fork note', check: async () => (await discord.thread(fork.id).text()).includes('continue the conversation') })
  await discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Check fork-check' })
  await waitForFooter({ discord, threadId: fork.id })
  expect(fork.name).toBe('Start first-marker (fork #1)')
  expect(hide(await discord.thread(fork.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Forked session created!**
    From: <#THREAD> (\`ses_ID\`)
    New session: \`ses_ID\`
    first answer
    You can now continue the conversation from this point.
    --- from: user (tommy)
    Check fork-check
    --- from: assistant (TestBot)
    fork has only the first message
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(hide(await discord.thread(source.id).text())).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Start first-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    first answer
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Then second-marker
    --- from: assistant (TestBot)
    second answer
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    Session forked! Continue in <#THREAD>"
  `)
})

test('/fork-subagent forks a subagent session into a new thread', async () => {
  const { discord } = twin
  const source = await sessionThread('Delegate subagent-marker')
  const client = await server.client()
  const unrelated = await client.session.create({ location: { directory: server.projectDirectory }, title: 'Unrelated session' })
  await client.session.prompt({ sessionID: unrelated.id, text: 'Start first-marker' })
  await client.session.wait({ sessionID: unrelated.id })
  const threadsBefore = (await discord.channel(twin.channelId).getThreads()).map((thread) => thread.id)
  const sessionsBefore = (await client.session.list({ directory: server.projectDirectory })).data.map((session) => session.id)
  await discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork-subagent' })
  const forged = await waitForSelectMenu({ discord, channelId: source.id, prefix: 'fork_sub:' })
  await discord.thread(source.id).user(TEST_USER_ID).selectMenu({ messageId: forged.message.id, customId: forged.select.custom_id, values: [unrelated.id] })
  await waitFor({
    label: 'fork selection response',
    check: async () => !(await discord.thread(source.id).getMessages()).find((message) => message.id === forged.message.id)?.content.includes('Select a subagent session'),
  })
  expect((await discord.thread(source.id).getMessages()).find((message) => message.id === forged.message.id)?.content).toMatchInlineSnapshot(`"This session is not the thread's root or a direct subagent. Run /fork or /fork-subagent in the session's own thread."`)
  expect((await discord.channel(twin.channelId).getThreads()).map((thread) => thread.id)).toEqual(threadsBefore)
  expect((await client.session.list({ directory: server.projectDirectory })).data.map((session) => session.id)).toEqual(sessionsBefore)
  await discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork-subagent' })
  const { message, select } = await waitForSelectMenu({ discord: twin.discord, channelId: source.id, prefix: 'fork_sub:' })
  expect(select.options.map((option) => option.label)).toMatchInlineSnapshot(`
    [
      "general · Count files",
    ]
  `)
  const fork = await newThread(() =>
    discord
      .thread(source.id)
      .user(TEST_USER_ID)
      .selectMenu({ messageId: message.id, customId: select.custom_id, values: [select.options[0]!.value] }),
  )
  await waitFor({ label: 'fork note', check: async () => (await discord.thread(fork.id).text()).includes('continue the conversation') })
  await discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'More child-followup' })
  await waitForFooter({ discord, threadId: fork.id })
  expect(fork.name).toMatchInlineSnapshot(`"Count files (fork #1)"`)
  expect(hide(await discord.thread(fork.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Forked subagent session created!**
    Agent: \`general\`
    Task: Count files
    From: \`ses_ID\`
    New session: \`ses_ID\`
    child says three
    You can now continue the conversation from this point.
    --- from: user (tommy)
    More child-followup
    --- from: assistant (TestBot)
    child fork continues
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ general*"
  `)
})

test('/resume of a session waiting on a question shows the question in the new thread', async () => {
  const { discord, channelId } = twin
  const client = await server.client()
  const tui = await client.session.create({ location: { directory: server.projectDirectory }, title: 'Asks a question' })
  await client.session.prompt({ sessionID: tui.id, text: 'Please ask-resume' })
  await waitFor({ label: 'pending form', check: async () => (await client.session.form.list({ sessionID: tui.id })).length > 0 })

  const user = discord.channel(channelId).user(TEST_USER_ID)
  const thread = await newThread(() => user.runSlashCommand({ name: 'resume', options: [{ name: 'session', type: 3, value: tui.id }] }))
  const { message, select } = await waitForSelectMenu({ discord, channelId: thread.id, prefix: 'form:' })
  await discord.thread(thread.id).user(TEST_USER_ID).selectMenu({ messageId: message.id, customId: select.custom_id, values: ['0'] })
  await waitForFooter({ discord, threadId: thread.id })
  expect(hide(await discord.thread(thread.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Resumed session:** Asks a question
    **Created:** <t:TIME:f>
    **Session resumed!** You can now continue the conversation by sending messages in this thread.
    **Color**
    Which color?
    ✓ _Red_
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
})
