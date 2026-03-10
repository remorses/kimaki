// Helpers that normalize Discord-like values into Kimaki platform transport types.
// Used when callers already have message/thread objects and need platform-shaped
// data without importing discord.js outside adapter boundaries.

import type { PlatformMessage, PlatformThread } from './types.js'

type DiscordLikeMessage = {
  id: string
  content: string
  channelId: string
  author: {
    id: string
    username: string
    displayName?: string | null
    bot: boolean
  }
  member?: {
    displayName?: string | null
  } | null
  attachments: PlatformMessage['attachments']
  embeds: Array<{
    footer?: {
      text?: string
    }
  }>
}

type DiscordLikeThread = {
  id: string
  name: string
  parentId: string | null
  guildId?: string | null
  createdTimestamp?: number | null
}

export function platformMessageFromDiscord(
  message: DiscordLikeMessage,
): PlatformMessage {
  return {
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName || message.author.displayName || message.author.username,
      globalName: message.author.displayName || undefined,
      bot: message.author.bot,
    },
    attachments: message.attachments,
    embeds: message.embeds.map((embed) => {
      return {
        data: {
          footer: {
            text: embed.footer?.text,
          },
        },
      }
    }),
  }
}

export function platformThreadFromDiscord(
  thread: DiscordLikeThread,
): PlatformThread {
  return {
    id: thread.id,
    name: thread.name,
    kind: 'thread',
    type: 'thread',
    parentId: thread.parentId,
    guildId: thread.guildId,
    createdTimestamp: thread.createdTimestamp ?? null,
    isThread() {
      return true
    },
  }
}
