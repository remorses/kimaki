// /create-new-project command - Create a new project folder, initialize git, and start a session.
// Also exports createNewProject() for reuse during onboarding (welcome channel creation).

import { ChannelType, type Guild, type TextChannel } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import type { CommandContext } from './types.js'
import { getProjectsDir } from '../config.js'
import { createProjectChannels } from '../channel-management.js'
import { handleOpencodeSession } from '../session-handler.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.CREATE_PROJECT)

/**
 * Core project creation logic: creates directory, inits git, creates Discord channels.
 * Reused by the slash command handler and by onboarding (welcome channel).
 * Returns null if the project directory already exists.
 */
export async function createNewProject({
  guild,
  projectName,
  appId,
  botName,
}: {
  guild: Guild
  projectName: string
  appId: string
  botName?: string
}): Promise<{
  textChannelId: string
  voiceChannelId: string | null
  channelName: string
  projectDirectory: string
  sanitizedName: string
} | null> {
  const sanitizedName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)

  if (!sanitizedName) {
    return null
  }

  const projectsDir = getProjectsDir()
  const projectDirectory = path.join(projectsDir, sanitizedName)

  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true })
    logger.log(`Created projects directory: ${projectsDir}`)
  }

  if (fs.existsSync(projectDirectory)) {
    return null
  }

  fs.mkdirSync(projectDirectory, { recursive: true })
  logger.log(`Created project directory: ${projectDirectory}`)

  execSync('git init', { cwd: projectDirectory, stdio: 'pipe' })
  logger.log(`Initialized git in: ${projectDirectory}`)

  const { textChannelId, voiceChannelId, channelName } = await createProjectChannels({
    guild,
    projectDirectory,
    appId,
    botName,
  })

  return { textChannelId, voiceChannelId, channelName, projectDirectory, sanitizedName }
}

export async function handleCreateNewProjectCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const projectName = command.options.getString('name', true)
  const guild = command.guild
  const channel = command.channel

  if (!guild) {
    await command.editReply('This command can only be used in a guild')
    return
  }

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.editReply('This command can only be used in a text channel')
    return
  }

  try {
    const result = await createNewProject({
      guild,
      projectName,
      appId,
      botName: command.client.user?.username,
    })

    if (!result) {
      const sanitizedName = projectName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100)

      if (!sanitizedName) {
        await command.editReply('Invalid project name')
        return
      }

      const projectDirectory = path.join(getProjectsDir(), sanitizedName)
      await command.editReply(`Project directory already exists: ${projectDirectory}`)
      return
    }

    const { textChannelId, voiceChannelId, channelName, projectDirectory, sanitizedName } = result
    const textChannel = (await guild.channels.fetch(textChannelId)) as TextChannel

    const voiceInfo = voiceChannelId ? `\n🔊 Voice: <#${voiceChannelId}>` : ''
    await command.editReply(
      `✅ Created new project **${sanitizedName}**\n📁 Directory: \`${projectDirectory}\`\n📝 Text: <#${textChannelId}>${voiceInfo}\n_Starting session..._`,
    )

    const starterMessage = await textChannel.send({
      content: `🚀 **New project initialized**\n📁 \`${projectDirectory}\``,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const thread = await starterMessage.startThread({
      name: `Init: ${sanitizedName}`,
      autoArchiveDuration: 1440,
      reason: 'New project session',
    })

    // Add user to thread so it appears in their sidebar
    await thread.members.add(command.user.id)

    await handleOpencodeSession({
      prompt: 'The project was just initialized. Say hi and ask what the user wants to build.',
      thread,
      projectDirectory,
      channelId: textChannel.id,
      appId,
    })

    logger.log(`Created new project ${channelName} at ${projectDirectory}`)
  } catch (error) {
    logger.error('[CREATE-NEW-PROJECT] Error:', error)
    await command.editReply(
      `Failed to create new project: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
