// Translates Discord REST API calls into Slack Web API calls.
// Each function takes Discord-shaped request data and calls the
// appropriate Slack method, then returns a Discord-shaped response.

import type { WebClient } from '@slack/web-api'
import {
  ChannelType,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIMessage,
  APIUser,
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIEmbed,
} from 'discord-api-types/v10'
import {
  encodeMessageId,
  encodeThreadId,
  decodeMessageId,
  resolveSlackTarget,
  slackTsToIso,
  isThreadChannelId,
  isEncodedMessageId,
} from './id-converter.js'
import { markdownToMrkdwn, mrkdwnToMarkdown } from './format-converter.js'
import { componentsToBlocks } from './component-converter.js'
import {
  uploadAttachmentsToSlack,
  type DiscordAttachment,
} from './file-upload.js'

// ---- Messages ----

/**
 * POST /channels/:id/messages -> chat.postMessage
 * Handles content, components (converted to Block Kit), and file attachments.
 */
export async function postMessage({
  slack,
  channelId,
  body,
  botUserId,
  guildId,
}: {
  slack: WebClient
  channelId: string
  body: {
    content?: string
    embeds?: APIEmbed[]
    components?: unknown[]
    attachments?: DiscordAttachment[]
  }
  botUserId: string
  guildId: string
}): Promise<APIMessage> {
  const { channel, threadTs } = resolveSlackTarget(channelId)

  // Upload file attachments first (Slack shares them to the channel)
  if (body.attachments && body.attachments.length > 0) {
    await uploadAttachmentsToSlack({
      slack,
      attachments: body.attachments,
      channel,
      threadTs,
    })
  }

  const text = markdownToMrkdwn(body.content ?? '')

  // Convert Discord components to Slack Block Kit blocks
  const blocks = body.components
    ? componentsToBlocks(body.components)
    : []

  // Slack's chat.postMessage has strict discriminated union types.
  // We build the args object matching the text+channel shape.
  const fallbackText = text || (blocks.length > 0 ? '(message with components)' : ' ')

  const result = await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: fallbackText,
    blocks: blocks.length > 0 ? blocks : undefined,
    unfurl_links: false,
    unfurl_media: false,
  })

  const messageTs = result.ts as string
  const messageId = encodeMessageId(channel, messageTs)

  return buildApiMessage({
    messageId,
    channelId,
    ts: messageTs,
    content: body.content ?? '',
    botUserId,
    guildId,
  })
}

/**
 * PATCH /channels/:id/messages/:mid -> chat.update
 */
export async function editMessage({
  slack,
  channelId,
  messageId,
  body,
  botUserId,
  guildId,
}: {
  slack: WebClient
  channelId: string
  messageId: string
  body: { content?: string; components?: unknown[] }
  botUserId: string
  guildId: string
}): Promise<APIMessage> {
  const { channel } = resolveSlackTarget(channelId)

  let ts: string
  if (isEncodedMessageId(messageId)) {
    const decoded = decodeMessageId(messageId)
    ts = decoded.ts
  } else {
    ts = messageId
  }

  const text = markdownToMrkdwn(body.content ?? '')
  const blocks = body.components
    ? componentsToBlocks(body.components)
    : []

  await slack.chat.update({
    channel,
    ts,
    text,
    blocks: blocks.length > 0 ? blocks : undefined,
  })

  return buildApiMessage({
    messageId,
    channelId,
    ts,
    content: body.content ?? '',
    botUserId,
    guildId,
    edited: true,
  })
}

/**
 * DELETE /channels/:id/messages/:mid -> chat.delete
 */
export async function deleteMessage({
  slack,
  channelId,
  messageId,
}: {
  slack: WebClient
  channelId: string
  messageId: string
}): Promise<void> {
  const { channel } = resolveSlackTarget(channelId)

  let ts: string
  if (isEncodedMessageId(messageId)) {
    const decoded = decodeMessageId(messageId)
    ts = decoded.ts
  } else {
    ts = messageId
  }

  await slack.chat.delete({
    channel,
    ts,
  })
}

/**
 * GET /channels/:id/messages -> conversations.history or conversations.replies
 */
