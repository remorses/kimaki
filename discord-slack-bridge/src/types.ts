// Shared types for the discord-slack-bridge adapter.

export interface SlackBridgeConfig {
  /** Slack bot token (xoxb-...) */
  slackBotToken: string
  /** Slack signing secret for webhook verification */
  slackSigningSecret: string
  /** Slack workspace ID (T...) */
  workspaceId: string
  /** Port to listen on. Default 3710 */
  port?: number
  /** Override gateway URL returned by GET /gateway/bot (useful behind proxies) */
  gatewayUrlOverride?: string
  /** Optional public base URL used to derive REST/Gateway/Webhook URLs. */
  publicBaseUrl?: string
  /** Optional explicit REST URL override (without /v10 suffix). */
  restUrlOverride?: string
  /** Optional explicit webhook URL override (/slack/events endpoint). */
  webhookUrlOverride?: string
  /** Override Slack API base URL (for testing with slack-digital-twin) */
  slackApiUrl?: string
}

export type SupportedSlackEventType =
  | 'message'
  | 'app_mention'
  | 'reaction_added'
  | 'reaction_removed'
  | 'channel_created'
  | 'channel_deleted'
  | 'channel_rename'
  | 'member_joined_channel'

export interface NormalizedSlackMessage {
  user?: string
  botId?: string
  text?: string
  ts: string
  threadTs?: string
  editedTs?: string
  files?: NormalizedSlackFile[]
}

export interface NormalizedSlackFile {
  id: string
  name: string
  mimetype?: string
  urlPrivate?: string
  permalink?: string
  size?: number
}

export interface NormalizedSlackMessageEvent {
  type: 'message' | 'app_mention'
  subtype?: string
  channel: string
  user?: string
  botId?: string
  text?: string
  ts?: string
  threadTs?: string
  message?: NormalizedSlackMessage
  previousMessage?: NormalizedSlackMessage
  deletedTs?: string
  files?: NormalizedSlackFile[]
}

export interface NormalizedSlackReactionEvent {
  type: 'reaction_added' | 'reaction_removed'
  user: string
  reaction: string
  item: {
    type: string
    channel: string
    ts: string
  }
  item_user?: string
  event_ts?: string
}

export interface NormalizedSlackChannelCreatedEvent {
  type: 'channel_created'
  channelId: string
  channelName: string
}

export interface NormalizedSlackChannelDeletedEvent {
  type: 'channel_deleted'
  channelId: string
}

export interface NormalizedSlackChannelRenameEvent {
  type: 'channel_rename'
  channelId: string
  channelName: string
}

export interface NormalizedSlackMemberJoinedChannelEvent {
  type: 'member_joined_channel'
  userId: string
  channelId: string
}

export type NormalizedSlackEvent =
  | NormalizedSlackMessageEvent
  | NormalizedSlackReactionEvent
  | NormalizedSlackChannelCreatedEvent
  | NormalizedSlackChannelDeletedEvent
  | NormalizedSlackChannelRenameEvent
  | NormalizedSlackMemberJoinedChannelEvent

export type NormalizedSlackEventEnvelope =
  | { type: 'url_verification'; challenge: string }
  | { type: 'event_callback'; eventId?: string; event: NormalizedSlackEvent }

export type NormalizedSlackActionType =
  | 'button'
  | 'static_select'
  | 'multi_static_select'
  | 'users_select'
  | 'multi_users_select'
  | 'conversations_select'
  | 'multi_conversations_select'
  | 'channels_select'
  | 'multi_channels_select'

export interface NormalizedSlackAction {
  actionId: string
  type: NormalizedSlackActionType
  value?: string
  selectedOptionValue?: string
  selectedOptionValues: string[]
  selectedUser?: string
  selectedUsers: string[]
  selectedChannel?: string
  selectedChannels: string[]
  selectedConversation?: string
  selectedConversations: string[]
}

export interface NormalizedSlackBlockActionsPayload {
  type: 'block_actions'
  triggerId?: string
  responseUrl?: string
  user: { id: string; username?: string; name?: string }
  channelId?: string
  messageTs?: string
  threadTs?: string
  actions: NormalizedSlackAction[]
}

export interface NormalizedSlackViewSubmissionStateValue {
  blockId: string
  actionId: string
  value: string
}

export interface NormalizedSlackViewSubmissionPayload {
  type: 'view_submission'
  triggerId?: string
  responseUrl?: string
  user: { id: string; username?: string; name?: string }
  channelId?: string
  viewId?: string
  callbackId?: string
  privateMetadata?: string
  stateValues: NormalizedSlackViewSubmissionStateValue[]
}

export type NormalizedSlackInteractivePayload =
  | NormalizedSlackBlockActionsPayload
  | NormalizedSlackViewSubmissionPayload

/** Cached Slack user info for serialization */
export interface CachedSlackUser {
  id: string
  name: string
  realName: string
  isBot: boolean
  avatar?: string
}

/** Pending interaction waiting for discord.js to respond */
export interface PendingInteraction {
  id: string
  token: string
  channelId: string
  guildId: string
  triggerId?: string
  responseUrl?: string
  acknowledged: boolean
  /** Slack message ts for update-type responses */
  messageTs?: string
}
