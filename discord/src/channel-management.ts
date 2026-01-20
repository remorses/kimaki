// Discord channel and category management.
// Creates and manages Kimaki project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from 'discord.js'
import path from 'node:path'
import { getDatabase } from './database.js'
import { extractTagsArrays } from './xml.js'

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
}: {
  guild: Guild
  projectDirectory: string
  appId: string
  botName?: string
}): Promise<{ textChannelId: string; voiceChannelId: string; channelName: string }> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const kimakiCategory = await ensureKimakiCategory(guild, botName)
  const kimakiAudioCategory = await ensureKimakiAudioCategory(guild, botName)

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: kimakiCategory,
    topic: `<kimaki><directory>${projectDirectory}</directory><app>${appId}</app></kimaki>`,
  })

  const voiceChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: kimakiAudioCategory,
  })

  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type, app_id) VALUES (?, ?, ?, ?)',
    )
    .run(textChannel.id, projectDirectory, 'text', appId)

  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type, app_id) VALUES (?, ?, ?, ?)',
    )
    .run(voiceChannel.id, projectDirectory, 'voice', appId)

  return {
    textChannelId: textChannel.id,
    voiceChannelId: voiceChannel.id,
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

  guild.channels.cache
    .filter((channel) => channel.isTextBased())
    .forEach((channel) => {
      const textChannel = channel as TextChannel
      const description = textChannel.topic || null

      let kimakiDirectory: string | undefined
      let kimakiApp: string | undefined

      if (description) {
        const extracted = extractTagsArrays({
          xml: description,
          tags: ['kimaki.directory', 'kimaki.app'],
        })

        kimakiDirectory = extracted['kimaki.directory']?.[0]?.trim()
        kimakiApp = extracted['kimaki.app']?.[0]?.trim()
      }

      channels.push({
        id: textChannel.id,
        name: textChannel.name,
        description,
        kimakiDirectory,
        kimakiApp,
      })
    })

  return channels
}