export async function getMessages({
  slack,
  channelId,
  query,
  botUserId,
  guildId,
}: {
  slack: WebClient
  channelId: string
  query: { limit?: string; before?: string; after?: string }
  botUserId: string
  guildId: string
}): Promise<APIMessage[]> {
  const { channel, threadTs } = resolveSlackTarget(channelId)
  const limit = query.limit ? Number.parseInt(query.limit, 10) : 50

  // Discord uses snowflake-based before/after cursors.
  // Our message IDs encode Slack timestamps, so we can extract them.
  // If the cursor isn't an encoded ID (e.g. raw snowflake), ignore it.
  const latestTs = (() => {
    if (!query.before) {
      return undefined
    }
    try {
      return decodeMessageId(query.before).ts
    } catch {
      return undefined
    }
  })()

  const oldestTs = (() => {
    if (!query.after) {
      return undefined
    }
    try {
      return decodeMessageId(query.after).ts
    } catch {
      return undefined
    }
  })()

  if (threadTs) {
    // Thread: use conversations.replies
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit,
      latest: latestTs,
      oldest: oldestTs,
    })

    return (result.messages ?? []).map((msg) => {
      return buildApiMessageFromSlack({
        msg: msg as unknown as Record<string, unknown>,
        channel,
        channelId,
        botUserId,
        guildId,
      })
    })
  }

  // Channel: use conversations.history
  const result = await slack.conversations.history({
    channel,
    limit,
    latest: latestTs,
    oldest: oldestTs,
  })

  return (result.messages ?? []).map((msg) => {
    return buildApiMessageFromSlack({
      msg: msg as unknown as Record<string, unknown>,
      channel,
      channelId,
      botUserId,
      guildId,
    })
  })
}

// ---- Channels ----

/**
 * GET /channels/:id -> conversations.info
 */
export async function getChannel({
  slack,
  channelId,
  guildId,
}: {
  slack: WebClient
  channelId: string
  guildId: string
}): Promise<APIChannel> {
  if (isThreadChannelId(channelId)) {
    const { channel, threadTs } = resolveSlackTarget(channelId)
    // For threads, build a synthetic channel object
    return {
      id: channelId,
      type: ChannelType.PublicThread,
      name: `thread-${threadTs}`,
      guild_id: guildId,
      parent_id: channel,
      message_count: 0,
      member_count: 0,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 1440,
        archive_timestamp: slackTsToIso(threadTs!),
        locked: false,
      },
    } as APIChannel
  }

  const result = await slack.conversations.info({ channel: channelId })
  const ch = result.channel as {
    id: string
    name?: string
    topic?: { value?: string }
    is_archived?: boolean
    is_private?: boolean
  }

  return {
    id: ch.id,
    type: ch.is_private ? ChannelType.GuildText : ChannelType.GuildText,
    name: ch.name ?? '',
    guild_id: guildId,
    topic: ch.topic?.value ?? null,
    position: 0,
  } as APIChannel
}

/**
 * GET /guilds/:id/channels -> conversations.list
 */
export async function listChannels({
  slack,
  guildId,
}: {
  slack: WebClient
  guildId: string
}): Promise<APIChannel[]> {
  const result = await slack.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  })

  return (result.channels ?? []).map((ch) => {
    const c = ch as {
      id: string
      name?: string
      topic?: { value?: string }
      is_private?: boolean
    }
    return {
      id: c.id,
      type: c.is_private ? ChannelType.GuildText : ChannelType.GuildText,
      name: c.name ?? '',
      guild_id: guildId,
      topic: c.topic?.value ?? null,
      position: 0,
    } as APIChannel
  })
}

// ---- Reactions ----

/**
 * PUT /channels/:id/messages/:mid/reactions/:emoji/@me -> reactions.add
 */
export async function addReaction({
  slack,
  channelId,
  messageId,
  emoji,
}: {
  slack: WebClient
  channelId: string
  messageId: string
  emoji: string
}): Promise<void> {
  const { channel } = resolveSlackTarget(channelId)

  let ts: string
  if (isEncodedMessageId(messageId)) {
    const decoded = decodeMessageId(messageId)
    ts = decoded.ts
  } else {
    ts = messageId
  }

  // Remove colons and skin tone modifiers for Slack API
  const emojiName = emoji.replace(/:/g, '').split('~')[0]!

  await slack.reactions.add({
    channel,
    timestamp: ts,
    name: emojiName,
  })
}

