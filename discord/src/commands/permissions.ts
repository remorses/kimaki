// Permission button handler - Shows buttons for permission requests.
// When OpenCode asks for permission, this module renders 3 buttons:
// Accept, Accept Always, and Deny.

import { MessageFlags, type ThreadChannel } from 'discord.js'
import crypto from 'node:crypto'
import type { PermissionRequest } from '@opencode-ai/sdk/v2'
import { getOpencodeClient } from '../opencode.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { ButtonEvent, PlatformThread } from '../platform/types.js'
import { platformThreadFromDiscord } from '../platform/platform-value.js'
import { getDefaultRuntimeAdapter } from '../session-handler/thread-session-runtime.js'

const logger = createLogger(LogPrefix.PERMISSIONS)

function wildcardMatch({
  value,
  pattern,
}: {
  value: string
  pattern: string
}): boolean {
  let escapedPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')

  if (escapedPattern.endsWith(' .*')) {
    escapedPattern = escapedPattern.slice(0, -3) + '( .*)?'
  }

  return new RegExp(`^${escapedPattern}$`, 's').test(value)
}

export function arePatternsCoveredBy({
  patterns,
  coveringPatterns,
}: {
  patterns: string[]
  coveringPatterns: string[]
}): boolean {
  return patterns.every((pattern) => {
    return coveringPatterns.some((coveringPattern) => {
      return wildcardMatch({ value: pattern, pattern: coveringPattern })
    })
  })
}

export function compactPermissionPatterns(patterns: string[]): string[] {
  const uniquePatterns = Array.from(new Set(patterns))
  return uniquePatterns.filter((pattern, index) => {
    return !uniquePatterns.some((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return false
      }
      return wildcardMatch({ value: pattern, pattern: candidate })
    })
  })
}

type PendingPermissionContext = {
  permission: PermissionRequest
  requestIds: string[]
  directory: string
  permissionDirectory: string
  thread: PlatformThread
  contextHash: string
}

// Store pending permission contexts by hash.
// TTL prevents unbounded growth if user never clicks a permission button.
const PERMISSION_CONTEXT_TTL_MS = 10 * 60 * 1000
export const pendingPermissionContexts = new Map<
  string,
  PendingPermissionContext
>()

// Atomic take: removes context from Map and returns it. Only the first caller
// (TTL expiry or button click) wins, preventing duplicate permission replies.
function takePendingPermissionContext(contextHash: string): PendingPermissionContext | undefined {
  const ctx = pendingPermissionContexts.get(contextHash)
  if (!ctx) {
    return undefined
  }
  pendingPermissionContexts.delete(contextHash)
  return ctx
}

/**
 * Show permission buttons for a permission request.
 * Displays 3 buttons in a row: Accept, Accept Always, Deny.
 * Returns the message ID and context hash for tracking.
 */
export async function showPermissionButtons({
  thread,
  permission,
  directory,
  permissionDirectory,
  subtaskLabel,
}: {
  thread: PlatformThread | ThreadChannel
  permission: PermissionRequest
  directory: string
  permissionDirectory: string
  subtaskLabel?: string
}): Promise<{ messageId: string; contextHash: string }> {
  const contextHash = crypto.randomBytes(8).toString('hex')
  const normalizedThread = 'raw' in thread ? thread : platformThreadFromDiscord(thread)

  const context: PendingPermissionContext = {
    permission,
    requestIds: [permission.id],
    directory,
    permissionDirectory,
    thread: normalizedThread,
    contextHash,
  }

  pendingPermissionContexts.set(contextHash, context)
  // Auto-reject on TTL expiry so the OpenCode session doesn't hang forever
  // waiting for a permission reply that will never come. Uses atomic take
  // so only one of TTL-expiry or button-click can win.
  setTimeout(async () => {
    const ctx = takePendingPermissionContext(contextHash)
    if (!ctx) {
      return
    }
    const client = getOpencodeClient(ctx.directory)
    if (client) {
      const requestIds = ctx.requestIds.length > 0
        ? ctx.requestIds
        : [ctx.permission.id]
      await Promise.all(
        requestIds.map((requestId) => {
          return client.permission.reply({
            requestID: requestId,
            directory: ctx.permissionDirectory,
            reply: 'reject',
          })
        }),
      ).catch((error) => {
        logger.error('Failed to auto-reject expired permission:', error)
      })
    }
  }, PERMISSION_CONTEXT_TTL_MS).unref()

  const patternStr = compactPermissionPatterns(permission.patterns).join(', ')

  const adapter = getDefaultRuntimeAdapter()
  if (!adapter) {
    throw new Error('No runtime adapter configured')
  }

  const subtaskLine = subtaskLabel ? `**From:** \`${subtaskLabel}\`\n` : ''
  const externalDirLine =
    permission.permission === 'external_directory'
      ? `Agent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n`
      : ''
  const fullContent =
    `⚠️ **Permission Required**\n` +
    subtaskLine +
    `**Type:** \`${permission.permission}\`\n` +
    externalDirLine +
    (patternStr ? `**Pattern:** \`${patternStr}\`` : '')
  const permissionMessage = await adapter.sendMessage(
      {
        channelId: normalizedThread.parentId || normalizedThread.id,
        threadId: normalizedThread.id,
      },
    {
      markdown: fullContent.slice(0, 1900),
      buttons: [
        {
          id: `permission_once:${contextHash}`,
          label: 'Accept',
          style: 'success',
        },
        {
          id: `permission_always:${contextHash}`,
          label: 'Accept Always',
          style: 'success',
        },
        {
          id: `permission_reject:${contextHash}`,
          label: 'Deny',
          style: 'secondary',
        },
      ],
      flags: NOTIFY_MESSAGE_FLAGS | MessageFlags.SuppressEmbeds,
    },
  )

  logger.log(`Showed permission buttons for ${permission.id}`)

  return { messageId: permissionMessage.id, contextHash }
}

