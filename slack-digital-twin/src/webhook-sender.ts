// Sends signed Slack Events API payloads to a webhook endpoint.
// Used to simulate Slack → your app event delivery.
// Signs payloads with HMAC-SHA256 matching Slack's signature verification.

import crypto from 'node:crypto'
import type { SlackEventEnvelope, SlackEventPayload } from './types.js'

export interface WebhookSenderConfig {
  webhookUrl: string
  signingSecret: string
  workspaceId: string
}

// Sign and POST an Events API envelope to the configured webhook URL.
// Mirrors Slack's signing: HMAC-SHA256 of "v0:{timestamp}:{body}".
export async function sendWebhookEvent({
  config,
  event,
}: {
  config: WebhookSenderConfig
  event: SlackEventPayload
}): Promise<Response> {
  const envelope: SlackEventEnvelope = {
    type: 'event_callback',
    token: 'test-verification-token',
    team_id: config.workspaceId,
    api_app_id: 'A0001',
    event,
    event_id: `Ev${Date.now()}`,
    event_time: Math.floor(Date.now() / 1000),
  }

  return sendSignedPayload({ config, body: JSON.stringify(envelope) })
}

// Send a slash command as form-urlencoded (matching Slack's format).
export async function sendSlashCommand({
  config,
  command,
  text,
  userId,
  userName,
  channelId,
  channelName,
  triggerId,
}: {
  config: WebhookSenderConfig
  command: string
  text: string
  userId: string
  userName: string
  channelId: string
  channelName: string
  triggerId?: string
}): Promise<Response> {
  const params = new URLSearchParams({
    command,
    text,
    user_id: userId,
    user_name: userName,
    channel_id: channelId,
    channel_name: channelName,
    team_id: config.workspaceId,
    team_domain: 'test-workspace',
    trigger_id: triggerId ?? `${Date.now()}.${userId}`,
    response_url: `${config.webhookUrl}/response`,
  })

  return sendSignedPayload({
    config,
    body: params.toString(),
    contentType: 'application/x-www-form-urlencoded',
  })
}

// Send an interactive payload (button click, modal submit) as form-urlencoded.
export async function sendInteractivePayload({
  config,
  payload,
}: {
  config: WebhookSenderConfig
  payload: Record<string, unknown>
}): Promise<Response> {
  const params = new URLSearchParams({
    payload: JSON.stringify(payload),
  })

  return sendSignedPayload({
    config,
    body: params.toString(),
    contentType: 'application/x-www-form-urlencoded',
  })
}

async function sendSignedPayload({
  config,
  body,
  contentType = 'application/json',
}: {
  config: WebhookSenderConfig
  body: string
  contentType?: string
}): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const sigBasestring = `v0:${timestamp}:${body}`
  const signature =
    'v0=' +
    crypto
      .createHmac('sha256', config.signingSecret)
      .update(sigBasestring)
      .digest('hex')

  return fetch(config.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  })
}
