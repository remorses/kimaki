// HTTP server for the discord-slack-bridge.
// Exposes two sets of routes on the same port:
//   1. /api/v10/* — Discord REST routes consumed by discord.js
//   2. /slack/events — Slack webhook receiver for Events API + interactions
//
// Also hosts the WebSocket gateway at /gateway for discord.js Gateway.

import http from 'node:http'
import type {
  ConversationsListArguments,
  ConversationsRepliesArguments,
  UsersInfoArguments,
  WebClient,
} from '@slack/web-api'
import { Spiceflow } from 'spiceflow'
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  ComponentType,
  GuildDefaultMessageNotifications,
  GatewayDispatchEvents,
  GuildExplicitContentFilter,
  GuildMemberFlags,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildSystemChannelFlags,
  GuildVerificationLevel,
  InteractionResponseType,
  InteractionType,
  Locale,
  MessageType,
  ThreadMemberFlags,
  TextInputStyle,
} from 'discord-api-types/v10'
import type {
  APIActionRowComponent,
  APIApplicationCommand,
  APIChannel,
  APIGuild,
  APIThreadList,
  APIThreadMember,
  APITextInputComponent,
} from 'discord-api-types/v10'
import {
  SlackBridgeGateway,
  type GatewayGuildState,
  type GatewayState,
} from './gateway.js'
import * as rest from './rest-translator.js'
import * as events from './event-translator.js'
import {
  encodeThreadId,
  encodeMessageId,
  isThreadChannelId,
  resolveDiscordChannelId,
  resolveSlackTarget,
} from './id-converter.js'
import {
  createTypingCoordinator,
} from './typing-state.js'
import { decodeComponentActionId } from './component-id-codec.js'
import type { DiscordAttachment } from './file-upload.js'
import type {
  CachedSlackUser,
  NormalizedSlackAction,
  NormalizedSlackBlockActionsPayload,
  NormalizedSlackEvent,
  NormalizedSlackEventEnvelope,
  NormalizedSlackMessageEvent,
  NormalizedSlackMessage,
  NormalizedSlackReactionEvent,
  PendingInteraction,
  NormalizedSlackInteractivePayload,
  NormalizedSlackViewSubmissionPayload,
  NormalizedSlackViewSubmissionStateValue,
  SlackBlockActionsPayload,
  SlackInteractivePayload,
  SlackViewSubmissionPayload,
  SupportedSlackEventType,
  BridgeAuthorizeCallback,
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
  publicBaseUrl?: string
  authorize?: BridgeAuthorizeCallback
}

export interface ServerComponents {
  httpServer: http.Server
  gateway: SlackBridgeGateway
  app: Spiceflow
}

type NormalizedPostMessageBody = {
  content?: string
  embeds?: unknown[]
  components?: unknown[]
  attachments?: DiscordAttachment[]
}

// User cache: avoids hitting Slack users.info API on every inbound event.
// TTL 1 hour, max 500 entries.
const USER_CACHE_TTL_MS = 60 * 60 * 1000
const USER_CACHE_MAX = 500
const userCache = new Map<string, { user: CachedSlackUser; expiresAt: number }>()

const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000

