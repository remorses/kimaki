---
title: Digital Discord - Local Discord API Test Server
description: |
  Comprehensive plan for building a local Discord API server (REST + Gateway
  WebSocket) that discord.js can connect to, enabling automated testing of the
  Kimaki bot without hitting real Discord. Uses Spiceflow for HTTP, ws for
  WebSocket, and Prisma + libsql for in-memory state.
prompt: |
  Voice transcript from Tommy asking to create a "digital twin" of Discord for
  testing Kimaki. The plan was created by reading: cli/src/discord-bot.ts,
  cli/src/discord-utils.ts, cli/src/interaction-handler.ts, all files
  in cli/src/commands/, the cli/package.json, the official Discord
  OpenAPI spec at opensrc/repos/github.com/discord/discord-api-spec/specs/
  openapi.json (139 paths, 498 schemas), Spiceflow source at opensrc/repos/
  github.com/remorses/spiceflow/, and the discord.js SDK source (@discordjs/
  rest and @discordjs/ws). Research included Discord Gateway protocol timing,
  discord-api-types npm package structure, and existing mock server packages.
---

# Digital Discord - Local Discord API Test Server

## Goal

Build a local server that implements enough of the Discord API (REST + Gateway
WebSocket) for the discord.js SDK to connect to it. This allows automated
testing of the Kimaki bot without real Discord, rate limits, or networking.

## Architecture

```
                         Test Suite (vitest)
                               |
            ┌──────────────────┼──────────────────┐
            |                  |                   |
            v                  v                   v
     DigitalDiscord      discord.js Client     Kimaki Bot
     test utilities      (pointed at local)    (unchanged)
     (inject messages,        |                    |
      assert state)           |                    |
            |                 v                    v
            |    ┌────────────────────────────────────┐
             |    |     discord-digital-twin server      |
            |    |                                     |
            |    |  ┌──────────────┐ ┌──────────────┐  |
            |    |  | HTTP Server  | | WS Gateway   |  |
            └───>|  | (Spiceflow)  | | (ws library) |  |
                 |  | /api/v10/*   | | /gateway     |  |
                 |  └──────┬───────┘ └──────┬───────┘  |
                 |         |                |          |
                 |         v                v          |
                 |  ┌──────────────────────────────┐   |
                 |  | Prisma + libsql (in-memory)  |   |
                 |  | guilds, channels, messages,  |   |
                 |  | threads, members, roles,     |   |
                 |  | reactions, interactions      |   |
                 |  └──────────────────────────────┘   |
                 └─────────────────────────────────────┘
```

## Reference Specifications and Resources

### Official Discord OpenAPI Spec

The Discord team publishes an official OpenAPI 3.1 spec:

- **Repository**: https://github.com/discord/discord-api-spec
- **Local copy**: `opensrc/repos/github.com/discord/discord-api-spec/specs/openapi.json`
- **Size**: 139 REST paths, 498 schemas
- **License**: MIT
- **API version**: v10

To download locally:

```bash
npx opensrc discord/discord-api-spec
```

The spec contains all REST endpoint definitions with request/response schemas.
Use it to validate that our route handlers accept the right parameters and
return the right shapes. The schema names follow Discord's internal naming
(e.g., `MessageResponse`, `GuildResponse`, `ChannelResponse`).

**How to read**: Parse the JSON, look up a path like
`/channels/{channel_id}/messages`, find the `post` method, check
`requestBody.content.application/json.schema` for the input shape and
`responses.200.content.application/json.schema` for the output shape. Schema
`$ref` values point to `#/components/schemas/SchemaName`.

**Caveats** (from the README): nullable fields may also be marked optional,
no descriptions on most operations/fields, no tags, flag values not detailed.

### Discord Developer Documentation

- **Gateway**: https://discord.com/developers/docs/events/gateway
- **Gateway Events**: https://discord.com/developers/docs/events/gateway-events
- **REST API**: https://discord.com/developers/docs/reference
- **Channels**: https://discord.com/developers/docs/resources/channel
- **Guilds**: https://discord.com/developers/docs/resources/guild
- **Users**: https://discord.com/developers/docs/resources/user
- **Interactions**: https://discord.com/developers/docs/interactions/receiving-and-responding
- **Message Components**: https://discord.com/developers/docs/interactions/message-components
- **Threads**: https://discord.com/developers/docs/resources/channel#threads
- **Rate Limits**: https://discord.com/developers/docs/topics/rate-limits
- **Opcodes & Status Codes**: https://discord.com/developers/docs/topics/opcodes-and-status-codes

Each implementing agent should fetch the relevant docs page for the endpoints
they are building. For example, the agent implementing message routes should
fetch `https://discord.com/developers/docs/resources/channel` and look at the
"Create Message" section for detailed field descriptions.

### NPM Packages for Types

**`discord-api-types`** is the single source of truth for TypeScript types.
It maps 1:1 to the official Discord API and is maintained by the discord.js
team.

```bash
pnpm add discord-api-types
```

#### Import Paths

```ts
// Everything for API v10 (most convenient)
import { ... } from 'discord-api-types/v10'

// Or more specific subpaths:
import { ... } from 'discord-api-types/gateway/v10'
import { ... } from 'discord-api-types/payloads/v10'
import { ... } from 'discord-api-types/rest/v10'
```

#### API Object Types (payloads)

These are the shapes of Discord objects returned in REST responses and
Gateway events:

```ts
import type {
  APIUser,
  APIGuild,
  APIChannel,
  APIMessage,
  APIGuildMember,
  APIRole,
  APIEmoji,
  APIApplication,
  APIUnavailableGuild,
  APIGatewayBotInfo,
  APIGatewaySessionStartLimit,
  APIAttachment,
  APIEmbed,
  APIAllowedMentions,
  APIMessageReference,
  APIThreadChannel,
  APIThreadMember,
  ChannelType,
  MessageFlags,
  MessageType,
  GuildFeature,
  InteractionType,
} from 'discord-api-types/v10'
```

#### Gateway Types (WebSocket protocol)

```ts
import {
  GatewayOpcodes, // Dispatch=0, Heartbeat=1, Identify=2, etc.
  GatewayDispatchEvents, // 'READY', 'MESSAGE_CREATE', etc. (60+ events)
  GatewayCloseCodes, // UnknownError=4000..DisallowedIntents=4014
  GatewayIntentBits, // Guilds, GuildMessages, MessageContent, etc.
  GatewayVersion, // '10'
} from 'discord-api-types/v10'

import type {
  // Client -> Server payloads
  GatewaySendPayload,
  GatewayIdentify,
  GatewayIdentifyData,
  GatewayIdentifyProperties,
  GatewayResume,
  GatewayResumeData,
  GatewayHeartbeat,

  // Server -> Client payloads
  GatewayReceivePayload,
  GatewayDispatchPayload,
  GatewayHello,
  GatewayHelloData,
  GatewayHeartbeatAck,
  GatewayInvalidSession,
  GatewayReconnect,

  // Dispatch event data types
  GatewayReadyDispatchData,
  GatewayGuildCreateDispatchData,
  GatewayMessageCreateDispatchData,
  GatewayInteractionCreateDispatch,
  GatewayChannelModifyDispatch,
  GatewayTypingStartDispatch,
} from 'discord-api-types/v10'
```

#### REST Route Types

The naming convention is `REST{Method}API{Resource}{Action}{Suffix}`:

```ts
import type {
  // Messages
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIChannelMessageResult, // = APIMessage
  RESTGetAPIChannelMessagesQuery,
  RESTGetAPIChannelMessagesResult, // = APIMessage[]
  RESTGetAPIChannelMessageResult, // = APIMessage
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageResult, // = APIMessage

  // Channels
  RESTGetAPIChannelResult, // = APIChannel
  RESTPatchAPIChannelJSONBody,
  RESTPatchAPIChannelResult, // = APIChannel
  RESTDeleteAPIChannelResult, // = APIChannel

  // Threads
  RESTPostAPIChannelThreadsJSONBody,
  RESTPostAPIChannelThreadsResult,
  RESTPostAPIChannelMessagesThreadsJSONBody,

  // Typing (returns 204 no content)
  RESTPostAPIChannelTypingResult, // = never

  // Reactions (returns 204 no content)
  RESTPutAPIChannelMessageReactionResult, // = never

  // Gateway
  RESTGetAPIGatewayBotResult, // = APIGatewayBotInfo
} from 'discord-api-types/v10'
```

#### Routes Helper

The `Routes` object builds URL paths. Use it as a reference for which
paths to implement:

```ts
import { Routes } from 'discord-api-types/v10'

// Examples:
Routes.channel('123') // '/channels/123'
Routes.channelMessages('123') // '/channels/123/messages'
Routes.channelMessage('123', '456') // '/channels/123/messages/456'
Routes.channelTyping('123') // '/channels/123/typing'
Routes.channelMessageOwnReaction('ch', 'msg', 'emoji')
Routes.threads('123') // '/channels/123/threads'
Routes.threads('123', '456') // '/channels/123/messages/456/threads'
Routes.threadMembers('123') // '/channels/123/thread-members'
Routes.guild('123') // '/guilds/123'
Routes.guildChannels('123') // '/guilds/123/channels'
Routes.guildMembers('123') // '/guilds/123/members'
Routes.guildMembersSearch('123') // '/guilds/123/members/search'
Routes.guildRoles('123') // '/guilds/123/roles'
Routes.user() // '/users/@me'
Routes.user('123') // '/users/123'
Routes.gatewayBot() // '/gateway/bot'
Routes.applicationCommands('app') // '/applications/app/commands'
Routes.applicationGuildCommands('app', 'guild') // '/applications/app/guilds/guild/commands'
Routes.interactionCallback('id', 'token') // '/interactions/id/token/callback'
Routes.webhook('id', 'token') // '/webhooks/id/token'
Routes.webhookMessage('id', 'token', 'msg') // '/webhooks/id/token/messages/msg'
```

### Existing Mock Server Packages (for reference only)

No mature implementation exists. The closest is:

- **blurplejs/blurple** (https://github.com/blurplejs/blurple): Koa HTTP
  server + in-memory repositories. Abandoned in 2022, incomplete, but
  useful for seeing how someone structured route handlers.
- **@shoginn/discordjs-mock**: Creates mock discord.js objects (not a server).
- **lvnacy/gauntlet**: Discord.js mock library, not a server.

We are building something novel.

### Spiceflow Documentation

Spiceflow is the HTTP API framework used in this project.

- **Source**: `opensrc/repos/github.com/remorses/spiceflow/`
- **npm**: https://www.npmjs.com/package/spiceflow
- **Docs**: https://getspiceflow.com/

**Important**: Spiceflow supports Zod schemas for `params`, `request`,
and `response` validation, but we do **NOT** use them for this server.
`discord-api-types` only publishes TypeScript types (no Zod schemas, no
runtime validators). Writing Zod schemas that mirror 498 Discord types
would be a massive maintenance burden with no real benefit -- our only
client is discord.js, which already sends well-formed payloads.

Instead, we use a simpler approach:

- **Return type annotations** on every serializer function and route handler.
  The compiler rejects missing or wrong fields at the function boundary.
- **No blanket `as Type` casts on return objects**. These bypass the return
  type check and silently hide missing fields. Removed in Phase 1 cleanup.
- **No `as unknown as Type` double casts**. These bypass ALL checking and
  were fully eliminated.
- **Targeted `as` only where unavoidable**, each documented inline:
  - `JSON.parse()` results (returns `any`, needs a type annotation)
  - `APIChannel` returns in `channelToAPI()` (discriminated union whose
    concrete variant is only known at runtime)
  - `APIMessage` returns in `messageToAPI()` (conditional spreads change
    the inferred shape)
  - Enum bitfield zero values via a `noFlags<T>()` helper (Discord enums
    don't include 0 as a member, but 0 means "no flags set")
- **Import and use enum values** instead of bare numbers for flag fields:
  `ApplicationFlags.GatewayPresence`, `Locale.EnglishUS`,
  `ApplicationWebhookEventStatus.Disabled`, etc.
- **Typed empty arrays**: `const x: SomeType[] = []` instead of bare `[]`
  which infers as `never[]`.
- **No runtime validation** on inputs or outputs

### REST route pattern (Spiceflow)

Spiceflow already infers `params` types from the path pattern, so no
casting needed there. For request bodies, `await request.json()` returns
`any` -- this is the one place `as` is justified (cast to the
`discord-api-types` request body type). For return types, annotate the
handler return type and let the compiler validate the shape.

```ts
import { Spiceflow } from 'spiceflow'
import type {
  RESTPostAPIChannelMessageJSONBody,
  RESTGetAPIGatewayBotResult,
  APIMessage,
} from 'discord-api-types/v10'

const app = new Spiceflow({ basePath: '/api/v10' })
  .route({
    method: 'GET',
    path: '/gateway/bot',
    handler(): RESTGetAPIGatewayBotResult {
      return {
        url: 'ws://localhost:PORT/gateway',
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
  .route({
    method: 'POST',
    path: '/channels/:channel_id/messages',
    async handler({ params, request }): Promise<APIMessage> {
      // params.channel_id is already typed by Spiceflow from the path
      const body = (await request.json()) as RESTPostAPIChannelMessageJSONBody
      const dbMessage = await createMessage(params.channel_id, body)
      // dispatch MESSAGE_CREATE to WS clients
      state.dispatch('MESSAGE_CREATE', messageToAPI(dbMessage))
      return messageToAPI(dbMessage)
    },
  })
```

### WebSocket Gateway pattern (ws library)

Spiceflow does NOT support WebSocket. We use the `ws` npm package
directly on the same Node HTTP server. Spiceflow's `handleForNode(app)`
converts the Spiceflow app into a Node request handler, and `ws`
handles the upgrade on the `/gateway` path.

All Gateway payloads are typed using `discord-api-types` -- both the
messages we send (server -> client) and the messages we receive
(client -> server). The `GatewaySendPayload` union covers everything
the client can send, and we construct typed dispatch payloads using
the specific `Gateway*DispatchData` types.

The Gateway is implemented as a class that owns the `WebSocketServer`,
tracks connected clients, and exposes methods for dispatching events.
REST routes call `gateway.broadcast()` to push events to all clients.

```ts
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { handleForNode } from 'spiceflow/_node-server'
import { GatewayOpcodes, GatewayDispatchEvents } from 'discord-api-types/v10'
import type {
  GatewaySendPayload,
  GatewayIdentifyData,
  GatewayHelloData,
  GatewayReadyDispatchData,
  GatewayGuildCreateDispatchData,
  GatewayMessageCreateDispatchData,
  APIMessage,
} from 'discord-api-types/v10'

// --- per-connection state (internal, not exported) ---

interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
}

// --- Gateway class ---

class DiscordGateway {
  wss: WebSocketServer
  clients: ConnectedClient[] = []

  // injected dependencies: how to load guilds/bot user for READY
  private loadState: () => Promise<GatewayState>
  private port: number

  constructor({
    httpServer,
    port,
    loadState,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
  }) {
    this.port = port
    this.loadState = loadState
    this.wss = new WebSocketServer({ server: httpServer, path: '/gateway' })
    this.wss.on('connection', (ws) => {
      this.handleConnection(ws)
    })
  }

  // --- public methods (called by REST routes and test utilities) ---

  broadcast<T>(event: string, data: T): void {
    for (const client of this.clients) {
      if (client.identified) {
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

  close(): void {
    for (const client of this.clients) {
      client.ws.close()
    }
    this.clients = []
    this.wss.close()
  }

  // --- private: send helpers ---

  private send(client: ConnectedClient, payload: unknown): void {
    client.ws.send(JSON.stringify(payload))
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

  // --- private: connection lifecycle ---

  private handleConnection(ws: WebSocket): void {
    const client: ConnectedClient = {
      ws,
      sessionId: crypto.randomUUID(),
      sequence: 0,
      identified: false,
      intents: 0,
    }
    this.clients.push(client)
    this.sendHello(client)

    ws.on('message', (raw) => {
      this.handleMessage(client, raw.toString())
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
    const payload = JSON.parse(raw) as GatewaySendPayload

    switch (payload.op) {
      case GatewayOpcodes.Heartbeat: {
        this.sendHeartbeatAck(client)
        break
      }
      case GatewayOpcodes.Identify: {
        const data = payload.d as GatewayIdentifyData
        client.identified = true
        client.intents = data.intents
        await this.sendReadySequence(client)
        break
      }
    }
  }

  private async sendReadySequence(client: ConnectedClient): Promise<void> {
    const state = await this.loadState()

    // Use ApplicationFlags enum instead of bare number for flags
    const readyData: GatewayReadyDispatchData = {
      v: 10,
      user: state.botUser,
      guilds: state.guilds.map((g) => ({
        id: g.id,
        unavailable: true,
      })),
      session_id: client.sessionId,
      resume_gateway_url: `ws://localhost:${this.port}/gateway`,
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
      // Use local type aliases for the narrowed channel/thread array types
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
        soundboard_sounds: emptySoundboardSounds,
      }
      this.sendDispatch(client, GatewayDispatchEvents.GuildCreate, guildData)
    }
  }
}

