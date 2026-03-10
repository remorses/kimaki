// HTTP server for the discord-slack-bridge.
// Exposes two sets of routes on the same port:
//   1. /api/v10/* — Discord REST routes consumed by discord.js
//   2. /slack/events — Slack webhook receiver for Events API + interactions
//
// Also hosts the WebSocket gateway at /gateway for discord.js Gateway.

import crypto from 'node:crypto'
import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebClient } from '@slack/web-api'
import { Spiceflow } from 'spiceflow'
import { GatewayDispatchEvents, GuildMemberFlags } from 'discord-api-types/v10'
import type { APIChannel, APIGuild } from 'discord-api-types/v10'
import { SlackBridgeGateway, type GatewayState } from './gateway.js'
import * as rest from './rest-translator.js'
import * as events from './event-translator.js'
import type {
  SlackEventEnvelope,
  SlackEvent,
  SlackReactionEvent,
  SlackInteractivePayload,
  CachedSlackUser,
  PendingInteraction,
} from './types.js'

export interface ServerConfig {
  slack: WebClient
  botUserId: string
  botUsername: string
  botToken: string
  signingSecret: string
  workspaceId: string
  port: number
  gatewayUrlOverride?: string
}

export interface ServerComponents {
  httpServer: http.Server
  gateway: SlackBridgeGateway
  app: Spiceflow
}

// User cache: avoids hitting Slack users.info API on every inbound event.
// TTL 1 hour, max 500 entries.
const USER_CACHE_TTL_MS = 60 * 60 * 1000
const USER_CACHE_MAX = 500
const userCache = new Map<string, { user: CachedSlackUser; expiresAt: number }>()

/**
 * Look up a Slack user with caching.
 * Falls back to the user ID as username if lookup fails.
 */
async function lookupUser(
  slack: WebClient,
  userId: string,
): Promise<CachedSlackUser> {
  const cached = userCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user
  }

  try {
    const result = await slack.users.info({ user: userId })
    const user = result.user as {
      id: string
      name?: string
      real_name?: string
      is_bot?: boolean
      profile?: { image_72?: string }
    }
    const cachedUser: CachedSlackUser = {
      id: user.id,
      name: user.name ?? userId,
      realName: user.real_name ?? user.name ?? userId,
      isBot: user.is_bot ?? false,
      avatar: user.profile?.image_72,
    }

    // Evict oldest if cache is full
    if (userCache.size >= USER_CACHE_MAX) {
      const firstKey = userCache.keys().next().value
      if (firstKey) {
        userCache.delete(firstKey)
      }
    }

    userCache.set(userId, {
      user: cachedUser,
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    })
    return cachedUser
  } catch {
    return {
      id: userId,
      name: userId,
      realName: userId,
      isBot: false,
    }
  }
}

