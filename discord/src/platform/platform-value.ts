// Helpers that normalize discord.js values into Kimaki platform transport types.
// Used by Discord-native command handlers that already have a raw thread/message
// from an interaction and need to pass platform-shaped data into shared runtime APIs.

import type { Message, ThreadChannel } from 'discord.js'
import type { PlatformMessage, PlatformThread } from './types.js'

export function platformMessageFromDiscord(
  message: Message,
): PlatformMessage {
  return {
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName || message.author.displayName,
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
    raw: message,
  }
}

export function platformThreadFromDiscord(
  thread: ThreadChannel,
): PlatformThread {
  return {
    id: thread.id,
    name: thread.name,
    parentId: thread.parentId,
    guildId: thread.guildId,
    createdTimestamp: thread.createdTimestamp ?? null,
    raw: thread,
  }
}