// GatewayState is what loadState() returns (built from DB by the server)
interface GatewayState {
  botUser: APIUser
  guilds: Array<{
    id: string
    apiGuild: APIGuild // serialized from DB
    joinedAt: string // ISO8601
    members: APIGuildMember[]
    channels: APIChannel[]
  }>
}
```

**Server setup** -- the HTTP server, Spiceflow app, and Gateway class
are wired together:

```ts
const httpServer = http.createServer(handleForNode(app))
const gateway = new DiscordGateway({
  httpServer,
  port,
  loadState: async () => buildGatewayState(prisma),
})
httpServer.listen(port)
```

REST routes call `gateway.broadcast()` or the typed convenience methods:

```ts
// in messages.ts route handler, after creating a message in DB:
gateway.broadcastMessageCreate(messageToAPI(dbMessage), guildId)

// in threads.ts route handler, after creating a thread:
gateway.broadcast(GatewayDispatchEvents.ThreadCreate, threadToAPI(dbThread))
```

The key pattern is: **return type annotations do the heavy lifting**.
Every serializer function and route handler declares its return type
explicitly. The compiler validates that the returned object matches.
We only use `as` for JSON.parse results (unavoidable) and for two
union types that can't be narrowed at compile time (APIChannel,
APIMessage). Enum values like `ApplicationFlags.GatewayPresence` are
imported and used directly instead of bare numbers. Empty arrays are
typed explicitly to prevent `never[]` inference.

**Important**: `discord-api-types` enums are plain TypeScript enums,
not branded types. All interfaces accept plain object literals. The
only tricky type is `APIChannel` -- a discriminated union of 12
channel variants keyed by `type`. Build concrete variants or use a
documented `as APIChannel` cast.

---

## Discord.js SDK Override Mechanism

The discord.js SDK can be pointed at a local server with zero patching:

### REST API Override

```ts
import { Client, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest: {
    api: 'http://localhost:PORT/api', // overrides https://discord.com/api
    version: '10',
  },
})

client.login('fake-bot-token')
```

- **Where it's set**: `@discordjs/rest` `RESTOptions.api` field
- **URL construction**: `${api}/v${version}${route}${query}`
- **HTTP client**: `undici.request()` internally (can be overridden via
  `rest.makeRequest` option)
- **Auth header**: `Authorization: Bot fake-bot-token`

### Gateway WebSocket Override

There is no direct gateway URL override. Instead, discord.js fetches
`GET /api/v10/gateway/bot` and connects to the `url` field in the response.

Our `/gateway/bot` endpoint returns:

```json
{
  "url": "ws://localhost:PORT/gateway",
  "shards": 1,
  "session_start_limit": {
    "total": 1000,
    "remaining": 999,
    "reset_after": 14400000,
    "max_concurrency": 1
  }
}
```

The SDK then connects to `ws://localhost:PORT/gateway?v=10&encoding=json`.

- **WebSocket library**: `ws` npm package in Node.js
- **Gateway version**: v10 (query param `v=10`)
- **Encoding**: JSON (query param `encoding=json`)

---

## Gateway WebSocket Protocol Specification

### Connection Lifecycle

```
Client                                  Server
  |                                       |
  |--- WebSocket connect ───────────────>|
  |                                       |
  |<──── op 10 Hello ────────────────────|  (immediately on connect)
  |      { heartbeat_interval: 45000 }    |
  |                                       |
  |── op 1 Heartbeat ──────────────────->|  (after interval * jitter)
  |      { d: null }                      |
  |                                       |
  |<──── op 11 Heartbeat ACK ───────────|
  |                                       |
  |── op 2 Identify ──────────────────->|
  |      { token, intents, properties }   |
  |                                       |
  |<──── op 0 READY ────────────────────|
  |      { v, user, guilds, session_id,  |
  |        resume_gateway_url, app }      |
  |                                       |
  |<──── op 0 GUILD_CREATE ─────────────|  (one per guild)
  |      { full guild object }            |
  |                                       |
  |      (periodic heartbeats)            |
  |── op 1 Heartbeat ──────────────────->|  (every heartbeat_interval)
  |<──── op 11 Heartbeat ACK ───────────|
  |                                       |
  |<──── op 0 MESSAGE_CREATE ───────────|  (when REST creates a message)
  |<──── op 0 THREAD_CREATE ────────────|  (when REST creates a thread)
  |<──── op 0 INTERACTION_CREATE ───────|  (when test injects interaction)
  |      ...                              |
```

### Opcodes

| Op  | Name                  | Direction        | Description                                      |
| --- | --------------------- | ---------------- | ------------------------------------------------ |
| 0   | Dispatch              | Server -> Client | Event dispatched (has `t` name and `s` sequence) |
| 1   | Heartbeat             | Both             | Keep-alive ping/pong                             |
| 2   | Identify              | Client -> Server | Initial auth with token + intents                |
| 3   | Presence Update       | Client -> Server | Update bot presence                              |
| 4   | Voice State Update    | Client -> Server | Join/leave voice (skip)                          |
| 6   | Resume                | Client -> Server | Resume disconnected session                      |
| 7   | Reconnect             | Server -> Client | Server tells client to reconnect                 |
| 8   | Request Guild Members | Client -> Server | Request offline members                          |
| 9   | Invalid Session       | Server -> Client | Session invalidated                              |
| 10  | Hello                 | Server -> Client | First message with heartbeat_interval            |
| 11  | Heartbeat ACK         | Server -> Client | Confirms heartbeat received                      |

### Payload Format

```ts
// All Gateway messages have this shape:
interface GatewayPayload {
  op: number // opcode
  d?: unknown // payload data
  s?: number | null // sequence number (only for op 0)
  t?: string | null // event name (only for op 0)
}
```

### Timing Details

| Parameter              | Value                            | Notes                                                                        |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `heartbeat_interval`   | 45000 ms                         | Sent in Hello; for test server, use a shorter value like 30000 or even 10000 |
| First heartbeat jitter | `interval * random(0, 1)`        | Client waits this before first heartbeat                                     |
| Hello sent             | Immediately on connect           | No delay                                                                     |
| Identify timeout       | Not formally specified           | If not sent, connection just idles                                           |
| READY sent             | Immediately after valid Identify | No artificial delay needed                                                   |
| GUILD_CREATE sent      | After READY                      | One per guild, sent sequentially                                             |
| Gateway rate limit     | 120 events per 60 seconds        | Client -> Server direction                                                   |
| Max payload size       | 4096 bytes                       | Client -> Server direction                                                   |

### Hello Payload (op 10)

```json
{ "op": 10, "d": { "heartbeat_interval": 45000 }, "s": null, "t": null }
```

### Identify Payload (op 2)

```json
{
  "op": 2,
  "d": {
    "token": "Bot fake-token",
    "intents": 33281,
    "properties": {
      "os": "linux",
      "browser": "discord.js",
      "device": "discord.js"
    },
    "compress": false,
    "large_threshold": 50,
    "shard": [0, 1]
  }
}
```

Required fields in `d`: `token`, `properties`, `intents`.

### READY Payload (op 0, t: "READY")

```json
{
  "op": 0,
  "s": 1,
  "t": "READY",
  "d": {
    "v": 10,
    "user": {
      "id": "BOT_USER_ID",
      "username": "TestBot",
      "discriminator": "0",
      "avatar": null,
      "bot": true,
      "system": false,
      "flags": 0,
      "global_name": "TestBot"
    },
    "guilds": [{ "id": "GUILD_ID", "unavailable": true }],
    "session_id": "random-session-id",
    "resume_gateway_url": "ws://localhost:PORT/gateway",
    "shard": [0, 1],
    "application": { "id": "BOT_USER_ID", "flags": 565248 }
  }
}
```

### GUILD_CREATE Payload (op 0, t: "GUILD_CREATE")

Sent after READY for each guild. This is a full guild object with extras:

```json
{
  "op": 0,
  "s": 2,
  "t": "GUILD_CREATE",
  "d": {
    "id": "GUILD_ID",
    "name": "Test Server",
    "icon": null,
    "splash": null,
    "discovery_splash": null,
    "owner_id": "OWNER_USER_ID",
    "afk_channel_id": null,
    "afk_timeout": 300,
    "verification_level": 0,
    "default_message_notifications": 0,
    "explicit_content_filter": 0,
    "roles": [
      {
        "id": "GUILD_ID",
        "name": "@everyone",
        "color": 0,
        "hoist": false,
        "position": 0,
        "permissions": "1071698660929",
        "managed": false,
        "mentionable": false,
        "flags": 0
      }
    ],
    "emojis": [],
    "features": [],
    "mfa_level": 0,
    "application_id": null,
    "system_channel_id": null,
    "system_channel_flags": 0,
    "rules_channel_id": null,
    "vanity_url_code": null,
    "description": null,
    "banner": null,
    "premium_tier": 0,
    "preferred_locale": "en-US",
    "public_updates_channel_id": null,
    "nsfw_level": 0,
    "premium_progress_bar_enabled": false,
    "safety_alerts_channel_id": null,
    "joined_at": "2024-01-01T00:00:00.000000+00:00",
    "large": false,
    "unavailable": false,
    "member_count": 2,
    "voice_states": [],
    "members": [
      {
        "user": { "id": "BOT_USER_ID", "username": "TestBot", "bot": true },
        "roles": [],
        "joined_at": "2024-01-01T00:00:00.000000+00:00",
        "deaf": false,
        "mute": false
      }
    ],
    "channels": [],
    "threads": [],
    "presences": [],
    "stage_instances": [],
    "guild_scheduled_events": [],
    "soundboard_sounds": []
  }
}
```

### MESSAGE_CREATE Payload (op 0, t: "MESSAGE_CREATE")

```json
{
  "op": 0,
  "s": 42,
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "MSG_SNOWFLAKE",
    "channel_id": "CHANNEL_ID",
    "guild_id": "GUILD_ID",
    "author": {
      "id": "USER_ID",
      "username": "TestUser",
      "discriminator": "0",
      "avatar": null,
      "bot": false,
      "global_name": "TestUser"
    },
    "member": {
      "roles": [],
      "joined_at": "2024-01-01T00:00:00.000000+00:00",
      "deaf": false,
      "mute": false
    },
    "content": "Hello bot!",
    "timestamp": "2024-01-01T12:00:00.000000+00:00",
    "edited_timestamp": null,
    "tts": false,
    "mention_everyone": false,
    "mentions": [],
    "mention_roles": [],
    "attachments": [],
    "embeds": [],
    "pinned": false,
    "type": 0
  }
}
```

Required message fields: `id`, `channel_id`, `author`, `content`,
`timestamp`, `edited_timestamp`, `tts`, `mention_everyone`, `mentions`,
`mention_roles`, `attachments`, `embeds`, `pinned`, `type`.

Optional but frequently used: `guild_id`, `member`, `flags`, `components`,
`message_reference`, `referenced_message`, `thread`, `nonce`,
`webhook_id`, `application_id`.

### INTERACTION_CREATE Payload (op 0, t: "INTERACTION_CREATE")

```json
{
  "op": 0,
  "s": 43,
  "t": "INTERACTION_CREATE",
  "d": {
    "id": "INTERACTION_SNOWFLAKE",
    "application_id": "BOT_USER_ID",
    "type": 2,
    "data": {
      "id": "CMD_SNOWFLAKE",
      "name": "model",
      "type": 1,
      "options": [{ "name": "provider", "type": 3, "value": "anthropic" }]
    },
    "guild_id": "GUILD_ID",
    "channel": {
      "id": "CHANNEL_ID",
      "type": 11,
      "name": "test-thread",
      "parent_id": "PARENT_CHANNEL_ID",
      "guild_id": "GUILD_ID"
    },
    "channel_id": "CHANNEL_ID",
    "member": {
      "user": {
        "id": "USER_ID",
        "username": "TestUser",
        "discriminator": "0",
        "avatar": null,
        "bot": false,
        "global_name": "TestUser"
      },
      "roles": [],
      "joined_at": "2024-01-01T00:00:00.000000+00:00",
      "deaf": false,
      "mute": false,
      "permissions": "1099511627775"
    },
    "token": "unique-interaction-token-abc123",
    "version": 1,
    "app_permissions": "1099511627775",
    "locale": "en-US",
    "guild_locale": "en-US",
    "entitlements": [],
    "authorizing_integration_owners": {},
    "context": 0,
    "attachment_size_limit": 26214400
  }
}
```

Interaction types: 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT,
4=AUTOCOMPLETE, 5=MODAL_SUBMIT.

**Important**: The `token` field is used for responding to interactions.
The interaction callback endpoint is
`POST /interactions/{id}/{token}/callback`. The token is valid for 15
minutes, and the bot must respond within 3 seconds (or defer).

### THREAD_CREATE Payload (op 0, t: "THREAD_CREATE")

```json
{
  "op": 0,
  "s": 5,
  "t": "THREAD_CREATE",
  "d": {
    "id": "THREAD_SNOWFLAKE",
    "guild_id": "GUILD_ID",
    "parent_id": "PARENT_CHANNEL_ID",
    "owner_id": "USER_ID",
    "name": "my-thread",
    "type": 11,
    "last_message_id": null,
    "message_count": 0,
    "member_count": 1,
    "rate_limit_per_user": 0,
    "thread_metadata": {
      "archived": false,
      "auto_archive_duration": 1440,
      "archive_timestamp": "2024-01-01T00:00:00.000000+00:00",
      "locked": false
    },
    "total_message_sent": 0,
    "newly_created": true
  }
}
```

### Gateway Close Codes

| Code | Name                  | Reconnectable | Description                      |
| ---- | --------------------- | :-----------: | -------------------------------- |
| 4000 | Unknown error         |      Yes      | Try reconnecting                 |
| 4001 | Unknown opcode        |      Yes      | Invalid opcode sent              |
| 4002 | Decode error          |      Yes      | Invalid payload (or >4096 bytes) |
| 4003 | Not authenticated     |      Yes      | Payload sent before Identify     |
| 4004 | Authentication failed |    **No**     | Bad token                        |
| 4005 | Already authenticated |      Yes      | Sent >1 Identify                 |
| 4007 | Invalid seq           |      Yes      | Bad sequence on Resume           |
| 4008 | Rate limited          |      Yes      | Sending too fast                 |
| 4009 | Session timed out     |      Yes      | Session expired                  |
| 4010 | Invalid shard         |    **No**     | Invalid shard value              |
| 4011 | Sharding required     |    **No**     | Too many guilds                  |
| 4012 | Invalid API version   |    **No**     | Bad gateway version              |
| 4013 | Invalid intent(s)     |    **No**     | Bad bitwise intent value         |
| 4014 | Disallowed intent(s)  |    **No**     | Privileged intent not enabled    |

For the test server, only code **4004** matters (reject bad tokens). All
other codes should not be triggered by normal bot usage.

---

## REST API Error Format

When a REST endpoint returns an error, use this JSON structure:

```json
{
  "code": 10003,
  "message": "Unknown Channel",
  "errors": {}
}
```

Common error codes:

- **10003**: Unknown Channel
- **10004**: Unknown Guild
- **10008**: Unknown Message
- **10062**: Unknown Interaction
- **50001**: Missing Access
- **50013**: Missing Permissions
- **50035**: Invalid Form Body (validation errors)

The `errors` object can contain nested field-level errors:

```json
{
  "code": 50035,
  "message": "Invalid Form Body",
  "errors": {
    "content": {
      "_errors": [
        {
          "code": "BASE_TYPE_MAX_LENGTH",
          "message": "Must be 2000 or fewer in length."
        }
      ]
    }
  }
}
```

### Rate Limit Headers

Return these on every successful response (prevents discord.js from
self-throttling):

```
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 49
X-RateLimit-Reset: 1700000000.000
X-RateLimit-Reset-After: 1.0
X-RateLimit-Bucket: fake-bucket-hash
```

The test server should return generous rate limit headers so the SDK
never throttles itself.

---

## REST Endpoints to Implement

Grouped by the Kimaki bot's actual usage. Each entry lists the HTTP method,
path (Spiceflow route format), the discord-api-types REST type for
request/response, and the corresponding Gateway dispatch event (if any).

### Phase 1: Core (bot can start) -- DONE

| Method | Spiceflow Path                           | Request Type                            | Response Type                         | Gateway Event |
| ------ | ---------------------------------------- | --------------------------------------- | ------------------------------------- | ------------- |
| GET    | `/gateway/bot`                           | -                                       | `RESTGetAPIGatewayBotResult`          | -             |
| GET    | `/users/@me`                             | -                                       | `APIUser`                             | -             |
| GET    | `/users/:user_id`                        | -                                       | `APIUser`                             | -             |
| GET    | `/applications/@me`                      | -                                       | `APIApplication`                      | -             |
| PUT    | `/applications/:application_id/commands` | `RESTPutAPIApplicationCommandsJSONBody` | `RESTPutAPIApplicationCommandsResult` | -             |

### Phase 2: Messages

