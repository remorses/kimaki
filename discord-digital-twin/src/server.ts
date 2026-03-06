// Combined HTTP (Spiceflow) + WebSocket (ws) server on a single port.
// The Spiceflow app handles REST API routes at /api/v10/*.
// The ws WebSocketServer handles Gateway connections at /gateway.
// All routes are defined inline since each is small.

import http from 'node:http'
import { Spiceflow } from 'spiceflow'
import {
  ApplicationFlags,
  ApplicationWebhookEventStatus,
  ApplicationCommandType,
  ChannelType,
  GatewayDispatchEvents,
  InteractionResponseType,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIUser,
  APIApplication,
  APIApplicationCommand,
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIThreadList,
  RESTGetAPIGatewayBotResult,
  RESTPutAPIApplicationCommandsJSONBody,
  RESTPutAPIApplicationCommandsResult,
  RESTPostAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIChannelJSONBody,
  RESTPostAPIChannelThreadsJSONBody,
  RESTPostAPIChannelMessagesThreadsJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPatchAPIGuildRoleJSONBody,
  RESTPostAPIGuildRoleJSONBody,
  APIInteractionResponseCallbackData,
  RESTPostAPIInteractionCallbackJSONBody,
} from 'discord-api-types/v10'
import { DiscordGateway } from './gateway.js'
import type { GatewayState } from './gateway.js'
import type { PrismaClient } from './generated/client.js'
import {
  userToAPI,
  messageToAPI,
  channelToAPI,
  threadMemberToAPI,
  guildToAPI,
  roleToAPI,
  memberToAPI,
} from './serializers.js'
import { generateSnowflake } from './snowflake.js'

// discord.js (via undici) URL-encodes @original to %40original.
// Decode so route handlers can check for the canonical form.
function resolveWebhookMessageId(raw: string): string {
  const decoded = decodeURIComponent(raw)
  return decoded
}

// Generous fake rate limit headers so discord.js never self-throttles
const RATE_LIMIT_HEADERS: Record<string, string> = {
  'X-RateLimit-Limit': '50',
  'X-RateLimit-Remaining': '49',
  'X-RateLimit-Reset-After': '60.0',
  'X-RateLimit-Bucket': 'fake-bucket',
}

const THREAD_CHANNEL_TYPES: ChannelType[] = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]

function isThreadChannelType(channelType: number): boolean {
  return THREAD_CHANNEL_TYPES.includes(channelType as ChannelType)
}

type GuildChannelCreateBody = RESTPostAPIGuildChannelJSONBody & {
  topic?: string
  position?: number
  rate_limit_per_user?: number
}

export interface ServerComponents {
  httpServer: http.Server
  gateway: DiscordGateway
  app: { handleForNode: Spiceflow['handleForNode'] }
  typingEvents: TypingEventRecord[]
  port: number
}

export type TypingEventRecord = {
  channelId: string
  timestamp: number
}

