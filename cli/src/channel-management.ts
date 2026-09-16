// Discord channel and category management.
// Creates and manages Kimaki project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  getChannelDirectory,
  setChannelDirectory,
  findChannelsByDirectory,
  listTrackedTextChannels,
  getGuildCategories,
  setGuildCategoryId,
  setGuildAudioCategoryId,
} from './database.js'
import { getProjectsDir } from './config.js'
import { execAsync } from './worktrees.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  trackEvent,
  type AnalyticsProjectKind,
  type AnalyticsProjectSource,
  type AnalyticsProps,
} from './analytics.js'

/**
 * Distinct non-default project directories mapped as text channels.
 * Returns null on query failure so callers omit the field instead of
 * emitting a fabricated zero.
 */
export async function getUserProjectCount(): Promise<number | null> {
  try {
    const channels = await listTrackedTextChannels()
    const defaultDir = path.resolve(getDefaultKimakiDirectory())
    const dirs = new Set(
      channels
        .map((row) => path.resolve(row.directory))
        .filter((directory) => directory !== defaultDir),
    )
    return dirs.size
  } catch {
    return null
  }
}

async function trackProjectRegistered({
  projectKind,
  source,
}: {
  projectKind: AnalyticsProjectKind
  source: AnalyticsProjectSource
}) {
  const userProjectCount = await getUserProjectCount()
  const props: AnalyticsProps = {
    project_kind: projectKind,
    source,
  }
  if (userProjectCount !== null) {
    props.user_project_count = userProjectCount
  }
  trackEvent('project_registered', props)
}

const logger = createLogger(LogPrefix.CHANNEL)

function defaultCategoryName(botName?: string) {
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  return botName && !isKimakiBot ? `Kimaki ${botName}` : 'Kimaki'
}

function defaultAudioCategoryName(botName?: string) {
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  return botName && !isKimakiBot ? `Kimaki Audio ${botName}` : 'Kimaki Audio'
}

function defaultKimakiChannelName({
  botName,
  isGatewayMode,
}: {
  botName?: string
  isGatewayMode: boolean
}) {
  if (isGatewayMode || !botName) return 'kimaki'
  const sanitized = botName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!sanitized || sanitized === 'kimaki') return 'kimaki'
  return `kimaki-${sanitized}`.slice(0, 100)
}

const categoryEnsures = new Map<string, Promise<CategoryChannel>>()

function ensureCategorySerialized({
  key,
  run,
}: {
  key: string
  run: () => Promise<CategoryChannel>
}) {
  const existing = categoryEnsures.get(key)
  if (existing) return existing
  const promise = run().finally(() => {
    if (categoryEnsures.get(key) === promise) {
      categoryEnsures.delete(key)
    }
  })
  categoryEnsures.set(key, promise)
  return promise
}

function isUnknownDiscordChannel(error: unknown) {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
  const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
  return code === 10003 || status === 404
}

function isCategoryChannel(
  channel: GuildBasedChannel | null | undefined,
): channel is CategoryChannel {
  return channel?.type === ChannelType.GuildCategory
}

async function fetchCategoryById(
  guild: Guild,
  categoryId: string,
): Promise<CategoryChannel | null> {
  const cached = guild.channels.cache.get(categoryId)
  if (isCategoryChannel(cached)) return cached
  try {
    const fetched = await guild.channels.fetch(categoryId)
    return isCategoryChannel(fetched) ? fetched : null
  } catch (error) {
    if (isUnknownDiscordChannel(error)) return null
    throw error
  }
}

async function adoptParentFromTrackedChannels({
  guild,
  channelType,
}: {
  guild: Guild
  channelType: 'text' | 'voice'
}): Promise<CategoryChannel | null> {
  const mappings = await findChannelsByDirectory({ channelType })
  const channels = await guild.channels.fetch()
  for (const row of mappings) {
    if (row.guild_id && row.guild_id !== guild.id) continue
    const channel = channels.get(row.channel_id)
    if (!channel?.parentId) continue
    const parent = await fetchCategoryById(guild, channel.parentId)
    if (parent) return parent
  }
  return null
}

async function createAndBindCategory({
  guild,
  name,
  kind,
}: {
  guild: Guild
  name: string
  kind: 'text' | 'audio'
}): Promise<CategoryChannel> {
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  })
  if (kind === 'audio') {
    await setGuildAudioCategoryId({
      guildId: guild.id,
      audioCategoryId: created.id,
    })
  } else {
    await setGuildCategoryId({ guildId: guild.id, categoryId: created.id })
  }
  return created
}

async function resolveKimakiCategory(guild: Guild, botName?: string) {
  const stored = await getGuildCategories(guild.id)
  if (stored?.category_id) {
    const existing = await fetchCategoryById(guild, stored.category_id)
    if (existing) return existing
  }

  const adopted = await adoptParentFromTrackedChannels({
    guild,
    channelType: 'text',
  })
  if (adopted) {
    await setGuildCategoryId({ guildId: guild.id, categoryId: adopted.id })
    return adopted
  }

  return createAndBindCategory({
    guild,
    name: defaultCategoryName(botName),
    kind: 'text',
  })
}

async function resolveKimakiAudioCategory(guild: Guild, botName?: string) {
  const stored = await getGuildCategories(guild.id)
  if (stored?.audio_category_id) {
    const existing = await fetchCategoryById(guild, stored.audio_category_id)
    if (existing) return existing
  }

  const adopted = await adoptParentFromTrackedChannels({
    guild,
    channelType: 'voice',
  })
  if (adopted) {
    await setGuildAudioCategoryId({
      guildId: guild.id,
      audioCategoryId: adopted.id,
    })
    return adopted
  }

  return createAndBindCategory({
    guild,
    name: defaultAudioCategoryName(botName),
    kind: 'audio',
  })
}

