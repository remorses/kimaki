// Slack API types for the digital twin server.
// These mirror the shapes returned by the Slack Web API.

export interface SlackApiResponse {
  ok: boolean
  error?: string
}

export interface SlackUser {
  id: string
  team_id: string
  name: string
  real_name: string
  is_bot: boolean
  profile: {
    image_48?: string
    real_name?: string
    display_name?: string
  }
}

export interface SlackChannel {
  id: string
  name: string
  is_channel: boolean
  is_private: boolean
  is_archived: boolean
  topic: { value: string }
  purpose: { value: string }
  created: number
  num_members?: number
}

export interface SlackMessage {
  type: 'message'
  user?: string
  bot_id?: string
  text: string
  ts: string
  thread_ts?: string
  edited?: { user: string; ts: string }
  blocks?: SlackBlock[]
  attachments?: SlackAttachment[]
  files?: SlackFile[]
  reactions?: SlackReaction[]
}

export interface SlackBlock {
  type: string
  block_id?: string
  [key: string]: unknown
}

export interface SlackAttachment {
  [key: string]: unknown
}

export interface SlackFile {
  id: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  url_private: string
  url_private_download: string
  permalink: string
}

export interface SlackReaction {
  name: string
  users: string[]
  count: number
}

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
  blocks?: SlackBlock[]
  // Reaction events
  reaction?: string
  item?: { type: string; channel: string; ts: string }
  item_user?: string
  event_ts?: string
}
