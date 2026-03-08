// Discord channel and category management.
// Creates and manages Kimaki project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  getChannelDirectory,
  setChannelDirectory,
  findChannelsByDirectory,
} from './database.js'
import { getProjectsDir } from './config.js'
import { execAsync } from './worktrees.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

export async function ensureKimakiCategory(
  guild: Guild,
  botName?: string,
): Promise<CategoryChannel> {
  // Skip appending bot name if it's already "kimaki" to avoid "Kimaki kimaki"
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const categoryName = botName && !isKimakiBot ? `Kimaki ${botName}` : 'Kimaki'

  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === categoryName.toLowerCase()
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  })
}

export async function ensureKimakiAudioCategory(
  guild: Guild,
  botName?: string,
): Promise<CategoryChannel> {
  // Skip appending bot name if it's already "kimaki" to avoid "Kimaki Audio kimaki"
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const categoryName =
    botName && !isKimakiBot ? `Kimaki Audio ${botName}` : 'Kimaki Audio'

  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === categoryName.toLowerCase()
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  })
}

export async function createProjectChannels({
  guild,
  projectDirectory,
  botName,
  enableVoiceChannels = false,
}: {
  guild: Guild
  projectDirectory: string
  botName?: string
  enableVoiceChannels?: boolean
}): Promise<{
  textChannelId: string
  voiceChannelId: string | null
  channelName: string
}> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const kimakiCategory = await ensureKimakiCategory(guild, botName)

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: kimakiCategory,
    // Channel configuration is stored in SQLite, not in the topic
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  let voiceChannelId: string | null = null

  if (enableVoiceChannels) {
    const kimakiAudioCategory = await ensureKimakiAudioCategory(guild, botName)

    const voiceChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: kimakiAudioCategory,
    })

    await setChannelDirectory({
      channelId: voiceChannel.id,
      directory: projectDirectory,
      channelType: 'voice',
    })

    voiceChannelId = voiceChannel.id
  }

  return {
    textChannelId: textChannel.id,
    voiceChannelId,
    channelName,
  }
}

export type ChannelWithTags = {
  id: string
  name: string
  description: string | null
  kimakiDirectory?: string
}

export async function getChannelsWithDescriptions(
  guild: Guild,
): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  const textChannels = guild.channels.cache.filter((channel) =>
    channel.isTextBased(),
  )

  for (const channel of textChannels.values()) {
    const textChannel = channel as TextChannel
    const description = textChannel.topic || null

    // Get channel config from database instead of parsing XML from topic
    const channelConfig = await getChannelDirectory(textChannel.id)

    channels.push({
      id: textChannel.id,
      name: textChannel.name,
      description,
      kimakiDirectory: channelConfig?.directory,
    })
  }

  return channels
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
.env
.env.*
!.env.example
.DS_Store
tmp/
*.log
__pycache__/
*.pyc
.venv/
*.egg-info/
`

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Kimaki. Not connected to a specific OpenCode project or repository.'

/**
 * Create (or find) the default "kimaki" channel for general-purpose tasks.
 * Channel name is "kimaki-{botName}" for self-hosted bots, "kimaki" for gateway.
 * Directory is ~/.kimaki/projects/kimaki, git-initialized with a .gitignore.
 *
 * Idempotency: checks the database for an existing channel mapped to the
 * kimaki projects directory. Also scans guild channels by name+category
 * as a fallback for channels created before DB mapping existed.
 */
export async function createDefaultKimakiChannel({
  guild,
  botName,
  appId,
  isGatewayMode,
}: {
  guild: Guild
  botName?: string
  appId: string
  isGatewayMode: boolean
}): Promise<{
  textChannel: TextChannel
  textChannelId: string
  channelName: string
  projectDirectory: string
} | null> {
  const projectDirectory = path.join(getProjectsDir(), 'kimaki')

  // Hydrate guild channels from API so the cache scan is complete
  try {
    await guild.channels.fetch()
  } catch (error) {
    logger.warn(
      `Could not fetch guild channels for ${guild.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // 1. Check database for existing channel mapped to this directory
  const existingMappings = await findChannelsByDirectory({
    directory: projectDirectory,
    channelType: 'text',
  })
  if (existingMappings.length > 0) {
    const channelId = existingMappings[0]!.channel_id
    // Verify the channel still exists in the guild
    const channel = guild.channels.cache.get(channelId)
    if (channel && channel.type === ChannelType.GuildText) {
      logger.log(`Default kimaki channel already exists: ${channelId}`)
      return null
    }
    // Channel was deleted from Discord but DB mapping remains — fall through
    logger.log(
      `DB mapping exists for ${channelId} but channel not found in guild, creating new one`,
    )
  }

  // 2. Fallback: detect existing channel by name+category
  const kimakiCategory = await ensureKimakiCategory(guild, botName)
  const existingByName = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    if (ch.parentId !== kimakiCategory.id) {
      return false
    }
    return ch.name === 'kimaki' || ch.name.startsWith('kimaki-')
  })
  if (existingByName) {
    logger.log(
      `Found existing default kimaki channel by name: ${existingByName.id}, restoring DB mapping`,
    )
    await setChannelDirectory({
      channelId: existingByName.id,
      directory: projectDirectory,
      channelType: 'text',
      skipIfExists: true,
    })
    return null
  }

  // Create directory and initialize git
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created default kimaki directory: ${projectDirectory}`)
  }

  // Git init — gracefully skip if git is not installed
  const gitDir = path.join(projectDirectory, '.git')
  if (!fs.existsSync(gitDir)) {
    try {
      await execAsync('git init', { cwd: projectDirectory, timeout: 10_000 })
      logger.log(`Initialized git in: ${projectDirectory}`)
    } catch (error) {
      logger.warn(
        `Could not initialize git in ${projectDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // Write .gitignore if it doesn't exist
  const gitignorePath = path.join(projectDirectory, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE)
  }

  // Channel name: "kimaki-{botName}" for self-hosted, "kimaki" for gateway
  const channelName = (() => {
    if (isGatewayMode || !botName) {
      return 'kimaki'
    }
    const sanitized = botName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (!sanitized || sanitized === 'kimaki') {
      return 'kimaki'
    }
    return `kimaki-${sanitized}`.slice(0, 100)
  })()

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: kimakiCategory,
    topic: DEFAULT_CHANNEL_TOPIC,
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  logger.log(`Created default kimaki channel: #${channelName} (${textChannel.id})`)

  return {
    textChannel,
    textChannelId: textChannel.id,
    channelName,
    projectDirectory,
  }
}