export function ensureKimakiCategory(guild: Guild, botName?: string) {
  return ensureCategorySerialized({
    key: `${guild.id}:text`,
    run: () => resolveKimakiCategory(guild, botName),
  })
}

export function ensureKimakiAudioCategory(guild: Guild, botName?: string) {
  return ensureCategorySerialized({
    key: `${guild.id}:audio`,
    run: () => resolveKimakiAudioCategory(guild, botName),
  })
}

export async function createProjectChannels({
  guild,
  projectDirectory,
  botName,
  enableVoiceChannels = false,
  analyticsSource = 'cli',
}: {
  guild: Guild
  projectDirectory: string
  botName?: string
  enableVoiceChannels?: boolean
  analyticsSource?: AnalyticsProjectSource
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
    guildId: guild.id,
  })
  await trackProjectRegistered({
    projectKind: 'user',
    source: analyticsSource,
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
      guildId: guild.id,
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

  const textChannels = guild.channels.cache.filter(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText,
  )

  for (const channel of textChannels.values()) {
    const description = channel.topic || null

    // Get channel config from database instead of parsing XML from topic
    const channelConfig = await getChannelDirectory(channel.id)

    channels.push({
      id: channel.id,
      name: channel.name,
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

/** Returns the absolute path to the default kimaki project directory. */
export function getDefaultKimakiDirectory(): string {
  return path.join(getProjectsDir(), 'kimaki')
}

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Kimaki. Not connected to a specific OpenCode project or repository.'

/**
 * Create (or find) the default "kimaki" channel for general-purpose tasks.
 * Channel name is "kimaki-{botName}" for self-hosted bots, "kimaki" for gateway.
 * Directory is ~/.kimaki/projects/kimaki, git-initialized with a .gitignore.
 *
 * Idempotency: checks the database for an existing channel mapped to the
 * kimaki projects directory. Also scans this machine's category for the
 * exact default channel name as a fallback for channels created before
 * DB mapping existed.
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
  const projectDirectory = getDefaultKimakiDirectory()

  // Ensure the default kimaki project directory exists before any DB mapping
  // restoration or git setup. Custom data dirs may not have <dataDir>/projects
  // created yet, and later writes assume the full path is present.
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created default kimaki directory: ${projectDirectory}`)
  }

  // Hydrate guild channels from API so the cache scan is complete
  try {
    await guild.channels.fetch()
  } catch (error) {
    logger.warn(
      `Could not fetch guild channels for ${guild.name}: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }

  // 1. Check database for existing channel mapped to this directory.
  // Check ALL mappings (not just the first) since the same directory could
  // have stale rows from deleted channels or other guilds.
  const existingMappings = await findChannelsByDirectory({
    directory: projectDirectory,
    channelType: 'text',
  })
  const mappedRow = existingMappings.find((row) => {
    const ch = guild.channels.cache.get(row.channel_id)
    return ch?.type === ChannelType.GuildText
  })
  if (mappedRow) {
    // Backfill guild_id for rows created before this column existed,
    // so the tombstone check works if the channel is deleted later.
    if (mappedRow.guild_id !== guild.id) {
      await setChannelDirectory({
        channelId: mappedRow.channel_id,
        directory: projectDirectory,
        channelType: 'text',
        guildId: guild.id,
      })
    }
    logger.log(`Default kimaki channel already exists: ${mappedRow.channel_id}`)
    return null
  }

  // 1b. If a mapping exists for this guild but the channel is gone from Discord,
  // it was previously created and then deleted. Don't recreate it.
  const staleForThisGuild = existingMappings.find(
    (row) => row.guild_id === guild.id,
  )
  if (staleForThisGuild) {
    logger.log(
      `Default kimaki channel was previously provisioned for guild ${guild.name} (${guild.id}) as ${staleForThisGuild.channel_id}, but no longer exists. Skipping recreation.`,
    )
    return null
  }

  // 2. Fallback: detect an existing default channel in THIS machine's group.
  // A #kimaki channel in another machine's group is ignored.
  const channelName = defaultKimakiChannelName({ botName, isGatewayMode })
  const kimakiCategory = await ensureKimakiCategory(guild, botName)
  const existingByName = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    if (ch.parentId !== kimakiCategory.id) {
      return false
    }
    return ch.name === channelName
  })
  if (existingByName) {
    logger.log(
      `Found existing default kimaki channel by name: ${existingByName.id}. Skipping recreation.`,
    )
    return null
  }

  // Git init — gracefully skip if git is not installed
  const gitDir = path.join(projectDirectory, '.git')
  if (!fs.existsSync(gitDir)) {
    try {
      await execAsync('git init', { cwd: projectDirectory, timeout: 10_000 })
      logger.log(`Initialized git in: ${projectDirectory}`)
    } catch (error) {
      logger.warn(
        `Could not initialize git in ${projectDirectory}: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  }

  // Write .gitignore if it doesn't exist
  const gitignorePath = path.join(projectDirectory, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE)
  }

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
    guildId: guild.id,
  })
  await trackProjectRegistered({
    projectKind: 'default',
    source: 'onboarding',
  })

  logger.log(`Created default kimaki channel: #${channelName} (${textChannel.id})`)

  return {
    textChannel,
    textChannelId: textChannel.id,
    channelName,
    projectDirectory,
  }
}
