// Phase 4: the question tool (V2 forms) as Discord dropdowns. Answer by
// select, by the "Other" modal, several questions in one form, a new message
// cancels a pending question, and a restarted bot shows it again.

import fs from 'node:fs'
import { ComponentType, type APIMessage } from 'discord.js'
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
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const COLOR = {
  question: 'Which color do you prefer?',
  header: 'Color',
  options: [
    { label: 'Red', description: 'warm' },
    { label: 'Blue', description: 'cold' },
  ],
}
const FRUITS = {
  question: 'Which fruits do you like?',
  header: 'Fruits',
  multiple: true,
  options: [
    { label: 'Apple', description: 'crisp' },
    { label: 'Kiwi', description: 'green' },
    { label: 'Pear', description: 'soft' },
  ],
}

function askTurn({ marker, questions }: { marker: string; questions: object[] }): DeterministicMatcher[] {
  return scriptedTurn({
    marker,
    steps: [{ id: `call-${marker}`, tool: 'question', input: { questions: JSON.parse(JSON.stringify(questions)) } }],
    finalText: `answers received ${marker}`,
  })
}

const matchers: DeterministicMatcher[] = [
  ...askTurn({ marker: 'ask-one', questions: [COLOR] }),
  ...askTurn({ marker: 'ask-two', questions: [COLOR, FRUITS] }),
  ...askTurn({ marker: 'ask-other', questions: [COLOR] }),
  ...askTurn({ marker: 'ask-cancel', questions: [COLOR] }),
  ...askTurn({ marker: 'ask-restart', questions: [COLOR] }),
  { id: 'instead', priority: 500, when: { latestUserTextIncludes: 'instead-marker' }, then: { parts: textParts('did the other thing') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

type Select = { message: APIMessage; customId: string; values: string[] }

function selectsOf(message: APIMessage): Select[] {
  return (message.components ?? []).flatMap((row) =>
    row.type === ComponentType.ActionRow
      ? row.components.flatMap((component) =>
          component.type === ComponentType.StringSelect
            ? [{ message, customId: component.custom_id, values: component.options.map((option) => option.value) }]
            : [],
        )
      : [],
  )
}

// Waits until the thread shows `count` question dropdowns.
async function waitForSelects({ threadId, count }: { threadId: string; count: number }): Promise<Select[]> {
  return waitFor({
    label: `${count} question dropdowns`,
    check: async () => {
      const messages = await twin.discord.thread(threadId).getMessages()
      const selects = messages.flatMap(selectsOf)
      return selects.length >= count ? selects : null
    },
  })
}

async function startThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

test('single question answered from the dropdown', async () => {
  const thread = await startThread('Pick a color ask-one')
  const [select] = await waitForSelects({ threadId: thread.id, count: 1 })
  expect(select!.values).toMatchInlineSnapshot(`
    [
      "0",
      "1",
      "other",
    ]
  `)
  await twin.discord.thread(thread.id).user(TEST_USER_ID).selectMenu({
    messageId: select!.message.id,
    customId: select!.customId,
    values: [select!.values[1]!],
  })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text({ showInteractions: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Pick a color ask-one
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Color**
    Which color do you prefer?
    ✓ _Blue_
    [user selects dropdown: 1]
    answers received ask-one
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('two questions: the form is answered after both, multi-select keeps options picked with Other', async () => {
  const thread = await startThread('Two questions ask-two')
  const [color, fruits] = await waitForSelects({ threadId: thread.id, count: 2 })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.selectMenu({ messageId: fruits!.message.id, customId: fruits!.customId, values: [fruits!.values[0]!, fruits!.values[1]!, 'other'] })
  await user.submitModal({
    customId: fruits!.customId.replace(/^form:/, 'form_other:'),
    messageId: fruits!.message.id,
    fields: [{ customId: 'answer', value: 'Banana' }],
  })
  await user.selectMenu({ messageId: color!.message.id, customId: color!.customId, values: [color!.values[0]!] })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Two questions ask-two
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Color**
    Which color do you prefer?
    ✓ _Red_
    **Fruits**
    Which fruits do you like?
    ✓ _Apple, Kiwi, Banana_
    answers received ask-two
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId })
  expect(JSON.stringify(messages.data)).toContain('\\"Which fruits do you like?\\"=\\"Apple, Kiwi, Banana\\"')
})

test('Other opens a modal and sends the typed answer', async () => {
  const thread = await startThread('Custom color ask-other')
  const [select] = await waitForSelects({ threadId: thread.id, count: 1 })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.selectMenu({ messageId: select!.message.id, customId: select!.customId, values: ['other'] })
  const modalId = select!.customId.replace(/^form:/, 'form_other:')
  await user.submitModal({ customId: modalId, messageId: select!.message.id, fields: [{ customId: 'answer', value: 'Teal' }] })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Custom color ask-other
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Color**
    Which color do you prefer?
    ✓ _Teal_
    answers received ask-other
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a new message cancels the pending question and is answered', async () => {
  const thread = await startThread('Ask then change ask-cancel')
  await waitForSelects({ threadId: thread.id, count: 1 })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Forget it instead-marker' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Ask then change ask-cancel
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Color**
    Which color do you prefer?
    ✗ _cancelled_
    --- from: user (tommy)
    Forget it instead-marker
    --- from: assistant (TestBot)
    did the other thing
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a restarted bot shows the pending question again and it still works', async () => {
  const thread = await startThread('Survive restart ask-restart')
  await waitForSelects({ threadId: thread.id, count: 1 })
  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server })
  const selects = await waitForSelects({ threadId: thread.id, count: 2 })
  const fresh = selects[selects.length - 1]!
  await twin.discord.thread(thread.id).user(TEST_USER_ID).selectMenu({
    messageId: fresh.message.id,
    customId: fresh.customId,
    values: [fresh.values[0]!],
  })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Survive restart ask-restart
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Color**
    Which color do you prefer?
    **Color**
    Which color do you prefer?
    ✓ _Red_
    answers received ask-restart
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