export function createServer(config: ServerConfig): ServerComponents {
  const {
    slack,
    botUserId,
    botUsername,
    botToken,
    signingSecret,
    workspaceId,
    port,
  } = config

  // Pending interactions awaiting discord.js responses
  const pendingInteractions = new Map<string, PendingInteraction>()

  // Track known threads so we can emit THREAD_CREATE on first sight
  const knownThreads = new Set<string>()

  const app = new Spiceflow({ basePath: '' })

  // ---- Slack Webhook Receiver ----

  app.post('/slack/events', async ({ request }) => {
    const body = await request.text()

    // Verify signature
    const timestamp = request.headers.get('x-slack-request-timestamp')
    const signature = request.headers.get('x-slack-signature')
    if (!verifySignature(body, timestamp, signature, signingSecret)) {
      return new Response('Invalid signature', { status: 401 })
    }

    // Check content type for interactive payloads (form-urlencoded)
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(body)

      // Slash command
      if (params.has('command') && !params.has('payload')) {
        handleSlashCommand(params)
        return new Response('', { status: 200 })
      }

      // Interactive payload (button clicks, modals)
      const payloadStr = params.get('payload')
      if (payloadStr) {
        handleInteractivePayload(payloadStr)
        return new Response('', { status: 200 })
      }

      return new Response('', { status: 200 })
    }

    // JSON event payload
    let payload: SlackEventEnvelope
    try {
      payload = JSON.parse(body) as SlackEventEnvelope
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    // URL verification challenge
    if (payload.type === 'url_verification' && payload.challenge) {
      return Response.json({ challenge: payload.challenge })
    }

    // Event callback
    if (payload.type === 'event_callback' && payload.event) {
      void handleEvent(payload.event)
    }

    return new Response('ok', { status: 200 })
  })

  // ---- Discord REST Routes ----

  // GET /api/v10/gateway/bot
  app.get('/api/v10/gateway/bot', ({ request }) => {
    const host = request.headers.get('host') ?? `127.0.0.1:${port}`
    const gatewayUrl =
      config.gatewayUrlOverride ?? `ws://${host}/gateway`
    return Response.json({
      url: gatewayUrl,
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 14400000,
        max_concurrency: 1,
      },
    })
  })

  // GET /api/v10/users/@me
  app.get('/api/v10/users/@me', async () => {
    const user = await rest.getUser({ slack, userId: botUserId })
    return withRateLimitHeaders(Response.json(user))
  })

  // GET /api/v10/users/:user_id
  app.get('/api/v10/users/:user_id', async ({ params }) => {
    const user = await rest.getUser({
      slack,
      userId: params.user_id as string,
    })
    return withRateLimitHeaders(Response.json(user))
  })

  // GET /api/v10/applications/@me
  app.get('/api/v10/applications/@me', () => {
    return withRateLimitHeaders(
      Response.json({
        id: botUserId,
        name: botUsername,
        bot: { id: botUserId, username: botUsername },
      }),
    )
  })

  // POST /api/v10/channels/:channel_id/messages
  app.post(
    '/api/v10/channels/:channel_id/messages',
    async ({ params, request }) => {
      const body = (await request.json()) as {
        content?: string
        embeds?: unknown[]
        components?: unknown[]
      }
      const message = await rest.postMessage({
        slack,
        channelId: params.channel_id as string,
        body: body as Parameters<typeof rest.postMessage>[0]['body'],
        botUserId,
        guildId: workspaceId,
      })
      gateway.broadcastMessageCreate(message, workspaceId)
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // PATCH /api/v10/channels/:channel_id/messages/:message_id
  app.patch(
    '/api/v10/channels/:channel_id/messages/:message_id',
    async ({ params, request }) => {
      const body = (await request.json()) as { content?: string }
      const message = await rest.editMessage({
        slack,
        channelId: params.channel_id as string,
        messageId: params.message_id as string,
        body,
        botUserId,
        guildId: workspaceId,
      })
      gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
        ...message,
        guild_id: workspaceId,
      })
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // DELETE /api/v10/channels/:channel_id/messages/:message_id
  app.delete(
    '/api/v10/channels/:channel_id/messages/:message_id',
    async ({ params }) => {
      await rest.deleteMessage({
        slack,
        channelId: params.channel_id as string,
        messageId: params.message_id as string,
      })
      gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
        id: params.message_id,
        channel_id: params.channel_id,
        guild_id: workspaceId,
      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // GET /api/v10/channels/:channel_id/messages
  app.get(
    '/api/v10/channels/:channel_id/messages',
    async ({ params, request }) => {
      const url = new URL(request.url)
      const messages = await rest.getMessages({
        slack,
        channelId: params.channel_id as string,
        query: {
          limit: url.searchParams.get('limit') ?? undefined,
          before: url.searchParams.get('before') ?? undefined,
          after: url.searchParams.get('after') ?? undefined,
        },
        botUserId,
        guildId: workspaceId,
      })
      return withRateLimitHeaders(Response.json(messages))
    },
  )

  // POST /api/v10/channels/:channel_id/typing (no-op)
  app.post('/api/v10/channels/:channel_id/typing', () => {
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // GET /api/v10/channels/:channel_id
  app.get('/api/v10/channels/:channel_id', async ({ params }) => {
    const channel = await rest.getChannel({
      slack,
      channelId: params.channel_id as string,
      guildId: workspaceId,
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // PUT /api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me
  app.put(
    '/api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
    async ({ params }) => {
      await rest.addReaction({
        slack,
        channelId: params.channel_id as string,
        messageId: params.message_id as string,
        emoji: decodeURIComponent(params.emoji as string),
      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // DELETE /api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me
  app.delete(
    '/api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
    async ({ params }) => {
      await rest.removeReaction({
        slack,
        channelId: params.channel_id as string,
        messageId: params.message_id as string,
        emoji: decodeURIComponent(params.emoji as string),
      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // POST /api/v10/channels/:channel_id/threads
  app.post(
    '/api/v10/channels/:channel_id/threads',
    async ({ params, request }) => {
      const body = (await request.json()) as {
        name: string
        auto_archive_duration?: number
      }
      const thread = await rest.createThread({
        slack,
        parentChannelId: params.channel_id as string,
        body,
        botUserId,
        guildId: workspaceId,
      })
      gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
        ...thread,
        newly_created: true,
      })
      return withRateLimitHeaders(Response.json(thread))
    },
  )

  // GET /api/v10/guilds/:guild_id
  app.get('/api/v10/guilds/:guild_id', () => {
    return withRateLimitHeaders(
      Response.json({
        id: workspaceId,
        name: 'Slack Workspace',
        owner_id: botUserId,
        roles: [],
        emojis: [],
        features: [],
        verification_level: 0,
        default_message_notifications: 0,
        explicit_content_filter: 0,
        mfa_level: 0,
        system_channel_flags: 0,
        premium_tier: 0,
        nsfw_level: 0,
      }),
    )
  })

  // GET /api/v10/guilds/:guild_id/channels
  app.get('/api/v10/guilds/:guild_id/channels', async () => {
    const channels = await rest.listChannels({
      slack,
      guildId: workspaceId,
    })
    return withRateLimitHeaders(Response.json(channels))
  })

  // POST /api/v10/interactions/:interaction_id/:interaction_token/callback
  app.post(
    '/api/v10/interactions/:interaction_id/:interaction_token/callback',
    async ({ params, request }) => {
      const body = (await request.json()) as {
        type: number
        data?: { content?: string; flags?: number }
      }
      const interactionId = params.interaction_id as string
      const pending = pendingInteractions.get(interactionId)
      if (!pending) {
        return new Response('Unknown interaction', { status: 404 })
      }

      pending.acknowledged = true

      // Type 4: CHANNEL_MESSAGE_WITH_SOURCE
      if (body.type === 4 && body.data) {
        const message = await rest.postMessage({
          slack,
          channelId: pending.channelId,
          body: { content: body.data.content },
          botUserId,
          guildId: workspaceId,
        })
        gateway.broadcastMessageCreate(message, workspaceId)
      }

      // Type 5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (ack, respond later)
      // Type 6: DEFERRED_UPDATE_MESSAGE (ack)
      // These just acknowledge -- the actual response comes via webhook edit

      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // POST /api/v10/webhooks/:webhook_id/:webhook_token (follow-up message)
  app.post(
    '/api/v10/webhooks/:webhook_id/:webhook_token',
    async ({ params, request }) => {
      const body = (await request.json()) as { content?: string }
      // Find interaction by token
      const pending = [...pendingInteractions.values()].find(
        (p) => p.token === (params.webhook_token as string),
      )
      if (!pending) {
        return new Response('Unknown webhook token', { status: 404 })
      }

      const message = await rest.postMessage({
        slack,
        channelId: pending.channelId,
        body: { content: body.content },
        botUserId,
        guildId: workspaceId,
      })
      gateway.broadcastMessageCreate(message, workspaceId)
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // ---- Internal Event Handlers ----

  async function handleEvent(event: SlackEvent): Promise<void> {
    const eventType = event.type
    const subtype = event.subtype

    if (eventType === 'message' || eventType === 'app_mention') {
      if (subtype === 'message_changed') {
        const author = await lookupUser(
          slack,
          event.message?.user ?? botUserId,
        )
        const translated = events.translateMessageUpdate({
          event,
          guildId: workspaceId,
          author,
        })
        if (translated) {
          gateway.broadcast(translated.eventName, translated.data)
        }
        return
      }

      if (subtype === 'message_deleted') {
        const translated = events.translateMessageDelete({
          event,
          guildId: workspaceId,
        })
        if (translated) {
          gateway.broadcast(translated.eventName, translated.data)
        }
        return
      }

      // Skip system subtypes
      const ignoredSubtypes = new Set([
        'channel_join',
        'channel_leave',
        'channel_topic',
        'channel_purpose',
        'channel_name',
        'channel_archive',
        'channel_unarchive',
        'group_join',
        'group_leave',
        'message_replied',
      ])
      if (subtype && ignoredSubtypes.has(subtype)) {
        return
      }

      // New message
      const userId = event.user ?? event.bot_id ?? botUserId
      const author = await lookupUser(slack, userId)

      // If this message is a thread reply and we haven't seen this thread,
      // emit THREAD_CREATE first
      if (
        event.thread_ts &&
        event.channel &&
        event.thread_ts !== event.ts
      ) {
        const threadKey = `${event.channel}:${event.thread_ts}`
        if (!knownThreads.has(threadKey)) {
          knownThreads.add(threadKey)
          const threadChannel = events.buildThreadChannel({
            parentChannel: event.channel,
            threadTs: event.thread_ts,
            guildId: workspaceId,
          })
          gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
            ...threadChannel,
            newly_created: true,
          })
        }
      }

      const translated = events.translateMessageCreate({
        event,
        guildId: workspaceId,
        author,
      })
      if (translated) {
        gateway.broadcast(translated.eventName, translated.data)
      }
      return
    }

    if (
      eventType === 'reaction_added' ||
      eventType === 'reaction_removed'
    ) {
      const reactionEvent = event as unknown as SlackReactionEvent
      const translated = events.translateReaction({
        event: reactionEvent,
        guildId: workspaceId,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }

    if (eventType === 'channel_created') {
      const ch = (event as unknown as { channel: { id: string; name: string } })
        .channel
      const translated = events.translateChannelCreate({
        channelId: ch.id,
        channelName: ch.name,
        guildId: workspaceId,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }
  }

  function handleSlashCommand(params: URLSearchParams): void {
    const command = params.get('command') ?? ''
    const text = params.get('text') ?? ''
    const userId = params.get('user_id') ?? ''
    const channelId = params.get('channel_id') ?? ''
    const triggerId = params.get('trigger_id') ?? ''
    const responseUrl = params.get('response_url') ?? ''

    const interactionId = crypto.randomUUID()
    const interactionToken = crypto.randomUUID()

    pendingInteractions.set(interactionId, {
      id: interactionId,
      token: interactionToken,
      channelId,
      guildId: workspaceId,
      triggerId,
      responseUrl,
      acknowledged: false,
    })

    // Broadcast as INTERACTION_CREATE
    gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
      id: interactionId,
      application_id: botUserId,
      type: 2, // ApplicationCommand
      token: interactionToken,
      version: 1,
      channel_id: channelId,
      guild_id: workspaceId,
      member: {
        user: {
          id: userId,
          username: params.get('user_name') ?? userId,
          discriminator: '0',
          avatar: null,
        },
        roles: [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
      },
      data: {
        id: interactionId,
        name: command.replace(/^\//, ''),
        type: 1, // ChatInput
        options: text
          ? [{ name: 'text', type: 3, value: text }]
          : [],
      },
    })
  }

  function handleInteractivePayload(payloadStr: string): void {
    let payload: SlackInteractivePayload
    try {
      payload = JSON.parse(payloadStr) as SlackInteractivePayload
    } catch {
      return
    }

    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        const interactionId = crypto.randomUUID()
        const interactionToken = crypto.randomUUID()
        const channelId =
          payload.channel?.id ??
          payload.container?.channel_id ??
          ''

        pendingInteractions.set(interactionId, {
          id: interactionId,
          token: interactionToken,
          channelId,
          guildId: workspaceId,
          triggerId: payload.trigger_id,
          responseUrl: payload.response_url,
          acknowledged: false,
          messageTs: payload.message?.ts,
        })

        gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
          id: interactionId,
          application_id: botUserId,
          type: 3, // MessageComponent
          token: interactionToken,
          version: 1,
          channel_id: channelId,
          guild_id: workspaceId,
          member: {
            user: {
              id: payload.user.id,
              username: payload.user.username ?? payload.user.name ?? 'unknown',
              discriminator: '0',
              avatar: null,
            },
            roles: [],
            joined_at: new Date().toISOString(),
            deaf: false,
            mute: false,
          },
          data: {
            custom_id: action.action_id,
            component_type: 2, // Button
            values: action.selected_option
              ? [action.selected_option.value]
              : [],
          },
        })
      }
    }
  }

  // ---- Gateway Setup ----

  const httpServer = http.createServer((req, res) => {
    return app.handleForNode(req, res)
  })

  const loadGatewayState = async (): Promise<GatewayState> => {
    // Build gateway state from Slack API
    const authResult = await slack.auth.test()
    const channelsList = await slack.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    })

    const channels: APIChannel[] = (channelsList.channels ?? []).map(
      (ch) => {
        const c = ch as {
          id: string
          name?: string
          topic?: { value?: string }
          is_private?: boolean
        }
        return {
          id: c.id,
          type: 0, // GuildText
          name: c.name ?? '',
          guild_id: workspaceId,
          topic: c.topic?.value ?? null,
          position: 0,
        } as APIChannel
      },
    )

    return {
      botUser: {
        id: botUserId,
        username: botUsername,
        discriminator: '0',
        avatar: null,
        global_name: botUsername,
      },
      guilds: [
        {
          id: workspaceId,
          apiGuild: {
            id: workspaceId,
            name: (authResult.team as string) ?? 'Slack Workspace',
            owner_id: botUserId,
            roles: [],
            emojis: [],
            features: [],
            verification_level: 0,
            default_message_notifications: 0,
            explicit_content_filter: 0,
            mfa_level: 0,
            system_channel_flags: 0,
            premium_tier: 0,
            nsfw_level: 0,
          } as unknown as APIGuild,
          joinedAt: new Date().toISOString(),
          members: [
            {
              user: {
                id: botUserId,
                username: botUsername,
                discriminator: '0',
                avatar: null,
                global_name: botUsername,
              },
              roles: [],
              joined_at: new Date().toISOString(),
              deaf: false,
              mute: false,
              flags: GuildMemberFlags.CompletedOnboarding,
            },
          ],
          channels,
        },
      ],
    }
  }

  const gateway = new SlackBridgeGateway({
    httpServer,
    port,
    loadState: loadGatewayState,
    expectedToken: botToken,
  })

  return { httpServer, gateway, app }
}

export function startServer(
  components: ServerComponents,
  port: number,
): Promise<void> {
  return new Promise((resolve) => {
    components.httpServer.listen(port, () => {
      resolve()
    })
  })
}

export function stopServer(components: ServerComponents): Promise<void> {
  components.gateway.close()
  return new Promise((resolve, reject) => {
    components.httpServer.close((err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

// ---- Helpers ----

function verifySignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): boolean {
  if (!(timestamp && signature)) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number.parseInt(timestamp, 10)) > 300) {
    return false
  }

  const sigBasestring = `v0:${timestamp}:${body}`
  const expectedSignature =
    'v0=' +
    createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    )
  } catch {
    return false
  }
}

function withRateLimitHeaders(response: Response): Response {
  response.headers.set('X-RateLimit-Limit', '50')
  response.headers.set('X-RateLimit-Remaining', '49')
  response.headers.set('X-RateLimit-Reset-After', '60.0')
  response.headers.set('X-RateLimit-Bucket', 'fake-bucket')
  return response
}
