import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js'
import path from 'node:path'
import { getDatabase } from './database.js'
import { extractTagsArrays } from './xml.js'

export async function ensureKimakiCategory(guild: Guild): Promise<CategoryChannel> {
  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === 'kimaki'
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: 'Kimaki',
    type: ChannelType.GuildCategory,
  })
}

export async function ensureKimakiAudioCategory(guild: Guild): Promise<CategoryChannel> {
  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === 'kimaki audio'
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: 'Kimaki Audio',
    type: ChannelType.GuildCategory,
  })
}

export async function createProjectChannels({
  guild,
  projectDirectory,
  appId,
}: {
  guild: Guild
  projectDirectory: string
  appId: string
}): Promise<{ textChannelId: string; voiceChannelId: string; channelName: string }> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const kimakiCategory = await ensureKimakiCategory(guild)
  const kimakiAudioCategory = await ensureKimakiAudioCategory(guild)

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
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
    )
    .run(textChannel.id, projectDirectory, 'text')

  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
    )
    .run(voiceChannel.id, projectDirectory, 'voice')

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

export async function getChannelsWithDescriptions(
  guild: Guild,
): Promise<ChannelWithTags[]> {
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
