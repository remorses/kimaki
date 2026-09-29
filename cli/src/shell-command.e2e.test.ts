// E2e coverage for `!cmd` shell commands in a session thread: plain messages,
// command action buttons, and the queue suffix. Commands never touch the OpenCode
// session; reply to the output message to give it to the model.

import { describe, test, expect, onTestFinished } from 'vitest'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { pendingActionButtonContexts } from './commands/action-buttons.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001091'

// Longer than the 80-char label limit, so it could never fit in a label.
const LONG_BUTTON_OUTPUT = `long-button-output-${'x'.repeat(100)}-end`

// One step with two kimaki_action_buttons calls: the first has an 81-char
// label and must fail, the second shows a short label with a long command.
const shellButtonMatcher: DeterministicMatcher = {
  id: 'shell-button-tool-calls',
  priority: 140,
  when: {
    lastMessageRole: 'user',
    latestUserTextIncludes: 'SHELL_BUTTON_MARKER',
  },
  then: {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'shell-button-text' },
      { type: 'text-delta', id: 'shell-button-text', delta: 'Print the long line?' },
      { type: 'text-end', id: 'shell-button-text' },
      {
        type: 'tool-call',
        toolCallId: 'shell-button-long-label',
        toolName: 'kimaki_action_buttons',
        input: JSON.stringify({ buttons: [{ label: 'y'.repeat(81) }] }),
      },
      {
        type: 'tool-call',
        toolCallId: 'shell-button-command',
        toolName: 'kimaki_action_buttons',
        input: JSON.stringify({
          buttons: [{ label: 'Print long line', command: `printf '%s\\n' '${LONG_BUTTON_OUTPUT}'` }],
        }),
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ],
  },
}

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
    extraMatchers: [shellButtonMatcher],
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
    'command button rejects long labels and runs the full long command',
    async () => {
      // The real plugin -> SQLite -> bot IPC path; the suite does not start it.
      await startIpcPolling({ discordClient: ctx.botClient })
      onTestFinished(stopIpcPolling)

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SHELL_BUTTON_MARKER show buttons',
      })
      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => t.name === 'SHELL_BUTTON_MARKER show buttons',
      })
      const th = ctx.discord.thread(thread.id)
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '**Action Required**',
        timeout: 4_000,
      })

      // The over-long label is rejected in the plugin execute() with an error.
      const sessionId = await getThreadSession(thread.id)
      const getClient = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
      if (getClient instanceof Error) throw getClient
      const messages = await getClient().session.messages({
        sessionID: sessionId!,
        directory: ctx.directories.projectDirectory,
      })
      const buttonToolStates = (messages.data || []).flatMap((message) => {
        return message.parts.flatMap((part) => {
          if (part.type !== 'tool' || part.tool !== 'kimaki_action_buttons') return []
          if (part.state.status === 'error') return [`error: ${part.state.error}`]
          if (part.state.status === 'completed') return [`completed: ${part.state.output}`]
          return [part.state.status]
        })
      })
      expect(buttonToolStates).toMatchInlineSnapshot(`
        [
          "error: button 1 label is 81 chars, max 80. Use a short label and put any shell command in "command".",
          "completed: Action button(s) shown: Print long line",
        ]
      `)

      const entry = await (async () => {
        for (let i = 0; i < 40; i++) {
          const found = [...pendingActionButtonContexts.entries()].find(([, c]) => {
            return c.thread.id === thread.id && Boolean(c.messageId)
          })
          if (found) return found
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return undefined
      })()
      if (!entry) throw new Error('Expected pending action buttons')
      const [contextHash, context] = entry
      // The command is visible before the click.
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (shell-tester)
        SHELL_BUTTON_MARKER show buttons
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        > Print the long line?
        **Action Required**
        **Print long line** runs:
        \`\`\`sh
        printf '%s\\n' 'long-button-output-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-end'
        \`\`\`
        tool done
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const interaction = await th.user(TEST_USER_ID).clickButton({
        messageId: context.messageId!,
        customId: `action_button:${contextHash}:0`,
      })
      await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '-# exit 0',
        timeout: 4_000,
      })

      expect(normalizeDurations(await th.text({ showInteractions: true }))).toMatchInlineSnapshot(`
        "--- from: user (shell-tester)
        SHELL_BUTTON_MARKER show buttons
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        > Print the long line?
        **Action Required**
        _Selected: Print long line_
        tool done
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        [user clicks button]
        » **shell-tester:** Print long line
        \`\`\`
        long-button-output-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-end
        \`\`\`
        -# exit 0 ⋅ Ns"
      `)
      expect(
        await getSessionTimeline({ threadId: thread.id, directory: ctx.directories.projectDirectory }),
      ).toMatchInlineSnapshot(`
        [
          "user: SHELL_BUTTON_MARKER show buttons",
          "assistant: Print the long line?",
          "assistant: tool done",
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
