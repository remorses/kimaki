// Durable Object runtime for discord-slack-bridge in Cloudflare Workers.
// Uses a runtime-agnostic gateway session manager so WebSocket transport
// details are isolated from gateway protocol logic.

import { WebClient } from '@slack/web-api'
import { DurableObject } from 'cloudflare:workers'
import {
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildSystemChannelFlags,
  GuildVerificationLevel,
  Locale,
} from 'discord-api-types/v10'
import type {
  APIGuild,
  APIGuildMember,
  APIUser,
  GatewayGuildCreateDispatchData,
} from 'discord-api-types/v10'
import { createBridgeApp } from 'discord-slack-bridge/src/server'
import {
  GatewaySessionManager,
  type GatewayClientSnapshot,
  type GatewaySocketTransport,
} from 'discord-slack-bridge/src/gateway-session-manager'
import {
  resolveGatewayClientFromCacheOrDb,
} from './gateway-client-kv.js'
import type { Env } from './env.js'

type BridgeRpcRequest = {
  clientId: string
  url: string
  path: string
  method: string
  headers: Array<[string, string]>
  body: string
}

type BridgeRpcResponse = {
  status: number
  headers: Array<[string, string]>
  body: string
}

type GatewayState = {
  botUser: APIUser
  guilds: Array<{
    id: string
    apiGuild: APIGuild
    joinedAt: string
    members: APIGuildMember[]
    channels: GatewayGuildCreateDispatchData['channels']
  }>
}

type RuntimeState = {
  app: {
    handle: (request: Request) => Promise<Response>
  }
  gatewaySessionManager: GatewaySessionManager
  setPublicGatewayUrl: (url: string) => void
}

