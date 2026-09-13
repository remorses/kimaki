// CLI-injected rules apply before execution and survive ordinary Discord follow-ups.
import fs from 'node:fs'
import path from 'node:path'
import { ChannelType } from 'discord.js'
import { expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const channelId = '200000000000001067'
const ctx = setupQueueAdvancedSuite({
  channelId,
  channelName: 'session-permission-ingress',
  dirName: 'session-permission-ingress',
  username: 'permission-tester',
  extraMatchers: [
    {
      id: 'session-permission-write',
      priority: 300,
      when: { lastMessageRole: 'user', latestUserTextIncludes: 'PERMISSION_WRITE_' },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'permission-write', toolName: 'write', input: JSON.stringify({ path: 'probe.txt', content: 'changed' }) },
          { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      },
    },
    {
      id: 'session-permission-write-finished',
      priority: 300,
      when: { lastMessageRole: 'tool', latestUserTextIncludes: 'PERMISSION_WRITE_' },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'finished' },
          { type: 'text-delta', id: 'finished', delta: 'permission-write-finished' },
          { type: 'text-end', id: 'finished' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      },
    },
  ],
})

test('creates, preserves, explicitly replaces, and preserves session rules', async () => {
  const file = path.join(ctx.directories.projectDirectory, 'probe.txt')
  fs.writeFileSync(file, 'original')
  const channel = await ctx.botClient.channels.fetch(channelId)
  if (channel?.type !== ChannelType.GuildText) throw new Error('Missing test channel')
  const starter = await channel.send({
    content: 'PERMISSION_WRITE_create',
    embeds: [{ footer: { text: JSON.stringify({
      start: true,
      username: 'permission-tester',
      userId: TEST_USER_ID,
      permissions: ['edit:probe.txt:deny'],
    }) } }],
  })
  const thread = await starter.startThread({ name: 'session-permission-ingress' })
  const th = ctx.discord.thread(thread.id)
  await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'permission-write-finished', timeout: 4_000 })
  await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, afterMessageIncludes: 'permission-write-finished', timeout: 4_000 })
  const results = [{ step: 'create', content: fs.readFileSync(file, 'utf8'), denied: (await th.text()).includes('Permission denied: edit') }]

  for (const step of [
    { name: 'preserve-deny', permissions: undefined },
    { name: 'replace', permissions: ['edit:probe.txt:allow'] },
    { name: 'preserve-allow', permissions: undefined },
  ]) {
    fs.writeFileSync(file, 'original')
    const prompt = `PERMISSION_WRITE_${step.name}`
    const message = step.permissions
      ? await thread.send({
          content: prompt,
          embeds: [{ footer: { text: JSON.stringify({ cliThreadPrompt: true, userId: TEST_USER_ID, username: 'permission-tester', permissions: step.permissions }) } }],
        })
      : await th.user(TEST_USER_ID).sendMessage({ content: prompt })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'permission-write-finished', afterMessageId: message.id, timeout: 4_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, afterMessageIncludes: 'permission-write-finished', timeout: 4_000 })
    const text = await th.text()
    results.push({ step: step.name, content: fs.readFileSync(file, 'utf8'), denied: text.slice(text.lastIndexOf(prompt)).includes('Permission denied: edit') })
  }

  expect(await th.text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    PERMISSION_WRITE_create
    [embed]
    > *using deterministic-provider/deterministic-v2*
    ▎write (1 line)
    ⨯ write Permission denied: edit (1 line)

    permission-write-finished
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>
    --- from: user (permission-tester)
    PERMISSION_WRITE_preserve-deny
    --- from: assistant (TestBot)
    ▎write (1 line)
    ⨯ write Permission denied: edit (1 line)

    permission-write-finished
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>
    PERMISSION_WRITE_replace
    [embed]
    ▎write (1 line)

    permission-write-finished
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>
    --- from: user (permission-tester)
    PERMISSION_WRITE_preserve-allow
    --- from: assistant (TestBot)
    ▎write (1 line)

    permission-write-finished
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>"
  `)
  expect(results).toEqual([
    { step: 'create', content: 'original', denied: true },
    { step: 'preserve-deny', content: 'original', denied: true },
    { step: 'replace', content: 'changed', denied: false },
    { step: 'preserve-allow', content: 'changed', denied: false },
  ])
}, 20_000)
