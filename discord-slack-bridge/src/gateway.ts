// Discord Gateway WebSocket server for the Slack bridge.
// Reuses the same protocol as discord-digital-twin: Hello -> Identify -> Ready
// -> GUILD_CREATE, plus heartbeat keep-alive. The bridge pushes translated
// Slack events via broadcast().

import crypto from 'node:crypto'
import type http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  GatewayOpcodes,
  GatewayDispatchEvents,
  ApplicationFlags,
} from 'discord-api-types/v10'
import type {
  GatewaySendPayload,
  GatewayHelloData,
  GatewayReadyDispatchData,
  GatewayGuildCreateDispatchData,
  GatewayMessageCreateDispatchData,
  GatewayPresenceUpdate,
  APIUser,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIBaseVoiceState,
  APIStageInstance,
  APIGuildScheduledEvent,
  APISoundboardSound,
} from 'discord-api-types/v10'
import type { BridgeAuthorizeCallback } from './types.js'

interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
  clientId?: string
  authorizedTeamIds?: Set<string>
}

export interface GatewayGuildState {
  id: string
  apiGuild: APIGuild
  joinedAt: string
  members: APIGuildMember[]
  channels: GatewayGuildCreateDispatchData['channels']
}

export interface GatewayState {
  botUser: APIUser
  guilds: GatewayGuildState[]
}

export class SlackBridgeGateway {
  wss: WebSocketServer
  clients: ConnectedClient[] = []
  private loadState: () => Promise<GatewayState>
  /** Mutable: updated via setPort() after OS-assigned bind (port:0). */
  private port: number
  private expectedToken: string
  private gatewayUrlOverride?: string
  private authorize?: BridgeAuthorizeCallback
  private workspaceId: string

