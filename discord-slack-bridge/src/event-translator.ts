// Translates Slack webhook events into Discord Gateway dispatch payloads.
// Each function takes a Slack event and returns a Discord-shaped object
// that can be broadcast via the Gateway.

import {
  ChannelType,
  GatewayDispatchEvents,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIMessage,
  APIUser,
  APIChannel,
} from 'discord-api-types/v10'
import {
  encodeMessageId,
  resolveDiscordChannelId,
  encodeThreadId,
  slackTsToIso,
} from './id-converter.js'
import { mrkdwnToMarkdown } from './format-converter.js'
import type {
  SlackEvent,
  SlackReactionEvent,
  CachedSlackUser,
} from './types.js'

/**
 * Translate a Slack message event into a Discord MESSAGE_CREATE payload.
 */
export function translateMessageCreate({
  event,
  guildId,
  author,
}: {
  event: SlackEvent
  guildId: string
  author: CachedSlackUser
}): { eventName: string; data: APIMessage & { guild_id: string } } | null {
  if (!(event.channel && event.ts)) {
    return null
  }

  const channelId = resolveDiscordChannelId(
    event.channel,
    event.thread_ts,
    event.ts,
  )
  const messageId = encodeMessageId(event.channel, event.ts)
  const content = mrkdwnToMarkdown(event.text ?? '')

  const apiUser: APIUser = {
    id: author.id,
    username: author.name,
    discriminator: '0',
    avatar: author.avatar ?? null,
    bot: author.isBot,
    global_name: author.realName,
  }

  const apiMessage: APIMessage & { guild_id: string } = {
    id: messageId,
    channel_id: channelId,
    author: apiUser,
    content,
    timestamp: slackTsToIso(event.ts),
    edited_timestamp: event.edited ? slackTsToIso(event.edited.ts) : null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    guild_id: guildId,
  }

  return {
    eventName: GatewayDispatchEvents.MessageCreate,
    data: apiMessage,
  }
}

/**
 * Translate a Slack message_changed subtype into MESSAGE_UPDATE.
 */
export function translateMessageUpdate({
  event,
  guildId,
  author,
}: {
  event: SlackEvent
  guildId: string
  author: CachedSlackUser
}): { eventName: string; data: APIMessage & { guild_id: string } } | null {
  // message_changed has the updated message in event.message
  const inner = event.message
  if (!(event.channel && inner?.ts)) {
    return null
  }

  const channelId = resolveDiscordChannelId(
    event.channel,
    inner.thread_ts,
    inner.ts,
  )
  const messageId = encodeMessageId(event.channel, inner.ts)
  const content = mrkdwnToMarkdown(inner.text ?? '')

  const apiUser: APIUser = {
    id: author.id,
    username: author.name,
    discriminator: '0',
    avatar: author.avatar ?? null,
    bot: author.isBot,
    global_name: author.realName,
  }

  const apiMessage: APIMessage & { guild_id: string } = {
    id: messageId,
    channel_id: channelId,
    author: apiUser,
    content,
    timestamp: slackTsToIso(inner.ts),
    edited_timestamp: inner.edited ? slackTsToIso(inner.edited.ts) : null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    guild_id: guildId,
  }

  return {
    eventName: GatewayDispatchEvents.MessageUpdate,
    data: apiMessage,
  }
}

/**
 * Translate a Slack message_deleted subtype into MESSAGE_DELETE.
 */
export function translateMessageDelete({
  event,
  guildId,
}: {
  event: SlackEvent
  guildId: string
}): {
  eventName: string
  data: { id: string; channel_id: string; guild_id: string }
} | null {
  if (!(event.channel && event.deleted_ts)) {
    return null
  }

  const channelId = resolveDiscordChannelId(
    event.channel,
    event.previous_message?.thread_ts,
    event.deleted_ts,
  )
  const messageId = encodeMessageId(event.channel, event.deleted_ts)

  return {
    eventName: GatewayDispatchEvents.MessageDelete,
    data: {
      id: messageId,
      channel_id: channelId,
      guild_id: guildId,
    },
  }
}

/**
 * Translate a Slack reaction event into MESSAGE_REACTION_ADD or REMOVE.
 */
export function translateReaction({
  event,
  guildId,
  threadTs,
}: {
  event: SlackReactionEvent
  guildId: string
  threadTs?: string
}): {
  eventName: string
  data: {
    user_id: string
    channel_id: string
    message_id: string
    guild_id: string
    emoji: { name: string; id: null }
  }
} {
  const messageId = encodeMessageId(event.item.channel, event.item.ts)
  const channelId = resolveDiscordChannelId(
    event.item.channel,
    threadTs,
    event.item.ts,
  )

  return {
    eventName:
      event.type === 'reaction_added'
        ? GatewayDispatchEvents.MessageReactionAdd
        : GatewayDispatchEvents.MessageReactionRemove,
    data: {
      user_id: event.user,
      channel_id: channelId,
      message_id: messageId,
      guild_id: guildId,
      emoji: { name: event.reaction, id: null },
    },
  }
}

/**
 * Translate a Slack channel_created event into CHANNEL_CREATE.
 */
export function translateChannelCreate({
  channelId,
  channelName,
  guildId,
}: {
  channelId: string
  channelName: string
  guildId: string
}): { eventName: string; data: APIChannel } {
  const channel: APIChannel = {
    id: channelId,
    type: ChannelType.GuildText,
    name: channelName,
    guild_id: guildId,
    position: 0,
  } as APIChannel

  return {
    eventName: GatewayDispatchEvents.ChannelCreate,
    data: channel,
  }
}

/**
 * Build a Discord APIChannel object for a Slack thread.
 * Used when a new thread is detected (first reply to a message).
 */
export function buildThreadChannel({
  parentChannel,
  threadTs,
  guildId,
  name,
}: {
  parentChannel: string
  threadTs: string
  guildId: string
  name?: string
}): APIChannel {
  const threadId = encodeThreadId(parentChannel, threadTs)
  return {
    id: threadId,
    type: ChannelType.PublicThread,
    name: name ?? `thread-${threadTs}`,
    guild_id: guildId,
    parent_id: parentChannel,
    message_count: 0,
    member_count: 0,
    thread_metadata: {
      archived: false,
      auto_archive_duration: 1440,
      archive_timestamp: slackTsToIso(threadTs),
      locked: false,
    },
  } as APIChannel
}
