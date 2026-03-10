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
}

/** Slack event envelope (Events API) */
export interface SlackEventEnvelope {
  token?: string
  team_id?: string
  api_app_id?: string
  event?: SlackEvent
  type: 'url_verification' | 'event_callback'
  challenge?: string
  event_id?: string
  event_time?: number
}

/** Slack message event */
export interface SlackEvent {
  type: string
  subtype?: string
  channel?: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  edited?: { user: string; ts: string }
  team?: string
  team_id?: string
  files?: SlackFile[]
  blocks?: SlackBlock[]
  /** For message_changed subtype */
  message?: SlackEvent
  /** For message_deleted subtype */
  previous_message?: SlackEvent
  deleted_ts?: string
}

export interface SlackFile {
  id: string
  name?: string
  title?: string
  mimetype?: string
  filetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
  permalink?: string
}

// Using unknown for blocks since the full Block Kit type is very complex
// and we pass them through as-is in most cases
export type SlackBlock = Record<string, unknown>

/** Slack reaction event */
export interface SlackReactionEvent {
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

/** Slack interactive payload (block_actions, view_submission, etc.) */
export interface SlackInteractivePayload {
  type: string
  trigger_id?: string
  user: { id: string; username?: string; name?: string }
  channel?: { id: string; name?: string }
  message?: { ts?: string; thread_ts?: string }
  container?: {
    type?: string
    channel_id?: string
    message_ts?: string
    thread_ts?: string
    is_ephemeral?: boolean
  }
  actions?: Array<{
    action_id: string
    block_id?: string
    type: string
    value?: string
    selected_option?: { value: string }
  }>
  view?: {
    id: string
    callback_id?: string
    private_metadata?: string
    state?: {
      values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>
    }
  }
  response_url?: string
}

/** Slack slash command payload (form-urlencoded fields) */
export interface SlackSlashCommand {
  command: string
  text: string
  user_id: string
  user_name: string
  channel_id: string
  channel_name: string
  team_id: string
  team_domain: string
  trigger_id: string
  response_url: string
}

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
