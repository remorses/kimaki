// Discord channel and category management.
// Creates and manages Kimaki project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from 'discord.js'
import path from 'node:path'
import { getChannelDirectory, setChannelDirectory } from './database.js'

export async function ensureKimakiCategory(
  guild: Guild,
  botName?: string,
): Promise<CategoryChannel> {
  // Skip appending bot name if it's already "kimaki" to avoid "Kimaki kimaki"
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const categoryName = botName && !isKimakiBot ? `Kimaki ${botName}` : 'Kimaki'

  const existingCategory = guild.channels.cache.find((channel): channel is CategoryChannel => {
    if (channel.type !== ChannelType.GuildCategory) {
      return false
    }

    return channel.name.toLowerCase() === categoryName.toLowerCase()
  })

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
  const categoryName = botName && !isKimakiBot ? `Kimaki Audio ${botName}` : 'Kimaki Audio'

  const existingCategory = guild.channels.cache.find((channel): channel is CategoryChannel => {
    if (channel.type !== ChannelType.GuildCategory) {
      return false
    }

    return channel.name.toLowerCase() === categoryName.toLowerCase()
  })

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
  appId,
  botName,
  enableVoiceChannels = false,
}: {
  guild: Guild
  projectDirectory: string
  appId: string
  botName?: string
  enableVoiceChannels?: boolean
}): Promise<{ textChannelId: string; voiceChannelId: string | null; channelName: string }> {
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
    appId,
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
      appId,
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
  kimakiApp?: string
}

export async function getChannelsWithDescriptions(guild: Guild): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  const textChannels = guild.channels.cache.filter((channel) => channel.isTextBased())

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
      kimakiApp: channelConfig?.appId || undefined,
    })
  }

  return channels
}
