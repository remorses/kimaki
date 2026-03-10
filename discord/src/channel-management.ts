// Discord channel and category management.
// Creates and manages Kimaki project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

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
import { TUTORIAL_WELCOME_TEXT } from './onboarding-tutorial.js'
import type { KimakiAdapter, PlatformAdmin, PlatformChannel } from './platform/types.js'

const logger = createLogger(LogPrefix.CHANNEL)

const THREAD_AUTO_ARCHIVE_ONE_DAY = 1440

function isCategoryChannel(channel: PlatformChannel): boolean {
  return channel.kind === 'other' && channel.parentId === null
}

function isTextChannel(channel: PlatformChannel): boolean {
  return channel.kind === 'text'
}

export async function ensureKimakiCategory(
  {
    admin,
    guildId,
    botName,
  }: {
    admin: PlatformAdmin
    guildId: string
    botName?: string
  },
): Promise<PlatformChannel> {
  // Skip appending bot name if it's already "kimaki" to avoid "Kimaki kimaki"
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const categoryName = botName && !isKimakiBot ? `Kimaki ${botName}` : 'Kimaki'

  const channels = await admin.listChannels({ guildId })
  const existingCategory = channels.find((channel) => {
    if (!isCategoryChannel(channel)) {
      return false
    }
    if (!channel.name) {
      return false
    }
    return channel.name.toLowerCase() === categoryName.toLowerCase()
  })

  if (existingCategory) {
    return existingCategory
  }

  return admin.createCategory({
    guildId,
    name: categoryName,
  })
}

export async function ensureKimakiAudioCategory(
  {
    admin,
    guildId,
    botName,
  }: {
    admin: PlatformAdmin
    guildId: string
    botName?: string
  },
): Promise<PlatformChannel> {
  // Skip appending bot name if it's already "kimaki" to avoid "Kimaki Audio kimaki"
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const categoryName =
    botName && !isKimakiBot ? `Kimaki Audio ${botName}` : 'Kimaki Audio'

  const channels = await admin.listChannels({ guildId })
  const existingCategory = channels.find((channel) => {
    if (!isCategoryChannel(channel)) {
      return false
    }
    if (!channel.name) {
      return false
    }
    return channel.name.toLowerCase() === categoryName.toLowerCase()
  })

  if (existingCategory) {
    return existingCategory
  }

  return admin.createCategory({
    guildId,
    name: categoryName,
  })
}

export async function createProjectChannels({
  admin,
  guildId,
  projectDirectory,
  botName,
  enableVoiceChannels = false,
}: {
  admin: PlatformAdmin
  guildId: string
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

  const kimakiCategory = await ensureKimakiCategory({
    admin,
    guildId,
    botName,
  })

  const textChannel = await admin.createTextChannel({
    guildId,
    name: channelName,
    parentId: kimakiCategory.id,
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  let voiceChannelId: string | null = null

  if (enableVoiceChannels) {
    const kimakiAudioCategory = await ensureKimakiAudioCategory({
      admin,
      guildId,
      botName,
    })

    const voiceChannel = await admin.createVoiceChannel?.({
      guildId,
      name: channelName,
      parentId: kimakiAudioCategory.id,
    })

    if (!voiceChannel) {
      return {
        textChannelId: textChannel.id,
        voiceChannelId: null,
        channelName,
      }
    }

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
  {
    admin,
    guildId,
  }: {
    admin: PlatformAdmin
    guildId: string
  },
): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  const textChannels = (await admin.listChannels({ guildId })).filter((channel) => {
    return isTextChannel(channel)
  })

  for (const textChannel of textChannels) {
    const description = textChannel.topic || null

    // Get channel config from database instead of parsing XML from topic
    const channelConfig = await getChannelDirectory(textChannel.id)

    channels.push({
      id: textChannel.id,
      name: textChannel.name || textChannel.id,
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
  admin,
  guildId,
  botName,
  isGatewayMode,
}: {
  admin: PlatformAdmin
  guildId: string
  botName?: string
  isGatewayMode: boolean
}): Promise<{
  textChannelId: string
  channelName: string
  projectDirectory: string
} | null> {
  const projectDirectory = path.join(getProjectsDir(), 'kimaki')

  // Ensure the default kimaki project directory exists before any DB mapping
  // restoration or git setup. Custom data dirs may not have <dataDir>/projects
  // created yet, and later writes assume the full path is present.
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created default kimaki directory: ${projectDirectory}`)
  }

  // 1. Check database for existing channel mapped to this directory.
  // Check ALL mappings (not just the first) since the same directory could
  // have stale rows from deleted channels or other guilds.
  const existingMappings = await findChannelsByDirectory({
    directory: projectDirectory,
    channelType: 'text',
  })
  const mappedChannelInGuildResults = await Promise.all(
    existingMappings.map(async (row) => {
      return admin.fetchChannel({ guildId, channelId: row.channel_id })
    }),
  )
  const mappedChannelInGuild = mappedChannelInGuildResults.find((channel) => {
    return channel?.kind === 'text'
  })
  if (mappedChannelInGuild) {
    logger.log(`Default kimaki channel already exists: ${mappedChannelInGuild.id}`)
    return null
  }

  // 2. Fallback: detect existing channel by name+category
  const kimakiCategory = await ensureKimakiCategory({ admin, guildId, botName })
  const guildChannels = await admin.listChannels({ guildId })
  const existingByName = guildChannels.find((ch) => {
    if (!isTextChannel(ch)) {
      return false
    }
    if (ch.parentId !== kimakiCategory.id) {
      return false
    }
    const channelName = ch.name || ''
    return channelName === 'kimaki' || channelName.startsWith('kimaki-')
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

  const textChannel = await admin.createTextChannel({
    guildId,
    name: channelName,
    parentId: kimakiCategory.id,
    topic: DEFAULT_CHANNEL_TOPIC,
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  logger.log(`Created default kimaki channel: #${channelName} (${textChannel.id})`)

  return {
    textChannelId: textChannel.id,
    channelName,
    projectDirectory,
  }
}

// ── Onboarding welcome message ──────────────────────────────────────────

function buildWelcomeText(): string {
  return `**Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
**What you can do:**
- Use \`/add-project\` to create a Discord channel linked to one OpenCode project (git repo)
- Collaborate with teammates in the same session
- Upload images and files, the bot can share screenshots back
${TUTORIAL_WELCOME_TEXT}`
}

function buildThreadPrompt({ mentionUserId }: { mentionUserId?: string }): string {
  const mentionSuffix = mentionUserId ? ` <@${mentionUserId}>` : ''
  return `Want to build an example browser game? Respond in this thread.${mentionSuffix}`
}

export async function sendWelcomeMessage({
  adapter,
  channelId,
  mentionUserId,
}: {
  adapter: KimakiAdapter
  channelId: string
  mentionUserId?: string
}): Promise<void> {
  try {
    const conversation = adapter.conversation({ channelId })
    const message = await conversation.send({ markdown: buildWelcomeText() })
    const thread = await conversation.message(message.id).then((messageHandle) => {
      return messageHandle.startThread({
      name: 'Kimaki tutorial',
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_ONE_DAY,
      reason: 'Onboarding tutorial thread',
    })
    })
    await adapter.conversation(thread.target).send({
      markdown: buildThreadPrompt({ mentionUserId }),
    })
    logger.log(`Sent welcome message with thread to channel ${channelId}`)
  } catch (error) {
    logger.warn(
      `Failed to send welcome message to channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
