// Converters from Prisma DB rows to Slack Web API response shapes.
// Slack API responses always wrap data in { ok: true, ... }.

import type { User, Channel, Message, Reaction } from './generated/client.js'
import type {
  SlackUser,
  SlackChannel,
  SlackMessage,
  SlackReaction,
} from './types.js'

export function userToSlack({
  user,
  workspaceId,
}: {
  user: User
  workspaceId: string
}): SlackUser {
  return {
    id: user.id,
    team_id: workspaceId,
    name: user.name,
    real_name: user.realName,
    is_bot: user.isBot,
    profile: {
      image_48: user.avatar ?? undefined,
      real_name: user.realName,
      display_name: user.name,
    },
  }
}

export function channelToSlack({ channel }: { channel: Channel }): SlackChannel {
  return {
    id: channel.id,
    name: channel.name,
    is_channel: !channel.isPrivate,
    is_private: channel.isPrivate,
    is_archived: channel.isArchived,
    topic: { value: channel.topic },
    purpose: { value: channel.purpose },
    created: Math.floor(channel.createdAt.getTime() / 1000),
  }
}

export function messageToSlack({
  message,
  reactions,
}: {
  message: Message
  reactions?: Reaction[]
}): SlackMessage {
  const result: SlackMessage = {
    type: 'message',
    text: message.text,
    ts: message.ts,
  }

  if (message.userId && !message.botId) {
    result.user = message.userId
  }
  if (message.botId) {
    result.bot_id = message.botId
  }
  if (message.threadTs) {
    result.thread_ts = message.threadTs
  }
  if (message.editedTs) {
    result.edited = { user: message.userId, ts: message.editedTs }
  }

  const blocks = JSON.parse(message.blocks) as unknown[]
  if (blocks.length > 0) {
    result.blocks = blocks as SlackMessage['blocks']
  }

  const files = JSON.parse(message.files) as unknown[]
  if (files.length > 0) {
    result.files = files as SlackMessage['files']
  }

  if (reactions && reactions.length > 0) {
    // Group reactions by name
    const grouped = new Map<string, string[]>()
    for (const r of reactions) {
      const existing = grouped.get(r.name)
      if (existing) {
        existing.push(r.userId)
      } else {
        grouped.set(r.name, [r.userId])
      }
    }
    result.reactions = [...grouped.entries()].map(
      ([name, users]): SlackReaction => ({
        name,
        users,
        count: users.length,
      }),
    )
  }

  return result
}