const DISCORD_DEFAULT_DISCRIMINATOR = '0'
const DISCORD_ZERO_PERMISSIONS = '0'
const THREAD_TYPING_STATUS_TEXT = 'Typing...'

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
    const args = { user: userId } satisfies UsersInfoArguments
    const result = await slack.users.info(args)
    const user = result.user
    if (!user?.id) {
      throw new Error('Slack users.info returned invalid user payload')
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
    authorize,
  } = config

  // Pending interactions awaiting discord.js responses
  const pendingInteractions = new Map<string, PendingInteraction>()

  // Slack event replay protection (event_id -> expiresAt)
  const seenEventIds = new Map<string, number>()

  // Track announced threads so we emit THREAD_CREATE exactly once per thread.
  // Keyed by encoded thread ID (channel + thread_ts) to avoid cross-channel
  // collisions when Slack thread_ts values are the same in different channels.
  // Bounded to prevent memory leaks on long-running bots.
  const KNOWN_THREADS_MAX = 10_000
  const knownThreads = new Set<string>()
  const knownThreadChannels = new Map<string, APIChannel>()
  const applicationCommandRegistry = new Map<string, APIApplicationCommand[]>()
  const typingCoordinator = createTypingCoordinator({
    setStatus: ({ threadChannelId, statusText }) => {
      return rest.setThreadTypingStatus({
        slack,
        threadChannelId,
        statusText,
      })
    },
    clearStatus: ({ threadChannelId }) => {
      return rest.clearThreadTypingStatus({
        slack,
        threadChannelId,
      })
    },
    resolveThreadTarget: ({ threadChannelId }) => {
      const target = resolveSlackTarget(threadChannelId)
      return {
        channelId: target.channel,
        threadTs: target.threadTs,
      }
    },
    statusText: THREAD_TYPING_STATUS_TEXT,
  })

  const app = new Spiceflow({ basePath: '' }).onError(({ error }) => {
    if (error instanceof Response) {
      return error
    }
    const details = getErrorStack(error) ?? getErrorMessage(error)
    return errorJsonResponse({
      status: 500,
      error: 'internal_server_error',
      message: getErrorMessage(error),
      details,
      errorDescription: details,
    })
  })

  // ---- Slack Webhook Receiver ----

  app.post('/slack/events', async ({ request }) => {
    const body = await request.text()

    // Verify signature
    const timestamp = request.headers.get('x-slack-request-timestamp')
    const signature = request.headers.get('x-slack-signature')
    if (!(await verifySignature(body, timestamp, signature, signingSecret))) {
      return errorJsonResponse({ status: 401, error: 'invalid_signature' })
    }

    // Check content type for interactive payloads (form-urlencoded)
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(body)

      // Slash command
      if (params.has('command') && !params.has('payload')) {
        const allowSlashAction = await authorizeSlackInbound({
          authorize,
          kind: 'webhook-action',
          teamId: params.get('team_id') ?? undefined,
          request,
          workspaceId,
        })
        if (!allowSlashAction) {
          return errorJsonResponse({ status: 403, error: 'unauthorized_team' })
        }
        handleSlashCommand(params)
        return new Response('', { status: 200 })
      }

      // Interactive payload (button clicks, selects)
      const payloadStr = params.get('payload')
      if (payloadStr) {
        const allowInteractiveAction = await authorizeSlackInbound({
          authorize,
          kind: 'webhook-action',
          teamId: readInteractiveTeamId(payloadStr),
          request,
          workspaceId,
        })
        if (!allowInteractiveAction) {
          return errorJsonResponse({ status: 403, error: 'unauthorized_team' })
        }
        handleInteractivePayload(payloadStr)
        return new Response('', { status: 200 })
      }

      return new Response('', { status: 200 })
    }

    // JSON event payload
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return errorJsonResponse({ status: 400, error: 'invalid_json' })
    }

    const normalizedEnvelope = normalizeSlackEventEnvelope(payload)
    if (!normalizedEnvelope) {
      console.warn('Unsupported Slack webhook payload', {
        payloadType: isRecord(payload) ? readString(payload, 'type') : undefined,
        contentType,
        bodyPreview: body.slice(0, 300),
      })
      return errorJsonResponse({ status: 400, error: 'unsupported_event_payload' })
    }

    const allowEvent = await authorizeSlackInbound({
      authorize,
      kind: 'webhook-event',
      teamId: readSlackEventTeamId(payload),
      request,
      workspaceId,
    })
    if (!allowEvent) {
      return errorJsonResponse({ status: 403, error: 'unauthorized_team' })
    }

    // URL verification challenge
    if (normalizedEnvelope.type === 'url_verification') {
      return Response.json({ challenge: normalizedEnvelope.challenge })
    }

    // Event callback
    const eventId = normalizedEnvelope.eventId
    if (eventId) {
      pruneExpiredEventIds({ seenEventIds, now: Date.now() })
      if (seenEventIds.has(eventId)) {
        return new Response('ok', { status: 200 })
      }
      seenEventIds.set(eventId, Date.now() + EVENT_DEDUPE_TTL_MS)
    }
    void handleEvent(normalizedEnvelope.event)

    return new Response('ok', { status: 200 })
  })

  // ---- Discord REST Routes ----

  // GET /api/v10/gateway/bot
  app.get('/api/v10/gateway/bot', ({ request }) => {
    const gatewayUrl = resolveGatewayUrl({
      request,
      gatewayUrlOverride: config.gatewayUrlOverride,
      publicBaseUrl: config.publicBaseUrl,
      port,
    })
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
    const userId = readString(params, 'user_id')
    if (!userId) {
      return errorJsonResponse({ status: 400, error: 'missing_user_id' })
    }
    const user = await rest.getUser({
      slack,
      userId,
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

  // PUT /api/v10/applications/:application_id/commands
  app.put('/api/v10/applications/:application_id/commands', async ({ params, request }) => {
    const applicationId = readString(params, 'application_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    const commands = normalizeApplicationCommandsBody(await request.json())
    const key = getGlobalCommandRegistryKey({ applicationId })
    const stored = commands.map((command) => {
      return createApplicationCommandRecord({
        applicationId,
        command,
      })
    })
    applicationCommandRegistry.set(key, stored)
    return withRateLimitHeaders(Response.json(stored))
  })

  // GET /api/v10/applications/:application_id/commands
  app.get('/api/v10/applications/:application_id/commands', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    const key = getGlobalCommandRegistryKey({ applicationId })
    const commands = applicationCommandRegistry.get(key) ?? []
    return withRateLimitHeaders(Response.json(commands))
  })

  // PUT /api/v10/applications/:application_id/guilds/:guild_id/commands
  app.put('/api/v10/applications/:application_id/guilds/:guild_id/commands', async ({ params, request }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    if (!guildId) {
      return errorJsonResponse({ status: 400, error: 'missing_guild_id' })
    }
    if (guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const commands = normalizeApplicationCommandsBody(await request.json())
    const key = getGuildCommandRegistryKey({ applicationId, guildId })
    const stored = commands.map((command) => {
      return createApplicationCommandRecord({
        applicationId,
        guildId,
        command,
      })
    })
    applicationCommandRegistry.set(key, stored)
    return withRateLimitHeaders(Response.json(stored))
  })

  // GET /api/v10/applications/:application_id/guilds/:guild_id/commands
  app.get('/api/v10/applications/:application_id/guilds/:guild_id/commands', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    if (!guildId) {
      return errorJsonResponse({ status: 400, error: 'missing_guild_id' })
    }
    if (guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const key = getGuildCommandRegistryKey({ applicationId, guildId })
    const commands = applicationCommandRegistry.get(key) ?? []
    return withRateLimitHeaders(Response.json(commands))
  })

  // GET /api/v10/applications/:application_id/guilds/:guild_id/commands/:command_id
  app.get('/api/v10/applications/:application_id/guilds/:guild_id/commands/:command_id', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    const commandId = readString(params, 'command_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    if (!guildId) {
      return errorJsonResponse({ status: 400, error: 'missing_guild_id' })
    }
    if (!commandId) {
      return errorJsonResponse({ status: 400, error: 'missing_command_id' })
    }
    if (guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }

    const key = getGuildCommandRegistryKey({ applicationId, guildId })
    const command = (applicationCommandRegistry.get(key) ?? []).find((entry) => {
      return entry.id === commandId
    })
    if (!command) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_application_command',
        code: 10063,
        message: 'Unknown application command',
      })
    }

    return withRateLimitHeaders(Response.json(command))
  })

  // POST /api/v10/channels/:channel_id/messages
  app.post(
    '/api/v10/channels/:channel_id/messages',
    async ({ params, request }) => {
      const body = await normalizePostMessageRequestBody(request)
      const channelId = readString(params, 'channel_id')
      if (!channelId) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
      }
      const message = await rest.postMessage({
        slack,
        channelId,
        body,
        botUserId,
        guildId: workspaceId,

      })
      if (isThreadChannelId(channelId)) {
        typingCoordinator.noteAssistantMessage({
          threadChannelId: channelId,
          messageId: message.id,
        })
      }
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // PATCH /api/v10/channels/:channel_id/messages/:message_id
  app.patch(
    '/api/v10/channels/:channel_id/messages/:message_id',
    async ({ params, request }) => {
      const body = normalizeEditMessageBody(await request.json())
      const channelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      if (!(channelId && messageId)) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
      }
      const message = await rest.editMessage({
        slack,
        channelId,
        messageId,
        body,
        botUserId,
        guildId: workspaceId,

      })
      if (isThreadChannelId(channelId)) {
        typingCoordinator.noteAssistantMessage({
          threadChannelId: channelId,
          messageId: message.id,
        })
      }
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // DELETE /api/v10/channels/:channel_id/messages/:message_id
  app.delete(
    '/api/v10/channels/:channel_id/messages/:message_id',
    async ({ params }) => {
      const channelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      if (!(channelId && messageId)) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
      }
      await rest.deleteMessage({
        slack,
        channelId,
        messageId,

      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // GET /api/v10/channels/:channel_id/messages
  app.get(
    '/api/v10/channels/:channel_id/messages',
    async ({ params, request }) => {
      const url = new URL(request.url)
      const channelId = readString(params, 'channel_id')
      if (!channelId) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
      }
      const messages = await rest.getMessages({
        slack,
        channelId,
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

  // GET /api/v10/channels/:channel_id/messages/:message_id
  app.get(
    '/api/v10/channels/:channel_id/messages/:message_id',
    async ({ params }) => {
      const channelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      if (!(channelId && messageId)) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
      }

      const message = await rest.getMessage({
        slack,
        channelId,
        messageId,
        botUserId,
        guildId: workspaceId,

      })
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // POST /api/v10/channels/:channel_id/typing
  app.post('/api/v10/channels/:channel_id/typing', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    if (!isThreadChannelId(channelId)) {
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    }

    typingCoordinator.requestStart({
      threadChannelId: channelId,
    })

    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // GET /api/v10/channels/:channel_id
  app.get('/api/v10/channels/:channel_id', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const channel = await rest.getChannel({
      slack,
      channelId,
      guildId: workspaceId,
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // PATCH /api/v10/channels/:channel_id
  app.patch('/api/v10/channels/:channel_id', async ({ params, request }) => {
    const body = normalizePatchChannelBody(await request.json())
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }

    const channel = await rest.updateChannel({
      slack,
      channelId,
      body,
      guildId: workspaceId,
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // PUT /api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me
  app.put(
    '/api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
    async ({ params }) => {
      const channelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      const emoji = readString(params, 'emoji')
      if (!(channelId && messageId && emoji)) {
        return errorJsonResponse({ status: 400, error: 'missing_reaction_route_params' })
      }
      await rest.addReaction({
        slack,
        channelId,
        messageId,
        emoji: decodeURIComponent(emoji),

      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // DELETE /api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me
  app.delete(
    '/api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
    async ({ params }) => {
      const channelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      const emoji = readString(params, 'emoji')
      if (!(channelId && messageId && emoji)) {
        return errorJsonResponse({ status: 400, error: 'missing_reaction_route_params' })
      }
      await rest.removeReaction({
        slack,
        channelId,
        messageId,
        emoji: decodeURIComponent(emoji),

      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // POST /api/v10/channels/:channel_id/threads
  app.post(
    '/api/v10/channels/:channel_id/threads',
    async ({ params, request }) => {
      const body = normalizeCreateThreadBody(await request.json())
      const parentChannelId = readString(params, 'channel_id')
      if (!parentChannelId) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
      }
      const thread = await rest.createThread({
        slack,
        parentChannelId,
        body,
        botUserId,
        guildId: workspaceId,
      })
      // Register thread so we don't emit duplicate THREAD_CREATE events.
      const threadKey = thread.id
      evictIfFull(knownThreads, KNOWN_THREADS_MAX)
      knownThreads.add(threadKey)
      evictMapIfFull(knownThreadChannels, KNOWN_THREADS_MAX)
      gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
        ...thread,
        newly_created: true,
      })
      knownThreadChannels.set(thread.id, thread)
      return withRateLimitHeaders(Response.json(thread))
    },
  )

  // POST /api/v10/channels/:channel_id/messages/:message_id/threads
  app.post(
    '/api/v10/channels/:channel_id/messages/:message_id/threads',
    async ({ params, request }) => {
      const body = normalizeCreateThreadBody(await request.json())
      const parentChannelId = readString(params, 'channel_id')
      const messageId = readString(params, 'message_id')
      if (!(parentChannelId && messageId)) {
        return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
      }

      const thread = await rest.createThreadFromMessage({
        slack,
        parentChannelId,
        messageId,
        body,
        botUserId,
        guildId: workspaceId,
      })

      const threadKey = thread.id
      evictIfFull(knownThreads, KNOWN_THREADS_MAX)
      knownThreads.add(threadKey)
      evictMapIfFull(knownThreadChannels, KNOWN_THREADS_MAX)
      gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
        ...thread,
        newly_created: true,
      })
      knownThreadChannels.set(thread.id, thread)

      return withRateLimitHeaders(Response.json(thread))
    },
  )

  // GET /api/v10/channels/:channel_id/thread-members
  app.get('/api/v10/channels/:channel_id/thread-members', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    if (!isThreadChannelId(channelId)) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_channel',
        code: 10003,
        message: `Unknown Channel: ${channelId}`,
      })
    }
    const members = await rest.listThreadMembers({
      slack,
      threadChannelId: channelId,
      botUserId,
    })
    return withRateLimitHeaders(Response.json(members))
  })

  // GET /api/v10/channels/:channel_id/thread-members/@me
  app.get('/api/v10/channels/:channel_id/thread-members/@me', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    if (!isThreadChannelId(channelId)) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_channel',
        code: 10003,
        message: `Unknown Channel: ${channelId}`,
      })
    }
    const member = await rest.getThreadMember({
      slack,
      threadChannelId: channelId,
      userId: botUserId,
      botUserId,
    })
    return withRateLimitHeaders(Response.json(member))
  })

  // PUT /api/v10/channels/:channel_id/thread-members/@me
  app.put('/api/v10/channels/:channel_id/thread-members/@me', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    if (!isThreadChannelId(channelId)) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_channel',
        code: 10003,
        message: `Unknown Channel: ${channelId}`,
      })
    }
    await rest.joinThreadMember({
      slack,
      threadChannelId: channelId,
      userId: botUserId,
    })
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // DELETE /api/v10/channels/:channel_id/thread-members/@me
  app.delete('/api/v10/channels/:channel_id/thread-members/@me', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    if (!isThreadChannelId(channelId)) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_channel',
        code: 10003,
        message: `Unknown Channel: ${channelId}`,
      })
    }
    await rest.leaveThreadMember({
      slack,
      threadChannelId: channelId,
      userId: botUserId,
    })
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // PUT /api/v10/channels/:channel_id/thread-members/:user_id
  app.put('/api/v10/channels/:channel_id/thread-members/:user_id', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    const userId = readString(params, 'user_id')
    if (!(channelId && userId)) {
      return errorJsonResponse({ status: 400, error: 'missing_thread_member_route_params' })
    }
    if (!isThreadChannelId(channelId)) {
      return errorJsonResponse({
        status: 404,
        error: 'unknown_channel',
        code: 10003,
        message: `Unknown Channel: ${channelId}`,
      })
    }
    if (userId !== botUserId) {
      return errorJsonResponse({
        status: 403,
        error: 'missing_permissions',
        code: 50013,
        message: 'Missing Permissions',
      })
    }
    await rest.joinThreadMember({
      slack,
      threadChannelId: channelId,
      userId,
    })
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // GET /api/v10/guilds/:guild_id
  app.get('/api/v10/guilds/:guild_id', ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    return withRateLimitHeaders(
      Response.json({
        id: workspaceId,
        name: 'Slack Workspace',
        owner_id: botUserId,
        roles: [],
        emojis: [],
        features: [],
        verification_level: GuildVerificationLevel.None,
        default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
        explicit_content_filter: GuildExplicitContentFilter.Disabled,
        mfa_level: GuildMFALevel.None,
        system_channel_flags: GuildSystemChannelFlags.SuppressJoinNotifications,
        premium_tier: GuildPremiumTier.None,
        nsfw_level: GuildNSFWLevel.Default,
      }),
    )
  })

  // GET /api/v10/guilds/:guild_id/channels
  app.get('/api/v10/guilds/:guild_id/channels', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const channels = await rest.listChannels({
      slack,
      guildId: workspaceId,
    })
    return withRateLimitHeaders(Response.json(channels))
  })

  // POST /api/v10/guilds/:guild_id/channels
  app.post('/api/v10/guilds/:guild_id/channels', async ({ params, request }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const body = normalizeCreateGuildChannelBody(await request.json())
    const channel = await rest.createChannel({
      slack,
      guildId: workspaceId,
      body,
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // GET /api/v10/guilds/:guild_id/members
  app.get('/api/v10/guilds/:guild_id/members', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const members = await rest.listGuildMembers({ slack })
    return withRateLimitHeaders(Response.json(members))
  })

  // GET /api/v10/guilds/:guild_id/members/:uid
  app.get('/api/v10/guilds/:guild_id/members/:uid', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const userId = readString(params, 'uid')
    if (!userId) {
      return errorJsonResponse({ status: 400, error: 'missing_uid' })
    }
    const member = await rest.getGuildMember({
      slack,
      userId,
    })
    return withRateLimitHeaders(Response.json(member))
  })

  // GET /api/v10/guilds/:guild_id/roles
  app.get('/api/v10/guilds/:guild_id/roles', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (guildId && guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }
    const roles = await rest.listGuildRoles({ slack })
    return withRateLimitHeaders(Response.json(roles))
  })

  // GET /api/v10/guilds/:guild_id/threads/active
  app.get('/api/v10/guilds/:guild_id/threads/active', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (!guildId) {
      return errorJsonResponse({ status: 400, error: 'missing_guild_id' })
    }
    if (guildId !== workspaceId) {
      return unknownGuildResponse(guildId)
    }

    const threadList = await rest.getActiveThreads({
      slack,
      guildId: workspaceId,
      botUserId,
    })
    const merged = mergeActiveThreadsWithKnown({
      active: threadList,
      knownThreadChannels,
      botUserId,
    })
    return withRateLimitHeaders(Response.json(merged))
  })

  // POST /api/v10/interactions/:interaction_id/:interaction_token/callback
  app.post(
    '/api/v10/interactions/:interaction_id/:interaction_token/callback',
    async ({ params, request }) => {
      const body = normalizeInteractionCallbackBody(await request.json())
      const interactionId = readString(params, 'interaction_id')
      const interactionToken = readString(params, 'interaction_token')
      if (!(interactionId && interactionToken)) {
        return errorJsonResponse({ status: 400, error: 'missing_interaction_route_params' })
      }
      const pending = pendingInteractions.get(interactionId)
      if (!pending) {
        return errorJsonResponse({ status: 404, error: 'unknown_interaction' })
      }
      if (pending.token !== interactionToken) {
        return errorJsonResponse({ status: 401, error: 'invalid_interaction_token' })
      }

      pending.acknowledged = true

      // CHANNEL_MESSAGE_WITH_SOURCE
      if (body.type === InteractionResponseType.ChannelMessageWithSource && body.data) {
        const message = await rest.postMessage({
          slack,
          channelId: pending.channelId,
          body: { content: body.data.content },
          botUserId,
          guildId: workspaceId,
  
        })
        if (isThreadChannelId(pending.channelId)) {
          typingCoordinator.noteAssistantMessage({
            threadChannelId: pending.channelId,
            messageId: message.id,
          })
        }
        gateway.broadcastMessageCreate(message, workspaceId)
      }

      if (body.type === InteractionResponseType.UpdateMessage && body.data && pending.messageTs) {
        const message = await rest.editMessage({
          slack,
          channelId: pending.channelId,
          messageId: encodeMessageId(
            resolveSlackTarget(pending.channelId).channel,
            pending.messageTs,
          ),
          body: {
            content: body.data.content,
            components: body.data.components,
          },
          botUserId,
          guildId: workspaceId,
  
        })
        if (isThreadChannelId(pending.channelId)) {
          typingCoordinator.noteAssistantMessage({
            threadChannelId: pending.channelId,
            messageId: message.id,
          })
        }
        gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
          ...message,
          guild_id: workspaceId,
        })
      }

      if (
        body.type === InteractionResponseType.Modal &&
        body.data &&
        pending.triggerId
      ) {
        const modalData = normalizeModalInteractionResponseData(body.data)
        await rest.openModalView({
          slack,
          triggerId: pending.triggerId,
          modal: modalData,
        })
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
      const body = await normalizePostMessageRequestBody(request)
      const webhookToken = readString(params, 'webhook_token')
      if (!webhookToken) {
        return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
      }
      // Find interaction by token
      const pending = [...pendingInteractions.values()].find(
        (p) => p.token === webhookToken,
      )
      if (!pending) {
        return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
      }

      const message = await rest.postMessage({
        slack,
        channelId: pending.channelId,
        body,
        botUserId,
        guildId: workspaceId,

      })
      if (isThreadChannelId(pending.channelId)) {
        typingCoordinator.noteAssistantMessage({
          threadChannelId: pending.channelId,
          messageId: message.id,
        })
      }
      return withRateLimitHeaders(Response.json(message))
    },
  )

  // PATCH /api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id
  // Supports @original (edits the interaction source message) and specific
  // message IDs (edits follow-up messages).
  app.patch(
    '/api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id',
    async ({ params, request }) => {
      const body = normalizeWebhookBody(await request.json())
      const webhookToken = readString(params, 'webhook_token')
      const rawMessageId = readString(params, 'message_id')
      if (!webhookToken) {
        return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
      }
      const pending = [...pendingInteractions.values()].find((entry) => {
        return entry.token === webhookToken
      })
      if (!pending) {
        return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
      }

      // Resolve which message to edit: @original → source message, otherwise decode ID
      const resolvedMessageId = resolveWebhookMessageId({
        rawMessageId,
        pending,
        channelId: pending.channelId,

      })
      if (!resolvedMessageId) {
        return errorJsonResponse({ status: 400, error: 'no_source_message_for_webhook_update' })
      }

      const message = await rest.editMessage({
        slack,
        channelId: pending.channelId,
        messageId: resolvedMessageId,
        body: {
          content: body.content,
        },
        botUserId,
        guildId: workspaceId,

      })
      if (isThreadChannelId(pending.channelId)) {
        typingCoordinator.noteAssistantMessage({
          threadChannelId: pending.channelId,
          messageId: message.id,
        })
      }

      return withRateLimitHeaders(Response.json(message))
    },
  )

  // DELETE /api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id
  // Supports @original (deletes the interaction source message) and specific
  // message IDs (deletes follow-up messages).
  app.delete(
    '/api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id',
    async ({ params }) => {
      const webhookToken = readString(params, 'webhook_token')
      const rawMessageId = readString(params, 'message_id')
      if (!webhookToken) {
        return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
      }
      const pending = [...pendingInteractions.values()].find((entry) => {
        return entry.token === webhookToken
      })
      if (!pending) {
        return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
      }

      const resolvedMessageId = resolveWebhookMessageId({
        rawMessageId,
        pending,
        channelId: pending.channelId,

      })
      if (!resolvedMessageId) {
        return errorJsonResponse({ status: 400, error: 'no_source_message_for_webhook_delete' })
      }

      await rest.deleteMessage({
        slack,
        channelId: pending.channelId,
        messageId: resolvedMessageId,

      })
      return withRateLimitHeaders(new Response(null, { status: 204 }))
    },
  )

  // ---- Internal Event Handlers ----

  async function handleEvent(event: NormalizedSlackEvent): Promise<void> {
    const eventType = event.type
    const subtype = 'subtype' in event ? event.subtype : undefined

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
      const userId = event.user ?? event.botId ?? botUserId
      const author = await lookupUser(slack, userId)

      // If this message is a thread reply and we haven't seen this thread,
      // emit THREAD_CREATE first
      if (
        event.threadTs &&
        event.channel &&
        event.threadTs !== event.ts
      ) {
        const threadKey = encodeThreadId(event.channel, event.threadTs)
        if (!knownThreads.has(threadKey)) {
          evictIfFull(knownThreads, KNOWN_THREADS_MAX)
          knownThreads.add(threadKey)
          const threadChannel = events.buildThreadChannel({
            parentChannel: event.channel,
            threadTs: event.threadTs,
            guildId: workspaceId,
          })
          evictMapIfFull(knownThreadChannels, KNOWN_THREADS_MAX)
          knownThreadChannels.set(threadKey, threadChannel)
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
      const threadTs = await resolveThreadTsForReaction({
        slack,
        event,
      })
      const translated = events.translateReaction({
        event,
        guildId: workspaceId,
        threadTs,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }

    if (eventType === 'channel_created') {
      const translated = events.translateChannelCreate({
        channelId: event.channelId,
        channelName: event.channelName,
        guildId: workspaceId,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }

    if (eventType === 'channel_deleted') {
      const translated = events.translateChannelDelete({
        channelId: event.channelId,
        guildId: workspaceId,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }

    if (eventType === 'channel_rename') {
      const translated = events.translateChannelRename({
        channelId: event.channelId,
        channelName: event.channelName,
        guildId: workspaceId,
      })
      gateway.broadcast(translated.eventName, translated.data)
      return
    }

    if (eventType === 'member_joined_channel') {
      const memberUser = await lookupUser(slack, event.userId)
      const translated = events.translateMemberJoinedChannel({
        event,
        user: memberUser,
      })
      gateway.broadcast(translated.eventName, {
        ...translated.data,
        guild_id: workspaceId,
      })
      return
    }

    console.warn('Unhandled Slack event', { eventType, subtype })
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
        type: InteractionType.ApplicationCommand,
        token: interactionToken,
        version: 1,
        entitlements: [],
      channel_id: channelId,
      guild_id: workspaceId,
      member: {
        user: {
          id: userId,
          username: params.get('user_name') ?? userId,
          discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
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
        type: ApplicationCommandType.ChatInput,
        options: text
          ? [{ name: 'text', type: ApplicationCommandOptionType.String, value: text }]
          : [],
      },
    })
  }

  function handleInteractivePayload(payloadStr: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(payloadStr)
    } catch {
      console.warn('Failed to parse Slack interactive payload', {
        payloadPreview: payloadStr.slice(0, 200),
      })
      return
    }

  const normalizedPayload = normalizeSlackInteractivePayload(payload)
  if (!normalizedPayload) {
    console.warn('Unhandled Slack interactive payload', {
      ...collectInteractivePayloadDebugInfo(payload),
      payloadPreview: payloadStr.slice(0, 300),
    })
    return
  }

    if (normalizedPayload.type === 'block_actions') {
      console.log('Slack interactive block_actions received', {
        actionCount: normalizedPayload.actions.length,
        channelId: normalizedPayload.channelId,
        messageTs: normalizedPayload.messageTs,
        threadTs: normalizedPayload.threadTs,
      })
    for (const action of normalizedPayload.actions) {
      const interactionId = crypto.randomUUID()
      const interactionToken = crypto.randomUUID()
      const slackChannelId = normalizedPayload.channelId
      if (!slackChannelId) {
        console.warn('Dropping Slack block_actions payload without channel id', {
          actionId: action.actionId,
          actionType: action.type,
          messageTs: normalizedPayload.messageTs,
          threadTs: normalizedPayload.threadTs,
        })
        continue
      }
      const threadTs = normalizedPayload.threadTs
      const messageTs = normalizedPayload.messageTs
      const channelId = resolveDiscordChannelId(
        slackChannelId,
        threadTs,
          messageTs,
        )
        const interactionData = buildDiscordComponentDataFromSlackAction({
          action,
        })
        const decodedAction = decodeComponentActionId(action.actionId)

        pendingInteractions.set(interactionId, {
          id: interactionId,
          token: interactionToken,
          channelId,
          guildId: workspaceId,
          triggerId: normalizedPayload.triggerId,
          responseUrl: normalizedPayload.responseUrl,
          acknowledged: false,
          messageTs,
        })

      const messageId = messageTs
        ? encodeMessageId(slackChannelId, messageTs)
        : interactionId

      console.log('Emitting Discord interaction from Slack block action', {
        interactionId,
        actionId: action.actionId,
        actionType: action.type,
        customId: decodedAction.customId,
        componentType: interactionData.componentType,
        channelId,
        messageTs,
        threadTs,
      })

        gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
          id: interactionId,
          application_id: botUserId,
          type: InteractionType.MessageComponent,
          token: interactionToken,
          version: 1,
          entitlements: [],
          channel_id: channelId,
          guild_id: workspaceId,
          member: {
              user: {
                id: normalizedPayload.user.id,
                username:
                  normalizedPayload.user.username ??
                  normalizedPayload.user.name ??
                  'unknown',
                discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
                avatar: null,
              },
            roles: [],
            joined_at: new Date().toISOString(),
            deaf: false,
            mute: false,
          },
          data: {
            custom_id: decodedAction.customId,
            component_type: interactionData.componentType,
            values: interactionData.values,
            ...(buildResolvedData({
              componentType: interactionData.componentType,
              values: interactionData.values,
            }) ?? {}),
          },
          message: {
            id: messageId,
            channel_id: channelId,
            content: '',
            attachments: [],
            embeds: [],
            components: [],
            author: {
              id: botUserId,
              username: botUsername,
              discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
              avatar: null,
            },
            timestamp: new Date().toISOString(),
            edited_timestamp: null,
            tts: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            pinned: false,
            type: MessageType.Default,
          },
        })
      }
      return
    }

    const modalInteractionId = crypto.randomUUID()
    const modalInteractionToken = crypto.randomUUID()
    const modalChannelId = normalizedPayload.channelId ?? ''

    console.log('Slack interactive view_submission received', {
      channelId: modalChannelId,
      callbackId: normalizedPayload.callbackId,
      stateValues: normalizedPayload.stateValues.length,
    })

    pendingInteractions.set(modalInteractionId, {
      id: modalInteractionId,
      token: modalInteractionToken,
      channelId: modalChannelId,
      guildId: workspaceId,
      triggerId: normalizedPayload.triggerId,
      responseUrl: normalizedPayload.responseUrl,
      acknowledged: false,
    })

    gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
      id: modalInteractionId,
      application_id: botUserId,
      type: InteractionType.ModalSubmit,
      token: modalInteractionToken,
      version: 1,
      entitlements: [],
      channel_id: modalChannelId,
      guild_id: workspaceId,
      member: {
        user: {
          id: normalizedPayload.user.id,
          username:
            normalizedPayload.user.username ??
            normalizedPayload.user.name ??
            'unknown',
          discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
          avatar: null,
        },
        roles: [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
      },
      data: {
        custom_id: normalizedPayload.callbackId ?? 'modal',
        components: toDiscordModalComponents({
          stateValues: normalizedPayload.stateValues,
        }),
      },
    })
    return
  }

  // ---- Gateway Setup ----

  // Wrap the HTTP handler to catch Slack API errors and return Discord-shaped
  // error responses instead of generic 500s.
  const httpServer = http.createServer(async (req, res) => {
    try {
      const unauthorizedResponse = await authorizeIncomingRestRequest({
        authorize,
        request: req,
        workspaceId,
      })
      if (unauthorizedResponse) {
        res.writeHead(unauthorizedResponse.status, {
          'content-type': 'application/json',
        })
        res.end(JSON.stringify({
          code: unauthorizedResponse.code,
          message: unauthorizedResponse.message,
        }))
        return
      }
      await app.handleForNode(req, res)
    } catch (err) {
      if (err instanceof rest.DiscordApiError) {
        res.writeHead(err.httpStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: err.discordCode, message: err.message }))
        return
      }
      // Try mapping Slack SDK errors to Discord-shaped responses
      const mapped = rest.mapSlackErrorToDiscordError(err)
      res.writeHead(mapped.httpStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: mapped.discordCode, message: mapped.message }))
    }
  })

  const loadGatewayState = async (): Promise<GatewayState> => {
    // Build gateway state from Slack API
    const authResult = await slack.auth.test()
    const listArgs = {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    } satisfies ConversationsListArguments
    const channelsList = await slack.conversations.list(listArgs)

    const channels: GatewayGuildState['channels'] = (channelsList.channels ?? [])
      .filter((ch): ch is typeof ch & { id: string } => {
        return !!ch.id
      })
      .map((ch) => {
        return {
          id: ch.id,
          type: ChannelType.GuildText,
          name: ch.name ?? '',
          guild_id: workspaceId,
          topic: ch.topic?.value ?? null,
          position: 0,
        }
      })

    const workspaceName = authResult.team ?? 'Slack Workspace'
    const gatewayGuild = buildGatewayGuild({
      workspaceId,
      workspaceName,
      botUserId,
    })

    return {
      botUser: {
        id: botUserId,
        username: botUsername,
        discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
        avatar: null,
        global_name: botUsername,
      },
      guilds: [
        {
          id: workspaceId,
          apiGuild: gatewayGuild,
          joinedAt: new Date().toISOString(),
          members: [
            {
              user: {
                id: botUserId,
                username: botUsername,
                discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
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
    authorize,
    workspaceId,
    gatewayUrlOverride: resolveGatewayUrl({
      gatewayUrlOverride: config.gatewayUrlOverride,
      publicBaseUrl: config.publicBaseUrl,
      port,
    }),
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

function resolveGatewayUrl({
  request,
  gatewayUrlOverride,
  publicBaseUrl,
  port,
}: {
  request?: Request
  gatewayUrlOverride?: string
  publicBaseUrl?: string
  port: number
}): string {
  if (gatewayUrlOverride) {
    return gatewayUrlOverride
  }
  if (publicBaseUrl) {
    return buildWebSocketUrlFromHttpBase({
      httpBaseUrl: publicBaseUrl,
      path: '/gateway',
    })
  }
  if (request) {
    return buildWebSocketUrlFromHttpBase({
      httpBaseUrl: request.url,
      path: '/gateway',
    })
  }
  return `ws://127.0.0.1:${port}/gateway`
}

function buildWebSocketUrlFromHttpBase({
  httpBaseUrl,
  path,
}: {
  httpBaseUrl: string
  path: string
}): string {
  const baseUrl = new URL(httpBaseUrl)
  const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsBase = `${protocol}//${baseUrl.host}`
  return new URL(path, wsBase).toString()
}

async function authorizeIncomingRestRequest({
  authorize,
  request,
  workspaceId,
}: {
  authorize?: BridgeAuthorizeCallback
  request: http.IncomingMessage
  workspaceId: string
}): Promise<
  | { status: number; code: number; message: string }
  | undefined
> {
  if (!authorize) {
    return undefined
  }

  const method = request.method ?? 'GET'
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (!pathname.startsWith('/api/v10/')) {
    return undefined
  }
  if (isRestRouteAllowedWithoutAuth({ method, pathname })) {
    return undefined
  }

  const token = extractAuthorizationToken(request.headers.authorization)
  if (!token) {
    return {
      status: 401,
      code: 0,
      message: 'Missing authorization token',
    }
  }

  const result = await authorize({
    kind: 'rest',
    token,
    teamId: workspaceId,
    path: pathname,
    method,
  })
  if (!result.allow) {
    return {
      status: 401,
      code: 0,
      message: 'Authentication failed',
    }
  }

  if (
    !result.authorizedTeamIds?.includes(workspaceId)
  ) {
    return {
      status: 403,
      code: 50001,
      message: 'Missing access to Slack workspace',
    }
  }

  return undefined
}

function isRestRouteAllowedWithoutAuth({
  method,
  pathname,
}: {
  method: string
  pathname: string
}): boolean {
  const routeSegments = pathname.split('/').filter((segment) => {
    return segment.length > 0
  })
  if (routeSegments[0] !== 'api' || routeSegments[1] !== 'v10') {
    return false
  }

  const route = routeSegments.slice(2)
  const normalizedMethod = method.toUpperCase()
  if (route[0] === 'interactions') {
    return (
      normalizedMethod === 'POST' &&
      route[1] !== undefined &&
      route[1].length > 0 &&
      route[2] !== undefined &&
      route[2].length > 0 &&
      route[3] === 'callback' &&
      route.length === 4
    )
  }
  if (route[0] === 'webhooks') {
    return isTokenizedWebhookRouteAllowedWithoutAuth({
      method: normalizedMethod,
      route,
    })
  }

  return false
}

function isTokenizedWebhookRouteAllowedWithoutAuth({
  method,
  route,
}: {
  method: string
  route: string[]
}): boolean {
  if (!(route[1] && route[2])) {
    return false
  }

  if (route.length === 3) {
    return method === 'POST'
  }

  if (
    route.length === 5 &&
    route[3] === 'messages' &&
    route[4] !== undefined &&
    route[4].length > 0
  ) {
    return method === 'GET' || method === 'PATCH' || method === 'DELETE'
  }

  return (
    route.length >= 4 &&
    route[3] === 'messages' &&
    method === 'POST'
  )
}

function extractAuthorizationToken(
  authorizationHeader: string | string[] | undefined,
): string | undefined {
  const rawValue = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader
  if (!rawValue) {
    return undefined
  }
  const parts = rawValue.trim().split(/\s+/)
  const token = parts[parts.length - 1]
  return token || undefined
}

async function authorizeSlackInbound({
  authorize,
  kind,
  teamId,
  request,
  workspaceId,
}: {
  authorize?: BridgeAuthorizeCallback
  kind: 'webhook-event' | 'webhook-action'
  teamId?: string
  request: Request
  workspaceId: string
}): Promise<boolean> {
  if (!authorize) {
    return true
  }
  if (!teamId || teamId !== workspaceId) {
    return false
  }
  const result = await authorize({
    kind,
    teamId,
    request,
  })
  if (!result.allow) {
    return false
  }
  if (result.authorizedTeamIds) {
    return result.authorizedTeamIds.includes(teamId)
  }
  return true
}

function readInteractiveTeamId(payloadStr: string): string | undefined {
  try {
    const payload = JSON.parse(payloadStr)
    if (!isRecord(payload)) {
      return undefined
    }
    const teamRecord = readRecord(payload, 'team')
    if (teamRecord) {
      return readString(teamRecord, 'id')
    }
    return undefined
  } catch {
    return undefined
  }
}

function readSlackEventTeamId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const topLevelTeamId = readString(payload, 'team_id')
  if (topLevelTeamId) {
    return topLevelTeamId
  }

  const teamRecord = readRecord(payload, 'team')
  if (teamRecord) {
    const nestedTeamId = readString(teamRecord, 'id')
    if (nestedTeamId) {
      return nestedTeamId
    }
  }

  const authorizations = readArray(payload, 'authorizations')
  for (const authorization of authorizations) {
    if (!isRecord(authorization)) {
      continue
    }
    const teamId = readString(authorization, 'team_id')
    if (teamId) {
      return teamId
    }
  }

  return undefined
}

/** Evict oldest entries from a Set when it exceeds maxSize. */
function evictIfFull(set: Set<string>, maxSize: number): void {
  if (set.size < maxSize) {
    return
  }
  // Evict oldest 10% to avoid frequent evictions
  const evictCount = Math.max(1, Math.floor(maxSize * 0.1))
  let removed = 0
  for (const key of set) {
    if (removed >= evictCount) {
      break
    }
    set.delete(key)
    removed++
  }
}

function evictMapIfFull<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size < maxSize) {
    return
  }
  const evictCount = Math.max(1, Math.floor(maxSize * 0.1))
  const keys = [...map.keys()].slice(0, evictCount)
  for (const key of keys) {
    map.delete(key)
  }
}

function pruneExpiredEventIds({
  seenEventIds,
  now,
}: {
  seenEventIds: Map<string, number>
  now: number
}): void {
  for (const [eventId, expiresAt] of seenEventIds.entries()) {
    if (expiresAt <= now) {
      seenEventIds.delete(eventId)
    }
  }
}

/**
 * Resolve the actual message ID to use for webhook follow-up routes.
 * - `@original` → use the interaction's source message ts (pending.messageTs)
 * - any other value → use it as-is (already an encoded message ID or raw ts)
 * Returns undefined if @original is requested but no source message exists.
 */
function resolveWebhookMessageId({
  rawMessageId,
  pending,
  channelId,
}: {
  rawMessageId: string | undefined
  pending: PendingInteraction
  channelId: string
}): string | undefined {
  if (!rawMessageId || rawMessageId === '@original') {
    if (!pending.messageTs) {
      return undefined
    }
    return encodeMessageId(
      resolveSlackTarget(channelId).channel,
      pending.messageTs,
    )
  }
  return rawMessageId
}

function errorJsonResponse({
  status,
  error,
  code,
  message,
  details,
  errorDescription,
}: {
  status: number
  error: string
  code?: number
  message?: string
  details?: string
  errorDescription?: string
}): Response {
  const resolvedMessage = message ?? humanizeErrorCode(error)
  const resolvedErrorDescription =
    errorDescription ?? details ?? resolvedMessage

  return Response.json(
    {
      error,
      ...(code !== undefined ? { code } : {}),
      ...(resolvedMessage ? { message: resolvedMessage } : {}),
      ...(details ? { details } : {}),
      ...(resolvedErrorDescription
        ? { error_description: resolvedErrorDescription }
        : {}),
    },
    { status },
  )
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack
  }
  return undefined
}

function humanizeErrorCode(error: string): string {
  const withSpaces = error.replaceAll('_', ' ')
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1)
}

/** Return a Discord-shaped 404 for unknown guild IDs. */
function unknownGuildResponse(guildId: string): Response {
  return errorJsonResponse({
    status: 404,
    error: 'unknown_guild',
    code: 10004,
    message: `Unknown Guild: ${guildId}`,
  })
}

const SUPPORTED_SLACK_EVENT_TYPES: ReadonlySet<SupportedSlackEventType> =
  new Set<SupportedSlackEventType>([
    'message',
    'app_mention',
    'reaction_added',
    'reaction_removed',
    'channel_created',
    'channel_deleted',
    'channel_rename',
    'member_joined_channel',
  ])

const SUPPORTED_SLACK_ACTION_TYPES: ReadonlySet<NormalizedSlackAction['type']> =
  new Set<NormalizedSlackAction['type']>([
    'button',
    'static_select',
    'multi_static_select',
    'users_select',
    'multi_users_select',
    'conversations_select',
    'multi_conversations_select',
    'channels_select',
    'multi_channels_select',
  ])

function normalizeSlackEventEnvelope(
  payload: unknown,
): NormalizedSlackEventEnvelope | undefined {
  if (!isRecord(payload)) {
    return undefined
  }
  const payloadType = readString(payload, 'type')

  if (payloadType === 'url_verification') {
    const challenge = readString(payload, 'challenge')
    if (!challenge) {
      return undefined
    }
    return {
      type: 'url_verification',
      challenge,
    }
  }

  if (payloadType !== 'event_callback') {
    return undefined
  }

  const rawEvent = payload['event']
  const event = normalizeSlackEvent(rawEvent)
  if (!event) {
    return undefined
  }

  return {
    type: 'event_callback',
    eventId: readString(payload, 'event_id'),
    event,
  }
}

function normalizeSlackEvent(event: unknown): NormalizedSlackEvent | undefined {
  if (!isRecord(event)) {
    return undefined
  }

  const eventType = readString(event, 'type')
  if (!eventType) {
    return undefined
  }
  const supportedType = normalizeSupportedSlackEventType(eventType)
  if (!supportedType) {
    return undefined
  }

  if (supportedType === 'reaction_added' || supportedType === 'reaction_removed') {
    return normalizeSlackReactionEvent({
      event,
      type: supportedType,
    })
  }

  if (supportedType === 'channel_created') {
    const channel = readRecord(event, 'channel')
    const channelId = channel ? readString(channel, 'id') : undefined
    const channelName = channel ? readString(channel, 'name') : undefined
    if (!(channelId && channelName)) {
      return undefined
    }
    return {
      type: 'channel_created',
      channelId,
      channelName,
    }
  }

  if (supportedType === 'channel_deleted') {
    const channel = readString(event, 'channel')
    if (!channel) {
      return undefined
    }
    return {
      type: 'channel_deleted',
      channelId: channel,
    }
  }

  if (supportedType === 'channel_rename') {
    const channel = readRecord(event, 'channel')
    const channelId = channel ? readString(channel, 'id') : undefined
    const channelName = channel ? readString(channel, 'name') : undefined
    if (!(channelId && channelName)) {
      return undefined
    }
    return {
      type: 'channel_rename',
      channelId,
      channelName,
    }
  }

  if (supportedType === 'member_joined_channel') {
    const userId = readString(event, 'user')
    const channelId = readString(event, 'channel')
    if (!(userId && channelId)) {
      return undefined
    }
    return {
      type: 'member_joined_channel',
      userId,
      channelId,
    }
  }

  return normalizeSlackMessageEvent({
    event,
    type: supportedType,
  })
}

function normalizeSlackMessageEvent({
  event,
  type,
}: {
  event: Record<string, unknown>
  type: 'message' | 'app_mention'
}): NormalizedSlackMessageEvent | undefined {
  const channel = readString(event, 'channel')
  if (!channel) {
    return undefined
  }

  return {
    type,
    subtype: readString(event, 'subtype'),
    channel,
    user: readString(event, 'user'),
    botId: readString(event, 'bot_id'),
    text: readString(event, 'text'),
    ts: readString(event, 'ts'),
    threadTs: readString(event, 'thread_ts'),
    message: normalizeSlackMessage(readRecord(event, 'message')),
    previousMessage: normalizeSlackMessage(readRecord(event, 'previous_message')),
    deletedTs: readString(event, 'deleted_ts'),
    files: normalizeSlackFiles(readArray(event, 'files')),
  }
}

function normalizeSlackMessage(
  message: Record<string, unknown> | undefined,
): NormalizedSlackMessage | undefined {
  if (!message) {
    return undefined
  }
  const ts = readString(message, 'ts')
  if (!ts) {
    return undefined
  }

  const edited = readRecord(message, 'edited')
  return {
    user: readString(message, 'user'),
    botId: readString(message, 'bot_id'),
    text: readString(message, 'text'),
    ts,
    threadTs: readString(message, 'thread_ts'),
    editedTs: edited ? readString(edited, 'ts') : undefined,
    files: normalizeSlackFiles(readArray(message, 'files')),
  }
}

function normalizeSlackFiles(rawFiles: unknown[]): NormalizedSlackMessage['files'] {
  const files = rawFiles
    .map((rawFile) => {
      if (!isRecord(rawFile)) {
        return undefined
      }
      const id = readString(rawFile, 'id')
      const name = readString(rawFile, 'name')
      if (!(id && name)) {
        return undefined
      }
      return {
        id,
        name,
        mimetype: readString(rawFile, 'mimetype') ?? undefined,
        urlPrivate: readString(rawFile, 'url_private') ?? undefined,
        permalink: readString(rawFile, 'permalink') ?? undefined,
        size: readNumber(rawFile, 'size') ?? undefined,
      }
    })
    .filter(isDefined)

  return files.length > 0 ? files : undefined
}

function normalizeSlackReactionEvent({
  event,
  type,
}: {
  event: Record<string, unknown>
  type: 'reaction_added' | 'reaction_removed'
}): NormalizedSlackReactionEvent | undefined {
  const user = readString(event, 'user')
  const reaction = readString(event, 'reaction')
  const item = readRecord(event, 'item')
  if (!(user && reaction && item)) {
    return undefined
  }
  const itemType = readString(item, 'type')
  const itemChannel = readString(item, 'channel')
  const itemTs = readString(item, 'ts')
  if (!(itemType && itemChannel && itemTs)) {
    return undefined
  }

  return {
    type,
    user,
    reaction,
    item: {
      type: itemType,
      channel: itemChannel,
      ts: itemTs,
    },
    item_user: readString(event, 'item_user'),
    event_ts: readString(event, 'event_ts'),
  }
}

function normalizeSlackBlockActionsPayload(
  payload: SlackBlockActionsPayload,
): NormalizedSlackBlockActionsPayload | undefined {
  const userId = payload.user.id
  if (!userId) {
    return undefined
  }

  const channel = payload.channel
  const message = payload.message
  const container = payload.container
  const actions = payload.actions
    .map((rawAction) => {
      return normalizeSlackAction(rawAction)
    })
    .filter(isDefined)
  if (actions.length === 0) {
    return undefined
  }

  return {
    type: 'block_actions',
    triggerId: payload.trigger_id,
    responseUrl: payload.response_url,
    user: {
      id: userId,
      username: payload.user.username,
      name: payload.user.name,
    },
    channelId:
      (channel ? channel.id : undefined) ??
      (container ? container.channel_id : undefined),
    messageTs:
      (message ? message.ts : undefined) ??
      (container ? container.message_ts : undefined),
    threadTs:
      (message ? message.thread_ts : undefined) ??
      (container ? container.thread_ts : undefined),
    actions,
  }
}

function normalizeSlackViewSubmissionPayload(
  payload: SlackViewSubmissionPayload,
): NormalizedSlackViewSubmissionPayload | undefined {
  const userId = payload.user.id
  if (!userId) {
    return undefined
  }

  const view = payload.view
  const stateValues = normalizeSlackViewSubmissionStateValues(view)
  const channelId = extractChannelIdFromViewPayload(view)
  const responseUrl = extractResponseUrlFromViewPayload(view)

  return {
    type: 'view_submission',
    triggerId: payload.trigger_id,
    responseUrl,
    user: {
      id: userId,
      username: payload.user.username,
      name: payload.user.name,
    },
    channelId,
    viewId: view ? view.id : undefined,
    callbackId: view ? view.callback_id : undefined,
    privateMetadata: view ? view.private_metadata : undefined,
    stateValues,
  }
}

function parseSlackInteractivePayload(payload: unknown): SlackInteractivePayload | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const payloadType = readString(payload, 'type')
  if (payloadType === 'block_actions') {
    const user = readRecord(payload, 'user')
    const userId = user ? readString(user, 'id') : undefined
    if (!userId) {
      return undefined
    }

    const actions = readArray(payload, 'actions')
    if (actions.length === 0) {
      return undefined
    }

    const typedPayload: SlackBlockActionsPayload = {
      type: 'block_actions',
      trigger_id: readString(payload, 'trigger_id'),
      response_url: readString(payload, 'response_url'),
      user: {
        id: userId,
        username: user ? readString(user, 'username') : undefined,
        name: user ? readString(user, 'name') : undefined,
      },
      channel: (() => {
        const channel = readRecord(payload, 'channel')
        return channel
          ? {
              id: readString(channel, 'id'),
            }
          : undefined
      })(),
      message: (() => {
        const message = readRecord(payload, 'message')
        return message
          ? {
              ts: readString(message, 'ts'),
              thread_ts: readString(message, 'thread_ts'),
            }
          : undefined
      })(),
      container: (() => {
        const container = readRecord(payload, 'container')
        return container
          ? {
              channel_id: readString(container, 'channel_id'),
              message_ts: readString(container, 'message_ts'),
              thread_ts: readString(container, 'thread_ts'),
            }
          : undefined
      })(),
      actions: actions
        .map((rawAction) => {
          return parseSlackInteractiveAction(rawAction)
        })
        .filter(isDefined),
    }

    if (typedPayload.actions.length === 0) {
      return undefined
    }
    return typedPayload
  }

  if (payloadType === 'view_submission') {
    const user = readRecord(payload, 'user')
    const userId = user ? readString(user, 'id') : undefined
    if (!userId) {
      return undefined
    }

    const view = readRecord(payload, 'view')
    const typedPayload: SlackViewSubmissionPayload = {
      type: 'view_submission',
      trigger_id: readString(payload, 'trigger_id'),
      response_url: readString(payload, 'response_url'),
      user: {
        id: userId,
        username: user ? readString(user, 'username') : undefined,
        name: user ? readString(user, 'name') : undefined,
      },
      view: view
        ? {
            id: readString(view, 'id'),
            callback_id: readString(view, 'callback_id'),
            private_metadata: readString(view, 'private_metadata'),
            response_urls: readArray(view, 'response_urls')
              .map((entry) => {
                if (!isRecord(entry)) {
                  return undefined
                }
                return {
                  response_url: readString(entry, 'response_url'),
                }
              })
              .filter(isDefined),
            state: (() => {
              const state = readRecord(view, 'state')
              const values = state ? readRecord(state, 'values') : undefined
              if (!values) {
                return undefined
              }

              const typedValues = Object.entries(values).reduce<
                Record<
                  string,
                  Record<
                    string,
                    {
                      value?: string
                      selected_option?: { value?: string }
                      selected_user?: string
                      selected_channel?: string
                      selected_conversation?: string
                    }
                  >
                >
              >((acc, [blockId, rawBlockValue]) => {
                if (!isRecord(rawBlockValue)) {
                  return acc
                }

                const typedBlockValues = Object.entries(rawBlockValue).reduce<
                  Record<
                    string,
                    {
                      value?: string
                      selected_option?: { value?: string }
                      selected_user?: string
                      selected_channel?: string
                      selected_conversation?: string
                    }
                  >
                >((blockAcc, [actionId, rawActionValue]) => {
                  if (!isRecord(rawActionValue)) {
                    return blockAcc
                  }

                  blockAcc[actionId] = {
                    value: readString(rawActionValue, 'value'),
                    selected_option: (() => {
                      const selectedOption = readRecord(rawActionValue, 'selected_option')
                      if (!selectedOption) {
                        return undefined
                      }
                      return {
                        value: readString(selectedOption, 'value'),
                      }
                    })(),
                    selected_user: readString(rawActionValue, 'selected_user'),
                    selected_channel: readString(rawActionValue, 'selected_channel'),
                    selected_conversation: readString(rawActionValue, 'selected_conversation'),
                  }
                  return blockAcc
                }, {})

                acc[blockId] = typedBlockValues
                return acc
              }, {})

              return {
                values: typedValues,
              }
            })(),
          }
        : undefined,
    }

    return typedPayload
  }

  return undefined
}

function parseSlackInteractiveAction(
  value: unknown,
): SlackBlockActionsPayload['actions'][number] | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const actionId = readString(value, 'action_id')
  const type = readString(value, 'type')
  if (!(actionId && type)) {
    return undefined
  }

  return {
    action_id: actionId,
    type,
    value: readString(value, 'value'),
    selected_option: (() => {
      const option = readRecord(value, 'selected_option')
      if (!option) {
        return undefined
      }
      return { value: readString(option, 'value') }
    })(),
    selected_options: readArray(value, 'selected_options')
      .map((entry) => {
        if (!isRecord(entry)) {
          return undefined
        }
        return {
          value: readString(entry, 'value'),
        }
      })
      .filter(isDefined),
    selected_user: readString(value, 'selected_user'),
    selected_users: readArray(value, 'selected_users').filter((entry): entry is string => {
      return typeof entry === 'string'
    }),
    selected_channel: readString(value, 'selected_channel'),
    selected_channels: readArray(value, 'selected_channels').filter((entry): entry is string => {
      return typeof entry === 'string'
    }),
    selected_conversation: readString(value, 'selected_conversation'),
    selected_conversations: readArray(value, 'selected_conversations').filter((entry): entry is string => {
      return typeof entry === 'string'
    }),
  }
}

export function normalizeSlackInteractivePayload(
  payload: unknown,
): NormalizedSlackInteractivePayload | undefined {
  const typedPayload = parseSlackInteractivePayload(payload)
  if (!typedPayload) {
    return undefined
  }
  if (typedPayload.type === 'block_actions') {
    return normalizeSlackBlockActionsPayload(typedPayload)
  }
  return normalizeSlackViewSubmissionPayload(typedPayload)
}

function normalizeSlackViewSubmissionStateValues(
  view: SlackViewSubmissionPayload['view'] | undefined,
): NormalizedSlackViewSubmissionStateValue[] {
  if (!view) {
    return []
  }
  const values = view.state?.values
  if (!values) {
    return []
  }

  const collectedValues: NormalizedSlackViewSubmissionStateValue[] = []
  for (const [blockId, rawBlockValue] of Object.entries(values)) {
    if (!isRecord(rawBlockValue)) {
      continue
    }
    for (const [actionId, rawActionValue] of Object.entries(rawBlockValue)) {
      if (!isRecord(rawActionValue)) {
        continue
      }
      const extractedValue =
        readString(rawActionValue, 'value') ??
        readViewOptionValue(rawActionValue, 'selected_option') ??
        readString(rawActionValue, 'selected_user') ??
        readString(rawActionValue, 'selected_channel') ??
        readString(rawActionValue, 'selected_conversation') ??
        ''
      collectedValues.push({
        blockId,
        actionId,
        value: extractedValue,
      })
    }
  }

  return collectedValues
}

function readViewOptionValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const option = readRecord(record, key)
  return option ? readString(option, 'value') : undefined
}

function extractChannelIdFromViewPayload(
  view: SlackViewSubmissionPayload['view'] | undefined,
): string | undefined {
  if (!view) {
    return undefined
  }
  const privateMetadata = view.private_metadata
  if (!privateMetadata) {
    return undefined
  }
  try {
    const metadata = JSON.parse(privateMetadata)
    if (!isRecord(metadata)) {
      return undefined
    }
    return readString(metadata, 'channel_id')
  } catch {
    return undefined
  }
}

function extractResponseUrlFromViewPayload(
  view: SlackViewSubmissionPayload['view'] | undefined,
): string | undefined {
  if (!view) {
    return undefined
  }
  const responseUrls = Array.isArray(view.response_urls) ? view.response_urls : []
  for (const responseUrlEntry of responseUrls) {
    const responseUrl = responseUrlEntry.response_url
    if (responseUrl) {
      return responseUrl
    }
  }
  return undefined
}

export function toDiscordModalComponents({
  stateValues,
}: {
  stateValues: NormalizedSlackViewSubmissionStateValue[]
}): Array<{
  type: number
  components: Array<{ type: number; custom_id: string; value: string }>
}> {
  return stateValues.map((entry) => {
    return {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.TextInput,
          custom_id: entry.actionId,
          value: entry.value,
        },
      ],
    }
  })
}

function normalizeSlackAction(rawAction: SlackBlockActionsPayload['actions'][number]): NormalizedSlackAction | undefined {
  const actionId = rawAction.action_id
  const actionType = rawAction.type
  if (!(actionId && actionType)) {
    return undefined
  }
  const normalizedActionType = normalizeSupportedSlackActionType(actionType)
  if (!normalizedActionType) {
    return undefined
  }

  return {
    actionId,
    type: normalizedActionType,
    value: rawAction.value,
    selectedOptionValue: rawAction.selected_option?.value,
    selectedOptionValues: normalizeOptionValues(rawAction.selected_options),
    selectedUser: rawAction.selected_user,
    selectedUsers: normalizeStringValues(rawAction.selected_users),
    selectedChannel: rawAction.selected_channel,
    selectedChannels: normalizeStringValues(rawAction.selected_channels),
    selectedConversation: rawAction.selected_conversation,
    selectedConversations: normalizeStringValues(rawAction.selected_conversations),
  }
}

function normalizeOptionValues(
  options: SlackBlockActionsPayload['actions'][number]['selected_options'],
): string[] {
  if (!Array.isArray(options)) {
    return []
  }
  return options
    .map((option) => {
      return option?.value
    })
    .filter(isDefined)
}

function normalizeStringValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return []
  }
  return values
}

function readOptionValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const option = readRecord(record, key)
  return option ? readString(option, 'value') : undefined
}

function readOptionValues(
  record: Record<string, unknown>,
  key: string,
): string[] {
  return readArray(record, key)
    .map((entry) => {
      return isRecord(entry) ? readString(entry, 'value') : undefined
    })
    .filter(isDefined)
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  return readArray(record, key)
    .filter((entry): entry is string => {
      return typeof entry === 'string'
    })
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function normalizeSupportedSlackEventType(
  value: string,
): SupportedSlackEventType | undefined {
  if (value === 'message') {
    return value
  }
  if (value === 'app_mention') {
    return value
  }
  if (value === 'reaction_added') {
    return value
  }
  if (value === 'reaction_removed') {
    return value
  }
  if (value === 'channel_created') {
    return value
  }
  if (value === 'channel_deleted') {
    return value
  }
  if (value === 'channel_rename') {
    return value
  }
  if (value === 'member_joined_channel') {
    return value
  }
  return undefined
}

function normalizeSupportedSlackActionType(
  value: string,
): NormalizedSlackAction['type'] | undefined {
  if (value === 'button') {
    return value
  }
  if (value === 'static_select') {
    return value
  }
  if (value === 'multi_static_select') {
    return value
  }
  if (value === 'users_select') {
    return value
  }
  if (value === 'multi_users_select') {
    return value
  }
  if (value === 'conversations_select') {
    return value
  }
  if (value === 'multi_conversations_select') {
    return value
  }
  if (value === 'channels_select') {
    return value
  }
  if (value === 'multi_channels_select') {
    return value
  }
  return undefined
}

function collectInteractivePayloadDebugInfo(payload: unknown): {
  payloadType?: string
  actionTypes: string[]
  actionCount: number
  hasChannelId: boolean
  hasContainerChannelId: boolean
  hasMessageTs: boolean
  hasContainerMessageTs: boolean
  hasThreadTs: boolean
} {
  if (!isRecord(payload)) {
    return {
      actionTypes: [],
      actionCount: 0,
      hasChannelId: false,
      hasContainerChannelId: false,
      hasMessageTs: false,
      hasContainerMessageTs: false,
      hasThreadTs: false,
    }
  }

  const actions = readArray(payload, 'actions')
  const actionTypes = actions
    .map((entry) => {
      return isRecord(entry) ? readString(entry, 'type') : undefined
    })
    .filter(isDefined)
  const channel = readRecord(payload, 'channel')
  const container = readRecord(payload, 'container')
  const message = readRecord(payload, 'message')

  return {
    payloadType: readString(payload, 'type'),
    actionTypes,
    actionCount: actions.length,
    hasChannelId: Boolean(channel ? readString(channel, 'id') : undefined),
    hasContainerChannelId: Boolean(
      container ? readString(container, 'channel_id') : undefined,
    ),
    hasMessageTs: Boolean(message ? readString(message, 'ts') : undefined),
    hasContainerMessageTs: Boolean(
      container ? readString(container, 'message_ts') : undefined,
    ),
    hasThreadTs: Boolean(
      (message ? readString(message, 'thread_ts') : undefined) ??
        (container ? readString(container, 'thread_ts') : undefined),
    ),
  }
}

async function normalizePostMessageRequestBody(
  request: Request,
): Promise<NormalizedPostMessageBody> {
  const contentType = request.headers.get('content-type') ?? ''
  const isMultipart = contentType.toLowerCase().includes('multipart/form-data')
  if (!isMultipart) {
    return normalizePostMessageBody(await request.json())
  }

  const formData = await request.formData()
  const payloadJson = formData.get('payload_json')
  const payloadValue = (() => {
    if (typeof payloadJson !== 'string') {
      return undefined
    }
    try {
      return JSON.parse(payloadJson)
    } catch {
      return undefined
    }
  })()

  const normalizedPayload = normalizePostMessageBody(payloadValue)
  const attachments = await normalizeMultipartAttachments({
    formData,
    payloadValue,
  })

  return {
    content: normalizedPayload.content,
    embeds: normalizedPayload.embeds,
    components: normalizedPayload.components,
    attachments,
  }
}

function normalizePostMessageBody(value: unknown): NormalizedPostMessageBody {
  if (!isRecord(value)) {
    return {}
  }
  const embeds = Array.isArray(value.embeds) ? value.embeds : undefined
  const components = Array.isArray(value.components) ? value.components : undefined
  const attachments = normalizeAttachmentDescriptors(value)
  return {
    content: readString(value, 'content'),
    embeds,
    components,
    attachments,
  }
}

function normalizeAttachmentDescriptors(value: Record<string, unknown>):
  | DiscordAttachment[]
  | undefined {
  const rawAttachments = Array.isArray(value.attachments)
    ? value.attachments
    : []
  if (rawAttachments.length === 0) {
    return undefined
  }

  const descriptors = rawAttachments
    .map((rawAttachment) => {
      if (!isRecord(rawAttachment)) {
        return undefined
      }
      const id = readString(rawAttachment, 'id')
      const filename = readString(rawAttachment, 'filename')
      const size = readNumber(rawAttachment, 'size')
      const url = readString(rawAttachment, 'url')
      if (!(id && filename && typeof size === 'number' && size > 0 && url)) {
        return undefined
      }
      return {
        id,
        filename,
        size,
        url,
        content_type: readString(rawAttachment, 'content_type') ?? undefined,
      } satisfies DiscordAttachment
    })
    .filter(isDefined)

  return descriptors.length > 0 ? descriptors : undefined
}

async function normalizeMultipartAttachments({
  formData,
  payloadValue,
}: {
  formData: FormData
  payloadValue: unknown
}): Promise<DiscordAttachment[] | undefined> {
  const payloadRecord = isRecord(payloadValue) ? payloadValue : undefined
  const payloadAttachments = Array.isArray(payloadRecord?.attachments)
    ? payloadRecord.attachments
    : []

  const files = await Promise.all(
    [...formData.entries()].map(async ([fieldName, fieldValue]) => {
      if (!(fieldValue instanceof File)) {
        return undefined
      }
      const index = parseFileFieldIndex(fieldName)
      const payloadAttachment =
        index === undefined
          ? undefined
          : payloadAttachments[index]
      const payloadRecordValue = isRecord(payloadAttachment)
        ? payloadAttachment
        : undefined
      const fileId =
        (payloadRecordValue ? readString(payloadRecordValue, 'id') : undefined)
        ?? (index !== undefined ? String(index) : fieldName)
      const filename =
        (payloadRecordValue
          ? readString(payloadRecordValue, 'filename')
          : undefined)
        ?? fieldValue.name
      const mimeType = fieldValue.type || 'application/octet-stream'
      const dataBuffer = Buffer.from(await fieldValue.arrayBuffer())
      return {
        id: fileId,
        filename,
        size: fieldValue.size,
        url: `buffer://${fileId}`,
        content_type: mimeType,
        data: dataBuffer,
      } satisfies DiscordAttachment
    }),
  )

  const normalizedFiles = files.filter(isDefined)

  if (normalizedFiles.length === 0) {
    return normalizeAttachmentDescriptors(payloadRecord ?? {})
  }

  return normalizedFiles
}

function parseFileFieldIndex(fieldName: string): number | undefined {
  const match = /^files\[(\d+)\]$/.exec(fieldName)
  if (!match) {
    return undefined
  }
  const index = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(index)) {
    return undefined
  }
  return index
}

