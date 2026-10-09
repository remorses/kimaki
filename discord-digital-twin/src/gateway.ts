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
  APIVoiceState,
  APIStageInstance,
  APIGuildScheduledEvent,
  APISoundboardSound,
  GatewayVoiceServerUpdateDispatchData,
} from 'discord-api-types/v10'
import type { DiscordVoiceServer } from './voice.js'

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
  private botUserId: string
  private voice: DiscordVoiceServer | null
  // `${guildId}:${userId}` -> voice state, for users and the bot in a voice channel.
  private voiceStates = new Map<string, APIVoiceState>()

  constructor({
    httpServer,
    port,
    loadState,
    authorize,
    offlineClients,
    botUserId,
    voice,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
    authorize: GatewayAuthorize
    // Only in gateway-proxy mode. Real Discord has no offline buffer.
    offlineClients?: GatewayOfflineClients
    botUserId: string
    // Voice server for op 4 joins. Without it, op 4 is ignored.
    voice?: DiscordVoiceServer
  }) {
    this.port = port
    this.loadState = loadState
    this.authorize = authorize
    this.offlineClients = offlineClients ?? null
    this.botUserId = botUserId
    this.voice = voice ?? null
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

  // Moves a user (or the bot) into a voice channel, or out with channelId null,
  // and broadcasts VOICE_STATE_UPDATE to the guild.
  setVoiceState({
    guildId,
    channelId,
    userId,
    sessionId,
    selfMute = false,
    selfDeaf = false,
  }: {
    guildId: string
    channelId: string | null
    userId: string
    sessionId: string
    selfMute?: boolean
    selfDeaf?: boolean
  }): void {
    const key = `${guildId}:${userId}`
    const state: APIVoiceState = {
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
      session_id: sessionId,
      deaf: false,
      mute: false,
      self_deaf: selfDeaf,
      self_mute: selfMute,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    }
    if (channelId) this.voiceStates.set(key, state)
    else this.voiceStates.delete(key)
    this.broadcast(GatewayDispatchEvents.VoiceStateUpdate, state)
  }

  // Gateway op 4 from the bot session.
  private handleVoiceStateUpdate(
    client: ConnectedClient,
    { guildId, channelId, selfMute, selfDeaf }: { guildId: string; channelId: string | null; selfMute: boolean; selfDeaf: boolean },
  ): void {
    if (!this.voice) return
    if (client.guilds && !client.guilds.has(guildId)) return
    const current = this.voiceStates.get(`${guildId}:${this.botUserId}`)
    // Like Discord: a join for the channel this session is already in only
    // updates mute/deaf, with no new voice token. No change sends no events.
    if (channelId && current?.channel_id === channelId && current.session_id === client.sessionId) {
      if (current.self_mute === selfMute && current.self_deaf === selfDeaf) return
      this.setVoiceState({ guildId, channelId, userId: this.botUserId, sessionId: client.sessionId, selfMute, selfDeaf })
      return
    }
    if (!channelId) {
      if (!current) return
      this.voice.revoke({ guildId, userId: this.botUserId })
      this.setVoiceState({ guildId, channelId: null, userId: this.botUserId, sessionId: client.sessionId })
      return
    }
    this.setVoiceState({ guildId, channelId, userId: this.botUserId, sessionId: client.sessionId, selfMute, selfDeaf })
    const token = this.voice.grant({ guildId, channelId, userId: this.botUserId, sessionId: client.sessionId })
    const server: GatewayVoiceServerUpdateDispatchData = { token, guild_id: guildId, endpoint: this.voice.endpoint }
    // Only the session that asked gets the voice token.
    this.sendDispatch(client, GatewayDispatchEvents.VoiceServerUpdate, server)
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
      // The bot leaves voice when the gateway session that joined ends.
      for (const state of [...this.voiceStates.values()]) {
        if (state.user_id !== this.botUserId || state.session_id !== client.sessionId || !state.guild_id) continue
        this.voice?.revoke({ guildId: state.guild_id, userId: this.botUserId })
        this.setVoiceState({ guildId: state.guild_id, channelId: null, userId: this.botUserId, sessionId: client.sessionId })
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
      case GatewayOpcodes.VoiceStateUpdate: {
        if (!client.identified) return
        const { guild_id, channel_id, self_mute, self_deaf } = payload.d
        this.handleVoiceStateUpdate(client, { guildId: guild_id, channelId: channel_id, selfMute: self_mute, selfDeaf: self_deaf })
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
        voice_states: [...this.voiceStates.values()]
          .filter((voiceState) => voiceState.guild_id === guild.id)
          .map(({ guild_id: _guildId, ...voiceState }) => voiceState),
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
