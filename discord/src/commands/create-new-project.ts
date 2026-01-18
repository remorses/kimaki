// /create-new-project command - Create a new project folder, initialize git, and start a session.

import { ChannelType, type TextChannel } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext } from './types.js'
import { getProjectsDir } from '../config.js'
import { createProjectChannels } from '../channel-management.js'
import { handleOpencodeSession } from '../session-handler.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger } from '../logger.js'

const logger = createLogger('CREATE-NEW-PROJECT')

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

  const projectsDir = getProjectsDir()
  const projectDirectory = path.join(projectsDir, sanitizedName)

  try {
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true })
      logger.log(`Created projects directory: ${projectsDir}`)
    }

    if (fs.existsSync(projectDirectory)) {
      await command.editReply(`Project directory already exists: ${projectDirectory}`)
      return
    }

    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created project directory: ${projectDirectory}`)

    const { execSync } = await import('node:child_process')
    execSync('git init', { cwd: projectDirectory, stdio: 'pipe' })
    logger.log(`Initialized git in: ${projectDirectory}`)

    const { textChannelId, voiceChannelId, channelName } = await createProjectChannels({
      guild,
      projectDirectory,
      appId,
    })

    const textChannel = (await guild.channels.fetch(textChannelId)) as TextChannel

    await command.editReply(
      `✅ Created new project **${sanitizedName}**\n📁 Directory: \`${projectDirectory}\`\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n\n_Starting session..._`,
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

    await handleOpencodeSession({
      prompt: 'The project was just initialized. Say hi and ask what the user wants to build.',
      thread,
      projectDirectory,
      channelId: textChannel.id,
    })

    logger.log(`Created new project ${channelName} at ${projectDirectory}`)
  } catch (error) {
    logger.error('[CREATE-NEW-PROJECT] Error:', error)
    await command.editReply(
      `Failed to create new project: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
