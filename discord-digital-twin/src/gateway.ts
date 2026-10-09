// Discord Gateway WebSocket server.
// Implements the minimum Gateway protocol needed for discord.js to connect:
// Hello -> Identify -> Ready -> GUILD_CREATE, plus heartbeat keep-alive.
// REST routes call gateway.broadcast() to push events to connected clients.

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
  APIChannel,
  APIMessage,
   APIBaseVoiceState,
   APIStageInstance,
   APIGuildScheduledEvent,
   APISoundboardSound,
} from 'discord-api-types/v10'

interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
  // Guilds this connection may see. null = all (the real bot token).
  guilds: ReadonlySet<string> | null
  token: string | null
  // Live events that arrive while the READY sequence is sent; null once sent.
  held: Array<{ event: string; data: unknown }> | null
}

// Result of authenticating a token: the guilds it may see, null = all guilds,
// false = rejected.
export type GatewayAuthorize = (token: string) => ReadonlySet<string> | null | false

// gateway-proxy mode: every registered client token with its guilds. Events
// for a client with no live connection are buffered and replayed on IDENTIFY.
export type GatewayOfflineClients = () => Iterable<[token: string, guilds: ReadonlySet<string>]>

// Same events and cap as gateway-proxy/src/dispatch.rs and state.rs.
const BUFFERED_EVENTS = new Set<string>([
  GatewayDispatchEvents.MessageCreate,
  GatewayDispatchEvents.MessageUpdate,
  GatewayDispatchEvents.MessageDelete,
  GatewayDispatchEvents.ThreadCreate,
  GatewayDispatchEvents.ThreadUpdate,
  GatewayDispatchEvents.ThreadDelete,
])
const OFFLINE_EVENT_BUFFER_LIMIT = 200

type BufferedEvent = { event: string; data: unknown; guildId: string }

export interface GatewayGuildState {
  id: string
  apiGuild: APIGuild
  joinedAt: string
  members: APIGuildMember[]
  channels: APIChannel[]
}

export interface GatewayState {
  botUser: APIUser
  guilds: GatewayGuildState[]
}

export class DiscordGateway {
  wss: WebSocketServer
  clients: ConnectedClient[] = []
  private loadState: () => Promise<GatewayState>
  private port: number
  private authorize: GatewayAuthorize
  private offlineClients: GatewayOfflineClients | null
  // Client token -> events it missed while offline, oldest first.
  private offlineEvents = new Map<string, BufferedEvent[]>()