function normalizeEditMessageBody(value: unknown): { content?: string } {
  if (!isRecord(value)) {
    return {}
  }
  return {
    content: readString(value, 'content'),
  }
}

function normalizeCreateThreadBody(value: unknown): {
  name: string
  auto_archive_duration?: number
} {
  if (!isRecord(value)) {
    return { name: 'thread' }
  }
  return {
    name: readString(value, 'name') ?? 'thread',
    auto_archive_duration: readNumber(value, 'auto_archive_duration'),
  }
}

function normalizePatchChannelBody(value: unknown): {
  name?: string
  topic?: string
  archived?: boolean
} {
  if (!isRecord(value)) {
    return {}
  }

  return {
    name: readString(value, 'name'),
    topic: readString(value, 'topic'),
    archived: readBoolean(value, 'archived'),
  }
}

function normalizeCreateGuildChannelBody(value: unknown): {
  name: string
  type?: ChannelType
} {
  if (!isRecord(value)) {
    return { name: 'channel' }
  }

  const channelType = readNumber(value, 'type')
  const normalizedType =
    channelType === ChannelType.GuildText ||
    channelType === ChannelType.GuildAnnouncement
      ? channelType
      : undefined

  return {
    name: readString(value, 'name') ?? 'channel',
    type: normalizedType,
  }
}

