// E2e tests for the `queue` message suffix.
// Covers deleting queued Discord messages before drain, and `kimaki send`
// prompts ending in `queue` taking the same local-queue path as user messages.

import { describe, test, expect } from 'vitest'
import { Routes } from 'discord.js'
import YAML from 'yaml'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import type { ThreadStartMarker } from './system-message.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { buildLongPromptMessage } from './cli-runner.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
  waitForThreadState,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001071'

const e2eTest = describe

e2eTest('queue delete message', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'queue-delete-message-e2e',
    dirName: 'queue-delete-message-e2e',
    username: 'queue-delete-tester',
  })

  test(
    'deleting a queued Discord message removes it from queue',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup'
        },
      })
      const th = ctx.discord.thread(thread.id)

      // Clamped helper: the first turn of a file pays the OpenCode cold start.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '*using ',
        timeout: 4_000,
      })

      const queuedMsg = await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: deleted-queue. queue',
      })

      await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.some((item) => {
            return item.sourceMessageId === queuedMsg.id
          })
        },
        timeout: 4_000,
        description: 'queue has item to delete',
      })

      await th.user(TEST_USER_ID).deleteMessage({ messageId: queuedMsg.id })

      await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return !state.queueItems.some((item) => {
            return item.sourceMessageId === queuedMsg.id
          })
        },
        timeout: 4_000,
        description: 'queued item removed after Discord delete',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'removed message from queue',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-delete-tester)
        SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        -# Queued at position 1. Edit or delete your message to update the queue
        -# **queue-delete-tester** removed message from queue
        slow-busy-reply
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const finalText = await th.text()
      expect(finalText).not.toContain(
        '» **queue-delete-tester:** Reply with exactly: deleted-queue',
      )
    },
    12_000,
  )

  test(
    'kimaki send prompts ending in queue use the local queue',
    async () => {
      // Same marker `kimaki send` puts on --channel starters and --thread injections.
      const marker: ThreadStartMarker = {
        start: true,
        username: 'queue-delete-tester',
        userId: TEST_USER_ID,
      }
      const embeds = [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]

      // `kimaki send --channel`: raw starter message, then thread via REST.
      const starter = await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .bot()
        .sendMessage({
          content: 'SLOW_BUSY_MARKER Reply with exactly: cli-queue-setup. queue',
          embeds,
        })
      const thread = (await ctx.botClient.rest.post(
        Routes.threads(TEXT_CHANNEL_ID, starter.id),
        { body: { name: 'cli-queue-setup', auto_archive_duration: 1440 } },
      )) as { id: string }
      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '*using ',
        timeout: 4_000,
      })

      // `kimaki send --thread` with a prompt over 2000 chars, while the first
      // turn is still running. The CLI moves it into prompt.md.
      const longPrompt = buildLongPromptMessage(
        `» **kimaki-cli:**\nReply with exactly: cli-queued\n${'filler line\n'.repeat(200)}. queue`,
      )
      const injected = await th.bot().sendMessage({
        content: longPrompt.content,
        embeds,
        attachments: [
          {
            id: '200000000000009001',
            filename: 'prompt.md',
            content_type: 'text/markdown',
            size: longPrompt.fileText.length,
            url: `data:text/markdown;base64,${Buffer.from(longPrompt.fileText).toString('base64')}`,
            proxy_url: 'data:text/markdown;base64,',
          },
        ],
      })

      await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.some((item) => {
            return item.sourceMessageId === injected.id
          })
        },
        timeout: 4_000,
        description: 'CLI-injected message waits in local queue',
      })

      // The drain repost is the last message containing the queued prompt.
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        afterMessageIncludes: '» **queue-delete-tester:**',
        timeout: 8_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        SLOW_BUSY_MARKER Reply with exactly: cli-queue-setup. queue
        [embed]
        -# *using deterministic-provider/deterministic-v2*
        Prompt attached as file (2448 chars)

        > » **kimaki-cli:** Reply with exactly: cli-queued filler line filler line filler line filler line fil…

        queue
        [embed]
        [attachment: prompt.md]
        -# Queued at position 1. Edit or delete your message to update the queue
        slow-busy-reply
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **queue-delete-tester:** Prompt attached as file (2448 chars)

        > » **kimaki-cli:** Reply with exactly: cli-queued filler line filler line filler line filler line fil…

        <attach...
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // Both CLI paths strip the suffix before the prompt reaches the model.
      const sessionId = await getThreadSession(thread.id)
      const getClient = await initializeOpencodeForDirectory(
        ctx.directories.projectDirectory,
      )
      if (getClient instanceof Error) {
        throw getClient
      }
      const messages = await getClient().session.messages({
        sessionID: sessionId!,
        directory: ctx.directories.projectDirectory,
      })
      const userPrompts = (messages.data || []).flatMap((m) => {
        if (m.info.role !== 'user') return []
        return m.parts.flatMap((part) => {
          if (part.type !== 'text' || part.synthetic) return []
          return [
            part.text
              .replace(/(filler line\n)+/g, '<filler>\n')
              .replace(/<attachment [^>]*>/g, '<attachment prompt.md>'),
          ]
        })
      })
      expect(userPrompts).toMatchInlineSnapshot(`
        [
          "SLOW_BUSY_MARKER Reply with exactly: cli-queue-setup

        <embed>
        Footer: start: true
        username: queue-delete-tester
        userId: "200000000000000991"

        </embed>",
          "Prompt attached as file (2448 chars)

        > » **kimaki-cli:** Reply with exactly: cli-queued filler line filler line filler line filler line fil…

        <attachment prompt.md>
        » **kimaki-cli:**
        Reply with exactly: cli-queued
        <filler>
        </attachment>",
        ]
      `)
    },
    15_000,
  )
})
