// Translates Discord REST API calls into Slack Web API calls.
// Each function takes Discord-shaped request data and calls the
// appropriate Slack method, then returns a Discord-shaped response.

import type {
  ChatDeleteArguments,
  ChatPostMessageArguments,
  ChatUpdateArguments,
  ConversationsArchiveArguments,
  ConversationsCreateArguments,
  ConversationsHistoryArguments,
  ConversationsInfoArguments,
  ConversationsListArguments,
  ConversationsRenameArguments,
  ConversationsRepliesArguments,
  ConversationsSetTopicArguments,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  ConversationsListResponse,
  ConversationsCreateResponse,
  ReactionsAddArguments,
  ReactionsRemoveArguments,
  UsergroupsListArguments,
  UsergroupsListResponse,
  UsersInfoArguments,
  UsersInfoResponse,
  UsersListArguments,
  UsersListResponse,
  ViewsOpenArguments,
  WebClient,
  WebAPIPlatformError,
} from '@slack/web-api'
import { ErrorCode } from '@slack/web-api'

// Extract nested types from Slack SDK response types via indexed access.
// These are not re-exported from @slack/web-api directly because they
// have colliding names across response modules (Channel, User, etc.).
type SlackChannel = NonNullable<ConversationsInfoResponse['channel']>
type SlackListChannel = NonNullable<ConversationsListResponse['channels']>[number]
type SlackMessage = NonNullable<ConversationsHistoryResponse['messages']>[number]
type SlackCreateChannel = NonNullable<ConversationsCreateResponse['channel']>
type SlackUser = NonNullable<UsersInfoResponse['user']>
type SlackMember = NonNullable<UsersListResponse['members']>[number]
type SlackUsergroup = NonNullable<UsergroupsListResponse['usergroups']>[number]
import {
  ChannelType,
  ComponentType,
  GuildMemberFlags,
  PermissionFlagsBits,
  MessageType,
  RoleFlags,
  ThreadMemberFlags,
  TextInputStyle,
} from 'discord-api-types/v10'
import type {
  APIAttachment,
  APIThreadList,
  APIThreadMember,
  APIMessage,
  APIUser,
  APIChannel,
  APIGuildMember,
  APIRole,
  APIActionRowComponent,
  APITextInputComponent,
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
    embeds?: unknown[]
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

  const postArgs = {
    channel,
    thread_ts: threadTs,
    text: fallbackText,
    blocks: blocks.length > 0 ? blocks : undefined,
    unfurl_links: false,
    unfurl_media: false,
  } satisfies ChatPostMessageArguments
  const result = await slack.chat.postMessage(postArgs)
  const messageTs = result.ts
  if (!messageTs) {
    throw new Error('Slack chat.postMessage response missing ts')
  }
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

  const updateArgs = {
    channel,
    ts,
    text,
    blocks: blocks.length > 0 ? blocks : undefined,
  } satisfies ChatUpdateArguments

  await slack.chat.update(updateArgs)

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

  const deleteArgs = {
    channel,
    ts,
  } satisfies ChatDeleteArguments

  await slack.chat.delete(deleteArgs)
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
    const repliesArgs = {
      channel,
      ts: threadTs,
      limit,
      latest: latestTs,
      oldest: oldestTs,
    } satisfies ConversationsRepliesArguments
    const result = await slack.conversations.replies(repliesArgs)

    return (result.messages ?? []).map((msg) => {
      return buildApiMessageFromSlack({
        msg,
        channel,
        channelId,
        botUserId,
        guildId,
      })
    })
  }

  // Channel: use conversations.history
  const historyArgs = {
    channel,
    limit,
    latest: latestTs,
    oldest: oldestTs,
  } satisfies ConversationsHistoryArguments
  const result = await slack.conversations.history(historyArgs)

  return (result.messages ?? []).map((msg) => {
    return buildApiMessageFromSlack({
      msg,
      channel,
      channelId,
      botUserId,
      guildId,
    })
  })
}

