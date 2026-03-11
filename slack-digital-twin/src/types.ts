// Slack API types for the digital twin server.
// Response types (User, Channel, Message, Reaction, File) are extracted from
// the official @slack/web-api SDK response types to guarantee shape compliance.
// Events API envelope types stay custom — they represent inbound webhook
// payloads that aren't modeled by the SDK's response types.

import type {
  ConversationsHistoryResponse,
  ConversationsListResponse,
  UsersInfoResponse,
} from '@slack/web-api'
import type { Block, KnownBlock } from '@slack/types'

// --- SDK response types (extracted from top-level response interfaces) ---
// The inner interfaces (MessageElement, Channel, User, etc.) are not
// re-exported from @slack/web-api's main index, so we extract them with
// NonNullable<T>[number] from the response arrays / fields.

export type SlackUser = NonNullable<UsersInfoResponse['user']>
export type SlackChannel = NonNullable<ConversationsListResponse['channels']>[number]
export type SlackMessage = NonNullable<ConversationsHistoryResponse['messages']>[number]
export type SlackReaction = NonNullable<SlackMessage['reactions']>[number]
export type SlackFile = NonNullable<SlackMessage['files']>[number]
export type SlackEdited = NonNullable<SlackMessage['edited']>

// --- Events API types (custom — not in the SDK response types) ---

// Slack Events API envelope posted to webhook endpoints
export interface SlackEventEnvelope {
  type: 'event_callback' | 'url_verification'
  token?: string
  team_id?: string
  api_app_id?: string
  event?: SlackEventPayload
  challenge?: string
  event_id?: string
  event_time?: number
}

export interface SlackEventPayload {
  type: string
  subtype?: string
  channel?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  edited?: { user: string; ts: string }
  message?: SlackEventPayload
  previous_message?: SlackEventPayload
  deleted_ts?: string
  files?: SlackFile[]
  blocks?: (KnownBlock | Block)[]
  // Reaction events
  reaction?: string
  item?: { type: string; channel: string; ts: string }
  item_user?: string
  event_ts?: string
}

export type SlackOpenedView = {
  trigger_id?: string
  view?: {
    callback_id?: string
    private_metadata?: string
    title?: {
      type?: string
      text?: string
    }
    blocks?: unknown[]
    [key: string]: unknown
  }
}

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
  text?: { text?: string | undefined } | undefined
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

export type SlackBlockSuggestionPayload = {
  type: 'block_suggestion'
  user: SlackInteractiveUser
  action_id?: string | undefined
  value?: string | undefined
  channel?: SlackInteractiveChannel | undefined
  view?: {
    id?: string | undefined
    callback_id?: string | undefined
    private_metadata?: string | undefined
  } | undefined
}

export type SlackInteractivePayload =
  | SlackBlockActionsPayload
  | SlackBlockSuggestionPayload
  | SlackViewSubmissionPayload
