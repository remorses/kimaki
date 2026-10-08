// E2e coverage for `!cmd` shell commands in a session thread: plain messages
// and the queue suffix. Commands never touch the OpenCode
// session; reply to the output message to give it to the model.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001091'

// `role: first text line`, plus the error name of aborted assistant messages.
async function getSessionTimeline({
  threadId,
  directory,
}: {
  threadId: string
  directory: string
}) {
  const sessionId = await getThreadSession(threadId)
  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) throw getClient
  const messages = await getClient().session.messages({
    sessionID: sessionId!,
    directory,
  })
  return (messages.data || []).map((message) => {
    const text = message.parts.flatMap((part) => {
      if (part.type !== 'text' || part.synthetic) return []
      return [part.text]
    }).join('\n')
    const error = message.info.role === 'assistant' ? message.info.error?.name : undefined
    return `${message.info.role}${error ? ` ${error}` : ''}: ${text.split('\n')[0]}`
  })
}

function normalizeDurations(text: string): string {
  return text.replace(/-# exit (\d+) ⋅ [\d.]+m?s/g, '-# exit $1 ⋅ Ns')
}

describe('shell commands', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'shell-command-e2e',
    dirName: 'shell-command-e2e',
    username: 'shell-tester',
  })

  test(
    '!cmd streams interleaved output and leaves the session untouched',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: shell-setup',
      })
      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => t.name === 'Reply with exactly: shell-setup',
      })
      const th = ctx.discord.thread(thread.id)
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: "!printf 'shell-out\\n'; echo shell-err >&2; exit 3",
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '-# exit 3',
        timeout: 4_000,
      })

      expect(normalizeDurations(await th.text())).toMatchInlineSnapshot(`
        "--- from: user (shell-tester)
        Reply with exactly: shell-setup
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (shell-tester)
        !printf 'shell-out\\n'; echo shell-err >&2; exit 3
        --- from: assistant (TestBot)
        \`\`\`
        shell-out
        shell-err
        \`\`\`
        -# exit 3 ⋅ Ns"
      `)
      expect(
        await getSessionTimeline({ threadId: thread.id, directory: ctx.directories.projectDirectory }),
      ).toMatchInlineSnapshot(`
        [
          "user: Reply with exactly: shell-setup",
          "assistant: ok",
        ]
      `)
    },
    20_000,
  )

  test(
    '!cmd with the queue suffix runs after the running turn ends',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLOW_BUSY_MARKER shell queue setup',
      })
      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => t.name === 'SLOW_BUSY_MARKER shell queue setup',
      })
      const th = ctx.discord.thread(thread.id)
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '*using ',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({ content: '!echo queued-shell. queue' })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '-# exit 0',
        timeout: 4_000,
      })

      expect(normalizeDurations(await th.text())).toMatchInlineSnapshot(`
        "--- from: user (shell-tester)
        SLOW_BUSY_MARKER shell queue setup
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        --- from: user (shell-tester)
        !echo queued-shell. queue
        --- from: assistant (TestBot)
        -# Queued at position 1. Edit or delete your message to update the queue
        slow-busy-reply
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        \`\`\`
        queued-shell
        \`\`\`
        -# exit 0 ⋅ Ns"
      `)
    },
    20_000,
  )
})