/**
 * GET /channels/:id/messages/:mid -> single message fetch.
 * Uses conversations.history (or conversations.replies for threads) with
 * oldest=ts, latest=ts, inclusive=true to fetch the exact target message
 * by its Slack timestamp.
 */
export async function getMessage({
  slack,
  channelId,
  messageId,
  botUserId,
  guildId,
}: {
  slack: WebClient
  channelId: string
  messageId: string
  botUserId: string
  guildId: string
}): Promise<APIMessage> {
  const { channel, threadTs } = resolveSlackTarget(channelId)

  const targetTs = isEncodedMessageId(messageId)
    ? decodeMessageId(messageId).ts
    : messageId

  if (threadTs) {
    // Thread message: use conversations.replies with inclusive range
    const repliesArgs = {
      channel,
      ts: threadTs,
      oldest: targetTs,
      latest: targetTs,
      inclusive: true,
      limit: 1,
    } satisfies ConversationsRepliesArguments
    const result = await slack.conversations.replies(repliesArgs)
    const msg = (result.messages ?? []).find((m) => {
      return m.ts === targetTs
    })
    if (msg) {
      return buildApiMessageFromSlack({
        msg,
        channel,
        channelId,
        botUserId,
        guildId,
      })
    }
    throw new MessageNotFoundError(messageId)
  }

  // Channel message: use conversations.history with inclusive range
  const historyArgs = {
    channel,
    oldest: targetTs,
    latest: targetTs,
    inclusive: true,
    limit: 1,
  } satisfies ConversationsHistoryArguments
  const result = await slack.conversations.history(historyArgs)
  const msg = (result.messages ?? []).find((m) => {
    return m.ts === targetTs
  })
  if (msg) {
    return buildApiMessageFromSlack({
      msg,
      channel,
      channelId,
      botUserId,
      guildId,
    })
  }
  throw new MessageNotFoundError(messageId)
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
    if (!threadTs) {
      throw new Error(`Thread channel ${channelId} resolved without threadTs`)
    }
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
        archive_timestamp: slackTsToIso(threadTs),
        locked: false,
      },
    }
  }

  const infoArgs = { channel: channelId } satisfies ConversationsInfoArguments
  const result = await slack.conversations.info(infoArgs)
  const ch = requireSlackChannelId(result.channel)

  return {
    id: ch.id,
    type: ChannelType.GuildText,
    name: ch.name ?? '',
    guild_id: guildId,
    topic: ch.topic?.value ?? null,
    position: 0,
  }
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
  const listArgs = {
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  } satisfies ConversationsListArguments
  const result = await slack.conversations.list(listArgs)

  return (result.channels ?? []).map((ch) => {
    const c = requireSlackChannelId(ch)
    return {
      id: c.id,
      type: ChannelType.GuildText,
      name: c.name ?? '',
      guild_id: guildId,
      topic: c.topic?.value ?? null,
      position: 0,
    }
  })
}

/**
 * PATCH /channels/:id -> conversations.rename / conversations.setTopic / archive
 */
export async function updateChannel({
  slack,
  channelId,
  body,
  guildId,
}: {
  slack: WebClient
  channelId: string
  body: { name?: string; topic?: string; archived?: boolean }
  guildId: string
}): Promise<APIChannel> {
  if (body.name) {
    const renameArgs = {
      channel: channelId,
      name: body.name,
    } satisfies ConversationsRenameArguments
    await slack.conversations.rename(renameArgs)
  }

  if (body.topic) {
    const topicArgs = {
      channel: channelId,
      topic: body.topic,
    } satisfies ConversationsSetTopicArguments
    await slack.conversations.setTopic(topicArgs)
  }

  if (body.archived === true) {
    const archiveArgs = {
      channel: channelId,
    } satisfies ConversationsArchiveArguments
    await slack.conversations.archive(archiveArgs)
  }

  return getChannel({
    slack,
    channelId,
    guildId,
  })
}

/**
 * POST /guilds/:id/channels -> conversations.create
 */
