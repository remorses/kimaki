// E2e test for /model switch behavior through interrupt recovery.
// Reproduces fallback where interrupt plugin resume can run without model,
// causing default opencode.json model to be used after switching session model.

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { DigitalDiscord } from 'discord-digital-twin/src'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
  waitForFooterMessage,
  waitForMessageById,
} from './test-utils.js'
import { getThreadState } from './session-handler/thread-runtime-state.js'
import { getSessionModel } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'

const TEXT_CHANNEL_ID = '200000000000001007'

function getCustomIdFromInteractionData({
  serializedComponents,
  prefix,
}: {
  serializedComponents: string
  prefix: string
}): string {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const customIdRegex = new RegExp(`\"custom_id\"\\s*:\\s*\"(${escapedPrefix}[^\"]+)\"`)
  const match = serializedComponents.match(customIdRegex)
  if (!match?.[1]) {
    throw new Error(
      `Could not find custom_id with prefix ${prefix} in components: ${serializedComponents}`,
    )
  }
  return match[1]
}

async function waitForMessageComponentsWithCustomId({
  discord,
  threadId,
  messageId,
  customIdPrefix,
  timeoutMs,
}: {
  discord: DigitalDiscord
  threadId: string
  messageId: string
  customIdPrefix: string
  timeoutMs: number
}): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const message = await waitForMessageById({
      discord,
      threadId,
      messageId,
      timeout: 1_000,
    })
    const serializedComponents = JSON.stringify(message.components)
    if (serializedComponents.includes(customIdPrefix)) {
      return serializedComponents
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  throw new Error(
    `Timed out waiting for custom_id prefix ${customIdPrefix} in message ${messageId}`,
  )
}