export class SlackBridgeDO extends DurableObject<Env> {
  private runtimePromise?: Promise<RuntimeState>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/slack/gateway' || url.pathname.startsWith('/slack/gateway/')) {
      return this.handleGatewayUpgrade(request)
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  async handleDiscordRest(
    request: BridgeRpcRequest,
  ): Promise<BridgeRpcResponse> {
    try {
      const runtime = await this.getRuntime({ clientId: request.clientId })
      runtime.setPublicGatewayUrl(
        buildGatewayWebSocketUrlFromRequestUrl(request.url),
      )
      const response = await runtime.app.handle(toRequest(request))
      return serializeResponse(response)
    } catch (cause) {
      return {
        status: 500,
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          error: 'handleDiscordRest failed',
          details: String(cause),
        }),
      }
    }
  }

  async handleSlackWebhook(
    request: BridgeRpcRequest,
  ): Promise<BridgeRpcResponse> {
    try {
      const runtime = await this.getRuntime({ clientId: request.clientId })
      runtime.setPublicGatewayUrl(
        buildGatewayWebSocketUrlFromRequestUrl(request.url),
      )
      const response = await runtime.app.handle(toRequest(request))
      return serializeResponse(response)
    } catch (cause) {
      return {
        status: 500,
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          error: 'handleSlackWebhook failed',
          details: String(cause),
        }),
      }
    }
  }

  private async handleGatewayUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'Expected websocket upgrade' }, { status: 426 })
    }

    const requestClientId = new URL(request.url).searchParams.get('clientId')
      ?? undefined
    const runtime = await this.getRuntime({ clientId: requestClientId })
    runtime.setPublicGatewayUrl(
      buildGatewayWebSocketUrlFromRequestUrl(request.url),
    )
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ['gateway'])

    const transport: GatewaySocketTransport = {
      send: (payload) => {
        server.send(payload)
      },
      close: (code, reason) => {
        server.close(code, reason)
      },
      isOpen: () => {
        return true
      },
    }

    const clientId = runtime.gatewaySessionManager.registerClient(transport)
    writeSocketAttachment({
      ws: server,
      attachment: {
        role: 'gateway',
        gatewayClientId: clientId,
        snapshot: runtime.gatewaySessionManager.getClientSnapshot(clientId),
      },
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }

    const runtime = await this.getRuntime({})
    const rawMessage =
      typeof message === 'string' ? message : new TextDecoder().decode(message)
    await runtime.gatewaySessionManager.handleRawMessage({
      clientId: attachment.gatewayClientId,
      raw: rawMessage,
    })
    writeSocketAttachment({
      ws,
      attachment: {
        ...attachment,
        snapshot: runtime.gatewaySessionManager.getClientSnapshot(
          attachment.gatewayClientId,
        ),
      },
    })
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }
    const runtime = await this.getRuntime({})
    runtime.gatewaySessionManager.removeClient(attachment.gatewayClientId)
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }
    const runtime = await this.getRuntime({})
    runtime.gatewaySessionManager.removeClient(attachment.gatewayClientId)
  }

  private async getRuntime({
    clientId,
  }: {
    clientId?: string
  }): Promise<RuntimeState> {
    if (!this.runtimePromise) {
      this.runtimePromise = this.createRuntime({ clientId })
    }
    return this.runtimePromise
  }

  private async createRuntime({
    clientId,
  }: {
    clientId?: string
  }): Promise<RuntimeState> {
    if (!clientId) {
      throw new Error('Missing clientId while creating Slack bridge runtime')
    }

    const gatewayClient = await resolveGatewayClientFromCacheOrDb({
      clientId,
      env: this.env,
    })
    if (gatewayClient instanceof Error) {
      throw gatewayClient
    }
    if (!gatewayClient) {
      throw new Error(`Unknown gateway client: ${clientId}`)
    }

    const slackBotToken = gatewayClient.bot_token
      ?? (this.env.SLACK_WORKSPACE_ID === gatewayClient.guild_id
        ? this.env.SLACK_BOT_TOKEN
        : null)
    if (!slackBotToken) {
      throw new Error(`Missing Slack bot token for team ${gatewayClient.guild_id}`)
    }

    const slack = new WebClient(slackBotToken)
    const authResult = await slack.auth.test()
    const botUserId = authResult.user_id
    if (!botUserId) {
      throw new Error('Slack auth.test missing user_id')
    }
    const botUsername = authResult.user ?? 'kimaki'

    let publicGatewayUrl = 'wss://slack-gateway.kimaki.xyz/slack/gateway'

    const gatewaySessionManager = new GatewaySessionManager({
      loadState: async () => {
        return loadGatewayState({
          slack,
          workspaceId: gatewayClient.guild_id,
          botUserId,
          botUsername,
        })
      },
      expectedToken: slackBotToken,
      workspaceId: gatewayClient.guild_id,
      authorize: async (context) => {
        const teamId = context.teamId
        if (context.kind === 'webhook-action' || context.kind === 'webhook-event') {
          if (!teamId || teamId !== gatewayClient.guild_id) {
            return { allow: false }
          }
          return {
            allow: true,
            clientId,
            authorizedTeamIds: [gatewayClient.guild_id],
          }
        }

        const token = context.token
        const parsedToken = parseGatewayToken(token)
        if (!parsedToken) {
          return { allow: false }
        }

        if (parsedToken.clientId !== clientId) {
          return { allow: false }
        }

        const latestGatewayClient = await resolveGatewayClientFromCacheOrDb({
          clientId,
          env: this.env,
        })
        if (latestGatewayClient instanceof Error || !latestGatewayClient) {
          return { allow: false }
        }

        if (latestGatewayClient.secret !== parsedToken.secret) {
          return { allow: false }
        }

        if (teamId && teamId !== latestGatewayClient.guild_id) {
          return { allow: false }
        }

        return {
          allow: true,
          clientId,
          authorizedTeamIds: [latestGatewayClient.guild_id],
        }
      },
      gatewayUrlProvider: () => {
        return publicGatewayUrl
      },
    })

    const bridgeApp = createBridgeApp({
      slack,
      botUserId,
      botUsername,
      botToken: slackBotToken,
      signingSecret: this.env.SLACK_SIGNING_SECRET,
      workspaceId: gatewayClient.guild_id,
      port: 0,
    })

    bridgeApp.setGateway({
      broadcast: (event, data) => {
        gatewaySessionManager.broadcast(event, data)
      },
      broadcastMessageCreate: (message, guildId) => {
        gatewaySessionManager.broadcastMessageCreate(message, guildId)
      },
      close: () => {
        gatewaySessionManager.closeAll()
      },
    })

    this.restoreHibernatedGatewaySockets({ gatewaySessionManager })

    return {
      app: bridgeApp.app,
      gatewaySessionManager,
      setPublicGatewayUrl: (url) => {
        publicGatewayUrl = url
      },
    }
  }

  private restoreHibernatedGatewaySockets({
    gatewaySessionManager,
  }: {
    gatewaySessionManager: GatewaySessionManager
  }): void {
    const sockets = this.ctx.getWebSockets('gateway')
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket)
      if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
        continue
      }
      if (gatewaySessionManager.hasClient(attachment.gatewayClientId)) {
        continue
      }
      const transport = createGatewaySocketTransport(socket)
      gatewaySessionManager.hydrateClient({
        transport,
        clientId: attachment.gatewayClientId,
        snapshot: attachment.snapshot ?? {
          sessionId: crypto.randomUUID(),
          sequence: 0,
          identified: false,
          intents: 0,
        },
      })
    }
  }
}