export async function createChannel({
  slack,
  guildId,
  body,
}: {
  slack: WebClient
  guildId: string
  body: { name: string; type?: ChannelType }
}): Promise<APIChannel> {
  const createArgs = {
    name: body.name,
    is_private: false,
  } satisfies ConversationsCreateArguments
  const result = await slack.conversations.create(createArgs)
  const channel = requireSlackChannelId(result.channel)

  return {
    id: channel.id,
    type: ChannelType.GuildText,
    name: channel.name ?? body.name,
    guild_id: guildId,
    topic: channel.topic?.value ?? null,
    position: 0,
  }
}

/**
 * GET /guilds/:id/members -> users.list
 */
export async function listGuildMembers({
  slack,
}: {
  slack: WebClient
}): Promise<APIGuildMember[]> {
  const args = {
    limit: 200,
  } satisfies UsersListArguments
  const result = await slack.users.list(args)

  return (result.members ?? [])
    .filter((member): member is SlackMember & { id: string } => {
      return !!member.id
    })
    .map((member) => {
      return {
        user: {
          id: member.id,
          username: member.name ?? member.id,
          discriminator: '0',
          avatar: member.profile?.image_72 ?? null,
          bot: member.is_bot ?? false,
          global_name: member.real_name ?? member.name ?? null,
        },
        roles: [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
        flags: GuildMemberFlags.CompletedOnboarding,
      }
    })
}

/**
 * GET /guilds/:id/members/:uid -> users.info
 */
export async function getGuildMember({
  slack,
  userId,
}: {
  slack: WebClient
  userId: string
}): Promise<APIGuildMember> {
  const user = await getUser({
    slack,
    userId,
  })

  return {
    user,
    roles: [],
    joined_at: new Date().toISOString(),
    deaf: false,
    mute: false,
    flags: GuildMemberFlags.CompletedOnboarding,
  }
}

/**
 * GET /guilds/:id/roles -> usergroups.list
 */
export async function listGuildRoles({
  slack,
}: {
  slack: WebClient
}): Promise<APIRole[]> {
  const args = {
    include_disabled: false,
    include_users: false,
  } satisfies UsergroupsListArguments
  const result = await slack.usergroups.list(args)

  return (result.usergroups ?? [])
    .filter((group): group is SlackUsergroup & { id: string; name: string } => {
      return !!(group.id && group.name)
    })
    .map((group) => {
    return {
      id: group.id,
      name: group.name,
      color: 0,
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position: 0,
      permissions: String(PermissionFlagsBits.ViewChannel),
      managed: true,
      mentionable: true,
      flags: RoleFlags.InPrompt,
    }
  })
}

/**
 * Type 9 interaction responses -> views.open
 */
export async function openModalView({
  slack,
  triggerId,
  modal,
}: {
  slack: WebClient
  triggerId: string
  modal: {
    custom_id?: string
    title?: string
    submit?: string
    cancel?: string
    components?: APIActionRowComponent<APITextInputComponent>[]
  }
}): Promise<void> {
  const blocks = (modal.components ?? [])
    .flatMap((row) => {
      return row.components
    })
    .filter((component): component is APITextInputComponent => {
      return component.type === ComponentType.TextInput
    })
    .map((textInput) => {
      return {
        type: 'input',
        block_id: textInput.custom_id,
        label: {
          type: 'plain_text',
          text: textInput.label,
        },
        element: {
          type: 'plain_text_input',
          action_id: textInput.custom_id,
          multiline: textInput.style === TextInputStyle.Paragraph,
          initial_value: textInput.value,
          placeholder: textInput.placeholder
            ? {
                type: 'plain_text',
                text: textInput.placeholder,
              }
            : undefined,
        },
        optional: textInput.required === false,
      }
    })

  const openArgs = {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: modal.custom_id ?? 'modal',
      title: {
        type: 'plain_text',
        text: modal.title ?? 'Modal',
      },
      submit: modal.submit
        ? {
            type: 'plain_text',
            text: modal.submit,
          }
        : undefined,
      close: modal.cancel
        ? {
            type: 'plain_text',
            text: modal.cancel,
          }
        : undefined,
      blocks,
    },
  } satisfies ViewsOpenArguments

  await slack.views.open(openArgs)
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

  const addArgs = {
    channel,
    timestamp: ts,
    name: emojiName,
  } satisfies ReactionsAddArguments
  await slack.reactions.add(addArgs)
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

  const removeArgs = {
    channel,
    timestamp: ts,
    name: emojiName,
  } satisfies ReactionsRemoveArguments
  await slack.reactions.remove(removeArgs)
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
  const userInfoArgs = { user: userId } satisfies UsersInfoArguments
  const result = await slack.users.info(userInfoArgs)
  const user = requireSlackUserId(result.user)

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
  const createThreadArgs = {
    channel: parentChannelId,
    text: body.name,
  } satisfies ChatPostMessageArguments
  const result = await slack.chat.postMessage(createThreadArgs)
  const threadTs = result.ts
  if (!threadTs) {
    throw new Error('Slack chat.postMessage response missing ts for thread creation')
  }
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
  }
}