type NormalizedApplicationCommandInput = {
  name: string
  description: string
  type: ApplicationCommandType
  defaultMemberPermissions?: string | null
  dmPermission?: boolean
  nsfw?: boolean
}

function normalizeApplicationCommandsBody(
  value: unknown,
): NormalizedApplicationCommandInput[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined
      }
      const name = readString(entry, 'name')
      if (!name) {
        return undefined
      }
      const rawType = readNumber(entry, 'type')
      const type =
        rawType === ApplicationCommandType.User ||
        rawType === ApplicationCommandType.Message ||
        rawType === ApplicationCommandType.ChatInput
          ? rawType
          : ApplicationCommandType.ChatInput
      const description = readString(entry, 'description') ?? ''
      return {
        name,
        description,
        type,
        defaultMemberPermissions: readString(entry, 'default_member_permissions') ?? null,
        dmPermission: readBoolean(entry, 'dm_permission'),
        nsfw: readBoolean(entry, 'nsfw'),
      } satisfies NormalizedApplicationCommandInput
    })
    .filter(isDefined)
}

function createApplicationCommandRecord({
  applicationId,
  guildId,
  command,
}: {
  applicationId: string
  guildId?: string
  command: NormalizedApplicationCommandInput
}): APIApplicationCommand {
  const id = createSnowflakeLikeId()
  const version = createSnowflakeLikeId()
  return {
    id,
    application_id: applicationId,
    ...(guildId ? { guild_id: guildId } : {}),
    name: command.name,
    description: command.description,
    type: command.type,
    default_member_permissions: command.defaultMemberPermissions ?? null,
    dm_permission: command.dmPermission ?? true,
    nsfw: command.nsfw ?? false,
    version,
  }
}

