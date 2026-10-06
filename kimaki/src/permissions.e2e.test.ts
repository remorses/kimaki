// Phase 4: permission requests as Accept / Accept Always / Deny buttons,
// including requests of a subagent, shown in the parent thread.

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

const matchers: DeterministicMatcher[] = [
  { id: 'after-deny', priority: 500, when: { latestUserTextIncludes: 'after-deny' }, then: { parts: textParts('continued after deny') } },
  ...scriptedTurn({
    marker: 'perm-accept',
    steps: [{ id: 'call-accept', tool: 'shell', input: { command: 'echo guarded-accept', description: 'Guarded echo' } }],
    finalText: 'accept turn done',
  }),
  ...scriptedTurn({
    marker: 'perm-deny',
    steps: [{ id: 'call-deny', tool: 'shell', input: { command: 'echo guarded-deny', description: 'Guarded echo' } }],
    finalText: 'deny turn done',
  }),
  ...scriptedTurn({
    marker: 'perm-child',
    steps: [
      {
        id: 'call-child-task',
        tool: 'subagent',
        input: { agent: 'general', description: 'Run a guarded command', prompt: 'child-guarded run it' },
      },
    ],
    finalText: 'parent done',
  }),
  ...scriptedTurn({
    marker: 'child-guarded',
    steps: [{ id: 'call-child-shell', tool: 'shell', input: { command: 'echo guarded-child', description: 'Child echo' } }],
    finalText: 'child done',
  }).map((matcher) => ({ ...matcher, priority: (matcher.priority ?? 0) + 100 })),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({ matchers, permissions: [{ action: 'shell', resource: 'echo guarded*', effect: 'ask' }] }),
    startTwin(),
  ])
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

async function startThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

// The permission message and the custom id of the button with this label.
async function waitForButton({ threadId, label }: { threadId: string; label: string }) {
  return waitFor({
    label: `${label} button`,
    check: async () => {
      const messages = await twin.discord.thread(threadId).getMessages()
      for (const message of messages) {
        const customId = buttonId({ message, label })
        if (customId) return { message, customId }
      }
      return null
    },
  })
}

function buttonId({ message, label }: { message: APIMessage; label: string }): string | null {
  for (const row of message.components ?? []) {
    if (row.type !== ComponentType.ActionRow) continue
    for (const component of row.components) {
      if (component.type === ComponentType.Button && 'custom_id' in component && component.label === label) {
        return component.custom_id
      }
    }
  }
  return null
}

test('Accept runs the command', async () => {
  const thread = await startThread('Run it perm-accept')
  const { message, customId } = await waitForButton({ threadId: thread.id, label: 'Accept' })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).clickButton({ messageId: message.id, customId })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Run it perm-accept
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Guarded echo_
    **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo guarded-accept\`
    ✓ _Accepted_

    accept turn done
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

// Deny ends the run (OpenCode interrupts the execution; no footer, no error
// line). The next message works normally.
test('Deny stops the run, the next message is answered', async () => {
  const thread = await startThread('Run it perm-deny')
  const { message, customId } = await waitForButton({ threadId: thread.id, label: 'Deny' })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.clickButton({ messageId: message.id, customId })
  await waitFor({
    label: 'denied status',
    check: async () => (await twin.discord.thread(thread.id).getMessages()).some((m) => m.content.includes('Denied')),
  })
  await user.sendMessage({ content: 'Go on after-deny' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Run it perm-deny
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Guarded echo_
    **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo guarded-deny\`
    ✗ _Denied_
    --- from: user (tommy)
    Go on after-deny
    --- from: assistant (TestBot)
    continued after deny
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a subagent permission shows in the parent thread', async () => {
  const thread = await startThread('Delegate perm-child')
  const { message, customId } = await waitForButton({ threadId: thread.id, label: 'Accept Always' })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).clickButton({ messageId: message.id, customId })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Delegate perm-child
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ general **Run a guarded command**
    -# ┣ general ⋅ shell _Child echo_
    **Permission required**
    **From:** \`general\`
    **Type:** \`shell\`
    **Pattern:** \`echo guarded-child\`
    ✓ _Accepted always_

    parent done
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