export async function createThreadFromMessage({
  slack,
  parentChannelId,
  messageId,
  body,
  botUserId,
  guildId,
}: {
  slack: WebClient
  parentChannelId: string
  messageId: string
  body: { name: string; auto_archive_duration?: number }
  botUserId: string
  guildId: string
}): Promise<APIChannel> {
  const { channel } = resolveSlackTarget(parentChannelId)

  const threadTs = isEncodedMessageId(messageId)
    ? decodeMessageId(messageId).ts
    : messageId

  const repliesArgs = {
    channel,
    ts: threadTs,
    limit: 1,
    inclusive: true,
  } satisfies ConversationsRepliesArguments
  const replies = await slack.conversations.replies(repliesArgs)
  const hasParentMessage = (replies.messages ?? []).some((message) => {
    return message.ts === threadTs
  })
  if (!hasParentMessage) {
    throw new Error(`Unknown Message: ${messageId}`)
  }

  const threadChannelId = encodeThreadId(channel, threadTs)

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
  }
}

export async function listThreadMembers({
  slack,
  threadChannelId,
  botUserId,
}: {
  slack: WebClient
  threadChannelId: string
  botUserId: string
}): Promise<APIThreadMember[]> {
  const threadTarget = resolveThreadTarget({ threadChannelId })
  const parent = await fetchThreadParentMessage({
    slack,
    channel: threadTarget.channel,
    threadTs: threadTarget.threadTs,
    threadChannelId,
  })

  const repliesArgs = {
    channel: threadTarget.channel,
    ts: threadTarget.threadTs,
    inclusive: true,
    limit: 100,
  } satisfies ConversationsRepliesArguments
  const replies = await slack.conversations.replies(repliesArgs)
  const participants = [parent.user, parent.bot_id]
    .concat(
      (replies.messages ?? []).flatMap((message) => {
        return [message.user, message.bot_id]
      }),
    )
    .filter(isNonEmptyString)
    .map((participant) => {
      if (participant.startsWith('B')) {
        return botUserId
      }
      return participant
    })

  const uniqueParticipants = [...new Set(participants)]
  return uniqueParticipants.map((userId) => {
    return buildApiThreadMember({
      threadChannelId,
      userId,
      joinedAtTs: threadTarget.threadTs,
    })
  })
}

export async function getThreadMember({
  slack,
  threadChannelId,
  userId,
  botUserId,
}: {
  slack: WebClient
  threadChannelId: string
  userId: string
  botUserId: string
}): Promise<APIThreadMember> {
  const members = await listThreadMembers({
    slack,
    threadChannelId,
    botUserId,
  })
  const existing = members.find((member) => {
    return member.user_id === userId
  })
  if (existing) {
    return existing
  }

  const { threadTs } = resolveThreadTarget({ threadChannelId })
  return buildApiThreadMember({
    threadChannelId,
    userId,
    joinedAtTs: threadTs,
  })
}