/**
 * DELETE /channels/:id/messages/:mid/reactions/:emoji/@me -> reactions.remove
 */
export async function removeReaction({
  slack,
  channelId,
  messageId,
  emoji,
}: {
  slack: WebClient
  channelId: string
  messageId: string
  emoji: string
}): Promise<void> {
  const { channel } = resolveSlackTarget(channelId)

  let ts: string
  if (isEncodedMessageId(messageId)) {
    const decoded = decodeMessageId(messageId)
    ts = decoded.ts
  } else {
    ts = messageId
  }

  const emojiName = emoji.replace(/:/g, '').split('~')[0]!

  await slack.reactions.remove({
    channel,
    timestamp: ts,
    name: emojiName,
  })
}

// ---- Users ----

/**
 * GET /users/:id -> users.info
 */
export async function getUser({
  slack,
  userId,
}: {
  slack: WebClient
  userId: string
}): Promise<APIUser> {
  const result = await slack.users.info({ user: userId })
  const user = result.user as {
    id: string
    name?: string
    real_name?: string
    is_bot?: boolean
    profile?: { image_72?: string }
  }

  return {
    id: user.id,
    username: user.name ?? 'unknown',
    discriminator: '0',
    avatar: user.profile?.image_72 ?? null,
    bot: user.is_bot ?? false,
    global_name: user.real_name ?? user.name ?? null,
  }
}

// ---- Threads ----

/**
 * POST /channels/:id/threads -> post first message to create Slack thread
 */
export async function createThread({
  slack,
  parentChannelId,
  body,
  botUserId,
  guildId,
}: {
  slack: WebClient
  parentChannelId: string
  body: { name: string; auto_archive_duration?: number }
  botUserId: string
  guildId: string
}): Promise<APIChannel> {
  // In Slack, creating a thread = posting a message.
  // The message's ts becomes the thread_ts for all replies.
  const result = await slack.chat.postMessage({
    channel: parentChannelId,
    text: body.name,
  })

  const threadTs = result.ts as string
  const threadChannelId = encodeThreadId(parentChannelId, threadTs)

  return {
    id: threadChannelId,
    type: ChannelType.PublicThread,
    name: body.name,
    guild_id: guildId,
    parent_id: parentChannelId,
    owner_id: botUserId,
    message_count: 0,
    member_count: 1,
    thread_metadata: {
      archived: false,
      auto_archive_duration: body.auto_archive_duration ?? 1440,
      archive_timestamp: slackTsToIso(threadTs),
      locked: false,
    },
  } as APIChannel
}

// ---- Helpers ----

function buildApiMessage({
  messageId,
  channelId,
  ts,
  content,
  botUserId,
  guildId,
  edited,
}: {
  messageId: string
  channelId: string
  ts: string
  content: string
  botUserId: string
  guildId: string
  edited?: boolean
}): APIMessage {
  return {
    id: messageId,
    channel_id: channelId,
    author: {
      id: botUserId,
      username: 'bot',
      discriminator: '0',
      avatar: null,
      global_name: null,
    },
    content,
    timestamp: slackTsToIso(ts),
    edited_timestamp: edited ? new Date().toISOString() : null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
  }
}

function buildApiMessageFromSlack({
  msg,
  channel,
  channelId,
  botUserId,
  guildId,
}: {
  msg: Record<string, unknown>
  channel: string
  channelId: string
  botUserId: string
  guildId: string
}): APIMessage {
  const msgTs = (msg.ts as string) ?? ''
  const msgUser = (msg.user as string) ?? botUserId
  const msgText = (msg.text as string) ?? ''

  return {
    id: encodeMessageId(channel, msgTs),
    channel_id: channelId,
    author: {
      id: msgUser,
      username: msgUser,
      discriminator: '0',
      avatar: null,
      global_name: null,
    },
    content: mrkdwnToMarkdown(msgText),
    timestamp: slackTsToIso(msgTs),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
  }
}