  constructor({
    httpServer,
    port,
    loadState,
    expectedToken,
    gatewayUrlOverride,
    authorize,
    workspaceId,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
    expectedToken: string
    gatewayUrlOverride?: string
    authorize?: BridgeAuthorizeCallback
    workspaceId: string
  }) {
    this.port = port
    this.loadState = loadState
    this.expectedToken = expectedToken
    this.gatewayUrlOverride = gatewayUrlOverride
    this.authorize = authorize
    this.workspaceId = workspaceId
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (ws) => {
      this.handleConnection(ws)
    })
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(
        request.url ?? '/',
        `http://${request.headers.host}`,
      ).pathname
      if (pathname === '/gateway' || pathname === '/gateway/') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request)
        })
      } else {
        socket.destroy()
      }
    })
  }

  broadcast<T>(event: string, data: T): void {
    for (const client of this.clients) {
      if (client.identified && this.isClientAuthorizedForTeam(client, this.workspaceId)) {
        this.sendDispatch(client, event, data)
      }
    }
  }

  broadcastMessageCreate(message: APIMessage, guildId: string): void {
    const data: GatewayMessageCreateDispatchData = {
      ...message,
      guild_id: guildId,
      mentions: [],
    }
    this.broadcast(GatewayDispatchEvents.MessageCreate, data)
  }

  /** Update the port used in resume_gateway_url. Call after server bind
   *  when using port:0 (OS-assigned) so READY payloads have the real port. */
  setPort(port: number): void {
    this.port = port
  }

  close(): void {
    for (const client of this.clients) {
      client.ws.close()
    }
    this.clients = []
    this.wss.close()
  }

  private send(client: ConnectedClient, payload: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload))
    }
  }

  private sendHello(client: ConnectedClient): void {
    this.send(client, {
      op: GatewayOpcodes.Hello,
      d: { heartbeat_interval: 45000 } satisfies GatewayHelloData,
      s: null,
      t: null,
    })
  }

  private sendHeartbeatAck(client: ConnectedClient): void {
    this.send(client, {
      op: GatewayOpcodes.HeartbeatAck,
      s: null,
      t: null,
    })
  }

  private sendDispatch<T>(
    client: ConnectedClient,
    event: string,
    data: T,
  ): void {
    client.sequence++
    this.send(client, {
      op: GatewayOpcodes.Dispatch,
      t: event,
      s: client.sequence,
      d: data,
    })
  }

  private handleConnection(ws: WebSocket): void {
    const client: ConnectedClient = {
      ws,
      sessionId: crypto.randomUUID(),
      sequence: 0,
      identified: false,
      intents: 0,
      authorizedTeamIds: undefined,
      clientId: undefined,
    }
    this.clients.push(client)
    this.sendHello(client)

    ws.on('message', (raw) => {
      void this.handleMessage(client, raw.toString())
    })

    ws.on('close', () => {
      const idx = this.clients.indexOf(client)
      if (idx !== -1) {
        this.clients.splice(idx, 1)
      }
    })
  }

  private async handleMessage(
    client: ConnectedClient,
    raw: string,
  ): Promise<void> {
    const payload = parseGatewaySendPayload(raw)
    if (!payload) {
      return
    }

    switch (payload.op) {
      case GatewayOpcodes.Heartbeat: {
        this.sendHeartbeatAck(client)
        break
      }
      case GatewayOpcodes.Identify: {
        const { token, intents } = payload.d
        const cleanToken = token.replace(/^Bot\s+/i, '')
        const authResult = await this.authenticateGatewayIdentify(cleanToken)
        if (!authResult.allow) {
          client.ws.close(4004, 'Authentication failed')
          return
        }
        client.clientId = authResult.clientId
        client.authorizedTeamIds = authResult.authorizedTeamIds
          ? new Set(authResult.authorizedTeamIds)
          : undefined
        client.identified = true
        client.intents = intents
        await this.sendReadySequence(client)
        break
      }
    }
  }

  private async sendReadySequence(client: ConnectedClient): Promise<void> {
    const state = await this.loadState()

    const readyData: GatewayReadyDispatchData = {
      v: 10,
      user: state.botUser,
      guilds: state.guilds.map((g) => ({
        id: g.id,
        unavailable: true,
      })),
      session_id: client.sessionId,
      resume_gateway_url:
        this.gatewayUrlOverride ?? `ws://127.0.0.1:${this.port}/gateway`,
      application: {
        id: state.botUser.id,
        flags:
          ApplicationFlags.GatewayPresence |
          ApplicationFlags.GatewayGuildMembers |
          ApplicationFlags.GatewayMessageContent,
      },
    }
    this.sendDispatch(client, GatewayDispatchEvents.Ready, readyData)

    const emptyVoiceStates: APIBaseVoiceState[] = []
    const emptyPresences: GatewayPresenceUpdate[] = []
    const emptyStageInstances: APIStageInstance[] = []
    const emptyScheduledEvents: APIGuildScheduledEvent[] = []
    const emptySoundboardSounds: APISoundboardSound[] = []

    for (const guild of state.guilds) {
      const guildData: GatewayGuildCreateDispatchData = {
        ...guild.apiGuild,
        joined_at: guild.joinedAt,
        large: false,
        unavailable: false,
        member_count: guild.members.length,
        voice_states: emptyVoiceStates,
        members: guild.members,
        channels: guild.channels,
        threads: [],
        presences: emptyPresences,
        stage_instances: emptyStageInstances,
        guild_scheduled_events: emptyScheduledEvents,
        soundboard_sounds: emptySoundboardSounds,
      }
      this.sendDispatch(client, GatewayDispatchEvents.GuildCreate, guildData)
    }
  }

  private async authenticateGatewayIdentify(token: string): Promise<{
    allow: boolean
    clientId?: string
    authorizedTeamIds?: string[]
  }> {
    if (this.authorize) {
      const result = await this.authorize({
        kind: 'gateway-identify',
        token,
        teamId: this.workspaceId,
      })
      if (!result.allow) {
        return { allow: false }
      }
      if (!result.authorizedTeamIds?.includes(this.workspaceId)) {
        return { allow: false }
      }
      return result
    }

    if (token !== this.expectedToken) {
      return { allow: false }
    }

    return {
      allow: true,
      clientId: 'bot-token',
      authorizedTeamIds: [this.workspaceId],
    }
  }

  private isClientAuthorizedForTeam(
    client: ConnectedClient,
    teamId: string,
  ): boolean {
    return client.authorizedTeamIds?.has(teamId) ?? false
  }
}

function parseGatewaySendPayload(raw: string): GatewaySendPayload | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (!isRecord(payload)) {
    return undefined
  }
  const op = readNumber(payload, 'op')
  if (op === undefined) {
    return undefined
  }
  if (op === GatewayOpcodes.Heartbeat) {
    return {
      op,
      d: null,
    }
  }
  if (op === GatewayOpcodes.Identify) {
    const data = payload.d
    if (!isRecord(data)) {
      return undefined
    }
    const token = readString(data, 'token')
    const intents = readNumber(data, 'intents')
    if (!(token && intents !== undefined)) {
      return undefined
    }
    return {
      op,
      d: {
        token,
        intents,
        properties: {
          os: 'linux',
          browser: 'discord-slack-bridge',
          device: 'discord-slack-bridge',
        },
      },
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}
