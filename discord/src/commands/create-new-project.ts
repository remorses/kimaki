// /create-new-project command - Create a new project folder, initialize git, and start a session.
// Also exports createNewProject() for reuse during onboarding (welcome channel creation).

import fs from 'node:fs'
import path from 'node:path'
import { execAsync } from '../worktrees.js'
import type { CommandContext } from './types.js'
import { getProjectsDir } from '../config.js'
import { createProjectChannels } from '../channel-management.js'
import {
  getDefaultRuntimeAdapter,
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { PlatformAdmin } from '../platform/types.js'
import { isTextChannel } from './channel-ref.js'

const logger = createLogger(LogPrefix.CREATE_PROJECT)

/**
 * Core project creation logic: creates directory, inits git, creates Discord channels.
 * Reused by the slash command handler and by onboarding (welcome channel).
 * Returns null if the project directory already exists.
 */
export async function createNewProject({
  admin,
  guildId,
  projectName,
  botName,
}: {
  admin: PlatformAdmin
  guildId: string
  projectName: string
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

  // Git init — gracefully skip if git is not installed
  try {
    await execAsync('git init', { cwd: projectDirectory, timeout: 10_000 })
    logger.log(`Initialized git in: ${projectDirectory}`)
  } catch (error) {
    logger.warn(
      `Could not initialize git in ${projectDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const { textChannelId, voiceChannelId, channelName } =
    await createProjectChannels({
      admin,
      guildId,
      projectDirectory,
      botName,
    })

  return {
    textChannelId,
    voiceChannelId,
    channelName,
    projectDirectory,
    sanitizedName,
  }
}

export async function handleCreateNewProjectCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const projectName = command.options.getString('name', true)
  const guildId = command.guildId
  const channel = command.channel
  const adapter = getDefaultRuntimeAdapter()
  const admin = adapter?.admin

  if (!guildId) {
    await command.editReply('This command can only be used in a guild')
    return
  }
  if (!admin) {
    await command.editReply('Project creation is not available here')
    return
  }

  if (!isTextChannel(channel)) {
    await command.editReply('This command can only be used in a text channel')
    return
  }

  try {
    const result = await createNewProject({
      admin,
      guildId,
      projectName,
      botName: command.botUserName,
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
      await command.editReply(
        `Project directory already exists: ${projectDirectory}`,
      )
      return
    }

    const {
      textChannelId,
      voiceChannelId,
      channelName,
      projectDirectory,
      sanitizedName,
    } = result
    const voiceInfo = voiceChannelId ? `\n🔊 Voice: <#${voiceChannelId}>` : ''
    await command.editReply(
      `✅ Created new project **${sanitizedName}**\n📁 Directory: \`${projectDirectory}\`\n📝 Text: <#${textChannelId}>${voiceInfo}\n_Starting session..._`,
    )

    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      throw new Error('No runtime adapter configured')
    }
    const channelTarget = {
      channelId: textChannelId,
    }
    const starterMessage = await adapter.conversation(channelTarget).send({
      markdown: `🚀 **New project initialized**\n📁 \`${projectDirectory}\``,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const { thread, target: threadTarget } = await adapter
      .conversation(channelTarget)
      .message(starterMessage.id)
      .then((messageHandle) => {
        return messageHandle.startThread({
          name: `Init: ${sanitizedName}`,
          autoArchiveDuration: 1440,
          reason: 'New project session',
        })
      })

    const threadHandle = await adapter.thread({
      threadId: threadTarget.threadId,
      parentId: thread.parentId,
    })
    if (!threadHandle) {
      throw new Error(`Thread not found: ${threadTarget.threadId}`)
    }
    await threadHandle.addMember(command.user.id)

    const runtime = getOrCreateRuntime({
      threadId: thread.id,
      thread,
      projectDirectory,
      sdkDirectory: projectDirectory,
      channelId: textChannelId,
      appId,
    })
    await runtime.enqueueIncoming({
      prompt:
        'The project was just initialized. Say hi and ask what the user wants to build.',
      userId: command.user.id,
      username: command.user.displayName,
      appId,
      mode: 'opencode',
    })

    logger.log(`Created new project ${channelName} at ${projectDirectory}`)
  } catch (error) {
    logger.error('[CREATE-NEW-PROJECT] Error:', error)
    await command.editReply(
      `Failed to create new project: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
