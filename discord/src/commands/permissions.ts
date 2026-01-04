// Permission commands - /accept, /accept-always, /reject

import { ChannelType } from 'discord.js'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { pendingPermissions } from '../session-handler.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger } from '../logger.js'

const logger = createLogger('PERMISSIONS')

export async function handleAcceptCommand({
  command,
}: CommandContext): Promise<void> {
  const scope = command.commandName === 'accept-always' ? 'always' : 'once'
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const pending = pendingPermissions.get(channel.id)
  if (!pending) {
    await command.reply({
      content: 'No pending permission request in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(pending.directory)
    await getClient().postSessionIdPermissionsPermissionId({
      path: {
        id: pending.permission.sessionID,
        permissionID: pending.permission.id,
      },
      body: {
        response: scope,
      },
    })

    pendingPermissions.delete(channel.id)
    const msg =
      scope === 'always'
        ? `✅ Permission **accepted** (auto-approve similar requests)`
        : `✅ Permission **accepted**`
    await command.reply({ content: msg, flags: SILENT_MESSAGE_FLAGS })
    logger.log(`Permission ${pending.permission.id} accepted with scope: ${scope}`)
  } catch (error) {
    logger.error('[ACCEPT] Error:', error)
    await command.reply({
      content: `Failed to accept permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
  }
}

export async function handleRejectCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const pending = pendingPermissions.get(channel.id)
  if (!pending) {
    await command.reply({
      content: 'No pending permission request in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(pending.directory)
    await getClient().postSessionIdPermissionsPermissionId({
      path: {
        id: pending.permission.sessionID,
        permissionID: pending.permission.id,
      },
      body: {
        response: 'reject',
      },
    })

    pendingPermissions.delete(channel.id)
    await command.reply({
      content: `❌ Permission **rejected**`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    logger.log(`Permission ${pending.permission.id} rejected`)
  } catch (error) {
    logger.error('[REJECT] Error:', error)
    await command.reply({
      content: `Failed to reject permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
  }
}