function getGlobalCommandRegistryKey({
  applicationId,
}: {
  applicationId: string
}): string {
  return `global:${applicationId}`
}

function getGuildCommandRegistryKey({
  applicationId,
  guildId,
}: {
  applicationId: string
  guildId: string
}): string {
  return `guild:${applicationId}:${guildId}`
}

function mergeActiveThreadsWithKnown({
  active,
  knownThreadChannels,
  botUserId,
}: {
  active: APIThreadList
  knownThreadChannels: Map<string, APIChannel>
  botUserId: string
}): APIThreadList {
  const mergedThreads = new Map<string, APIChannel>(
    active.threads.map((thread) => {
      return [thread.id, thread]
    }),
  )
  for (const [threadId, thread] of knownThreadChannels.entries()) {
    if (!mergedThreads.has(threadId)) {
      mergedThreads.set(threadId, thread)
    }
  }

  const mergedMembers = new Map<string, APIThreadMember>(
    active.members.map((member) => {
      return [`${member.id}:${member.user_id}`, member]
    }),
  )
  for (const threadId of knownThreadChannels.keys()) {
    const key = `${threadId}:${botUserId}`
    if (!mergedMembers.has(key)) {
      mergedMembers.set(key, {
        id: threadId,
        user_id: botUserId,
        join_timestamp: new Date().toISOString(),
        flags: noFlags<ThreadMemberFlags>(),
      })
    }
  }

  return {
    threads: [...mergedThreads.values()],
    members: [...mergedMembers.values()],
  }
}

