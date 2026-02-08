// Permission button handler - Shows buttons for permission requests.
// When OpenCode asks for permission, this module renders 3 buttons:
// Accept, Accept Always, and Deny.

import {
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ActionRowBuilder,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import type { PermissionRequest } from '@opencode-ai/sdk/v2'
import { getOpencodeClientV2 } from '../opencode.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.PERMISSIONS)

function wildcardMatch({ value, pattern }: { value: string; pattern: string }): boolean {
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
  thread: ThreadChannel
  contextHash: string
}

// Store pending permission contexts by hash
export const pendingPermissionContexts = new Map<string, PendingPermissionContext>()

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
  thread: ThreadChannel
  permission: PermissionRequest
  directory: string
  permissionDirectory: string
  subtaskLabel?: string
}): Promise<{ messageId: string; contextHash: string }> {
  const contextHash = crypto.randomBytes(8).toString('hex')

  const context: PendingPermissionContext = {
    permission,
    requestIds: [permission.id],
    directory,
    permissionDirectory,
    thread,
    contextHash,
  }

  pendingPermissionContexts.set(contextHash, context)

  const patternStr = compactPermissionPatterns(permission.patterns).join(', ')

  // Build 3 buttons for permission actions
  const acceptButton = new ButtonBuilder()
    .setCustomId(`permission_once:${contextHash}`)
    .setLabel('Accept')
    .setStyle(ButtonStyle.Success)

  const acceptAlwaysButton = new ButtonBuilder()
    .setCustomId(`permission_always:${contextHash}`)
    .setLabel('Accept Always')
    .setStyle(ButtonStyle.Success)

  const denyButton = new ButtonBuilder()
    .setCustomId(`permission_reject:${contextHash}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Secondary)

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    acceptButton,
    acceptAlwaysButton,
    denyButton,
  )

  const subtaskLine = subtaskLabel ? `**From:** \`${subtaskLabel}\`\n` : ''
  const permissionMessage = await thread.send({
    content:
      `⚠️ **Permission Required**\n` +
      subtaskLine +
      `**Type:** \`${permission.permission}\`\n` +
      (patternStr ? `**Pattern:** \`${patternStr}\`` : ''),
    components: [actionRow],
    flags: NOTIFY_MESSAGE_FLAGS,
  })

  logger.log(`Showed permission buttons for ${permission.id}`)

  return { messageId: permissionMessage.id, contextHash }
}

/**
 * Handle button click for permission.
 */
export async function handlePermissionButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId

  // Extract action and hash from customId (e.g., "permission_once:abc123")
  const [actionPart, contextHash] = customId.split(':')
  if (!actionPart || !contextHash) {
    return
  }

  const response = actionPart.replace('permission_', '') as 'once' | 'always' | 'reject'

  const context = pendingPermissionContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'This permission request has expired or was already handled.',
      ephemeral: true,
    })
    return
  }

  await interaction.deferUpdate()

  try {
    const clientV2 = getOpencodeClientV2(context.directory)
    if (!clientV2) {
      throw new Error('OpenCode server not found for directory')
    }
    const requestIds = context.requestIds.length > 0 ? context.requestIds : [context.permission.id]
    await Promise.all(
      requestIds.map((requestId) => {
        return clientV2.permission.reply({
          requestID: requestId,
          directory: context.permissionDirectory,
          reply: response,
        })
      }),
    )

    pendingPermissionContexts.delete(contextHash)

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

    const patternStr = compactPermissionPatterns(context.permission.patterns).join(', ')
    await interaction.editReply({
      content:
        `⚠️ **Permission Required**\n` +
        `**Type:** \`${context.permission.permission}\`\n` +
        (patternStr ? `**Pattern:** \`${patternStr}\`\n` : '') +
        resultText,
      components: [], // Remove the buttons
    })

    logger.log(`Permission ${context.permission.id} ${response} (${requestIds.length} request(s))`)
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