export function createServer({
  prisma,
  botUserId,
  botToken,
  loadGatewayState,
  gatewayUrlOverride,
}: {
  prisma: PrismaClient
  botUserId: string
  botToken: string
  loadGatewayState: () => Promise<GatewayState>
  gatewayUrlOverride?: string
}): ServerComponents {
  const state = { port: 0 }
  const typingEvents: TypingEventRecord[] = []

  // Route handlers close over `gateway`. It's assigned after httpServer
  // creation but before any request arrives (server hasn't started listening).
  let gateway!: DiscordGateway

  const app = new Spiceflow({ basePath: '/api/v10' })

    // --- Gateway ---

    .route({
      method: 'GET',
      path: '/gateway/bot',
      handler(): RESTGetAPIGatewayBotResult {
        return {
          url: gatewayUrlOverride ?? `ws://127.0.0.1:${state.port}/gateway`,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 14400000,
            max_concurrency: 1,
          },
        }
      },
    })

    // --- Users ---

    .route({
      method: 'GET',
      path: '/users/@me',
      async handler(): Promise<APIUser> {
        const user = await prisma.user.findUniqueOrThrow({
          where: { id: botUserId },
        })
        return userToAPI(user)
      },
    })
    .route({
      method: 'GET',
      path: '/users/:user_id',
      async handler({ params }): Promise<APIUser> {
        const user = await prisma.user.findUnique({
          where: { id: params.user_id },
        })
        if (!user) {
          throw new Response(
            JSON.stringify({
              code: 10013,
              message: 'Unknown User',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return userToAPI(user)
      },
    })

    // --- Applications ---

    .route({
      method: 'GET',
      path: '/applications/@me',
      handler(): APIApplication {
        return {
          id: botUserId,
          name: 'TestBot',
          icon: null,
          description: '',
          summary: '',
          bot_public: true,
          bot_require_code_grant: false,
          verify_key: 'fake-verify-key',
          team: null,
          flags:
            ApplicationFlags.GatewayPresence |
            ApplicationFlags.GatewayGuildMembers |
            ApplicationFlags.GatewayMessageContent,
          event_webhooks_status: ApplicationWebhookEventStatus.Disabled,
        }
      },
    })
    .route({
      method: 'PUT',
      path: '/applications/:application_id/commands',
      async handler({
        params,
        request,
      }): Promise<RESTPutAPIApplicationCommandsResult> {
        // JSON.parse of unknown request body -- `as` is the only option
        const commands =
          (await request.json()) as RESTPutAPIApplicationCommandsJSONBody

        await prisma.applicationCommand.deleteMany({
          where: {
            applicationId: params.application_id,
            guildId: null,
          },
        })

        const results: APIApplicationCommand[] = []
        for (const cmd of commands) {
          const id = generateSnowflake()
          const version = generateSnowflake()
          const description =
            'description' in cmd ? (cmd.description ?? '') : ''
          const options = 'options' in cmd ? (cmd.options ?? []) : []
          const type = cmd.type ?? ApplicationCommandType.ChatInput
          await prisma.applicationCommand.create({
            data: {
              id,
              applicationId: params.application_id,
              guildId: null,
              name: cmd.name,
              description,
              type,
              options: JSON.stringify(options),
              defaultMemberPermissions: cmd.default_member_permissions ?? null,
              dmPermission: cmd.dm_permission ?? true,
              nsfw: cmd.nsfw ?? false,
              version,
            },
          })
          const command: APIApplicationCommand = {
            id,
            application_id: params.application_id,
            name: cmd.name,
            description,
            type,
            options,
            default_member_permissions: cmd.default_member_permissions ?? null,
            dm_permission: cmd.dm_permission ?? true,
            nsfw: cmd.nsfw ?? false,
            version,
          }
          results.push(command)
        }

        return results
      },
    })

    // --- Messages ---

    .route({
      method: 'POST',
      path: '/channels/:channel_id/messages',
      async handler({ params, request }): Promise<APIMessage> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPostAPIChannelMessageJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const messageId = generateSnowflake()
        await prisma.message.create({
          data: {
            id: messageId,
            channelId: params.channel_id,
            authorId: botUserId,
            content: body.content ?? '',
            tts: body.tts ?? false,
            nonce: body.nonce != null ? String(body.nonce) : null,
            flags: body.flags ?? 0,
            embeds: JSON.stringify(body.embeds ?? []),
            components: JSON.stringify(body.components ?? []),
            messageReference: body.message_reference
              ? JSON.stringify(body.message_reference)
              : null,
          },
        })
        await prisma.channel.update({
          where: { id: params.channel_id },
          data: {
            lastMessageId: messageId,
            messageCount: { increment: 1 },
            totalMessageSent: { increment: 1 },
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: messageId },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: botUserId },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: { guildId_userId: { guildId, userId: botUserId } },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        return apiMessage
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params }): Promise<APIMessage> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const dbMessage = await prisma.message.findUnique({
          where: { id: params.message_id },
        })
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        return messageToAPI(dbMessage, author, guildId, member ?? undefined)
      },
    })
    .route({
      method: 'PATCH',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params, request }): Promise<APIMessage> {
        const body =
          (await request.json()) as RESTPatchAPIChannelMessageJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await prisma.message.findUnique({
          where: { id: params.message_id },
        })
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.message.update({
          where: { id: params.message_id },
          data: {
            content: body.content ?? existing.content,
            editedTimestamp: new Date(),
            ...(body.embeds ? { embeds: JSON.stringify(body.embeds) } : {}),
            ...(body.components
              ? { components: JSON.stringify(body.components) }
              : {}),
            ...(body.flags != null ? { flags: body.flags } : {}),
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: params.message_id },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
          ...apiMessage,
          guild_id: guildId,
        })
        return apiMessage
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await prisma.message.findUnique({
          where: { id: params.message_id },
        })
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.message.delete({ where: { id: params.message_id } })
        gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
          id: params.message_id,
          channel_id: params.channel_id,
          guild_id: channel.guildId ?? undefined,
        })
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/messages',
      async handler({ params, request }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const before = url.searchParams.get('before')
        const after = url.searchParams.get('after')
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '50', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 50 : parsedLimit,
          100,
        )

        let messages = await prisma.message.findMany({
          where: { channelId: params.channel_id },
        })
        if (before) {
          const beforeBigInt = BigInt(before)
          messages = messages.filter((m) => BigInt(m.id) < beforeBigInt)
        }
        if (after) {
          const afterBigInt = BigInt(after)
          messages = messages.filter((m) => BigInt(m.id) > afterBigInt)
        }
        // Discord returns desc by default, asc when `after` is specified
        messages.sort((a, b) => {
          const cmp = Number(BigInt(a.id) - BigInt(b.id))
          return after ? cmp : -cmp
        })
        messages = messages.slice(0, limit)

        const guildId = channel.guildId ?? undefined
        const result: APIMessage[] = []
        for (const msg of messages) {
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: msg.authorId },
          })
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: { guildId_userId: { guildId, userId: msg.authorId } },
                include: { user: true },
              })
            : null
          result.push(messageToAPI(msg, author, guildId, member ?? undefined))
        }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    .route({
      method: 'POST',
      path: '/channels/:channel_id/typing',
      handler({ params }): Response {
        typingEvents.push({
          channelId: params.channel_id,
          timestamp: Date.now(),
        })
        if (typingEvents.length > 5_000) {
          typingEvents.splice(0, typingEvents.length - 5_000)
        }
        return new Response(null, { status: 204 })
      },
    })

    // --- Reactions ---

    .route({
      method: 'PUT',
      path: '/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
      async handler({ params }): Promise<Response> {
        const emoji = decodeURIComponent(params.emoji)
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const message = await prisma.message.findUnique({
          where: { id: params.message_id },
        })
        if (!message) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.reaction.upsert({
          where: {
            messageId_userId_emoji: {
              messageId: params.message_id,
              userId: botUserId,
              emoji,
            },
          },
          create: {
            messageId: params.message_id,
            userId: botUserId,
            emoji,
          },
          update: {},
        })
        gateway.broadcast(GatewayDispatchEvents.MessageReactionAdd, {
          user_id: botUserId,
          channel_id: params.channel_id,
          message_id: params.message_id,
          guild_id: channel.guildId ?? undefined,
          emoji: { id: null, name: emoji },
        })
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
      async handler({ params }): Promise<Response> {
        const emoji = decodeURIComponent(params.emoji)
        await prisma.reaction.deleteMany({
          where: {
            messageId: params.message_id,
            userId: botUserId,
            emoji,
          },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        gateway.broadcast(GatewayDispatchEvents.MessageReactionRemove, {
          user_id: botUserId,
          channel_id: params.channel_id,
          message_id: params.message_id,
          guild_id: channel?.guildId ?? undefined,
          emoji: { id: null, name: emoji },
        })
        return new Response(null, { status: 204 })
      },
    })

    // --- Channels ---

    .route({
      method: 'GET',
      path: '/channels/:channel_id',
      async handler({ params }): Promise<APIChannel> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return channelToAPI(channel)
      },
    })
    .route({
      method: 'PATCH',
      path: '/channels/:channel_id',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPatchAPIChannelJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const isThread = isThreadChannelType(channel.type)
        await prisma.channel.update({
          where: { id: params.channel_id },
          data: {
            ...(body.name != null ? { name: body.name } : {}),
            ...(body.topic !== undefined ? { topic: body.topic ?? null } : {}),
            ...(body.archived != null
              ? {
                  archived: body.archived,
                  archiveTimestamp: new Date(),
                }
              : {}),
            ...(body.locked != null ? { locked: body.locked } : {}),
            ...(body.auto_archive_duration != null
              ? { autoArchiveDuration: body.auto_archive_duration }
              : {}),
            ...(body.rate_limit_per_user != null
              ? { rateLimitPerUser: body.rate_limit_per_user }
              : {}),
          },
        })
        const updated = await prisma.channel.findUniqueOrThrow({
          where: { id: params.channel_id },
        })
        const apiChannel = channelToAPI(updated)
        const event = isThread
          ? GatewayDispatchEvents.ThreadUpdate
          : GatewayDispatchEvents.ChannelUpdate
        gateway.broadcast(event, apiChannel)
        return apiChannel
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id',
      async handler({ params }): Promise<APIChannel> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const isThread = isThreadChannelType(channel.type)
        const apiChannel = channelToAPI(channel)
        await prisma.channel.delete({ where: { id: params.channel_id } })
        if (isThread) {
          gateway.broadcast(GatewayDispatchEvents.ThreadDelete, {
            id: channel.id,
            guild_id: channel.guildId,
            parent_id: channel.parentId,
            type: channel.type,
          })
        } else {
          gateway.broadcast(GatewayDispatchEvents.ChannelDelete, apiChannel)
        }
        return apiChannel
      },
    })

    // --- Threads ---

    .route({
      method: 'POST',
      path: '/channels/:channel_id/threads',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPostAPIChannelThreadsJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const threadId = generateSnowflake()
        const threadType = body.type ?? ChannelType.PublicThread
        await prisma.channel.create({
          data: {
            id: threadId,
            guildId: channel.guildId,
            type: threadType,
            name: body.name,
            parentId: params.channel_id,
            ownerId: botUserId,
            autoArchiveDuration: body.auto_archive_duration ?? 1440,
            archiveTimestamp: new Date(),
            rateLimitPerUser: body.rate_limit_per_user ?? 0,
            memberCount: 1,
          },
        })
        // Auto-add creator as thread member
        await prisma.threadMember.create({
          data: { channelId: threadId, userId: botUserId },
        })
        const thread = await prisma.channel.findUniqueOrThrow({
          where: { id: threadId },
        })
        const apiChannel = channelToAPI(thread)
        // Include newly_created so discord.js ThreadCreate action emits the event
        // even when the REST response is processed before the gateway WS event
        const withCreated = { ...apiChannel, newly_created: true }
        gateway.broadcast(GatewayDispatchEvents.ThreadCreate, withCreated)
        return withCreated as APIChannel
      },
    })
    .route({
      method: 'POST',
      path: '/channels/:channel_id/messages/:message_id/threads',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body =
          (await request.json()) as RESTPostAPIChannelMessagesThreadsJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const message = await prisma.message.findUnique({
          where: { id: params.message_id },
        })
        if (!message) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const threadId = generateSnowflake()
        await prisma.channel.create({
          data: {
            id: threadId,
            guildId: channel.guildId,
            type: ChannelType.PublicThread,
            name: body.name,
            parentId: params.channel_id,
            ownerId: botUserId,
            autoArchiveDuration: body.auto_archive_duration ?? 1440,
            archiveTimestamp: new Date(),
            rateLimitPerUser: body.rate_limit_per_user ?? 0,
            starterMessageId: params.message_id,
            memberCount: 1,
          },
        })
        await prisma.threadMember.create({
          data: { channelId: threadId, userId: botUserId },
        })
        const thread = await prisma.channel.findUniqueOrThrow({
          where: { id: threadId },
        })
        const apiChannel = channelToAPI(thread)
        const withCreated = { ...apiChannel, newly_created: true }
        gateway.broadcast(GatewayDispatchEvents.ThreadCreate, withCreated)
        return withCreated as APIChannel
      },
    })
    .route({
      method: 'PUT',
      path: '/channels/:channel_id/thread-members/:user_id',
      async handler({ params }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await prisma.threadMember.findUnique({
          where: {
            channelId_userId: {
              channelId: params.channel_id,
              userId: params.user_id,
            },
          },
        })
        if (!existing) {
          await prisma.threadMember.create({
            data: { channelId: params.channel_id, userId: params.user_id },
          })
          await prisma.channel.update({
            where: { id: params.channel_id },
            data: { memberCount: { increment: 1 } },
          })
          const threadMember = await prisma.threadMember.findUniqueOrThrow({
            where: {
              channelId_userId: {
                channelId: params.channel_id,
                userId: params.user_id,
              },
            },
          })
          gateway.broadcast(GatewayDispatchEvents.ThreadMembersUpdate, {
            id: params.channel_id,
            guild_id: channel.guildId,
            member_count: channel.memberCount + 1,
            added_members: [threadMemberToAPI(threadMember)],
            removed_member_ids: [] as string[],
          })
        }
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/thread-members',
      async handler({ params }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const members = await prisma.threadMember.findMany({
          where: { channelId: params.channel_id },
        })
        return new Response(JSON.stringify(members.map(threadMemberToAPI)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    // --- Guilds ---

    .route({
      method: 'GET',
      path: '/guilds/:guild_id',
      async handler({ params }): Promise<APIGuild> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
          include: { roles: true },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return guildToAPI(guild)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/channels',
      async handler({ params }): Promise<APIChannel[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channels = await prisma.channel.findMany({
          where: {
            guildId: params.guild_id,
            type: { notIn: THREAD_CHANNEL_TYPES },
          },
          orderBy: { position: 'asc' },
        })
        return channels.map(channelToAPI)
      },
    })
    .route({
      method: 'POST',
      path: '/guilds/:guild_id/channels',
      async handler({ params, request }): Promise<APIChannel> {
        const body = (await request.json()) as GuildChannelCreateBody
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channelId = generateSnowflake()
        await prisma.channel.create({
          data: {
            id: channelId,
            guildId: params.guild_id,
            type: body.type ?? ChannelType.GuildText,
            name: body.name,
            topic: body.topic ?? null,
            parentId: body.parent_id != null ? String(body.parent_id) : null,
            position: body.position ?? 0,
            rateLimitPerUser: body.rate_limit_per_user ?? 0,
          },
        })
        const channel = await prisma.channel.findUniqueOrThrow({
          where: { id: channelId },
        })
        const apiChannel = channelToAPI(channel)
        gateway.broadcast(GatewayDispatchEvents.ChannelCreate, apiChannel)
        return apiChannel
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/roles',
      async handler({ params }): Promise<APIRole[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const roles = await prisma.role.findMany({
          where: { guildId: params.guild_id },
          orderBy: { position: 'asc' },
        })
        return roles.map(roleToAPI)
      },
    })
    .route({
      method: 'POST',
      path: '/guilds/:guild_id/roles',
      async handler({ params, request }): Promise<APIRole> {
        const body = (await request.json()) as RESTPostAPIGuildRoleJSONBody
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const roleCount = await prisma.role.count({
          where: { guildId: params.guild_id },
        })
        const roleId = generateSnowflake()
        await prisma.role.create({
          data: {
            id: roleId,
            guildId: params.guild_id,
            name: body.name ?? 'new role',
            color: body.color ?? 0,
            hoist: body.hoist ?? false,
            position: roleCount,
            permissions:
              body.permissions != null ? String(body.permissions) : '0',
            mentionable: body.mentionable ?? false,
          },
        })
        const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
        const apiRole = roleToAPI(role)
        gateway.broadcast(GatewayDispatchEvents.GuildRoleCreate, {
          guild_id: params.guild_id,
          role: apiRole,
        })
        return apiRole
      },
    })
    .route({
      method: 'PATCH',
      path: '/guilds/:guild_id/roles/:role_id',
      async handler({ params, request }): Promise<APIRole> {
        const body = (await request.json()) as RESTPatchAPIGuildRoleJSONBody
        const role = await prisma.role.findFirst({
          where: {
            id: params.role_id,
            guildId: params.guild_id,
          },
        })
        if (!role) {
          throw new Response(
            JSON.stringify({
              code: 10011,
              message: 'Unknown Role',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.role.update({
          where: { id: params.role_id },
          data: {
            ...(body.name !== undefined ? { name: body.name ?? 'new role' } : {}),
            ...(body.color !== undefined ? { color: body.color ?? 0 } : {}),
            ...(body.hoist !== undefined ? { hoist: body.hoist ?? false } : {}),
            ...(body.permissions !== undefined
              ? { permissions: body.permissions != null ? String(body.permissions) : '0' }
              : {}),
            ...(body.mentionable !== undefined
              ? { mentionable: body.mentionable ?? false }
              : {}),
          },
        })
        const updatedRole = await prisma.role.findUniqueOrThrow({
          where: { id: params.role_id },
        })
        const apiRole = roleToAPI(updatedRole)
        gateway.broadcast(GatewayDispatchEvents.GuildRoleUpdate, {
          guild_id: params.guild_id,
          role: apiRole,
        })
        return apiRole
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members/search',
      async handler({ params, request }): Promise<APIGuildMember[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const query = url.searchParams.get('query') ?? ''
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '1', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 1 : parsedLimit,
          1000,
        )
        const members = await prisma.guildMember.findMany({
          where: {
            guildId: params.guild_id,
            OR: [
              { user: { username: { contains: query } } },
              { nick: { contains: query } },
            ],
          },
          include: { user: true },
          take: limit,
        })
        return members.map(memberToAPI)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members',
      async handler({ params, request }): Promise<APIGuildMember[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const after = url.searchParams.get('after')
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '1', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 1 : parsedLimit,
          1000,
        )
        const members = await prisma.guildMember.findMany({
          where: {
            guildId: params.guild_id,
            ...(after ? { userId: { gt: after } } : {}),
          },
          include: { user: true },
          orderBy: { userId: 'asc' },
          take: limit,
        })
        return members.map(memberToAPI)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members/:user_id',
      async handler({ params }): Promise<APIGuildMember> {
        const member = await prisma.guildMember.findUnique({
          where: {
            guildId_userId: {
              guildId: params.guild_id,
              userId: params.user_id,
            },
          },
          include: { user: true },
        })
        if (!member) {
          throw new Response(
            JSON.stringify({
              code: 10007,
              message: 'Unknown Member',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return memberToAPI(member)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/threads/active',
      async handler({ params }): Promise<APIThreadList> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const threads = await prisma.channel.findMany({
          where: {
            guildId: params.guild_id,
            type: { in: THREAD_CHANNEL_TYPES },
            archived: false,
          },
          orderBy: { createdAt: 'desc' },
        })
        const threadIds = threads.map((thread) => {
          return thread.id
        })
        const threadMembers =
          threadIds.length === 0
            ? []
            : await prisma.threadMember.findMany({
                where: { channelId: { in: threadIds } },
              })
        return {
          threads: threads.map(channelToAPI),
          members: threadMembers.map(threadMemberToAPI),
        }
      },
    })

    // --- Interactions ---

    .route({
      method: 'POST',
      path: '/interactions/:interaction_id/:interaction_token/callback',
      async handler({ params, request }): Promise<Response> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body =
          (await request.json()) as RESTPostAPIInteractionCallbackJSONBody

        const existing = await prisma.interactionResponse.findUnique({
          where: { interactionId: params.interaction_id },
        })
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10062,
              message: 'Unknown Interaction',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (existing.acknowledged) {
          throw new Response(
            JSON.stringify({
              code: 40060,
              message: 'Interaction has already been acknowledged',
              errors: {},
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const callbackType = body.type
        let messageId: string | null = existing.messageId
        const data = (
          'data' in body ? body.data : null
        ) as APIInteractionResponseCallbackData | null

        // Type 4 (CHANNEL_MESSAGE_WITH_SOURCE) creates a message immediately
        if (callbackType === InteractionResponseType.ChannelMessageWithSource) {
          messageId = generateSnowflake()
          await prisma.message.create({
            data: {
              id: messageId,
              channelId: existing.channelId,
              authorId: botUserId,
              content: data?.content ?? '',
              tts: data?.tts ?? false,
              flags: data?.flags ?? 0,
              embeds: JSON.stringify(data?.embeds ?? []),
              components: JSON.stringify(data?.components ?? []),
              webhookId: existing.applicationId,
              applicationId: existing.applicationId,
              type: MessageType.Default,
            },
          })
          await prisma.channel.update({
            where: { id: existing.channelId },
            data: {
              lastMessageId: messageId,
              messageCount: { increment: 1 },
              totalMessageSent: { increment: 1 },
            },
          })
          const dbMessage = await prisma.message.findUniqueOrThrow({
            where: { id: messageId },
          })
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: botUserId },
          })
          const channel = await prisma.channel.findUnique({
            where: { id: existing.channelId },
          })
          const guildId = channel?.guildId ?? undefined
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: { guildId_userId: { guildId, userId: botUserId } },
                include: { user: true },
              })
            : null
          const apiMessage = messageToAPI(
            dbMessage,
            author,
            guildId,
            member ?? undefined,
          )
          gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        } else if (callbackType === InteractionResponseType.UpdateMessage) {
          messageId = existing.messageId
          if (!messageId) {
            throw new Response(
              JSON.stringify({
                code: 40060,
                message: 'Interaction is not attached to a message',
                errors: {},
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }
          const origMessage = await prisma.message.findUnique({
            where: { id: messageId },
          })
          if (!origMessage) {
            throw new Response(
              JSON.stringify({
                code: 10008,
                message: 'Unknown Message',
                errors: {},
              }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            )
          }
          await prisma.message.update({
            where: { id: messageId },
            data: {
              content: data?.content ?? origMessage.content,
              editedTimestamp: new Date(),
              ...(data?.embeds ? { embeds: JSON.stringify(data.embeds) } : {}),
              ...(data?.components
                ? { components: JSON.stringify(data.components) }
                : {}),
              ...(data?.flags != null ? { flags: data.flags } : {}),
            },
          })
          const dbMessage = await prisma.message.findUniqueOrThrow({
            where: { id: messageId },
          })
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: dbMessage.authorId },
          })
          const channel = await prisma.channel.findUnique({
            where: { id: dbMessage.channelId },
          })
          const guildId = channel?.guildId ?? undefined
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: {
                  guildId_userId: { guildId, userId: dbMessage.authorId },
                },
                include: { user: true },
              })
            : null
          const apiMessage = messageToAPI(
            dbMessage,
            author,
            guildId,
            member ?? undefined,
          )
          gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
            ...apiMessage,
            guild_id: guildId,
          })
        }

        // Mark interaction as acknowledged and store the response
        await prisma.interactionResponse.update({
          where: { interactionId: params.interaction_id },
          data: {
            acknowledged: true,
            type: callbackType,
            messageId,
            data: data ? JSON.stringify(data) : null,
          },
        })

        return new Response(null, { status: 204 })
      },
    })

    // --- Webhook endpoints for interaction follow-ups and edits ---
    // discord.js (via undici) URL-encodes @original to %40original, so we
    // use :message_id params and resolve @original inside each handler.

    .route({
      method: 'POST',
      path: '/webhooks/:webhook_id/:webhook_token',
      async handler({ params, request }): Promise<APIMessage> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPostAPIChannelMessageJSONBody

        // Look up the interaction to find which channel to post in
        const interaction = await prisma.interactionResponse.findUnique({
          where: { interactionToken: params.webhook_token },
        })
        if (!interaction) {
          throw new Response(
            JSON.stringify({
              code: 10062,
              message: 'Unknown Interaction',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const messageId = generateSnowflake()
        await prisma.message.create({
          data: {
            id: messageId,
            channelId: interaction.channelId,
            authorId: botUserId,
            content: body.content ?? '',
            tts: body.tts ?? false,
            flags: body.flags ?? 0,
            embeds: JSON.stringify(body.embeds ?? []),
            components: JSON.stringify(body.components ?? []),
            webhookId: interaction.applicationId,
            applicationId: interaction.applicationId,
            type: MessageType.Default,
          },
        })
        await prisma.channel.update({
          where: { id: interaction.channelId },
          data: {
            lastMessageId: messageId,
            messageCount: { increment: 1 },
            totalMessageSent: { increment: 1 },
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: messageId },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: botUserId },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: interaction.channelId },
        })
        const guildId = channel?.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: { guildId_userId: { guildId, userId: botUserId } },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        return apiMessage
      },
    })
    .route({
      method: 'GET',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params }): Promise<APIMessage> {
        const resolvedId = resolveWebhookMessageId(params.message_id)
        const messageId = await (async () => {
          if (resolvedId === '@original') {
            const interaction = await prisma.interactionResponse.findUnique({
              where: { interactionToken: params.webhook_token },
            })
            if (!interaction || !interaction.messageId) {
              throw new Response(
                JSON.stringify({
                  code: 10008,
                  message: 'Unknown Message',
                  errors: {},
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
            return interaction.messageId
          }
          return resolvedId
        })()

        const dbMessage = await prisma.message.findUnique({
          where: { id: messageId },
        })
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: dbMessage.channelId },
        })
        const guildId = channel?.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        return messageToAPI(dbMessage, author, guildId, member ?? undefined)
      },
    })
    .route({
      method: 'PATCH',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params, request }): Promise<APIMessage> {
        const body =
          (await request.json()) as RESTPatchAPIChannelMessageJSONBody
        const resolvedId = resolveWebhookMessageId(params.message_id)

        // For @original, look up the interaction response's messageId.
        // If deferred (no messageId yet), create the message on first edit.
        let wasNewlyCreated = false
        const messageId = await (async () => {
          if (resolvedId === '@original') {
            const interaction = await prisma.interactionResponse.findUnique({
              where: { interactionToken: params.webhook_token },
            })
            if (!interaction) {
              throw new Response(
                JSON.stringify({
                  code: 10062,
                  message: 'Unknown Interaction',
                  errors: {},
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
            if (!interaction.messageId) {
              // Deferred interaction -- create the message on first edit
              const newId = generateSnowflake()
              await prisma.message.create({
                data: {
                  id: newId,
                  channelId: interaction.channelId,
                  authorId: botUserId,
                  content: body.content ?? '',
                  flags: body.flags ?? 0,
                  embeds: JSON.stringify(body.embeds ?? []),
                  components: JSON.stringify(body.components ?? []),
                  webhookId: interaction.applicationId,
                  applicationId: interaction.applicationId,
                  type: MessageType.Default,
                },
              })
              await prisma.channel.update({
                where: { id: interaction.channelId },
                data: {
                  lastMessageId: newId,
                  messageCount: { increment: 1 },
                  totalMessageSent: { increment: 1 },
                },
              })
              await prisma.interactionResponse.update({
                where: { interactionId: interaction.interactionId },
                data: { messageId: newId },
              })
              wasNewlyCreated = true
              return newId
            }
            return interaction.messageId
          }
          return resolvedId
        })()

        const existing = await prisma.message.findUnique({
          where: { id: messageId },
        })
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }

        // Skip the DB update if we just created the message (deferred case)
        if (!wasNewlyCreated) {
          await prisma.message.update({
            where: { id: messageId },
            data: {
              content: body.content ?? existing.content,
              editedTimestamp: new Date(),
              ...(body.embeds ? { embeds: JSON.stringify(body.embeds) } : {}),
              ...(body.components
                ? { components: JSON.stringify(body.components) }
                : {}),
              ...(body.flags != null ? { flags: body.flags } : {}),
            },
          })
        }

        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: messageId },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: dbMessage.channelId },
        })
        const guildId = channel?.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
          ...apiMessage,
          guild_id: guildId,
        })
        return apiMessage
      },
    })
    .route({
      method: 'DELETE',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params }): Promise<Response> {
        const resolvedId = resolveWebhookMessageId(params.message_id)
        const messageId = await (async () => {
          if (resolvedId === '@original') {
            const interaction = await prisma.interactionResponse.findUnique({
              where: { interactionToken: params.webhook_token },
            })
            if (!interaction || !interaction.messageId) {
              throw new Response(
                JSON.stringify({
                  code: 10008,
                  message: 'Unknown Message',
                  errors: {},
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
            return interaction.messageId
          }
          return resolvedId
        })()

        const dbMessage = await prisma.message.findUnique({
          where: { id: messageId },
        })
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channel = await prisma.channel.findUnique({
          where: { id: dbMessage.channelId },
        })
        await prisma.message.delete({ where: { id: messageId } })
        gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
          id: messageId,
          channel_id: dbMessage.channelId,
          guild_id: channel?.guildId ?? undefined,
        })
        return new Response(null, { status: 204 })
      },
    })

  const httpServer = http.createServer((req, res) => {
    const origWriteHead = res.writeHead.bind(res)
    // Node's writeHead has complex overloads. Intercept to inject rate
    // limit headers on every response.
    res.writeHead = function writeHeadWithRateLimits(
      statusCode: number,
      ...rest: Parameters<typeof res.writeHead> extends [number, ...infer R]
        ? R
        : never[]
    ) {
      for (const [key, value] of Object.entries(RATE_LIMIT_HEADERS)) {
        res.setHeader(key, value)
      }
      res.setHeader('X-RateLimit-Reset', String(Date.now() / 1000 + 60))
      return origWriteHead(statusCode, ...rest)
    } as typeof res.writeHead
    return app.handleForNode(req, res)
  })

  gateway = new DiscordGateway({
    httpServer,
    port: 0,
    loadState: loadGatewayState,
    expectedToken: botToken,
  })

  return {
    httpServer,
    gateway,
    app,
    typingEvents,
    get port() {
      return state.port
    },
    set port(v) {
      state.port = v
    },
  }
}

export function startServer(components: ServerComponents): Promise<number> {
  return new Promise((resolve, reject) => {
    components.httpServer.listen(0, () => {
      const address = components.httpServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      const port = address.port
      components.port = port
      // @ts-expect-error -- updating private field after listen
      components.gateway.port = port
      resolve(port)
    })
  })
}

export function stopServer(components: ServerComponents): Promise<void> {
  return new Promise((resolve) => {
    components.gateway.close()
    components.httpServer.close(() => {
      resolve()
    })
  })
}