function createSnowflakeLikeId(): string {
  return `${Date.now()}${randomSixDigitSuffix()}`
}

function noFlags<T>(): T {
  return 0 as T
}

function normalizeInteractionCallbackBody(value: unknown): {
  type: number
  data?: {
    content?: string
    flags?: number
    components?: unknown[]
    custom_id?: string
    title?: string
    submit?: string
    cancel?: string
  }
} {
  if (!isRecord(value)) {
    return { type: InteractionResponseType.DeferredMessageUpdate }
  }
  const rawData = readRecord(value, 'data')
  const data = rawData
    ? {
        content: readString(rawData, 'content'),
        flags: readNumber(rawData, 'flags'),
        components: readArray(rawData, 'components'),
        custom_id: readString(rawData, 'custom_id'),
        title: readString(rawData, 'title'),
        submit: readString(rawData, 'submit'),
        cancel: readString(rawData, 'cancel'),
      }
    : undefined
  return {
    type: readNumber(value, 'type') ?? InteractionResponseType.DeferredMessageUpdate,
    data,
  }
}

function normalizeWebhookBody(value: unknown): { content?: string } {
  if (!isRecord(value)) {
    return {}
  }
  return {
    content: readString(value, 'content'),
  }
}

function normalizeModalInteractionResponseData(data: {
  custom_id?: string
  title?: string
  submit?: string
  cancel?: string
  components?: unknown[]
}): {
  custom_id?: string
  title?: string
  submit?: string
  cancel?: string
  components?: APIActionRowComponent<APITextInputComponent>[]
} {
  return {
    custom_id: data.custom_id,
    title: data.title,
    submit: data.submit,
    cancel: data.cancel,
    components: normalizeModalComponents(data.components),
  }
}