export async function joinThreadMember({
  slack,
  threadChannelId,
  userId,
}: {
  slack: WebClient
  threadChannelId: string
  userId: string
}): Promise<void> {
  const target = resolveThreadTarget({ threadChannelId })
  await fetchThreadParentMessage({
    slack,
    channel: target.channel,
    threadTs: target.threadTs,
    threadChannelId,
  })
  void userId
}

export async function leaveThreadMember({
  slack,
  threadChannelId,
  userId,
}: {
  slack: WebClient
  threadChannelId: string
  userId: string
}): Promise<void> {
  const target = resolveThreadTarget({ threadChannelId })
  await fetchThreadParentMessage({
    slack,
    channel: target.channel,
    threadTs: target.threadTs,
    threadChannelId,
  })
  void userId
}

export async function getActiveThreads({
  slack,
  guildId,
  botUserId,
}: {
  slack: WebClient
  guildId: string
  botUserId: string
}): Promise<APIThreadList> {
  const listArgs = {
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  } satisfies ConversationsListArguments
  const listed = await slack.conversations.list(listArgs)
  const channels = (listed.channels ?? []).filter((channel) => {
    return Boolean(channel.id)
  })

  const threadMap = new Map<string, APIChannel>()
  const memberMap = new Map<string, APIThreadMember>()

  for (const channel of channels) {
    const channelId = channel.id
    if (!channelId) {
      continue
    }
    const historyArgs = {
      channel: channelId,
      limit: 50,
    } satisfies ConversationsHistoryArguments
    const history = await slack.conversations.history(historyArgs)
    const parentCandidates = (history.messages ?? []).filter((message) => {
      return Boolean(message.ts)
    })

    for (const parent of parentCandidates) {
      const parentTs = parent.ts
      if (!parentTs) {
        continue
      }
      const repliesArgs = {
        channel: channelId,
        ts: parentTs,
        inclusive: true,
        limit: 2,
      } satisfies ConversationsRepliesArguments
      const replies = await slack.conversations.replies(repliesArgs)
      const replyMessages = replies.messages ?? []
      if (replyMessages.length < 2) {
        continue
      }

      const threadChannelId = encodeThreadId(channelId, parentTs)
      if (!threadMap.has(threadChannelId)) {
        const threadName = (() => {
          const rawText = parent.text?.trim()
          if (rawText) {
            return rawText.slice(0, 80)
          }
          return `thread-${parentTs}`
        })()
        threadMap.set(threadChannelId, {
          id: threadChannelId,
          type: ChannelType.PublicThread,
          name: threadName,
          guild_id: guildId,
          parent_id: channelId,
          owner_id: parent.user ?? parent.bot_id ?? botUserId,
          message_count: Math.max(0, replyMessages.length - 1),
          member_count: new Set(
            replyMessages
              .flatMap((message) => {
                return [message.user, message.bot_id]
              })
              .filter(isNonEmptyString),
          ).size,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: slackTsToIso(parentTs),
            locked: false,
          },
        })
      }

      const participants = replyMessages
        .flatMap((message) => {
          return [message.user, message.bot_id]
        })
        .filter(isNonEmptyString)
      for (const participant of participants) {
        const key = `${threadChannelId}:${participant}`
        if (memberMap.has(key)) {
          continue
        }
        memberMap.set(
          key,
          buildApiThreadMember({
            threadChannelId,
            userId: participant,
            joinedAtTs: parentTs,
          }),
        )
      }
    }
  }

  return {
    threads: [...threadMap.values()],
    members: [...memberMap.values()],
  }
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

function mapSlackFilesToDiscordAttachments(
  files: SlackMessage['files'] | undefined,
): APIAttachment[] {
  const slackFiles = files ?? []
  return slackFiles
    .map((file) => {
      if (!file?.id || !file.name) {
        return undefined
      }
      const attachmentUrl = file.url_private ?? file.permalink ?? ''
      return {
        id: file.id,
        filename: file.name,
        size: file.size ?? 0,
        url: attachmentUrl,
        proxy_url: attachmentUrl,
        content_type: file.mimetype,
      } satisfies APIAttachment
    })
    .filter(isDefined)
}