  constructor({
    httpServer,
    port,
    loadState,
    authorize,
    offlineClients,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
    authorize: GatewayAuthorize
    // Only in gateway-proxy mode. Real Discord has no offline buffer.
    offlineClients?: GatewayOfflineClients
  }) {
    this.port = port
    this.loadState = loadState
    this.authorize = authorize
    this.offlineClients = offlineClients ?? null
    // Use noServer mode so we can accept both /gateway and /gateway/
    // (twilight-gateway appends /?v=10&encoding=json, creating path /gateway/)
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (ws) => {
      this.handleConnection(ws)
    })
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
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
    // gateway-proxy forwards guild events only to clients authorized for that guild.
    const guildId =
      data && typeof data === 'object' && 'guild_id' in data && typeof data.guild_id === 'string'
        ? data.guild_id
        : null
    for (const client of this.clients) {
      if (!client.identified) continue
      if (guildId && client.guilds && !client.guilds.has(guildId)) continue
      // Still sending READY: deliver after it and after the missed events, in order.
      if (client.held) {
        client.held.push({ event, data })
        continue
      }
      this.sendDispatch(client, event, data)
    }
    if (guildId) this.bufferForOfflineClients({ event, data, guildId })
  }

  // Mirrors buffer_event_for_disconnected_clients in gateway-proxy dispatch.rs.
  private bufferForOfflineClients(buffered: BufferedEvent): void {
    if (!this.offlineClients || !BUFFERED_EVENTS.has(buffered.event)) return
    for (const [token, guilds] of this.offlineClients()) {
      if (!guilds.has(buffered.guildId)) continue
      if (this.clients.some((client) => client.identified && client.token === token)) continue
      const events = this.offlineEvents.get(token) ?? []
      if (events.length >= OFFLINE_EVENT_BUFFER_LIMIT) events.shift()
      events.push(buffered)
      this.offlineEvents.set(token, events)
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
      guilds: null,
      token: null,
      held: [],
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
    // JSON.parse returns unknown -- `as` is the only option for untyped JSON
    const payload = JSON.parse(raw) as GatewaySendPayload

    switch (payload.op) {
      case GatewayOpcodes.Heartbeat: {
        this.sendHeartbeatAck(client)
        break
      }
      case GatewayOpcodes.Identify: {
        // Switch on `op` narrows GatewaySendPayload to GatewayIdentify,
        // so payload.d is already GatewayIdentifyData -- no cast needed
        const { token, intents } = payload.d
        const bareToken = token.replace(/^Bot\s+/i, '')
        const guilds = this.authorize(bareToken)
        if (guilds === false) {
          client.ws.close(4004, 'Authentication failed')
          return
        }
        client.guilds = guilds
        client.token = bareToken
        client.identified = true
        client.intents = intents
        await this.sendReadySequence(client)
        break
      }
    }
  }

  private async sendReadySequence(client: ConnectedClient): Promise<void> {
    const loaded = await this.loadState()
    const state = {
      ...loaded,
      guilds: loaded.guilds.filter((guild) => !client.guilds || client.guilds.has(guild.id)),
    }

    const readyData: GatewayReadyDispatchData = {
      v: 10,
      user: state.botUser,
      guilds: state.guilds.map((g) => ({
        id: g.id,
        unavailable: true,
      })),
      session_id: client.sessionId,
      resume_gateway_url: `ws://127.0.0.1:${this.port}/gateway`,
      application: {
        id: state.botUser.id,
        flags:
          ApplicationFlags.GatewayPresence |
          ApplicationFlags.GatewayGuildMembers |
          ApplicationFlags.GatewayMessageContent,
      },
    }
    this.sendDispatch(client, GatewayDispatchEvents.Ready, readyData)

    // Typed empty arrays so TS doesn't infer never[]
    const emptyVoiceStates: APIBaseVoiceState[] = []
    const emptyPresences: GatewayPresenceUpdate[] = []
    const emptyStageInstances: APIStageInstance[] = []
    const emptyScheduledEvents: APIGuildScheduledEvent[] = []
    const emptySoundboardSounds: APISoundboardSound[] = []

    for (const guild of state.guilds) {
      // GatewayGuildCreateDispatchData narrows channels to non-thread types
      // and threads to thread types. Our channels from the DB are all guild
      // channels (not threads), so the cast is safe. Threads are always empty
      // at GUILD_CREATE time in this test server.
      type GuildCreateChannels = GatewayGuildCreateDispatchData['channels']
      type GuildCreateThreads = GatewayGuildCreateDispatchData['threads']

      const guildData: GatewayGuildCreateDispatchData = {
        ...guild.apiGuild,
        joined_at: guild.joinedAt,
        large: false,
        unavailable: false,
        member_count: guild.members.length,
        voice_states: emptyVoiceStates,
        members: guild.members,
        channels: guild.channels as GuildCreateChannels,
        threads: [] as GuildCreateThreads,
        presences: emptyPresences,
        stage_instances: emptyStageInstances,
        guild_scheduled_events: emptyScheduledEvents,
        // soundboard_sounds is missing in Gelbpunkt/twilight 0.16 used by the
        // gateway-proxy main branch. Our remorses/twilight 0.16-updated fork
        // ignores unknown struct fields, so this is safe.
        soundboard_sounds: emptySoundboardSounds,
      }
      this.sendDispatch(client, GatewayDispatchEvents.GuildCreate, guildData)
    }

    // Like forward_shard in gateway-proxy server.rs: READY, GUILD_CREATEs,
    // then the events missed while offline, then the live stream.
    const missed = client.token ? (this.offlineEvents.get(client.token) ?? []) : []
    if (client.token) this.offlineEvents.delete(client.token)
    for (const buffered of missed) {
      if (client.guilds && !client.guilds.has(buffered.guildId)) continue
      this.sendDispatch(client, buffered.event, buffered.data)
    }
    const held = client.held ?? []
    client.held = null
    for (const live of held) this.sendDispatch(client, live.event, live.data)
  }
}