export function normalizeModalComponents(
  components: unknown[] | undefined,
): APIActionRowComponent<APITextInputComponent>[] {
  const rows = Array.isArray(components) ? components : []
  const normalizedRows = rows
    .map((row) => {
      if (!isRecord(row)) {
        return undefined
      }
      if (readNumber(row, 'type') !== ComponentType.ActionRow) {
        return undefined
      }

      const rowComponents = readArray(row, 'components')
        .map((component) => {
          if (!isRecord(component)) {
            return undefined
          }
          if (readNumber(component, 'type') !== ComponentType.TextInput) {
            return undefined
          }

          const customId = readString(component, 'custom_id')
          const style = readNumber(component, 'style')
          const label = readString(component, 'label')
          if (!(customId && label && style)) {
            return undefined
          }

          const normalizedStyle =
            style === TextInputStyle.Paragraph
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short

          const normalizedComponent = {
            type: ComponentType.TextInput,
            custom_id: customId,
            style: normalizedStyle,
            label,
            required: readBoolean(component, 'required'),
            value: readString(component, 'value'),
            placeholder: readString(component, 'placeholder'),
            min_length: readNumber(component, 'min_length'),
            max_length: readNumber(component, 'max_length'),
          } satisfies APITextInputComponent

          return normalizedComponent
        })
        .filter(isDefined)

      if (rowComponents.length === 0) {
        return undefined
      }

      const normalizedRow = {
        type: ComponentType.ActionRow,
        components: rowComponents,
      } satisfies APIActionRowComponent<APITextInputComponent>

      return normalizedRow
    })
    .filter(isDefined)

  return normalizedRows
}



function buildGatewayGuild({
  workspaceId,
  workspaceName,
  botUserId,
}: {
  workspaceId: string
  workspaceName: string
  botUserId: string
}): APIGuild {
  const guild: APIGuild = {
    id: workspaceId,
    name: workspaceName,
    icon: null,
    splash: null,
    discovery_splash: null,
    owner_id: botUserId,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: GuildVerificationLevel.None,
    default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
    explicit_content_filter: GuildExplicitContentFilter.Disabled,
    roles: [],
    emojis: [],
    features: [],
    mfa_level: GuildMFALevel.None,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: GuildSystemChannelFlags.SuppressJoinNotifications,
    rules_channel_id: null,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: GuildPremiumTier.None,
    premium_subscription_count: 0,
    preferred_locale: Locale.EnglishUS,
    public_updates_channel_id: null,
    nsfw_level: GuildNSFWLevel.Default,
    max_video_channel_users: 0,
    max_stage_video_channel_users: 0,
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
    stickers: [],
    region: '',
    hub_type: null,
    incidents_data: null,
  }
  return guild
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function slackActionTypeToDiscordComponentType(
  actionType: NormalizedSlackAction['type'],
): ComponentType | undefined {
  if (actionType === 'button') {
    return ComponentType.Button
  }
  if (actionType === 'static_select') {
    return ComponentType.StringSelect
  }
  if (actionType === 'multi_static_select') {
    return ComponentType.StringSelect
  }
  if (actionType === 'users_select') {
    return ComponentType.UserSelect
  }
  if (actionType === 'multi_users_select') {
    return ComponentType.UserSelect
  }
  if (actionType === 'conversations_select') {
    return ComponentType.ChannelSelect
  }
  if (actionType === 'multi_conversations_select') {
    return ComponentType.ChannelSelect
  }
  if (actionType === 'channels_select') {
    return ComponentType.ChannelSelect
  }
  if (actionType === 'multi_channels_select') {
    return ComponentType.ChannelSelect
  }
  return undefined
}

function extractActionValues(action: NormalizedSlackAction): string[] {
  const selectedOptions = action.selectedOptionValues
  if (selectedOptions.length > 0) {
    return selectedOptions
  }

  if (action.selectedOptionValue) {
    return [action.selectedOptionValue]
  }
  if (action.selectedUser) {
    return [action.selectedUser]
  }
  if (action.selectedUsers.length > 0) {
    return action.selectedUsers
  }
  if (action.selectedChannel) {
    return [action.selectedChannel]
  }
  if (action.selectedChannels.length > 0) {
    return action.selectedChannels
  }
  if (action.selectedConversation) {
    return [action.selectedConversation]
  }
  if (action.selectedConversations.length > 0) {
    return action.selectedConversations
  }
  return []
}

export function buildDiscordComponentDataFromSlackAction({
  action,
}: {
  action: NormalizedSlackAction
}): {
  componentType: ComponentType
  values: string[]
} {
  const componentType = slackActionTypeToDiscordComponentType(action.type)
  const decodedAction = decodeComponentActionId(action.actionId)
  return {
    componentType: decodedAction.componentType ?? componentType ?? ComponentType.Button,
    values: extractActionValues(action),
  }
}

export function buildResolvedData({
  componentType,
  values,
}: {
  componentType: ComponentType
  values: string[]
}):
  | { resolved: Record<string, unknown> }
  | undefined {
  if (values.length === 0) {
    return undefined
  }

  if (componentType === ComponentType.UserSelect) {
    const users = values.reduce<Record<string, unknown>>((acc, id) => {
      acc[id] = {
        id,
        username: id,
        discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
        avatar: null,
      }
      return acc
    }, {})
    return { resolved: { users } }
  }

  if (componentType === ComponentType.ChannelSelect) {
    const channels = values.reduce<Record<string, unknown>>((acc, id) => {
      acc[id] = {
        id,
        type: ChannelType.GuildText,
        name: id,
        permissions: DISCORD_ZERO_PERMISSIONS,
      }
      return acc
    }, {})
    return { resolved: { channels } }
  }

  if (componentType === ComponentType.RoleSelect) {
    const roles = values.reduce<Record<string, unknown>>((acc, id) => {
      acc[id] = {
        id,
        name: id,
        color: 0,
        hoist: false,
        icon: null,
        unicode_emoji: null,
        position: 0,
        permissions: DISCORD_ZERO_PERMISSIONS,
        managed: false,
        mentionable: false,
        flags: 0,
      }
      return acc
    }, {})
    return { resolved: { roles } }
  }

  if (componentType === ComponentType.MentionableSelect) {
    const users = values.reduce<Record<string, unknown>>((acc, id) => {
      acc[id] = {
        id,
        username: id,
        discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
        avatar: null,
      }
      return acc
    }, {})
    return { resolved: { users } }
  }

  return undefined
}

async function resolveThreadTsForReaction({
  slack,
  event,
}: {
  slack: WebClient
  event: NormalizedSlackReactionEvent
}): Promise<string | undefined> {
  if (event.item.type !== 'message') {
    return undefined
  }

  try {
    const args = {
      channel: event.item.channel,
      ts: event.item.ts,
      limit: 1,
    } satisfies ConversationsRepliesArguments
    const result = await slack.conversations.replies(args)
    return result.messages?.[0]?.thread_ts
  } catch {
    return undefined
  }
}

async function verifySignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!(timestamp && signature)) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number.parseInt(timestamp, 10)) > 300) {
    return false
  }

  const sigBasestring = `v0:${timestamp}:${body}`
  const expectedDigest = await hmacSha256Hex({
    key: signingSecret,
    message: sigBasestring,
  })
  const expectedSignature = `v0=${expectedDigest}`

  return timingSafeEqualString({ left: signature, right: expectedSignature })
}

function randomSixDigitSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const randomValue =
    (bytes[0] ?? 0) * 16_777_216 +
    (bytes[1] ?? 0) * 65_536 +
    (bytes[2] ?? 0) * 256 +
    (bytes[3] ?? 0)
  const sixDigits = 100_000 + (randomValue % 900_000)
  return String(sixDigits)
}

async function hmacSha256Hex({
  key,
  message,
}: {
  key: string
  message: string
}): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(message),
  )
  return bufferToHex(signature)
}

function bufferToHex(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0')
    })
    .join('')
}

function timingSafeEqualString({ left, right }: { left: string; right: string }): boolean {
  if (left.length !== right.length) {
    return false
  }
  let diff = 0
  for (let index = 0; index < left.length; index++) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

function withRateLimitHeaders(response: Response): Response {
  response.headers.set('X-RateLimit-Limit', '50')
  response.headers.set('X-RateLimit-Remaining', '49')
  response.headers.set('X-RateLimit-Reset-After', '60.0')
  response.headers.set('X-RateLimit-Bucket', 'fake-bucket')
  return response
}