| Method | Spiceflow Path                                                    | Request Type                         | Response Type  | Gateway Event             |
| ------ | ----------------------------------------------------------------- | ------------------------------------ | -------------- | ------------------------- |
| POST   | `/channels/:channel_id/messages`                                  | `RESTPostAPIChannelMessageJSONBody`  | `APIMessage`   | `MESSAGE_CREATE`          |
| PATCH  | `/channels/:channel_id/messages/:message_id`                      | `RESTPatchAPIChannelMessageJSONBody` | `APIMessage`   | `MESSAGE_UPDATE`          |
| GET    | `/channels/:channel_id/messages/:message_id`                      | -                                    | `APIMessage`   | -                         |
| GET    | `/channels/:channel_id/messages`                                  | `RESTGetAPIChannelMessagesQuery`     | `APIMessage[]` | -                         |
| DELETE | `/channels/:channel_id/messages/:message_id`                      | -                                    | 204            | `MESSAGE_DELETE`          |
| POST   | `/channels/:channel_id/typing`                                    | -                                    | 204            | `TYPING_START`            |
| PUT    | `/channels/:channel_id/messages/:message_id/reactions/:emoji/@me` | -                                    | 204            | `MESSAGE_REACTION_ADD`    |
| DELETE | `/channels/:channel_id/messages/:message_id/reactions/:emoji/@me` | -                                    | 204            | `MESSAGE_REACTION_REMOVE` |

### Phase 3: Channels and Threads

| Method | Spiceflow Path                                       | Request Type                                | Response Type       | Gateway Event                       |
| ------ | ---------------------------------------------------- | ------------------------------------------- | ------------------- | ----------------------------------- |
| GET    | `/channels/:channel_id`                              | -                                           | `APIChannel`        | -                                   |
| PATCH  | `/channels/:channel_id`                              | `RESTPatchAPIChannelJSONBody`               | `APIChannel`        | `CHANNEL_UPDATE` or `THREAD_UPDATE` |
| DELETE | `/channels/:channel_id`                              | -                                           | `APIChannel`        | `CHANNEL_DELETE` or `THREAD_DELETE` |
| POST   | `/channels/:channel_id/threads`                      | `RESTPostAPIChannelThreadsJSONBody`         | `APIChannel`        | `THREAD_CREATE`                     |
| POST   | `/channels/:channel_id/messages/:message_id/threads` | `RESTPostAPIChannelMessagesThreadsJSONBody` | `APIChannel`        | `THREAD_CREATE`                     |
| PUT    | `/channels/:channel_id/thread-members/:user_id`      | -                                           | 204                 | `THREAD_MEMBERS_UPDATE`             |
| GET    | `/channels/:channel_id/thread-members`               | -                                           | `APIThreadMember[]` | -                                   |

### Phase 4: Interactions

| Method | Spiceflow Path                                              | Request Type              | Response Type | Gateway Event    |
| ------ | ----------------------------------------------------------- | ------------------------- | ------------- | ---------------- |
| POST   | `/interactions/:interaction_id/:interaction_token/callback` | Interaction callback body | 204           | -                |
| GET    | `/webhooks/:webhook_id/:webhook_token/messages/@original`   | -                         | `APIMessage`  | -                |
| PATCH  | `/webhooks/:webhook_id/:webhook_token/messages/@original`   | message edit body         | `APIMessage`  | `MESSAGE_UPDATE` |
| DELETE | `/webhooks/:webhook_id/:webhook_token/messages/@original`   | -                         | 204           | `MESSAGE_DELETE` |
| POST   | `/webhooks/:webhook_id/:webhook_token`                      | message create body       | `APIMessage`  | `MESSAGE_CREATE` |
| PATCH  | `/webhooks/:webhook_id/:webhook_token/messages/:message_id` | message edit body         | `APIMessage`  | `MESSAGE_UPDATE` |

Interaction callback types (in the request body `type` field):

1. PONG
2. CHANNEL_MESSAGE_WITH_SOURCE
3. DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
4. DEFERRED_UPDATE_MESSAGE
5. UPDATE_MESSAGE
6. APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
7. MODAL

### Phase 5: Guild Management

| Method | Spiceflow Path                       | Request Type                        | Response Type         | Gateway Event       |
| ------ | ------------------------------------ | ----------------------------------- | --------------------- | ------------------- |
| GET    | `/guilds/:guild_id`                  | -                                   | `APIGuild`            | -                   |
| GET    | `/guilds/:guild_id/channels`         | -                                   | `APIChannel[]`        | -                   |
| POST   | `/guilds/:guild_id/channels`         | create channel body                 | `APIChannel`          | `CHANNEL_CREATE`    |
| GET    | `/guilds/:guild_id/roles`            | -                                   | `APIRole[]`           | -                   |
| POST   | `/guilds/:guild_id/roles`            | create role body                    | `APIRole`             | `GUILD_ROLE_CREATE` |
| PATCH  | `/guilds/:guild_id/roles/:role_id`   | modify role body                    | `APIRole`             | `GUILD_ROLE_UPDATE` |
| GET    | `/guilds/:guild_id/members/search`   | `RESTGetAPIGuildMembersSearchQuery` | `APIGuildMember[]`    | -                   |
| GET    | `/guilds/:guild_id/members`          | `RESTGetAPIGuildMembersQuery`       | `APIGuildMember[]`    | -                   |
| GET    | `/guilds/:guild_id/members/:user_id` | -                                   | `APIGuildMember`      | -                   |
| GET    | `/guilds/:guild_id/threads/active`   | -                                   | active threads object | -                   |

---

## Database Schema (Prisma)

```prisma
datasource db {
  provider = "sqlite"
  url      = "file::memory:"
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

model Guild {
  id          String    @id
  name        String
  ownerId     String
  icon        String?
  description String?
  features    String    @default("[]")  // JSON array of strings
  channels    Channel[]
  members     GuildMember[]
  roles       Role[]
  createdAt   DateTime  @default(now())
}

model Channel {
  id              String    @id
  guildId         String?
  guild           Guild?    @relation(fields: [guildId], references: [id], onDelete: Cascade)
  type            Int       // ChannelType enum value
  name            String?
  topic           String?
  parentId        String?   // category or parent channel for threads
  position        Int       @default(0)
  ownerId         String?   // thread owner
  archived        Boolean   @default(false)
  locked          Boolean   @default(false)
  autoArchiveDuration Int   @default(1440)
  archiveTimestamp DateTime?
  lastMessageId   String?
  messageCount    Int       @default(0)
  memberCount     Int       @default(0)
  totalMessageSent Int      @default(0)
  rateLimitPerUser Int      @default(0)
  messages        Message[]
  threadMembers   ThreadMember[]
  createdAt       DateTime  @default(now())
}

model Message {
  id              String    @id
  channelId       String
  channel         Channel   @relation(fields: [channelId], references: [id], onDelete: Cascade)
  authorId        String
  content         String    @default("")
  timestamp       DateTime  @default(now())
  editedTimestamp  DateTime?
  tts             Boolean   @default(false)
  mentionEveryone Boolean   @default(false)
  pinned          Boolean   @default(false)
  type            Int       @default(0)  // MessageType enum
  flags           Int       @default(0)
  embeds          String    @default("[]")  // JSON
  components      String    @default("[]")  // JSON
  attachments     String    @default("[]")  // JSON
  mentions        String    @default("[]")  // JSON array of user IDs
  mentionRoles    String    @default("[]")  // JSON array of role IDs
  nonce           String?
  webhookId       String?
  applicationId   String?
  messageReference String?  // JSON of { message_id, channel_id, guild_id }
  reactions       Reaction[]
  createdAt       DateTime  @default(now())
}

model User {
  id            String    @id
  username      String
  discriminator String    @default("0")
  avatar        String?
  bot           Boolean   @default(false)
  system        Boolean   @default(false)
  flags         Int       @default(0)
  globalName    String?
  members       GuildMember[]
}

model GuildMember {
  guildId    String
  guild      Guild     @relation(fields: [guildId], references: [id], onDelete: Cascade)
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  nick       String?
  roles      String    @default("[]")  // JSON array of role IDs
  joinedAt   DateTime  @default(now())
  deaf       Boolean   @default(false)
  mute       Boolean   @default(false)
  permissions String?  // computed permissions string

  @@id([guildId, userId])
}

model Role {
  id          String  @id
  guildId     String
  guild       Guild   @relation(fields: [guildId], references: [id], onDelete: Cascade)
  name        String
  color       Int     @default(0)
  hoist       Boolean @default(false)
  position    Int     @default(0)
  permissions String  @default("0")
  managed     Boolean @default(false)
  mentionable Boolean @default(false)
  flags       Int     @default(0)
}

model Reaction {
  id        Int     @id @default(autoincrement())
  messageId String
  message   Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  userId    String
  emoji     String  // encoded emoji (e.g., "unicode_emoji" or "name:id")

  @@unique([messageId, userId, emoji])
}

model ThreadMember {
  channelId String
  channel   Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  userId    String
  joinedAt  DateTime @default(now())

  @@id([channelId, userId])
}

model ApplicationCommand {
  id              String  @id
  applicationId   String
  guildId         String? // null = global command
  name            String
  description     String  @default("")
  type            Int     @default(1)  // 1=CHAT_INPUT, 2=USER, 3=MESSAGE
  options         String  @default("[]")  // JSON
  defaultMemberPermissions String?
  dmPermission    Boolean @default(true)
  nsfw            Boolean @default(false)
  version         String

  @@unique([applicationId, guildId, name])
}

model InteractionResponse {
  interactionId    String  @id
  interactionToken String  @unique
  applicationId    String
  channelId        String
  type             Int     // callback type (4, 5, 6, 7, 8, 9)
  messageId        String? // the message created by the response
  data             String? // JSON of the response data
  acknowledged     Boolean @default(false)
  createdAt        DateTime @default(now())
}
```

