// /add-project command - Create Discord channels for an existing OpenCode project.

import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { findChannelsByDirectory, getAllTextChannelDirectories } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { createProjectChannels } from '../channel-management.js'
import { createLogger, LogPrefix } from '../logger.js'
import { abbreviatePath } from '../utils.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.ADD_PROJECT)

export async function handleAddProjectCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const projectId = command.options.getString('project', true)
  const guild = command.guild

  if (!guild) {
    await command.editReply('This command can only be used in a guild')
    return
  }

  try {
    const currentDir = process.cwd()
    const getClient = await initializeOpencodeForDirectory(currentDir)
    if (getClient instanceof Error) {
      await command.editReply(getClient.message)
      return
    }

    const projectsResponse = await getClient().project.list({})
    if (!projectsResponse.data) {
      await command.editReply('Failed to fetch projects')
      return
    }

    const project = projectsResponse.data.find((p) => p.id === projectId)

    if (!project) {
      await command.editReply('Project not found')
      return
    }

    const directory = project.worktree

    if (!fs.existsSync(directory)) {
      await command.editReply(`Directory does not exist: ${directory}`)
      return
    }

    const existingChannels = await findChannelsByDirectory({
      directory,
      channelType: 'text',
    })

    if (existingChannels.length > 0) {
      await command.editReply(
        `A channel already exists for this directory: <#${existingChannels[0]!.channel_id}>`,
      )
      return
    }

    const { textChannelId, voiceChannelId, channelName } = await createProjectChannels({
      guild,
      projectDirectory: directory,
      appId,
      botName: command.client.user?.username,
    })

    const voiceInfo = voiceChannelId ? `\n🔊 Voice: <#${voiceChannelId}>` : ''
    await command.editReply(
      `✅ Created channels for project:\n📝 Text: <#${textChannelId}>${voiceInfo}\n📁 Directory: \`${directory}\``,
    )

    logger.log(`Created channels for project ${channelName} at ${directory}`)
  } catch (error) {
    logger.error('[ADD-PROJECT] Error:', error)
    await command.editReply(
      `Failed to create channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleAddProjectAutocomplete({
  interaction,
  appId,
}: AutocompleteContext): Promise<void> {
  const focusedValue = interaction.options.getFocused()

  try {
    const currentDir = process.cwd()
    const getClient = await initializeOpencodeForDirectory(currentDir)
    if (getClient instanceof Error) {
      await interaction.respond([])
      return
    }

    const projectsResponse = await getClient().project.list({})
    if (!projectsResponse.data) {
      await interaction.respond([])
      return
    }

    const existingDirs = await getAllTextChannelDirectories()
    const existingDirSet = new Set(existingDirs)

    const availableProjects = projectsResponse.data.filter((project) => {
      if (existingDirSet.has(project.worktree)) {
        return false
      }
      if (path.basename(project.worktree).startsWith('opencode-test-')) {
        return false
      }
      return true
    })

    const projects = availableProjects
      .filter((project) => {
        const baseName = path.basename(project.worktree)
        const searchText = `${baseName} ${project.worktree}`.toLowerCase()
        return searchText.includes(focusedValue.toLowerCase())
      })
      .sort((a, b) => {
        const aTime = a.time.initialized || a.time.created
        const bTime = b.time.initialized || b.time.created
        return bTime - aTime
      })
      .slice(0, 25)
      .map((project) => {
        const name = `${path.basename(project.worktree)} (${abbreviatePath(project.worktree)})`
        return {
          name: name.length > 100 ? name.slice(0, 99) + '…' : name,
          value: project.id,
        }
      })

    await interaction.respond(projects)
  } catch (error) {
    logger.error('[AUTOCOMPLETE] Error fetching projects:', error)
    await interaction.respond([])
  }
}
