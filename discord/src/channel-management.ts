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

// Topic marker embedded in the default kimaki channel topic.
// Used for idempotency: scan guild channels for this marker instead of relying
// on DB state, which can drift after DB resets or migrations.
const DEFAULT_CHANNEL_TOPIC_MARKER = '[kimaki-default:'

export function buildDefaultChannelTopic(appId: string): string {
  return `General channel for misc tasks with Kimaki. Not connected to a specific OpenCode project or repository. ${DEFAULT_CHANNEL_TOPIC_MARKER}${appId}]`
}

export function findDefaultKimakiChannelInGuild({
  guild,
  appId,
}: {
  guild: Guild
  appId: string
}): TextChannel | null {
  const marker = `${DEFAULT_CHANNEL_TOPIC_MARKER}${appId}]`
  const found = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    return (ch as TextChannel).topic?.includes(marker) ?? false
  })
  return found ?? null
}

/**
 * Create (or find) the default "kimaki" channel for general-purpose tasks.
 * Channel name is "kimaki-{botName}" for self-hosted bots, "kimaki" for gateway.
 * Directory is ~/.kimaki/projects/kimaki, git-initialized with a .gitignore.
 *
 * Idempotency (3 layers):
 * 1. Hydrate guild channels from API to avoid stale cache misses
 * 2. Scan for topic marker [kimaki-default:{appId}]
 * 3. Legacy fallback: detect unmarked channels by name+category from before
 *    the marker was introduced, backfill their topic with the marker
 *
 * When an existing channel is found (marked or legacy), the DB mapping is
 * always re-written so it recovers from DB resets.
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

  // 1. Check for existing channel via topic marker
  const existing = findDefaultKimakiChannelInGuild({ guild, appId })
  if (existing) {
    logger.log(`Default kimaki channel already exists: ${existing.id}`)
    // Ensure DB mapping is present (recovers from DB resets)
    await setChannelDirectory({
      channelId: existing.id,
      directory: projectDirectory,
      channelType: 'text',
      skipIfExists: true,
    })
    return null
  }

  // 2. Legacy fallback: detect unmarked default channel by name+category
  //    from before the topic marker was introduced. Backfill the marker
  //    and restore DB mapping instead of creating a duplicate.
  const kimakiCategory = await ensureKimakiCategory(guild, botName)
  const legacyChannel = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    if (ch.parentId !== kimakiCategory.id) {
      return false
    }
    // Match channels named "kimaki" or "kimaki-{botname}"
    return ch.name === 'kimaki' || ch.name.startsWith('kimaki-')
  })
  if (legacyChannel) {
    logger.log(
      `Found legacy default kimaki channel without marker: ${legacyChannel.id}, backfilling topic`,
    )
    try {
      await legacyChannel.setTopic(buildDefaultChannelTopic(appId))
    } catch (error) {
      logger.warn(
        `Could not backfill topic marker on legacy channel ${legacyChannel.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await setChannelDirectory({
      channelId: legacyChannel.id,
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
    topic: buildDefaultChannelTopic(appId),
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