async function waitForInteractionMessage({
  getInteraction,
  interactionId,
  timeoutMs,
}: {
  getInteraction: (interactionId: string) => Promise<{
    messageId: string | null
    data: string | null
  } | null>
  interactionId: string
  timeoutMs: number
}): Promise<{ messageId: string; data: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const response = await getInteraction(interactionId)
    if (response?.messageId) {
      return {
        messageId: response.messageId,
        data: response.data || '',
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  throw new Error(`Timed out waiting for interaction message ${interactionId}`)
}

describe('queue advanced: /model with interrupt recovery', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-model-switch-e2e',
    dirName: 'qa-model-switch-e2e',
    username: 'queue-model-switch-tester',
  })

  test(
    'session model selected in /model survives interrupt-plugin resume path',
    async () => {
      const buildAgentDir = path.join(
        ctx.directories.projectDirectory,
        '.opencode',
        'agent',
      )
      fs.mkdirSync(buildAgentDir, { recursive: true })
      fs.writeFileSync(
        path.join(buildAgentDir, 'build.md'),
        [
          '---',
          'name: build',
          'description: Default build agent for deterministic model tests',
          'model: deterministic-provider/deterministic-v2',
          '---',
          '',
          'You are the default build agent.',
          '',
        ].join('\n'),
      )

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: model-switcher-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: model-switcher-setup'
        },
      })
      const th = ctx.discord.thread(thread.id)

      await th.waitForBotReply({ timeout: 4_000 })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const modelCommand = await th.user(TEST_USER_ID).runSlashCommand({
        name: 'model',
      })
      await th.waitForInteractionAck({
        interactionId: modelCommand.id,
        timeout: 4_000,
      })

      const providerStep = await waitForInteractionMessage({
        getInteraction: (interactionId) => {
          return th.getInteractionResponse(interactionId)
        },
        interactionId: modelCommand.id,
        timeoutMs: 4_000,
      })
      const providerCustomId = getCustomIdFromInteractionData({
        serializedComponents: await waitForMessageComponentsWithCustomId({
          discord: ctx.discord,
          threadId: thread.id,
          messageId: providerStep.messageId,
          customIdPrefix: 'model_provider:',
          timeoutMs: 4_000,
        }),
        prefix: 'model_provider:',
      })

      const providerSelect = await th.user(TEST_USER_ID).selectMenu({
        messageId: providerStep.messageId,
        customId: providerCustomId,
        values: ['deterministic-provider'],
      })
      await th.waitForInteractionAck({
        interactionId: providerSelect.id,
        timeout: 4_000,
      })

      const modelStep = await waitForInteractionMessage({
        getInteraction: (interactionId) => {
          return th.getInteractionResponse(interactionId)
        },
        interactionId: providerSelect.id,
        timeoutMs: 4_000,
      })
      const modelCustomId = getCustomIdFromInteractionData({
        serializedComponents: await waitForMessageComponentsWithCustomId({
          discord: ctx.discord,
          threadId: thread.id,
          messageId: modelStep.messageId,
          customIdPrefix: 'model_select:',
          timeoutMs: 4_000,
        }),
        prefix: 'model_select:',
      })

      const modelSelect = await th.user(TEST_USER_ID).selectMenu({
        messageId: modelStep.messageId,
        customId: modelCustomId,
        values: ['deterministic-v3'],
      })
      await th.waitForInteractionAck({
        interactionId: modelSelect.id,
        timeout: 4_000,
      })

      const maybeVariantOrScopeStep = await waitForInteractionMessage({
        getInteraction: (interactionId) => {
          return th.getInteractionResponse(interactionId)
        },
        interactionId: modelSelect.id,
        timeoutMs: 4_000,
      })

      const maybeVariantOrScopeMessage = await waitForMessageById({
        discord: ctx.discord,
        threadId: thread.id,
        messageId: maybeVariantOrScopeStep.messageId,
        timeout: 4_000,
      })
      const maybeVariantOrScopeComponents = JSON.stringify(
        maybeVariantOrScopeMessage.components,
      )

      const scopeStep = maybeVariantOrScopeComponents.includes('model_variant:')
        ? await (async () => {
            const variantCustomId = getCustomIdFromInteractionData({
              serializedComponents: maybeVariantOrScopeComponents,
              prefix: 'model_variant:',
            })
            const variantSelect = await th.user(TEST_USER_ID).selectMenu({
              messageId: maybeVariantOrScopeStep.messageId,
              customId: variantCustomId,
              values: ['__none__'],
            })
            await th.waitForInteractionAck({
              interactionId: variantSelect.id,
              timeout: 4_000,
            })
            return waitForInteractionMessage({
              getInteraction: (interactionId) => {
                return th.getInteractionResponse(interactionId)
              },
              interactionId: variantSelect.id,
              timeoutMs: 4_000,
            })
          })()
        : maybeVariantOrScopeStep

      const scopeCustomId = getCustomIdFromInteractionData({
        serializedComponents: await waitForMessageComponentsWithCustomId({
          discord: ctx.discord,
          threadId: thread.id,
          messageId: scopeStep.messageId,
          customIdPrefix: 'model_scope:',
          timeoutMs: 4_000,
        }),
        prefix: 'model_scope:',
      })

      const scopeSelect = await th.user(TEST_USER_ID).selectMenu({
        messageId: scopeStep.messageId,
        customId: scopeCustomId,
        values: ['session'],
      })
      await th.waitForInteractionAck({
        interactionId: scopeSelect.id,
        timeout: 4_000,
      })

      const sessionId = getThreadState(thread.id)?.sessionId
      expect(sessionId).toBeDefined()
      if (!sessionId) {
        throw new Error('Expected session id to be present after /model selection')
      }
      const sessionModel = await getSessionModel(sessionId)
      expect(sessionModel?.modelId).toBe('deterministic-provider/deterministic-v3')

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: model-switcher-followup',
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'model-switcher-followup',
        timeout: 8_000,
      })
      const finalMessages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'model-switcher-followup',
        afterAuthorId: TEST_USER_ID,
      })

      const footer = [...finalMessages].reverse().find((message) => {
        return message.author.id === ctx.discord.botUserId
          && message.content.startsWith('*')
          && message.content.includes('⋅')
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-model-switch-tester)
        Reply with exactly: model-switcher-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        Model set for this session:
        **Deterministic Provider** / **deterministic-v3**
        \`deterministic-provider/deterministic-v3\`
        _Restarting current request with new model..._
        _Tip: create [agent .md files](https://github.com/remorses/kimaki/blob/main/docs/model-switching.md) in .opencode/agent/ for one-command model switching_
        --- from: user (queue-model-switch-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ ok
        ⬥ starting sleep 100
        --- from: user (queue-model-switch-tester)
        Reply with exactly: model-switcher-followup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v3*"
      `)

      expect(footer).toBeDefined()
      expect(footer?.content).toContain('deterministic-v3')

      const getClient = await initializeOpencodeForDirectory(
        ctx.directories.projectDirectory,
      )
      if (getClient instanceof Error) {
        throw getClient
      }
      const sessionMessagesResponse = await getClient().session.messages({
        sessionID: sessionId,
        directory: ctx.directories.projectDirectory,
      })
      const sessionMessages = sessionMessagesResponse.data || []
      const emptyUserMessagesWithDefaultModel = sessionMessages.filter((message) => {
        if (message.info.role !== 'user') {
          return false
        }
        const hasNonEmptyTextPart = message.parts.some((part) => {
          if (part.type !== 'text') {
            return false
          }
          return part.text.trim().length > 0
        })
        if (hasNonEmptyTextPart) {
          return false
        }
        return message.info.model.modelID === 'deterministic-v2'
      })
      expect(emptyUserMessagesWithDefaultModel.length).toBe(0)
    },
    20_000,
  )
})
