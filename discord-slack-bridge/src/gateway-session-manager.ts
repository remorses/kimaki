// Runtime-agnostic Discord Gateway session manager.
// Handles identify/heartbeat/ready/dispatch using a generic socket interface
// so Node ws and Cloudflare Durable Object WebSockets can share one protocol core.

import {
  ApplicationFlags,
  GatewayDispatchEvents,
  GatewayOpcodes,
} from 'discord-api-types/v10'
import type {
  APIBaseVoiceState,
  APIGuildScheduledEvent,
  APIMessage,
  APISoundboardSound,
  APIStageInstance,
  GatewayGuildCreateDispatchData,
  GatewayHelloData,
  GatewayPresenceUpdate,
  GatewayReadyDispatchData,
} from 'discord-api-types/v10'
import type { BridgeAuthorizeCallback } from './types.js'
import type { GatewayState } from './gateway.js'

export interface GatewaySocketTransport {
  send(payload: string): void
  close(code?: number, reason?: string): void
  isOpen(): boolean
}

interface ManagedClient {
  transport: GatewaySocketTransport
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
  clientId?: string
  authorizedTeamIds?: Set<string>
}

export type GatewayClientSnapshot = {
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
  clientId?: string
  authorizedTeamIds?: string[]
}

export class GatewaySessionManager {
  private readonly clients = new Map<string, ManagedClient>()
  private readonly loadState: () => Promise<GatewayState>
  private readonly expectedToken: string
  private readonly workspaceId: string
  private readonly gatewayUrlProvider: () => string
  private readonly authorize?: BridgeAuthorizeCallback

  constructor({
    loadState,
    expectedToken,
    workspaceId,
    gatewayUrlProvider,
    authorize,
  }: {
    loadState: () => Promise<GatewayState>
    expectedToken: string
    workspaceId: string
    gatewayUrlProvider: () => string
    authorize?: BridgeAuthorizeCallback
  }) {
    this.loadState = loadState
    this.expectedToken = expectedToken
    this.workspaceId = workspaceId
    this.gatewayUrlProvider = gatewayUrlProvider
    this.authorize = authorize
  }

  registerClient(transport: GatewaySocketTransport): string {
    const clientId = crypto.randomUUID()
    this.clients.set(clientId, {
      transport,
      sessionId: crypto.randomUUID(),
      sequence: 0,
      identified: false,
      intents: 0,
      authorizedTeamIds: undefined,
      clientId: undefined,
    })
    this.sendHello(clientId)
    return clientId
  }

  hydrateClient({
    transport,
    clientId,
    snapshot,
  }: {
    transport: GatewaySocketTransport
    clientId: string
    snapshot: GatewayClientSnapshot
  }): void {
    this.clients.set(clientId, {
      transport,
      sessionId: snapshot.sessionId,
      sequence: snapshot.sequence,
      identified: snapshot.identified,
      intents: snapshot.intents,
      clientId: snapshot.clientId,
      authorizedTeamIds: snapshot.authorizedTeamIds
        ? new Set(snapshot.authorizedTeamIds)
        : undefined,
    })
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId)
  }

  getClientSnapshot(clientId: string): GatewayClientSnapshot | undefined {
    const client = this.clients.get(clientId)
    if (!client) {
      return undefined
    }
    return {
      sessionId: client.sessionId,
      sequence: client.sequence,
      identified: client.identified,
      intents: client.intents,
      clientId: client.clientId,
      authorizedTeamIds: client.authorizedTeamIds
        ? [...client.authorizedTeamIds]
        : undefined,
    }
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId)
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      client.transport.close(1000, 'gateway closed')
    }
    this.clients.clear()
  }

  close(): void {
    this.closeAll()
  }

  broadcast<T>(event: string, data: T): void {
    for (const [clientId, client] of this.clients.entries()) {
      if (!(client.identified && this.isClientAuthorizedForTeam(client))) {
        continue
      }
      this.sendDispatch(clientId, event, data)
    }
  }

  broadcastMessageCreate(message: APIMessage, guildId: string): void {
    this.broadcast(GatewayDispatchEvents.MessageCreate, {
      ...message,
      guild_id: guildId,
      mentions: [],
    })
  }

  async handleRawMessage({
    clientId,
    raw,
  }: {
    clientId: string
    raw: string
  }): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    const payload = parseGatewaySendPayload(raw)
    if (!payload) {
      return
    }

    if (payload.op === GatewayOpcodes.Heartbeat) {
      this.sendHeartbeatAck(clientId)
      return
    }

    const cleanToken = payload.d.token.replace(/^Bot\s+/i, '')
    const authResult = await this.authenticateGatewayIdentify(cleanToken)
    if (!authResult.allow) {
      client.transport.close(4004, 'Authentication failed')
      this.removeClient(clientId)
      return
    }

    client.clientId = authResult.clientId
    client.authorizedTeamIds = authResult.authorizedTeamIds
      ? new Set(authResult.authorizedTeamIds)
      : undefined
    client.identified = true
    client.intents = payload.d.intents
    await this.sendReadySequence(clientId)
  }

  private send(clientId: string, payload: unknown): void {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    if (!client.transport.isOpen()) {
      return
    }
    client.transport.send(JSON.stringify(payload))
  }

  private sendHello(clientId: string): void {
    this.send(clientId, {
      op: GatewayOpcodes.Hello,
      d: { heartbeat_interval: 45_000 } satisfies GatewayHelloData,
      s: null,
      t: null,
    })
  }

  private sendHeartbeatAck(clientId: string): void {
    this.send(clientId, {
      op: GatewayOpcodes.HeartbeatAck,
      s: null,
      t: null,
    })
  }

  private sendDispatch<T>(clientId: string, event: string, data: T): void {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    client.sequence += 1
    this.send(clientId, {
      op: GatewayOpcodes.Dispatch,
      t: event,
      s: client.sequence,
      d: data,
    })
  }

  private async sendReadySequence(clientId: string): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    const state = await this.loadState()
    const readyData: GatewayReadyDispatchData = {
      v: 10,
      user: state.botUser,
      guilds: state.guilds.map((guild) => {
        return { id: guild.id, unavailable: true }
      }),
      session_id: client.sessionId,
      resume_gateway_url: this.gatewayUrlProvider(),
      application: {
        id: state.botUser.id,
        flags:
          ApplicationFlags.GatewayPresence |
          ApplicationFlags.GatewayGuildMembers |
          ApplicationFlags.GatewayMessageContent,
      },
    }
    this.sendDispatch(clientId, GatewayDispatchEvents.Ready, readyData)

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
      this.sendDispatch(clientId, GatewayDispatchEvents.GuildCreate, guildData)
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

  private isClientAuthorizedForTeam(client: ManagedClient): boolean {
    return client.authorizedTeamIds?.has(this.workspaceId) ?? false
  }
}

function parseGatewaySendPayload(raw: string):
  | { op: GatewayOpcodes.Heartbeat }
  | { op: GatewayOpcodes.Identify; d: { token: string; intents: number } }
  | undefined {
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
  if (op === GatewayOpcodes.Heartbeat) {
    return { op: GatewayOpcodes.Heartbeat }
  }

  if (op !== GatewayOpcodes.Identify) {
    return undefined
  }

  const data = readRecord(payload, 'd')
  if (!data) {
    return undefined
  }
  const token = readString(data, 'token')
  const intents = readNumber(data, 'intents')
  if (!(token && intents !== undefined)) {
    return undefined
  }

  return {
    op: GatewayOpcodes.Identify,
    d: {
      token,
      intents,
    },
  }
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

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
