// /remove-project command - Remove Discord channels for a project.

import path from 'node:path'
import * as errore from 'errore'
import type { CommandContext, AutocompleteContext } from './types.js'
import { findChannelsByDirectory, deleteChannelDirectoriesByDirectory, getAllTextChannelDirectories } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { abbreviatePath } from '../utils.js'

const logger = createLogger(LogPrefix.REMOVE_PROJECT)

export async function handleRemoveProjectCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const directory = command.options.getString('project', true)
  const guild = command.guild

  if (!guild) {
    await command.editReply('This command can only be used in a guild')
    return
  }

  try {
    // Get channel IDs for this directory
    const channels = await findChannelsByDirectory({ directory })

    if (channels.length === 0) {
      await command.editReply(`No channels found for directory: \`${directory}\``)
      return
    }

    const deletedChannels: string[] = []
    const failedChannels: string[] = []

    for (const { channel_id, channel_type } of channels as Array<{ channel_id: string; channel_type: string }>) {
      const channel = await errore.tryAsync({
        try: () => guild.channels.fetch(channel_id),
        catch: (e) => e as Error,
      })
      
      if (channel instanceof Error) {
        logger.error(`Failed to fetch channel ${channel_id}:`, channel)
        failedChannels.push(`${channel_type}: ${channel_id}`)
        continue
      }
      
      if (channel) {
        try {
          await channel.delete(`Removed by /remove-project command`)
          deletedChannels.push(`${channel_type}: ${channel_id}`)
        } catch (error) {
          logger.error(`Failed to delete channel ${channel_id}:`, error)
          failedChannels.push(`${channel_type}: ${channel_id}`)
        }
      } else {
        deletedChannels.push(`${channel_type}: ${channel_id} (already deleted)`)
      }
    }

    // Remove from database
    await deleteChannelDirectoriesByDirectory(directory)

    const projectName = path.basename(directory)
    let message = `Removed project **${projectName}**\n`
    message += `Directory: \`${directory}\`\n\n`

    if (deletedChannels.length > 0) {
      message += `Deleted channels:\n${deletedChannels.map((c) => `- ${c}`).join('\n')}`
    }

    if (failedChannels.length > 0) {
      message += `\n\nFailed to delete (may be in another server):\n${failedChannels.map((c) => `- ${c}`).join('\n')}`
    }

    await command.editReply(message)
    logger.log(`Removed project ${projectName} at ${directory}`)
  } catch (error) {
    logger.error('[REMOVE-PROJECT] Error:', error)
    await command.editReply(
      `Failed to remove project: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleRemoveProjectAutocomplete({
  interaction,
  appId,
}: AutocompleteContext): Promise<void> {
  const focusedValue = interaction.options.getFocused()
  const guild = interaction.guild

  if (!guild) {
    await interaction.respond([])
    return
  }

  try {
    // Get all directories with channels
    const allChannels = await findChannelsByDirectory({ channelType: 'text' }) as Array<{ directory: string; channel_id: string }>

    // Filter to only channels that exist in this guild
    const projectsInGuild: { directory: string; channelId: string }[] = []

    for (const { directory, channel_id } of allChannels) {
      const channel = await errore.tryAsync({
        try: () => guild.channels.fetch(channel_id),
        catch: (e) => e as Error,
      })
      if (channel instanceof Error) {
        // Channel not in this guild, skip
        continue
      }
      if (channel) {
        projectsInGuild.push({ directory, channelId: channel_id })
      }
    }

    const projects = projectsInGuild
      .filter(({ directory }) => {
        const baseName = path.basename(directory)
        const searchText = `${baseName} ${directory}`.toLowerCase()
        return searchText.includes(focusedValue.toLowerCase())
      })
      .slice(0, 25)
      .map(({ directory }) => {
        const name = `${path.basename(directory)} (${abbreviatePath(directory)})`
        return {
          name: name.length > 100 ? name.slice(0, 99) + '...' : name,
          value: directory,
        }
      })

    await interaction.respond(projects)
  } catch (error) {
    logger.error('[AUTOCOMPLETE] Error fetching projects:', error)
    await interaction.respond([])
  }
}