function buildApiThreadMember({
  threadChannelId,
  userId,
  joinedAtTs,
}: {
  threadChannelId: string
  userId: string
  joinedAtTs: string
}): APIThreadMember {
  return {
    id: threadChannelId,
    user_id: userId,
    join_timestamp: slackTsToIso(joinedAtTs),
    flags: noFlags<ThreadMemberFlags>(),
  }
}

function noFlags<T>(): T {
  return 0 as T
}

function resolveThreadTarget({
  threadChannelId,
}: {
  threadChannelId: string
}): { channel: string; threadTs: string } {
  if (!isThreadChannelId(threadChannelId)) {
    throw new UnknownChannelError(threadChannelId)
  }
  const resolved = (() => {
    try {
      return resolveSlackTarget(threadChannelId)
    } catch {
      throw new UnknownChannelError(threadChannelId)
    }
  })()
  if (!resolved.threadTs) {
    throw new UnknownChannelError(threadChannelId)
  }
  return {
    channel: resolved.channel,
    threadTs: resolved.threadTs,
  }
}

async function fetchThreadParentMessage({
  slack,
  channel,
  threadTs,
  threadChannelId,
}: {
  slack: WebClient
  channel: string
  threadTs: string
  threadChannelId: string
}): Promise<SlackMessage> {
  const repliesArgs = {
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 1,
  } satisfies ConversationsRepliesArguments
  const replies = await slack.conversations.replies(repliesArgs)
  const parent = (replies.messages ?? []).find((message) => {
    return message.ts === threadTs
  })
  if (!parent) {
    throw new UnknownChannelError(threadChannelId)
  }
  return parent
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function buildApiMessageFromSlack({
  msg,
  channel,
  channelId,
  botUserId,
  guildId,
}: {
  msg: SlackMessage
  channel: string
  channelId: string
  botUserId: string
  guildId: string
}): APIMessage {
  const msgTs = msg.ts ?? ''
  const msgUser = msg.user ?? botUserId
  const msgText = msg.text ?? ''

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
    attachments: mapSlackFilesToDiscordAttachments(msg.files),
    embeds: [],
    pinned: false,
    type: MessageType.Default,
  }
}



function requireSlackChannelId(
  channel: SlackChannel | SlackListChannel | SlackCreateChannel | undefined,
): { id: string; name?: string; topic?: { value?: string }; is_private?: boolean } {
  if (!channel?.id) {
    throw new Error('Slack channel payload missing id')
  }
  return {
    id: channel.id,
    name: channel.name,
    topic: channel.topic
      ? { value: channel.topic.value }
      : undefined,
    is_private: 'is_private' in channel ? channel.is_private : undefined,
  }
}

function requireSlackUserId(
  user: SlackUser | SlackMember | undefined,
): { id: string; name?: string; real_name?: string; is_bot?: boolean; profile?: { image_72?: string } } {
  if (!user?.id) {
    throw new Error('Slack user payload missing id')
  }
  return {
    id: user.id,
    name: user.name,
    real_name: user.real_name,
    is_bot: user.is_bot,
    profile: user.profile
      ? { image_72: user.profile.image_72 }
      : undefined,
  }
}

// ---- Discord-shaped errors ----

/**
 * Bridge error that maps to a specific Discord REST API error shape.
 * Route handlers catch these and return { code, message } JSON with the
 * appropriate HTTP status.
 */
export class DiscordApiError extends Error {
  readonly httpStatus: number
  readonly discordCode: number

  constructor({
    httpStatus,
    discordCode,
    message,
  }: {
    httpStatus: number
    discordCode: number
    message: string
  }) {
    super(message)
    this.httpStatus = httpStatus
    this.discordCode = discordCode
  }

