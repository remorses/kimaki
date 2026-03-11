// Shared types for the discord-slack-bridge adapter.

export interface SlackBridgeConfig {
  /** Slack bot token (xoxb-...) */
  slackBotToken: string
  /** Optional Discord-facing client token (for example client_id:secret). */
  discordToken?: string
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
  /** Optional authorization callback for REST/Gateway and Slack inbound payloads. */
  authorize?: BridgeAuthorizeCallback
  /** Override Slack API base URL (for testing with slack-digital-twin) */
  slackApiUrl?: string
}

export type BridgeAuthorizeKind =
  | 'gateway-identify'
  | 'rest'
  | 'webhook-event'
  | 'webhook-action'

export interface BridgeAuthorizeContext {
  kind: BridgeAuthorizeKind
  token?: string
  teamId?: string
  request?: Request
  path?: string
  method?: string
}

export interface BridgeAuthorizeResult {
  allow: boolean
  clientId?: string
  authorizedTeamIds?: string[]
}

export type BridgeAuthorizeCallback = (
  context: BridgeAuthorizeContext,
) => Promise<BridgeAuthorizeResult>

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

export type SlackInteractiveUser = {
  id: string
  username?: string | undefined
  name?: string | undefined
}

export type SlackInteractiveChannel = {
  id?: string | undefined
}

export type SlackInteractiveMessage = {
  ts?: string | undefined
  thread_ts?: string | undefined
}

export type SlackInteractiveContainer = {
  channel_id?: string | undefined
  message_ts?: string | undefined
  thread_ts?: string | undefined
}

export type SlackInteractiveOption = {
  value?: string | undefined
}

export type SlackInteractiveActionPayload = {
  action_id: string
  type: string
  value?: string | undefined
  selected_option?: SlackInteractiveOption | undefined
  selected_options?: SlackInteractiveOption[] | undefined
  selected_user?: string | undefined
  selected_users?: string[] | undefined
  selected_channel?: string | undefined
  selected_channels?: string[] | undefined
  selected_conversation?: string | undefined
  selected_conversations?: string[] | undefined
}

export type SlackBlockActionsPayload = {
  type: 'block_actions'
  trigger_id?: string | undefined
  response_url?: string | undefined
  user: SlackInteractiveUser
  channel?: SlackInteractiveChannel | undefined
  message?: SlackInteractiveMessage | undefined
  container?: SlackInteractiveContainer | undefined
  actions: SlackInteractiveActionPayload[]
}

export type SlackViewSubmissionStateValue = {
  value?: string | undefined
  selected_option?: { value?: string | undefined } | undefined
  selected_user?: string | undefined
  selected_channel?: string | undefined
  selected_conversation?: string | undefined
}

export type SlackViewSubmissionPayload = {
  type: 'view_submission'
  trigger_id?: string | undefined
  user: SlackInteractiveUser
  response_url?: string | undefined
  view?: {
    id?: string | undefined
    callback_id?: string | undefined
    private_metadata?: string | undefined
    response_urls?: Array<{ response_url?: string | undefined }> | undefined
    state?: {
      values?: Record<string, Record<string, SlackViewSubmissionStateValue>> | undefined
    } | undefined
  } | undefined
}

export type SlackInteractivePayload =
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload

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
