// /add-project command - Create Discord channels for an existing OpenCode project.

import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { getDatabase } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { createProjectChannels } from '../channel-management.js'
import { createLogger } from '../logger.js'
import { abbreviatePath } from '../utils.js'
import * as errore from 'errore'

const logger = createLogger('ADD-PROJECT')

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
    if (errore.isError(getClient)) {
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

    const db = getDatabase()
    const existingChannel = db
      .prepare(
        'SELECT channel_id FROM channel_directories WHERE directory = ? AND channel_type = ?',
      )
      .get(directory, 'text') as { channel_id: string } | undefined

    if (existingChannel) {
      await command.editReply(
        `A channel already exists for this directory: <#${existingChannel.channel_id}>`,
      )
      return
    }

    const { textChannelId, voiceChannelId, channelName } = await createProjectChannels({
      guild,
      projectDirectory: directory,
      appId,
      botName: command.client.user?.username,
    })

    await command.editReply(
      `✅ Created channels for project:\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n📁 Directory: \`${directory}\``,
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
    if (errore.isError(getClient)) {
      await interaction.respond([])
      return
    }

    const projectsResponse = await getClient().project.list({})
    if (!projectsResponse.data) {
      await interaction.respond([])
      return
    }

    const db = getDatabase()
    const existingDirs = db
      .prepare('SELECT DISTINCT directory FROM channel_directories WHERE channel_type = ?')
      .all('text') as { directory: string }[]
    const existingDirSet = new Set(existingDirs.map((row) => row.directory))

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