---

## Snowflake ID Generation

Discord IDs are snowflakes: 64-bit integers encoding a timestamp.

```
 111111111111111111111111111111111111111111 11111 11111 111111111111
 64                                      22    17    12          0
 |--- Timestamp (ms since epoch) ------| |wkr| |pid| |increment|
```

Discord epoch: **1420070400000** (2015-01-01T00:00:00.000Z)

```ts
const DISCORD_EPOCH = 1420070400000n
let increment = 0n

function generateSnowflake(): string {
  const timestamp = BigInt(Date.now()) - DISCORD_EPOCH
  const id = (timestamp << 22n) | (0n << 17n) | (0n << 12n) | increment
  increment = (increment + 1n) & 0xfffn // 12-bit wrap
  return id.toString()
}
```

---

## Test Utilities API

### DigitalDiscord Class

```ts
interface DigitalDiscordOptions {
  guild?: { id?: string; name?: string; ownerId?: string }
  channels?: Array<{
    id?: string
    name: string
    type: ChannelType
    topic?: string
    parentId?: string
  }>
  users?: Array<{
    id?: string
    username: string
    bot?: boolean
  }>
  botUser?: { id?: string; username?: string }
  botToken?: string
  dbUrl?: string // default: "file::memory:?cache=shared"
}

class DigitalDiscord {
  readonly port: number
  readonly restUrl: string // http://localhost:PORT/api
  readonly gatewayUrl: string // ws://localhost:PORT/gateway

  constructor(options?: DigitalDiscordOptions)

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>

  // Simulate user actions (these write to DB + dispatch Gateway events)
  simulateUserMessage(options: {
    channelId: string
    userId: string
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
  }): Promise<APIMessage>

  simulateInteraction(options: {
    type: InteractionType
    channelId: string
    userId: string
    data: Record<string, unknown>
  }): Promise<{ id: string; token: string }>

  simulateReaction(options: {
    messageId: string
    channelId: string
    userId: string
    emoji: string
  }): Promise<void>

  // Read internal state for assertions
  getMessages(channelId: string): Promise<APIMessage[]>
  getMessage(messageId: string): Promise<APIMessage | null>
  getChannel(channelId: string): Promise<APIChannel | null>
  getThreads(parentChannelId: string): Promise<APIChannel[]>
  getReactions(
    messageId: string,
  ): Promise<Array<{ userId: string; emoji: string }>>
  getInteractionResponse(
    interactionId: string,
  ): Promise<InteractionResponse | null>
  getRegisteredCommands(): Promise<ApplicationCommand[]>

  // Wait for the bot to respond (polls for new messages in channel)
  waitForBotMessage(options: {
    channelId: string
    timeout?: number // ms, default 10000
  }): Promise<APIMessage>

  waitForBotReaction(options: {
    messageId: string
    timeout?: number
  }): Promise<{ emoji: string }>

  // Direct Prisma access for custom assertions
  readonly prisma: PrismaClient
}
```

### Example Test

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Client, GatewayIntentBits } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'

describe('Kimaki message handling', () => {
  let discord: DigitalDiscord
  let client: Client

  beforeAll(async () => {
    discord = new DigitalDiscord({
      guild: { name: 'Test Server' },
      channels: [
        {
          name: 'general',
          type: ChannelType.GuildText,
          topic: 'kimaki:/tmp/test-project app:BOT_ID',
        },
      ],
      users: [{ username: 'TestUser' }],
    })
    await discord.start()

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { api: discord.restUrl, version: '10' },
    })

    // Register Kimaki message handlers on this client
    // (reuse startDiscordBot or similar)
    await client.login(discord.botToken)
    // Wait for READY + GUILD_CREATE
    await new Promise((resolve) => client.once('ready', resolve))
  })

  afterAll(async () => {
    client.destroy()
    await discord.stop()
  })

  test('bot responds to user message', async () => {
    const generalChannel = (await discord.getThreads('...'))[0]
    const msg = await discord.simulateUserMessage({
      channelId: generalChannel.id,
      userId: discord.users[0].id,
      content: 'Hello bot!',
    })

    const reply = await discord.waitForBotMessage({
      channelId: generalChannel.id,
      timeout: 15000,
    })

    expect(reply.author.bot).toBe(true)
    expect(reply.content).toBeTruthy()
  })
})
```

---

## Package Structure

The original plan proposed a `src/routes/` folder with one file per route
group and a `src/state.ts` event bridge. The actual implementation inlines
all Phase 1 routes directly in `server.ts` since each is small (~20 lines).
As phases add more routes, they may be split into a `routes/` folder --
but only when a single file becomes unwieldy.

```
discord-digital-twin/
  package.json
  tsconfig.json
  schema.prisma
  src/
    index.ts              # Main export: DigitalDiscord class + seed logic
    server.ts             # HTTP (Spiceflow) + WS server, all REST routes inline
    db.ts                 # Prisma client init (in-memory libsql)
    gateway.ts            # WebSocket Gateway protocol handler
    snowflake.ts          # Discord snowflake ID generator
    serializers.ts        # DB rows -> Discord API object converters
    generated/            # Prisma-generated client (gitignored)
  tests/
    sdk-compat.test.ts    # Phase 1: discord.js Client connection + handshake
    messages.test.ts      # Phase 2: message CRUD, reactions, simulateUserMessage
```

Future phases will add:

```
  tests/
    threads.test.ts       # Phase 3: Thread lifecycle
    interactions.test.ts  # Phase 4: Interaction callback flow
