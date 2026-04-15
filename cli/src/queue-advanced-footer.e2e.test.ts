// E2e tests for footer emission in advanced queue scenarios.
// Split from thread-queue-advanced.e2e.test.ts for parallelization.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001001'

const e2eTest = describe

e2eTest('queue advanced: footer emission', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-footer-e2e',
    dirName: 'qa-footer-e2e',
    username: 'queue-advanced-tester',
  })

  test(
    'normal completion emits footer after bot reply',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-check',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-check'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      const footerMessages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        Reply with exactly: footer-check
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const foundFooter = footerMessages.some((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      })
      expect(foundFooter).toBe(true)
    },
    8_000,
  )

  test(
    'footer appears after second message in same session',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-multi-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-second',
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'footer-multi-second',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'footer-multi-second',
        afterAuthorId: TEST_USER_ID,
      })

      const msgs = await th.getMessages()
      const footerCount = msgs.filter((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      }).length
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        Reply with exactly: footer-multi-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        Reply with exactly: footer-multi-second
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      if (footerCount >= 2) {
        expect(footerCount).toBeGreaterThanOrEqual(2)
        return
      }

      const pollDeadline = Date.now() + 4_000
      let found = false
      while (Date.now() < pollDeadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        const latestMsgs = await th.getMessages()
        const count = latestMsgs.filter((m) => {
          return m.author.id === ctx.discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        }).length
        if (count >= 2) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    },
    12_000,
  )

  test(
    'interrupted run has no footer, completed follow-up has footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-footer-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: interrupt-footer-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      const beforeInterruptMsgs = await th.getMessages()
      const baselineCount = beforeInterruptMsgs.length

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep 100',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-footer-followup',
      })

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'interrupt-footer-followup',
        timeout: 12_000,
      })

      const followupUserIdx = messages.findIndex((m, idx) => {
        return idx >= baselineCount
          && m.author.id === TEST_USER_ID
          && m.content.includes('interrupt-footer-followup')
      })
      const okReplyIdx = messages.findIndex((m, idx) => {
        if (idx <= followupUserIdx) {
          return false
        }
        return m.author.id === ctx.discord.botUserId && m.content.includes('ok')
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'interrupt-footer-followup',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        Reply with exactly: interrupt-footer-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        --- from: user (queue-advanced-tester)
        Reply with exactly: interrupt-footer-followup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(followupUserIdx).toBeGreaterThanOrEqual(0)
      expect(okReplyIdx).toBeGreaterThan(followupUserIdx)

      const footerBetween = messages.some((m, idx) => {
        if (idx < baselineCount || idx >= okReplyIdx) {
          return false
        }
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      })
      expect(footerBetween).toBe(false)
    },
    15_000,
  )

  test(
    'plugin timeout interrupt aborts slow sleep and avoids intermediate footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: plugin-timeout-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: plugin-timeout-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep 100',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: plugin-timeout-after',
      })

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'plugin-timeout-after',
        timeout: 12_000,
      })

      const messagesWithFooter = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'plugin-timeout-after',
        afterAuthorId: TEST_USER_ID,
      })

      const afterIndex = messagesWithFooter.findIndex((message) => {
        return (
          message.author.id === TEST_USER_ID
          && message.content.includes('plugin-timeout-after')
        )
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        Reply with exactly: plugin-timeout-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        --- from: user (queue-advanced-tester)
        Reply with exactly: plugin-timeout-after
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(afterIndex).toBeGreaterThanOrEqual(0)

      const okReplyIndex = messagesWithFooter.findIndex((message, index) => {
        if (index <= afterIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId && message.content.includes('ok')
      })
      expect(okReplyIndex).toBeGreaterThan(afterIndex)

      const footerBeforeReply = messagesWithFooter.some((message, index) => {
        if (index <= afterIndex || index >= okReplyIndex) {
          return false
        }
        if (message.author.id !== ctx.discord.botUserId) {
          return false
        }
        return message.content.startsWith('*') && message.content.includes('⋅')
      })
      expect(footerBeforeReply).toBe(false)
    },
    15_000,
  )

  test(
    'tool-call assistant message gets footer when it completes normally',
    async () => {
      // Reproduces the bug: model responds with text + tool call,
      // finish="tool-calls", message gets completed timestamp. Then the tool
      // result triggers a follow-up text response in a second assistant message.
      // The second message gets a footer, but the first (tool-call) message
      // should ALSO get a footer since it completed normally.
      // This matches the real-world scenario where an agent calls a bash tool
      // (e.g. `kimaki send`) and then follows up with a summary text.
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'TOOL_CALL_FOOTER_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the follow-up text response after tool completion.
      // The tool call completes and the model follows up with a second
      // assistant message containing text.
      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'TOOL_CALL_FOOTER_MARKER',
        timeout: 6_000,
      })

      // Wait for at least one footer to appear
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // Poll until both footers have arrived — the first footer (after the
      // tool-call step) and the second (after the text follow-up) are emitted
      // by sequential handleNaturalAssistantCompletion calls but the second
      // may not have hit the Discord thread by the time we first check.
      const deadline = Date.now() + 4_000
      let footerCount = 0
      while (Date.now() < deadline) {
        const msgs = await th.getMessages()
        footerCount = msgs.filter((m) => {
          return m.author.id === ctx.discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        }).length
        if (footerCount >= 2) {
          break
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        TOOL_CALL_FOOTER_MARKER
        --- from: assistant (TestBot)
        ⬥ running tool
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // Only ONE footer at the end — the tool-call step's footer is NOT
      // emitted mid-turn. The final text follow-up gets the footer.
      expect(footerCount).toBe(1)
    },
    10_000,
  )

  test(
    'multi-step tool chain should only have one footer at the end',
    async () => {
      // Model does 3 sequential tool calls (each a separate assistant message
      // with finish="tool-calls") then a final text response. Only the final
      // text response should get a footer — intermediate tool-call steps
      // should NOT get footers since they're mid-turn work.
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'MULTI_TOOL_FOOTER_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the final text response after all 3 tool steps
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'all done, fixed 3 files',
        timeout: 6_000,
      })

      // Wait for the footer after the final response
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 6_000,
      })

      // Give any spurious extra footers time to arrive
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })

      const messages = await th.getMessages()
      const footerCount = messages.filter((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      }).length

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        MULTI_TOOL_FOOTER_MARKER
        --- from: assistant (TestBot)
        ⬥ investigating the issue
        ⬥ all done, fixed 3 files
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // Only ONE footer should appear — after the final text response.
      // Intermediate tool-call steps should NOT get footers.
      expect(footerCount).toBe(1)
    },
    10_000,
  )

  test(
    '3 sequential tool-call steps produce exactly 1 footer, not 3',
    async () => {
      // This is the most obvious reproduction of the multi-footer bug:
      // the model runs 3 sequential tool-call steps (each a SEPARATE
      // assistant message with finish="tool-calls"), then a final text.
      // With a naive fix that treats tool-calls as natural completions,
      // you'd see 4 footers (one per assistant message). Only the final
      // text response should produce a footer.
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'MULTI_STEP_CHAIN_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the final text after all 3 sequential tool steps
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'chain complete: all 3 steps done',
        timeout: 10_000,
      })

      // Wait for footer
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 6_000,
      })

      // Give any spurious extra footers time to arrive
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })

      const messages = await th.getMessages()
      const footerCount = messages.filter((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      }).length

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        MULTI_STEP_CHAIN_MARKER
        --- from: assistant (TestBot)
        ⬥ chain step 1: reading config
        ⬥ chain step 2: analyzing results
        ⬥ chain step 3: applying fix
        ⬥ chain complete: all 3 steps done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // The critical assertion: only 1 footer at the very end.
      // With the naive "allow tool-calls as natural completion" fix,
      // this would be 4 (one per assistant message). We want 1.
      expect(footerCount).toBe(1)
    },
    15_000,
  )
})
