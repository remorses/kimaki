// Permission dropdown handler - Shows dropdown for permission requests.
// When OpenCode asks for permission, this module renders a dropdown
// with Accept, Accept Always, and Deny options.

import {
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import type { PermissionRequest } from '@opencode-ai/sdk/v2'
import { getOpencodeClientV2 } from '../opencode.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.PERMISSIONS)

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
 * Show permission dropdown for a permission request.
 * Returns the message ID and context hash for tracking.
 */
export async function showPermissionDropdown({
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

  const patternStr = permission.patterns.join(', ')

  // Build dropdown options
  const options = [
    {
      label: 'Accept',
      value: 'once',
      description: 'Allow this request only',
    },
    {
      label: 'Accept Always',
      value: 'always',
      description: 'Auto-approve similar requests',
    },
    {
      label: 'Deny',
      value: 'reject',
      description: 'Reject this permission request',
    },
  ]

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`permission:${contextHash}`)
    .setPlaceholder('Choose an action')
    .addOptions(options)

  const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

  const subtaskLine = subtaskLabel ? `**From:** \`${subtaskLabel}\`\n` : ''
  const permissionMessage = await thread.send({
    content:
      `⚠️ **Permission Required**\n\n` +
      subtaskLine +
      `**Type:** \`${permission.permission}\`\n` +
      (patternStr ? `**Pattern:** \`${patternStr}\`` : ''),
    components: [actionRow],
    flags: NOTIFY_MESSAGE_FLAGS,
  })

  logger.log(`Showed permission dropdown for ${permission.id}`)

  return { messageId: permissionMessage.id, contextHash }
}

/**
 * Handle dropdown selection for permission.
 */
export async function handlePermissionSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('permission:')) {
    return
  }

  const contextHash = customId.replace('permission:', '')
  const context = pendingPermissionContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'This permission request has expired or was already handled.',
      ephemeral: true,
    })
    return
  }

  await interaction.deferUpdate()

  const response = interaction.values[0] as 'once' | 'always' | 'reject'

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

    const patternStr = context.permission.patterns.join(', ')
    await interaction.editReply({
      content:
        `⚠️ **Permission Required**\n\n` +
        `**Type:** \`${context.permission.permission}\`\n` +
        (patternStr ? `**Pattern:** \`${patternStr}\`\n\n` : '\n') +
        resultText,
      components: [], // Remove the dropdown
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