  toResponse(): Response {
    return Response.json(
      { code: this.discordCode, message: this.message },
      { status: this.httpStatus },
    )
  }
}

export class MessageNotFoundError extends DiscordApiError {
  constructor(messageId: string) {
    super({
      httpStatus: 404,
      discordCode: 10008,
      message: `Unknown Message: ${messageId}`,
    })
  }
}

export class UnknownChannelError extends DiscordApiError {
  constructor(channelId: string) {
    super({
      httpStatus: 404,
      discordCode: 10003,
      message: `Unknown Channel: ${channelId}`,
    })
  }
}

export class UnknownGuildError extends DiscordApiError {
  constructor(guildId: string) {
    super({
      httpStatus: 404,
      discordCode: 10004,
      message: `Unknown Guild: ${guildId}`,
    })
  }
}

export class MissingAccessError extends DiscordApiError {
  constructor() {
    super({
      httpStatus: 403,
      discordCode: 50001,
      message: 'Missing Access',
    })
  }
}

export class MissingPermissionsError extends DiscordApiError {
  constructor(message = 'Missing Permissions') {
    super({
      httpStatus: 403,
      discordCode: 50013,
      message,
    })
  }
}

/**
 * Maps a Slack API error (from WebClient) to a DiscordApiError.
 * Slack errors have a `data.error` string like "channel_not_found".
 */
export function mapSlackErrorToDiscordError(err: unknown): DiscordApiError {
  const slackErrorContext = extractSlackErrorContext(err)
  const slackError = slackErrorContext.code
  switch (slackError) {
    case 'invalid_auth':
    case 'not_authed':
    case 'account_inactive':
    case 'token_revoked':
      return new DiscordApiError({
        httpStatus: 401,
        discordCode: 50014,
        message: 'Invalid authentication token',
      })
    case 'channel_not_found':
      return new UnknownChannelError('unknown')
    case 'message_not_found':
    case 'thread_not_found':
      return new MessageNotFoundError('unknown')
    case 'not_in_channel':
      return new MissingAccessError()
    case 'no_permission':
    case 'cant_update_message':
    case 'cant_delete_message':
    case 'not_allowed_token_type':
      return new MissingPermissionsError()
    case 'missing_scope': {
      const scopeMessage = slackErrorContext.needed
        ? `Missing Permissions (Slack missing scope: ${slackErrorContext.needed})`
        : 'Missing Permissions (Slack missing required scope)'
      return new MissingPermissionsError(scopeMessage)
    }
    case 'is_archived':
      return new DiscordApiError({
        httpStatus: 403,
        discordCode: 50001,
        message: 'Channel is archived',
      })
    default:
      return new DiscordApiError({
        httpStatus: 500,
        discordCode: 0,
        message: `Slack API error: ${slackError || 'unknown'}`,
      })
  }
}

/** Extract the error code string from a Slack WebClient error. */
function extractSlackErrorCode(err: unknown): string | undefined {
  return extractSlackErrorContext(err).code
}

function extractSlackErrorContext(err: unknown): {
  code?: string
  needed?: string
  provided?: string
} {
  if (!(err instanceof Error)) {
    return {}
  }

  const platformError = isWebApiPlatformError(err) ? err : undefined
  const code = platformError?.data.error
  const needed = platformError
    ? readOptionalString(Reflect.get(platformError.data, 'needed'))
    : undefined
  const provided = platformError
    ? readOptionalString(Reflect.get(platformError.data, 'provided'))
    : undefined
  if (code) {
    return {
      code,
      needed,
      provided,
    }
  }

  // Some errors embed the code in the message like "An API error occurred: channel_not_found"
  const match = err.message.match(/An API error occurred: (\S+)/)
  return {
    code: match?.[1],
  }
}

function isWebApiPlatformError(error: Error): error is WebAPIPlatformError {
  if (!('code' in error)) {
    return false
  }
  if (error.code !== ErrorCode.PlatformError) {
    return false
  }
  if (!('data' in error)) {
    return false
  }

  const data = error.data
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string'
  )
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