```

### Dependencies (actual, from package.json)

```json
{
  "dependencies": {
    "@libsql/client": "^0.15.15",
    "@prisma/adapter-libsql": "7.3.0",
    "@prisma/client": "7.3.0",
    "discord-api-types": "^0.38.16",
    "spiceflow": "^1.17.12",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "discord.js": "^14.25.1",
    "prisma": "7.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Notes:

- `discord.js` is a **devDependency** only (used in tests to validate
  SDK compatibility). The server itself only depends on `discord-api-types`.
- `spiceflow` is from npm (not `workspace:*`) since this package may be
  extracted or published independently.
- Prisma version **must be pinned** (no `^`) to match the generated client.

---

## Implementation Phases

Each phase is designed to be implementable within a single 200k-token
context window. Phases are ordered so each builds on the previous one
and is independently testable.

### Phase 1: Scaffold + Gateway + Core REST (~80k tokens estimated)

**Goal**: A discord.js Client can connect, receive READY and GUILD_CREATE,
and the bot comes "online".

**What was implemented** (all done):

1.  Package scaffold: `package.json`, `tsconfig.json`, `schema.prisma`
2.  `prisma generate` + libsql in-memory adapter verified
3.  `src/snowflake.ts` - ID generator
4.  `src/db.ts` - Prisma client initialization with in-memory libsql
5.  `src/server.ts` - Combined HTTP (Spiceflow) + WS (`ws`) server on
    one port. All Phase 1 REST routes are inline here (no `routes/`
    folder or `state.ts` -- routes are small enough to inline).
6.  `src/gateway.ts` - WebSocket handler:
    - On connect: send `op 10 Hello`
    - On `op 2 Identify`: validate token, send `op 0 READY`, then
      `op 0 GUILD_CREATE` for each guild
    - On `op 1 Heartbeat`: send `op 11 Heartbeat ACK`
    - Track sequence numbers
7.  REST routes (all in `server.ts`):
    - `GET /gateway/bot` - returns local WS URL
    - `GET /users/@me` - bot user from DB
    - `GET /users/:user_id` - any user from DB (returns 404 if missing)
    - `GET /applications/@me` - fake application object
    - `PUT /applications/:id/commands` - bulk overwrite commands
8.  `src/serializers.ts` - DB row to Discord API object converters for
    User, Guild, Channel, Message, Member, Role, ThreadMember
9.  `src/index.ts` - `DigitalDiscord` class with `start()`, `stop()`,
    seed data setup, and `applySchema()` for in-memory DB init

**Gotcha: `applySchema()` pattern** -- libsql `:memory:` doesn't support
`prisma db push`. Instead, `DigitalDiscord.applySchema()` runs individual
`CREATE TABLE` SQL statements via `prisma.$executeRawUnsafe()`. If the
Prisma schema changes, these statements must be updated to match. Run
`pnpm generate` to regenerate the Prisma client after schema changes.

**How to validate**: Write `tests/gateway.test.ts` and
`tests/sdk-compat.test.ts` that:

- Create a `DigitalDiscord` instance with a guild and channel
- Create a discord.js `Client` pointed at localhost
- Call `client.login(token)`
- Assert `client.isReady()` is true
- Assert `client.guilds.cache.size === 1`
- Assert `client.user.username === 'TestBot'`

**Key references for the implementing agent**:

- Read `discord-api-types/v10` imports for `GatewayOpcodes`,
  `GatewayIdentifyData`, `GatewayReadyDispatchData`,
  `GatewayGuildCreateDispatchData`, `GatewayHelloData`
- Read `opensrc/repos/github.com/discord/discord-api-spec/specs/openapi.json`
  for the `/gateway/bot` and `/users/@me` response schemas
- Read `opensrc/repos/github.com/remorses/spiceflow/` for Spiceflow API
  patterns, especially `handleForNode` from `spiceflow/_node-server`
- Fetch https://discord.com/developers/docs/events/gateway for the full
  Gateway connection flow documentation
- Read `cli/src/discord-bot.ts:165-180` for the Client constructor
  options Kimaki uses

### Phase 2: Messages + Reactions (~60k tokens estimated)

**Goal**: The bot can receive messages and send replies. Messages are
stored in the DB and dispatched as Gateway events.

**What was implemented** (all done):

1.  8 REST routes added inline in `server.ts` (same pattern as Phase 1,
    no separate route files):
    - `POST /channels/:channel_id/messages` - Create message as bot user,
      store in DB, update channel's `lastMessageId`/`messageCount`,
      dispatch `MESSAGE_CREATE` via gateway
    - `GET /channels/:channel_id/messages/:message_id` - Fetch single message
    - `PATCH /channels/:channel_id/messages/:message_id` - Edit message,
      set `editedTimestamp`, dispatch `MESSAGE_UPDATE`
    - `DELETE /channels/:channel_id/messages/:message_id` - Delete, dispatch
      `MESSAGE_DELETE`
    - `GET /channels/:channel_id/messages` - List with `before`/`after`/`limit`
      query params. Snowflake IDs compared as BigInt. Sort desc by default,
      asc when `after` is specified.
    - `POST /channels/:channel_id/typing` - Return 204 (no gateway dispatch)
    - `PUT /channels/:channel_id/messages/:id/reactions/:emoji/@me` - Add
      reaction via `upsert`, dispatch `MESSAGE_REACTION_ADD`
    - `DELETE /channels/:channel_id/messages/:id/reactions/:emoji/@me` -
      Remove reaction, dispatch `MESSAGE_REACTION_REMOVE`
2.  Route handlers close over a `let gateway!: DiscordGateway` variable
    declared before the Spiceflow chain and assigned after `httpServer`
    creation. Safe because routes only execute after `listen()`.
3.  `simulateUserMessage()` added to `DigitalDiscord` -- inserts message
    in DB, updates channel counters, broadcasts `MESSAGE_CREATE` via
    gateway. Accepts optional `embeds` and `attachments`.
4.  `waitForBotMessage()` added to `DigitalDiscord` -- polls DB for new
    messages from the bot user with configurable timeout (default 10s).
5.  `getMessages()` and `getChannel()` were already done in Phase 1.

**Gotcha: `file::memory:?cache=shared`** -- Prisma's `upsert` (used for
reactions) uses transactions internally. libsql's `transaction()` sets
`this.#db = null` and lazily creates a `new Database()` on next use.
With bare `file::memory:`, each `new Database()` gets a **separate empty
in-memory database**, silently breaking `upsert` while `create`/`findMany`
keep working. Fixed by using `file::memory:?cache=shared` which makes all
connections share the same in-memory DB.

**Not implemented** (not needed for current test coverage):

- `multipart/form-data` for file uploads (discord.js sends JSON for
  text-only messages)
- `around` query param for message list (only `before`/`after`)
- `TYPING_START` gateway dispatch (just returns 204)

### Phase 3: Threads + Channels (~50k tokens estimated)

**Goal**: Thread creation, archiving, and member management works.

**What to implement**:

1. `src/routes/channels.ts`:
   - `GET /channels/:channel_id` - Fetch channel/thread from DB
   - `PATCH /channels/:channel_id` - Modify channel (name, topic, archived,
     locked), dispatch `CHANNEL_UPDATE` or `THREAD_UPDATE`
   - `DELETE /channels/:channel_id` - Delete, dispatch `CHANNEL_DELETE` or
     `THREAD_DELETE`
2. `src/routes/threads.ts`:
   - `POST /channels/:channel_id/threads` - Create thread without message,
     dispatch `THREAD_CREATE` with `newly_created: true`
   - `POST /channels/:channel_id/messages/:message_id/threads` - Create
     thread from message, link message to thread, dispatch `THREAD_CREATE`
   - `PUT /channels/:channel_id/thread-members/:user_id` - Add member,
     dispatch `THREAD_MEMBERS_UPDATE`
   - `GET /channels/:channel_id/thread-members` - List thread members
3. ~~Update serializers for Channel -> APIChannel~~ Already done in Phase 1
   (`channelToAPI` handles threads via `isThread` check).
4. ~~Add `getChannel()`, `getThreads()` to `DigitalDiscord`~~ Already done
   in Phase 1.
5. Update GUILD_CREATE to include channels list (already done in Phase 1)

**How to validate**: Write `tests/threads.test.ts`:

- Send a message, create a thread from it via `message.startThread()`
- Verify `THREAD_CREATE` event fires on the Client
- Send a message in the thread
- Archive the thread via `thread.setArchived(true)`
- Verify the thread's `archived` flag in DB
- Test thread member add

**Key references**:

- `discord-api-types/v10`: `RESTPostAPIChannelThreadsJSONBody`,
  `APIThreadChannel`, thread metadata types
- OpenAPI spec: `/channels/{channel_id}/threads` paths
- Fetch https://discord.com/developers/docs/resources/channel#start-thread-without-message
- Read `cli/src/commands/worktree.ts` and `cli/src/discord-bot.ts`
  for how Kimaki creates threads

### Phase 4: Interactions (~60k tokens estimated)

**Goal**: Slash commands, buttons, select menus, and modals work.

**What to implement**:

1. Extend `simulateInteraction()` in `DigitalDiscord` to dispatch
   `INTERACTION_CREATE` via Gateway with all required fields
2. `src/routes/interactions.ts`:
   - `POST /interactions/:id/:token/callback` - Handle interaction response
     callbacks (types 4, 5, 6, 7, 8, 9). For type 4 (message with source),
     create a message in the channel. For type 5 (deferred), mark as
     acknowledged. For type 9 (modal), store modal data.
   - `GET /webhooks/:app_id/:token/messages/@original` - Fetch the message
     created by the interaction response
   - `PATCH /webhooks/:app_id/:token/messages/@original` - Edit the
     interaction response message, dispatch `MESSAGE_UPDATE`
   - `DELETE /webhooks/:app_id/:token/messages/@original` - Delete it
   - `POST /webhooks/:app_id/:token` - Send followup message
   - `PATCH /webhooks/:app_id/:token/messages/:message_id` - Edit followup
3. Add `getInteractionResponse()` to `DigitalDiscord`
4. Support for all interaction types: APPLICATION_COMMAND (2),
   MESSAGE_COMPONENT (3), AUTOCOMPLETE (4), MODAL_SUBMIT (5)

**How to validate**: Write `tests/interactions.test.ts`:

- Register slash commands via the Client
- Simulate a slash command interaction
- Verify the bot calls the interaction callback endpoint
- Verify `interaction.reply()` creates a message
- Verify `interaction.editReply()` updates the message
- Test button interaction flow
- Test deferred response + followup pattern

**Key references**:

- `discord-api-types/v10`: `APIInteraction`, `InteractionType`,
  `InteractionResponseType`, `APIInteractionResponse`
- OpenAPI spec: `/interactions/{interaction_id}/{interaction_token}/callback`
- Fetch https://discord.com/developers/docs/interactions/receiving-and-responding
- Read `cli/src/interaction-handler.ts` and `cli/src/commands/`
  for how Kimaki handles interactions
- Read `cli/src/commands/permissions.ts` for button interaction flow
- Read `cli/src/commands/model.ts` for select menu interaction flow

### Phase 5: Guild Management + Polish (~40k tokens estimated)

**Goal**: Channel creation, role management, member search, and
remaining guild operations.

**What to implement**:

1. `src/routes/guilds.ts`:
   - `GET /guilds/:guild_id` - Fetch guild
   - `GET /guilds/:guild_id/channels` - List guild channels
   - `POST /guilds/:guild_id/channels` - Create channel (text, voice,
     category, forum), dispatch `CHANNEL_CREATE`
   - `GET /guilds/:guild_id/roles` - List roles
   - `POST /guilds/:guild_id/roles` - Create role, dispatch
     `GUILD_ROLE_CREATE`
   - `PATCH /guilds/:guild_id/roles/:role_id` - Modify role
   - `GET /guilds/:guild_id/members/search` - Search members by username
   - `GET /guilds/:guild_id/members` - List members
   - `GET /guilds/:guild_id/members/:user_id` - Get specific member
   - `GET /guilds/:guild_id/threads/active` - List active threads
2. Add `simulateReaction()` to `DigitalDiscord` if not done in Phase 2
3. Polish error responses to match Discord format
4. Add missing rate limit headers to all responses
5. Test full Kimaki bot startup flow end-to-end

**How to validate**: Write integration tests that:

- Start `DigitalDiscord` with channel topics matching Kimaki's format
- Start the full Kimaki bot (reuse `startDiscordBot()` from
  `cli/src/discord-bot.ts`)
- Verify the bot logs in, registers commands, and scans channels
- Simulate a user message and verify Kimaki creates a thread + starts
  processing
- Verify the complete flow from message -> thread -> bot response

**Key references**:

- OpenAPI spec: `/guilds/{guild_id}/channels`, `/guilds/{guild_id}/roles`
- Read `cli/src/channel-management.ts` for how Kimaki creates channels
- Read `cli/src/cli.ts` for command registration and startup flow
- Read `cli/src/discord-utils.ts:604` (`getKimakiMetadata`) for how
  channel topics are parsed

---

## Key Design Decisions

| Decision            | Choice                                                     | Rationale                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP framework      | Spiceflow                                                  | Project convention, type-safe routes                                                                                                                                                                                                                                               |
| WebSocket server    | `ws` npm package                                           | Same lib discord.js uses internally, proven                                                                                                                                                                                                                                        |
| Database            | Prisma + libsql, `file::memory:?cache=shared` default      | Matches project convention (libsql adapter), clean per-test state with `:memory:`. `cache=shared` is required because libsql's `transaction()` creates separate connections. Optional `dbUrl` constructor param for persistent file-based storage (debugging, integration tests).  |
| Cascade deletes     | `onDelete: Cascade` on all relations                       | Deleting a guild cascades to channels, messages, members, roles, reactions, thread members. SQLite supports this via Prisma's foreign key emulation. Makes test cleanup trivial.                                                                                                   |
| Shared port         | Single `http.createServer`                                 | One URL for both REST and WS, simpler config                                                                                                                                                                                                                                       |
| ID generation       | Custom snowflake generator                                 | Discord IDs are snowflakes, SDK may parse them                                                                                                                                                                                                                                     |
| Schema source       | Official `discord/discord-api-spec` OpenAPI                | 498 schemas, machine-readable, MIT licensed                                                                                                                                                                                                                                        |
| Types               | `discord-api-types` npm package                            | 1:1 mapping to Discord API, maintained by discord.js team                                                                                                                                                                                                                          |
| Input/output typing | Return type annotations + targeted `as` only, no Zod       | `discord-api-types` only publishes TS types, not Zod schemas. Return type annotations do the checking. Blanket `as Type` and `as unknown as Type` casts are banned -- they bypass the compiler. Targeted `as` only for: JSON.parse results, APIChannel union, enum bitfield zeros. |
| Scope               | Only endpoints Kimaki uses (~30 REST + ~10 Gateway events) | Practical, not trying to implement all 139 endpoints                                                                                                                                                                                                                               |
| Voice               | Skipped entirely                                           | Separate protocol (UDP + Opus), extremely complex                                                                                                                                                                                                                                  |
| Forum channels      | Included in schema but low priority                        | Used for memory sync, not core bot flow                                                                                                                                                                                                                                            |

## Risks and Mitigations

1. **discord.js caching**: The SDK caches aggressively. If our Gateway
   events are missing required fields, cache lookups will fail with partial
   objects. **Mitigation**: Use `discord-api-types` to ensure all required
   fields are present. Write SDK compatibility tests early.

2. **Rate limit self-throttling**: discord.js has built-in rate limit
   handling. If we don't return proper rate limit headers, the SDK may
   queue requests unnecessarily. **Mitigation**: Return generous fake
   rate limit headers on every response.

3. **Multipart file uploads**: Kimaki uses `multipart/form-data` for
   file attachments. Spiceflow handles this via `request.formData()`.
   **Mitigation**: Parse form data, store file metadata (not content).

4. **Components V2**: Kimaki uses Discord Components V2
   (`ContainerBuilder`, `TextDisplayBuilder`). These are JSON in message
   payloads. **Mitigation**: Store `components` as JSON string, return
   as-is.

5. **Gateway event ordering**: discord.js expects events in order (READY
   before GUILD_CREATE, etc.). **Mitigation**: Strict sequencing in the
   Gateway handler, increment `s` for every dispatch.

---

## Plan Maintenance

**This plan is a living document.** Implementing agents must update it
when they encounter issues, discover bugs, or learn something that
contradicts what's written here. This keeps the plan accurate for the
next agent in the chain.

### When to update this plan

- **Schema bugs**: If the Prisma schema has a missing field, wrong type,
  or missing relation that discord.js expects, fix the schema in this
  plan document after fixing it in code. Add a note in the changelog
  section below explaining what was wrong and why.
- **Missing endpoints**: If Kimaki uses a REST endpoint or Gateway event
  not listed here, add it to the appropriate phase table.
- **Wrong payload shapes**: If a Gateway event payload is missing a
  required field that discord.js expects, update the example payload in
  this plan.
- **Spiceflow or ws quirks**: If you discover a gotcha with the framework
  (e.g., Spiceflow doesn't parse certain content types, ws needs specific
  options), add it to the Risks section.
- **Phase scope changes**: If a phase turns out to be too large or too
  small for a 200k context window, split or merge phases and update the
  estimates.

### How to update

1. Edit `plans/digital-discord.md` directly (plan filename kept for continuity)
2. Add an entry to the changelog below with the date and what changed
3. Do NOT remove existing content unless it's factually wrong -- prefer
   adding corrections and notes

### Changelog

| Date       | Agent/Phase         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-24 | Initial plan        | Plan created with 5 phases, Prisma schema, Gateway protocol spec, REST endpoints                                                                                                                                                                                                                                                                                                                                                      |
| 2026-02-24 | Phase 1 done        | Scaffold, Gateway, core REST routes, SDK compat test (6/6 passing). Package renamed from `digital-discord` to `discord-digital-twin`, folder from `digital-discord/` to `discord-digital-twin/`. Class name `DigitalDiscord` kept.                                                                                                                                                                                                    |
| 2026-02-24 | Type safety cleanup | Removed all `as unknown as` double casts and most blanket `as Type` casts. Replaced with: return type annotations, enum imports (`ApplicationFlags`, `Locale`, `GuildSystemChannelFlags`), `noFlags<T>()` helper for bitfield zeros, typed empty arrays. Remaining `as` only for: JSON.parse, APIChannel union, APIMessage conditional spreads. Updated plan conventions to ban blanket casts.                                        |
| 2026-02-24 | Plan accuracy pass  | Fixed plan to match actual implementation: removed `src/routes/` folder and `src/state.ts` (routes inlined in server.ts), updated deps to actual versions (Prisma 7.3.0, spiceflow from npm), added `GET /users/:user_id` to Phase 1 table, noted `messageToAPI` already done in Phase 1, documented `applySchema()` gotcha for libsql :memory:, updated package structure tree.                                                      |
| 2026-02-24 | Phase 2 done        | 8 message/reaction routes inline in server.ts, `simulateUserMessage()` + `waitForBotMessage()` test utilities, 5/5 new tests passing (11 total). Fixed libsql `file::memory:` transaction bug with `?cache=shared`. Added `dbUrl` option to constructor for persistent/debuggable storage. Updated Phase 2 to "What was implemented", corrected Phase 3 to note `getChannel()`/`getThreads()`/`channelToAPI` already done in Phase 1. |