type GatewaySocketAttachment = {
  role: 'gateway'
  gatewayClientId: string
  snapshot?: GatewayClientSnapshot
}

function createGatewaySocketTransport(ws: WebSocket): GatewaySocketTransport {
  return {
    send: (payload) => {
      ws.send(payload)
    },
    close: (code, reason) => {
      ws.close(code, reason)
    },
    isOpen: () => {
      return true
    },
  }
}

function readSocketAttachment(
  ws: WebSocket,
): GatewaySocketAttachment | undefined {
  const raw = ws.deserializeAttachment()
  if (!isRecord(raw)) {
    return undefined
  }
  if (raw.role !== 'gateway') {
    return undefined
  }
  const gatewayClientId = raw.gatewayClientId
  if (typeof gatewayClientId !== 'string') {
    return undefined
  }
  const snapshot = isGatewayClientSnapshot(raw.snapshot)
    ? raw.snapshot
    : undefined
  return {
    role: 'gateway',
    gatewayClientId,
    snapshot,
  }
}

function writeSocketAttachment({
  ws,
  attachment,
}: {
  ws: WebSocket
  attachment: GatewaySocketAttachment
}): void {
  ws.serializeAttachment(attachment)
}

function isGatewayClientSnapshot(
  value: unknown,
): value is GatewayClientSnapshot {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.sessionId === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.identified === 'boolean' &&
    typeof value.intents === 'number'
  )
}

async function loadGatewayState({
  slack,
  workspaceId,
  botUserId,
  botUsername,
}: {
  slack: WebClient
  workspaceId: string
  botUserId: string
  botUsername: string
}): Promise<GatewayState> {
  const authResult = await slack.auth.test()
  const channelsList = await slack.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  })

  const channels: GatewayGuildCreateDispatchData['channels'] =
    (channelsList.channels ?? [])
      .filter((channel): channel is typeof channel & { id: string } => {
        return Boolean(channel.id)
      })
      .map((channel) => {
        return {
          id: channel.id,
          type: ChannelType.GuildText,
          name: channel.name ?? '',
          guild_id: workspaceId,
          topic: channel.topic?.value ?? null,
          position: 0,
        }
      })

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
        apiGuild: buildGatewayGuild({
          workspaceId,
          workspaceName: authResult.team ?? 'Slack Workspace',
          botUserId,
        }),
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
            flags: 8,
          },
        ],
        channels,
      },
    ],
  }
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
  return {
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
    max_presences: 25_000,
    max_members: 500_000,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: GuildPremiumTier.None,
    preferred_locale: Locale.EnglishUS,
    region: 'automatic',
    hub_type: null,
    incidents_data: null,
    public_updates_channel_id: null,
    nsfw_level: GuildNSFWLevel.Default,
    premium_progress_bar_enabled: false,
    stickers: [],
    safety_alerts_channel_id: null,
  }
}

function toRequest(request: BridgeRpcRequest): Request {
  const baseUrl = new URL(request.url)
  const requestUrl = new URL(request.path, baseUrl.origin)
  const init: RequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
  }
  return new Request(requestUrl, init)
}

async function serializeResponse(response: Response): Promise<BridgeRpcResponse> {
  const headers: Array<[string, string]> = []
  response.headers.forEach((value, key) => {
    headers.push([key, value])
  })
  return {
    status: response.status,
    headers,
    body: await response.text(),
  }
}

function buildGatewayWebSocketUrlFromRequestUrl(requestUrl: string): string {
  const baseUrl = new URL(requestUrl)
  const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return new URL('/slack/gateway', `${protocol}//${baseUrl.host}`).toString()
}

function parseGatewayToken(
  token: string | undefined,
): {
  clientId: string
  secret: string
} | undefined {
  if (!token) {
    return undefined
  }
  const [clientId, secret, ...rest] = token.split(':')
  if (rest.length > 0) {
    return undefined
  }
  if (!clientId || !secret) {
    return undefined
  }
  return { clientId, secret }
}

function isBridgeRpcRequest(value: unknown): value is BridgeRpcRequest {
  if (!isRecord(value)) {
    return false
  }
  if (
    typeof value.clientId !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.method !== 'string' ||
    typeof value.body !== 'string' ||
    !Array.isArray(value.headers)
  ) {
    return false
  }
  return value.headers.every((entry) => {
    return (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