/**
 * Handle button click for permission.
 */
export async function handlePermissionButton(
  interaction: ButtonEvent,
): Promise<void> {
  const customId = interaction.customId

  // Extract action and hash from customId (e.g., "permission_once:abc123")
  const [actionPart, contextHash] = customId.split(':')
  if (!actionPart || !contextHash) {
    return
  }

  const response = actionPart.replace('permission_', '') as
    | 'once'
    | 'always'
    | 'reject'

  // Atomic take: if TTL already expired and auto-rejected, context is gone.
  const context = takePendingPermissionContext(contextHash)

  if (!context) {
    await interaction.update({ components: [] })
    return
  }

  await interaction.deferUpdate()

  try {
    const permClient = getOpencodeClient(context.directory)
    if (!permClient) {
      throw new Error('OpenCode server not found for directory')
    }
    const requestIds =
      context.requestIds.length > 0
        ? context.requestIds
        : [context.permission.id]
    await Promise.all(
      requestIds.map((requestId) => {
        return permClient.permission.reply({
          requestID: requestId,
          directory: context.permissionDirectory,
          reply: response,
        })
      }),
    )

    // Context already removed by takePendingPermissionContext above.

    // Update message: show result and remove dropdown
    const resultText = (() => {
      switch (response) {
        case 'once':
          return '✅ Permission **accepted**'
        case 'always':
          return '✅ Permission **accepted** (auto-approve similar requests)'
        case 'reject':
          return '❌ Permission **rejected**'
      }
    })()

    const patternStr = compactPermissionPatterns(
      context.permission.patterns,
    ).join(', ')
    const externalDirLine =
      context.permission.permission === 'external_directory'
        ? `Agent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n`
        : ''
    await interaction.editReply({
      content:
        `⚠️ **Permission Required**\n` +
        `**Type:** \`${context.permission.permission}\`\n` +
        externalDirLine +
        (patternStr ? `**Pattern:** \`${patternStr}\`\n` : '') +
        resultText,
      components: [], // Remove the buttons
    })

    logger.log(
      `Permission ${context.permission.id} ${response} (${requestIds.length} request(s))`,
    )
  } catch (error) {
    logger.error('Error handling permission:', error)
    await interaction.editReply({
      content: `Failed to process permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

export function addPermissionRequestToContext({
  contextHash,
  requestId,
}: {
  contextHash: string
  requestId: string
}): boolean {
  const context = pendingPermissionContexts.get(contextHash)
  if (!context) {
    return false
  }
  if (context.requestIds.includes(requestId)) {
    return false
  }
  context.requestIds = [...context.requestIds, requestId]
  pendingPermissionContexts.set(contextHash, context)
  return true
}

/**
 * Clean up a pending permission context (e.g., on auto-reject).
 */
export function cleanupPermissionContext(contextHash: string): void {
  pendingPermissionContexts.delete(contextHash)
}
