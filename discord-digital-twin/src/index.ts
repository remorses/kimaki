// DigitalDiscord - Local Discord API test server.
// Creates a fake Discord server (REST + Gateway WebSocket) that discord.js
// can connect to. Used for automated testing of the Kimaki bot without
// hitting real Discord.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import {
  ChannelType,
  GatewayDispatchEvents,
  InteractionType,
  ComponentType,
} from 'discord-api-types/v10'
import type {
  APIMessage,
  APIChannel,
  APIEmbed,
  APIAttachment,
  APIInteraction,
  APIMessageReference,
} from 'discord-api-types/v10'
import { createPrismaClient, type PrismaClient } from './db.js'
import { generateSnowflake } from './snowflake.js'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
  type TypingEventRecord,
} from './server.js'
import type { GatewayState } from './gateway.js'
import {
  userToAPI,
  guildToAPI,
  memberToAPI,
  channelToAPI,
  messageToAPI,
  isoTimestamp,
} from './serializers.js'

const MAX_VITEST_WAIT_TIMEOUT_MS = 10_000

function normalizeWaitTimeout(timeout: number): number {
  if (process.env['KIMAKI_VITEST'] === '1') {
    return Math.min(timeout, MAX_VITEST_WAIT_TIMEOUT_MS)
  }
  return timeout
}

export type DigitalDiscordChannelOption = {
  id?: string
  name: string
  type: ChannelType
  topic?: string
  parentId?: string
}

export type DigitalDiscordGuildOption = {
  id?: string
  name?: string
  ownerId?: string
  channels?: DigitalDiscordChannelOption[]
}

export interface DigitalDiscordOptions {
  guild?: DigitalDiscordGuildOption
  // Multi-guild support: seed multiple guilds, each with its own channels.
  // If both guild and guilds are provided, guilds takes precedence.
  guilds?: DigitalDiscordGuildOption[]
  channels?: DigitalDiscordChannelOption[]
  users?: Array<{
    id?: string
    username: string
    bot?: boolean
  }>
  botUser?: {
    id?: string
    username?: string
  }
  botToken?: string
  // Database URL. Defaults to in-memory (file::memory:?cache=shared).
  // Pass a file: URL (e.g. "file:./test.db") for persistent storage.
  dbUrl?: string
  // Override the gateway URL returned by GET /gateway/bot.
  // Useful when a proxy sits between the client and this server.
  gatewayUrlOverride?: string
}

export type DigitalDiscordCommandOption = {
  name: string
  type: number
  value?: string | number | boolean
  options?: DigitalDiscordCommandOption[]
}

export type DigitalDiscordSelectOption = {
  values: string[]
}

export type DigitalDiscordModalField = {
  customId: string
  value: string
}

export type DigitalDiscordMessagePredicate = (message: APIMessage) => boolean
export type DigitalDiscordThreadPredicate = (thread: APIChannel) => boolean
export type DigitalDiscordTypingEvent = TypingEventRecord

type DigitalDiscordInteractionEvent = {
  timestamp: number
  channelId: string
  interactionType: InteractionType
  componentType?: ComponentType
  values?: string[]
}

function compareSnowflakeDesc(a: string, b: string): number {
  try {
    const aSnowflake = BigInt(a)
    const bSnowflake = BigInt(b)
    if (aSnowflake > bSnowflake) {
      return -1
    }
    if (aSnowflake < bSnowflake) {
      return 1
    }
    return 0
  } catch {
    return b.localeCompare(a)
  }
}

export class DigitalDiscord {
  prisma: PrismaClient
  botToken: string
  botUserId: string
  // First guild ID for backward compatibility
  guildId: string
  // All guild IDs when using multi-guild mode
  guildIds: string[]

  private server: ServerComponents | null = null
  private options: DigitalDiscordOptions
  private seeded = false
  private interactionEvents: DigitalDiscordInteractionEvent[] = []

  constructor(options: DigitalDiscordOptions = {}) {
    this.options = options
    this.prisma = createPrismaClient(options.dbUrl)
    this.botToken = options.botToken ?? 'fake-bot-token'
    this.botUserId = options.botUser?.id ?? generateSnowflake()

    if (options.guilds && options.guilds.length > 0) {
      this.guildIds = options.guilds.map((g) => g.id ?? generateSnowflake())
      this.guildId = this.guildIds[0] ?? generateSnowflake()
    } else {
      this.guildId = options.guild?.id ?? generateSnowflake()
      this.guildIds = [this.guildId]
    }
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  get restUrl(): string {
    return `http://127.0.0.1:${this.port}/api`
  }

  get gatewayUrl(): string {
    return `ws://127.0.0.1:${this.port}/gateway`
  }

  async start(): Promise<void> {
    await this.prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
    await this.prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')

    // Apply migrations by pushing schema to in-memory DB
    // For libsql :memory:, we use Prisma's $executeRawUnsafe with the schema SQL
    await this.applySchema()

    if (!this.seeded) {
      await this.seed()
      this.seeded = true
    }

    this.server = createServer({
      prisma: this.prisma,
      botUserId: this.botUserId,
      botToken: this.botToken,
      loadGatewayState: () => this.loadGatewayState(),
      gatewayUrlOverride: this.options.gatewayUrlOverride,
    })

    const port = await startServer(this.server)
    this.server.port = port
  }

  async stop(): Promise<void> {
    if (this.server) {
      await stopServer(this.server)
      this.server = null
    }
  }

  // --- Scoped accessors ---

  channel(channelId: string): ChannelScope {
    return new ChannelScope({ discord: this, channelId })
  }

  thread(threadId: string): ChannelScope {
    return new ChannelScope({ discord: this, channelId: threadId })
  }

  // --- State queries ---

  async getFirstNonBotUserId(): Promise<string | null> {
    const firstUser = await this.prisma.user.findFirst({
      where: { bot: false },
      orderBy: { id: 'asc' },
    })
    if (!firstUser) {
      return null
    }
    return firstUser.id
  }

  getTypingEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): DigitalDiscordTypingEvent[] {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const allEvents = this.server.typingEvents
    if (!channelId) {
      return [...allEvents]
    }
    return allEvents.filter((event) => {
      return event.channelId === channelId
    })
  }

  clearTypingEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): void {
    if (!this.server) {
      throw new Error('Server not started')
    }
    if (!channelId) {
      this.server.typingEvents.splice(0, this.server.typingEvents.length)
      return
    }
    const filtered = this.server.typingEvents.filter((event) => {
      return event.channelId !== channelId
    })
    this.server.typingEvents.splice(0, this.server.typingEvents.length, ...filtered)
  }

  getInteractionEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): DigitalDiscordInteractionEvent[] {
    if (!channelId) {
      return [...this.interactionEvents]
    }
    return this.interactionEvents.filter((event) => {
      return event.channelId === channelId
    })
  }

  clearInteractionEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): void {
    if (!channelId) {
      this.interactionEvents.splice(0, this.interactionEvents.length)
      return
    }
    const filtered = this.interactionEvents.filter((event) => {
      return event.channelId !== channelId
    })
    this.interactionEvents.splice(0, this.interactionEvents.length, ...filtered)
  }

  // --- Test utilities ---

  async simulateUserMessage({
    channelId,
    userId,
    content,
    embeds,
    attachments,
    messageReference,
  }: {
    channelId: string
    userId: string
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
    messageReference?: APIMessageReference
  }): Promise<APIMessage> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const messageId = generateSnowflake()
    await this.prisma.message.create({
      data: {
        id: messageId,
        channelId,
        authorId: userId,
        content,
        embeds: JSON.stringify(embeds ?? []),
        attachments: JSON.stringify(attachments ?? []),
        messageReference: messageReference
          ? JSON.stringify(messageReference)
          : null,
      },
    })
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        lastMessageId: messageId,
        messageCount: { increment: 1 },
        totalMessageSent: { increment: 1 },
      },
    })
    const dbMessage = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
    })
    const author = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    const guildId = channel?.guildId ?? undefined
    const member = guildId
      ? await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          include: { user: true },
        })
      : null
    const apiMessage = messageToAPI(
      dbMessage,
      author,
      guildId,
      member ?? undefined,
    )
    this.server.gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
    return apiMessage
  }

  async simulateInteraction({
    type,
    channelId,
    userId,
    data,
    guildId,
    messageId,
  }: {
    type: InteractionType
    channelId: string
    userId: string
    data?: Record<string, unknown>
    guildId?: string
    messageId?: string
  }): Promise<{ id: string; token: string }> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const interactionId = generateSnowflake()
    const interactionToken = `test-interaction-token-${interactionId}`
    const resolvedGuildId = guildId ?? this.guildId

    // Pre-create the InteractionResponse row so the callback endpoint can find it
    await this.prisma.interactionResponse.create({
      data: {
        interactionId,
        interactionToken,
        applicationId: this.botUserId,
        channelId,
        type: 0, // placeholder, updated when callback is received
        messageId: messageId ?? null,
        acknowledged: false,
      },
    })

    // Build the INTERACTION_CREATE gateway payload
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const member = await this.prisma.guildMember.findUnique({
      where: { guildId_userId: { guildId: resolvedGuildId, userId } },
      include: { user: true },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })

    let messageData: APIMessage | undefined = undefined
    if (messageId) {
      const msg = await this.prisma.message.findUniqueOrThrow({
        where: { id: messageId },
      })
      const msgAuthor = await this.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      const msgMember = resolvedGuildId
        ? await this.prisma.guildMember.findUnique({
            where: {
              guildId_userId: {
                guildId: resolvedGuildId,
                userId: msg.authorId,
              },
            },
            include: { user: true },
          })
        : null
      messageData = messageToAPI(
        msg,
        msgAuthor,
        resolvedGuildId,
        msgMember ?? undefined,
      )
    }

    const componentType = (() => {
      if (type !== InteractionType.MessageComponent || !data) {
        return undefined
      }
      const raw = data['component_type']
      if (typeof raw !== 'number') {
        return undefined
      }
      return raw as ComponentType
    })()
    const values = (() => {
      if (!data) {
        return undefined
      }
      const raw = data['values']
      if (!Array.isArray(raw)) {
        return undefined
      }
      return raw.filter((item): item is string => {
        return typeof item === 'string'
      })
    })()
    this.interactionEvents.push({
      timestamp: Date.now(),
      channelId,
      interactionType: type,
      componentType,
      values,
    })
    if (this.interactionEvents.length > 5_000) {
      this.interactionEvents.splice(0, this.interactionEvents.length - 5_000)
    }

    // APIInteraction is a discriminated union keyed by `type` -- the concrete
    // variant is only known at runtime, so `as APIInteraction` is justified
    const interactionPayload = {
      id: interactionId,
      application_id: this.botUserId,
      type,
      data: data ?? {},
      guild_id: resolvedGuildId,
      channel_id: channelId,
      channel: channel ? channelToAPI(channel) : undefined,
      message: messageData,
      member: member
        ? {
            user: userToAPI(member.user),
            nick: member.nick ?? undefined,
            roles: JSON.parse(member.roles) as string[],
            joined_at: isoTimestamp(member.joinedAt),
            deaf: member.deaf,
            mute: member.mute,
            flags: 0,
            permissions: member.permissions ?? '1099511627775',
          }
        : undefined,
      token: interactionToken,
      version: 1,
      app_permissions: '1099511627775',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: {},
      context: 0,
      attachment_size_limit: 26214400,
    } as unknown as APIInteraction

    this.server.gateway.broadcast(
      GatewayDispatchEvents.InteractionCreate,
      interactionPayload,
    )

    return { id: interactionId, token: interactionToken }
  }

  async simulateSlashCommand({
    channelId,
    userId,
    name,
    commandId,
    options,
    guildId,
  }: {
    channelId: string
    userId: string
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    // Resolve the registered command ID by name so guild.commands.fetch()
    // works when the bot looks up the command description at runtime.
    // Prefer guild-scoped command over global to avoid returning a global ID
    // that would 404 on the guild commands GET endpoint.
    const resolvedCommandId = await (async () => {
      if (commandId) {
        return commandId
      }
      const resolvedGuildId = guildId ?? this.guildId
      const guildCmd = await this.prisma.applicationCommand.findFirst({
        where: {
          applicationId: this.botUserId,
          name,
          guildId: resolvedGuildId,
        },
      })
      if (guildCmd) {
        return guildCmd.id
      }
      const globalCmd = await this.prisma.applicationCommand.findFirst({
        where: {
          applicationId: this.botUserId,
          name,
          guildId: null,
        },
      })
      return globalCmd?.id ?? generateSnowflake()
    })()

    return this.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId,
      guildId,
      data: {
        id: resolvedCommandId,
        name,
        type: 1,
        ...(options && options.length > 0 ? { options } : {}),
      },
    })
  }

  async simulateButtonClick({
    channelId,
    userId,
    messageId,
    customId,
    guildId,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: ComponentType.Button,
      },
    })
  }

  async simulateSelectMenu({
    channelId,
    userId,
    messageId,
    customId,
    values,
    guildId,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    values: string[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: ComponentType.StringSelect,
        values,
      },
    })
  }

  async simulateModalSubmit({
    channelId,
    userId,
    customId,
    fields,
    guildId,
  }: {
    channelId: string
    userId: string
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    const components = fields.map((field) => {
      return {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: field.customId,
            value: field.value,
          },
        ],
      }
    })

    return this.simulateInteraction({
      type: InteractionType.ModalSubmit,
      channelId,
      userId,
      guildId,
      data: {
        custom_id: customId,
        components,
      },
    })
  }



  // --- Internal ---

  private async applySchema(): Promise<void> {
    // Read the generated schema.sql (created by `pnpm generate:sql` from
    // schema.prisma via prisma db push + sqlite3 .schema). This avoids
    // hand-writing CREATE TABLE statements that can drift from the prisma schema.
    // src/ is always shipped in the package, so ../src/schema.sql works from
    // both src/ (dev with tsx) and dist/ (built with tsc).
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const schemaPath = path.resolve(__dirname, '../src/schema.sql')

    const sql = fs.readFileSync(schemaPath, 'utf-8')

    // Same parsing approach as cli/src/db.ts migrateSchema():
    // 1. Split on semicolons into statements
    // 2. Strip per-line SQL comments within each statement
    // 3. Filter out empty and sqlite_sequence statements
    // 4. Make CREATE INDEX idempotent with IF NOT EXISTS
    const statements = sql
      .split(';')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(
        (s) =>
          s.length > 0 &&
          !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s),
      )
      .map((s) =>
        s
          .replace(
            /^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i,
            'CREATE UNIQUE INDEX IF NOT EXISTS',
          )
          .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
      )

    for (const statement of statements) {
      await this.prisma.$executeRawUnsafe(statement)
    }
  }

  private async seed(): Promise<void> {
    const opts = this.options

    // Create bot user
    await this.prisma.user.create({
      data: {
        id: this.botUserId,
        username: opts.botUser?.username ?? 'TestBot',
        bot: true,
        globalName: opts.botUser?.username ?? 'TestBot',
      },
    })

    // Create additional users first (needed for guild membership)
    const userIds: string[] = []
    for (const userOpts of opts.users ?? []) {
      const userId = userOpts.id ?? generateSnowflake()
      userIds.push(userId)
      await this.prisma.user.create({
        data: {
          id: userId,
          username: userOpts.username,
          bot: userOpts.bot ?? false,
          globalName: userOpts.username,
        },
      })
    }

    // Build the list of guilds to seed
    const guildConfigs: Array<{ id: string; config: DigitalDiscordGuildOption }> = (() => {
      if (opts.guilds && opts.guilds.length > 0) {
        return this.guildIds.map((id, i) => ({ id, config: opts.guilds![i] ?? {} }))
      }
      return [{ id: this.guildId, config: opts.guild ?? {} }]
    })()

    for (const { id: guildId, config: guildConfig } of guildConfigs) {
      const ownerId = guildConfig.ownerId ?? generateSnowflake()
      await this.prisma.guild.create({
        data: {
          id: guildId,
          name: guildConfig.name ?? 'Test Server',
          ownerId,
        },
      })

      // Create @everyone role
      await this.prisma.role.create({
        data: {
          id: guildId,
          guildId,
          name: '@everyone',
          permissions: '1071698660929',
          position: 0,
        },
      })

      // Add bot as guild member
      await this.prisma.guildMember.create({
        data: { guildId, userId: this.botUserId },
      })

      // Add all users as members of each guild
      for (const userId of userIds) {
        await this.prisma.guildMember.create({
          data: { guildId, userId },
        })
      }

      // Create channels for this guild (from per-guild channels or top-level channels)
      const channels = guildConfig.channels ?? (guildId === this.guildId ? (opts.channels ?? []) : [])
      for (const chOpts of channels) {
        await this.prisma.channel.create({
          data: {
            id: chOpts.id ?? generateSnowflake(),
            guildId,
            type: chOpts.type,
            name: chOpts.name,
            topic: chOpts.topic,
            parentId: chOpts.parentId,
          },
        })
      }
    }
  }

  private async loadGatewayState(): Promise<GatewayState> {
    const botUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: this.botUserId },
    })

    const guilds = await this.prisma.guild.findMany({
      include: {
        roles: true,
        members: { include: { user: true } },
        channels: true,
      },
    })

    return {
      botUser: userToAPI(botUser),
      guilds: guilds.map((guild) => ({
        id: guild.id,
        apiGuild: guildToAPI(guild),
        joinedAt: isoTimestamp(guild.createdAt),
        members: guild.members.map(memberToAPI),
        channels: guild.channels.map(channelToAPI),
      })),
    }
  }
}

// Scoped accessor returned by discord.channel(id) and discord.thread(id).
// Binds a channelId so every method operates on that target without repeating it.
export class ChannelScope {
  private readonly discord: DigitalDiscord
  readonly channelId: string

  constructor({
    discord,
    channelId,
  }: {
    discord: DigitalDiscord
    channelId: string
  }) {
    this.discord = discord
    this.channelId = channelId
  }

  user(userId: string): ScopedUserActor {
    return new ScopedUserActor({
      discord: this.discord,
      channelId: this.channelId,
      userId,
    })
  }

  bot(): ScopedUserActor {
    return this.user(this.discord.botUserId)
  }

  /**
   * Returns a markdown-like textual representation of all messages in this
   * channel/thread. Useful for inline snapshots in tests so both agents and
   * humans can see what happened in Discord at a glance.
   *
   * Format:
   *   --- from: user (Username)
   *   message content
   *   --- from: assistant (BotName)
   *   reply content
   *   [typing]
   *
   * @param deterministicFooters - When true (default), replaces non-deterministic
   *   values in footer lines (duration like "2m 30s" and context percentage like
   *   "71%") with stable placeholders ("Ns" and "N%") so inline snapshots don't
   *   break across runs. Footer lines are detected by starting with "*" and
   *   containing "⋅".
   * @param showTyping - When true, interleaves [typing] markers at the
   *   chronological position of typing indicator POST calls. Defaults to false
   *   so existing snapshots are not affected.
   * @param showInteractions - When true, interleaves interaction markers like
   *   [user clicks button] and [user selects dropdown: value] at the
   *   chronological position of interaction events. Defaults to false so
   *   existing snapshots are not affected.
   */
  async text({ deterministicFooters = true, showTyping = false, showInteractions = false }: { deterministicFooters?: boolean; showTyping?: boolean; showInteractions?: boolean } = {}): Promise<string> {
    const messages = await this.getMessages()

    // Build timeline entries: messages + optional typing events
    type TimelineEntry =
      | { kind: 'message'; ts: number; msg: APIMessage }
      | { kind: 'typing'; ts: number }
      | { kind: 'interaction'; ts: number; event: DigitalDiscordInteractionEvent }

    const timeline: TimelineEntry[] = messages.map((msg) => {
      return {
        kind: 'message' as const,
        ts: new Date(msg.timestamp).getTime(),
        msg,
      }
    })

    if (showTyping) {
      const typingEvents = this.discord.getTypingEvents({ channelId: this.channelId })
      for (const evt of typingEvents) {
        timeline.push({ kind: 'typing' as const, ts: evt.timestamp })
      }
    }

    if (showInteractions) {
      const interactionEvents = this.discord.getInteractionEvents({
        channelId: this.channelId,
      })
      for (const event of interactionEvents) {
        timeline.push({
          kind: 'interaction' as const,
          ts: event.timestamp,
          event,
        })
      }
    }

    if (showTyping || showInteractions) {
      timeline.sort((a, b) => {
        return a.ts - b.ts
      })
    }

    const lines: string[] = []
    // Track last author to skip repeated --- from: headers for consecutive
    // messages from the same user, matching how Discord groups messages.
    let lastAuthorId: string | null = null
    for (const entry of timeline) {
      if (entry.kind === 'typing') {
        lines.push('[bot typing]')
        continue
      }
      if (entry.kind === 'interaction') {
        const label = (() => {
          if (
            entry.event.interactionType === InteractionType.MessageComponent &&
            entry.event.componentType === ComponentType.Button
          ) {
            return '[user clicks button]'
          }
          if (
            entry.event.interactionType === InteractionType.MessageComponent &&
            entry.event.componentType === ComponentType.StringSelect
          ) {
            const selectedValues = (entry.event.values || []).join(', ')
            if (!selectedValues) {
              return '[user selects dropdown]'
            }
            return `[user selects dropdown: ${selectedValues}]`
          }
          if (entry.event.interactionType === InteractionType.ModalSubmit) {
            return '[user submits modal]'
          }
          return '[user interaction]'
        })()
        lines.push(label)
        continue
      }
      const msg = entry.msg
      const role = msg.author.bot ? 'assistant' : 'user'
      if (msg.author.id !== lastAuthorId) {
        lines.push(`--- from: ${role} (${msg.author.username})`)
      }
      lastAuthorId = msg.author.id
      if (msg.content) {
        let content = msg.content
        // Footer lines look like: *project ⋅ main ⋅ <1s ⋅ 2% ⋅ model-name*
        // Replace duration and percentage with stable placeholders.
        if (deterministicFooters && content.startsWith('*') && content.includes('⋅')) {
          content = content
            .replace(/<1s/g, 'Ns')
            .replace(/\b\d+m\s+\d+s\b/g, 'Ns')
            .replace(/\b\d+s\b/g, 'Ns')
            .replace(/\b\d+m\b/g, 'Ns')
            .replace(/\b\d+%/g, 'N%')
        }
        lines.push(content)
      }
      const embeds = msg.embeds ?? []
      for (const embed of embeds) {
        // Escape quotes/newlines in titles so snapshots stay clean
        const safeTitle = embed.title ? JSON.stringify(embed.title).slice(1, -1) : ''
        const label = safeTitle ? `embed: "${safeTitle}"` : 'embed'
        lines.push(`[${label}]`)
      }
      const attachments = msg.attachments ?? []
      for (const attachment of attachments) {
        lines.push(`[attachment: ${attachment.filename}]`)
      }
    }
    return lines.join('\n')
  }

  async getMessages(): Promise<APIMessage[]> {
    const channel = await this.discord.prisma.channel.findUnique({
      where: { id: this.channelId },
    })
    const messages = await this.discord.prisma.message.findMany({
      where: { channelId: this.channelId },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    })
    const result: APIMessage[] = []
    // For threads created from a message, prepend the starter message
    // (it lives in the parent channel, not in the thread's own messages)
    if (channel?.starterMessageId) {
      const starterMsg = await this.discord.prisma.message.findUnique({
        where: { id: channel.starterMessageId },
      })
      if (starterMsg && !messages.some((m) => { return m.id === starterMsg.id })) {
        const starterAuthor = await this.discord.prisma.user.findUniqueOrThrow({
          where: { id: starterMsg.authorId },
        })
        result.push(messageToAPI(starterMsg, starterAuthor, channel.guildId ?? undefined))
      }
    }
    for (const msg of messages) {
      const author = await this.discord.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      result.push(
        messageToAPI(msg, author, channel?.guildId ?? undefined),
      )
    }
    return result
  }

  getTypingEvents(): DigitalDiscordTypingEvent[] {
    return this.discord.getTypingEvents({ channelId: this.channelId })
  }

  clearTypingEvents(): void {
    this.discord.clearTypingEvents({ channelId: this.channelId })
  }

  async waitForTypingEvent({
    timeout = 10000,
    afterTimestamp = 0,
  }: {
    timeout?: number
    afterTimestamp?: number
  } = {}): Promise<DigitalDiscordTypingEvent> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const event = this.getTypingEvents().find((entry) => {
        return entry.timestamp > afterTimestamp
      })
      if (event) {
        return event
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for typing event in channel ${this.channelId}`,
    )
  }

  async waitForTypingToStop({
    timeout = 12000,
    idleMs = 8500,
    afterTimestamp,
  }: {
    timeout?: number
    idleMs?: number
    afterTimestamp?: number
  } = {}): Promise<void> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    const baselineTimestamp = afterTimestamp ?? start
    while (Date.now() - start < effectiveTimeout) {
      const latestTypingTimestamp = this.getTypingEvents()
        .filter((entry) => {
          return entry.timestamp >= baselineTimestamp
        })
        .map((entry) => {
          return entry.timestamp
        })
        .sort((a, b) => {
          return b - a
        })[0] ?? baselineTimestamp

      if (Date.now() - latestTypingTimestamp >= idleMs) {
        return
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    throw new Error(
      `Timed out waiting for typing to stop in channel ${this.channelId}`,
    )
  }

  async getChannel(): Promise<APIChannel | null> {
    const channel = await this.discord.prisma.channel.findUnique({
      where: { id: this.channelId },
    })
    if (!channel) {
      return null
    }
    return channelToAPI(channel)
  }

  async getThreads(): Promise<APIChannel[]> {
    const threads = await this.discord.prisma.channel.findMany({
      where: {
        parentId: this.channelId,
        type: {
          in: [
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ],
        },
      },
    })
    return threads.map(channelToAPI)
  }

  async waitForMessage({
    timeout = 10000,
    predicate,
  }: {
    timeout?: number
    predicate?: DigitalDiscordMessagePredicate
  } = {}): Promise<APIMessage> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const messages = await this.getMessages()
      const matchedMessage = [...messages]
        .reverse()
        .find((message) => {
          if (!predicate) {
            return true
          }
          return predicate(message)
        })
      if (matchedMessage) {
        return matchedMessage
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for message in channel ${this.channelId}`,
    )
  }

  async waitForBotReply({ timeout = 10000 }: { timeout?: number } = {}): Promise<APIMessage> {
    return this.waitForMessage({
      timeout,
      predicate: (message) => {
        return message.author.id === this.discord.botUserId
      },
    })
  }

  async waitForThread({
    timeout = 10000,
    predicate,
  }: {
    timeout?: number
    predicate?: DigitalDiscordThreadPredicate
  } = {}): Promise<APIChannel> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const threads = await this.getThreads()
      const matchedThreads = predicate
        ? threads.filter((thread) => {
            return predicate(thread)
          })
        : threads
      if (matchedThreads.length > 0) {
        const newestThread = [...matchedThreads].sort((a, b) => {
          return compareSnowflakeDesc(a.id, b.id)
        })[0]
        if (newestThread) {
          return newestThread
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for thread in channel ${this.channelId}`,
    )
  }

  async getInteractionResponse(interactionId: string): Promise<{
    interactionId: string
    interactionToken: string
    applicationId: string
    channelId: string
    type: number
    messageId: string | null
    data: string | null
    acknowledged: boolean
  } | null> {
    return this.discord.prisma.interactionResponse.findUnique({
      where: { interactionId },
    })
  }

  async waitForInteractionAck({
    interactionId,
    timeout = 10000,
  }: {
    interactionId: string
    timeout?: number
  }): Promise<{
    interactionId: string
    interactionToken: string
    type: number
    messageId: string | null
    acknowledged: boolean
  }> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const response =
        await this.discord.prisma.interactionResponse.findUnique({
          where: { interactionId },
        })
      if (response?.acknowledged) {
        return response
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for interaction response ${interactionId}`,
    )
  }
}

// User actor scoped to a specific channel/thread.
// Returned by discord.channel(id).user(userId) or discord.thread(id).user(userId).
export class ScopedUserActor {
  private readonly discord: DigitalDiscord
  private readonly channelId: string
  private readonly userId: string

  constructor({
    discord,
    channelId,
    userId,
  }: {
    discord: DigitalDiscord
    channelId: string
    userId: string
  }) {
    this.discord = discord
    this.channelId = channelId
    this.userId = userId
  }

  async sendMessage({
    content,
    embeds,
    attachments,
    messageReference,
  }: {
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
    messageReference?: APIMessageReference
  }) {
    return this.discord.simulateUserMessage({
      channelId: this.channelId,
      userId: this.userId,
      content,
      embeds,
      attachments,
      messageReference,
    })
  }

  /**
   * Send a voice message (audio attachment with content_type: audio/ogg).
   * The attachment URL is fake — tests using deterministic transcription
   * bypass the fetch entirely. Content defaults to empty string since
   * real Discord voice messages have no text body.
   */
  async sendVoiceMessage({ content }: { content?: string } = {}) {
    return this.sendMessage({
      content: content ?? '',
      attachments: [
        {
          id: generateSnowflake(),
          filename: 'voice-message.ogg',
          content_type: 'audio/ogg',
          size: 1024,
          url: 'https://fake-cdn.discord.test/voice-message.ogg',
          proxy_url: 'https://fake-cdn.discord.test/voice-message.ogg',
        },
      ],
    })
  }

  async runSlashCommand({
    name,
    commandId,
    options,
    guildId,
  }: {
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }) {
    return this.discord.simulateSlashCommand({
      channelId: this.channelId,
      userId: this.userId,
      name,
      commandId,
      options,
      guildId,
    })
  }

  async clickButton({
    messageId,
    customId,
    guildId,
  }: {
    messageId: string
    customId: string
    guildId?: string
  }) {
    return this.discord.simulateButtonClick({
      channelId: this.channelId,
      userId: this.userId,
      messageId,
      customId,
      guildId,
    })
  }

  async selectMenu({
    messageId,
    customId,
    values,
    guildId,
  }: {
    messageId: string
    customId: string
    values: string[]
    guildId?: string
  }) {
    return this.discord.simulateSelectMenu({
      channelId: this.channelId,
      userId: this.userId,
      messageId,
      customId,
      values,
      guildId,
    })
  }

  async submitModal({
    customId,
    fields,
    guildId,
  }: {
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
  }) {
    return this.discord.simulateModalSubmit({
      channelId: this.channelId,
      userId: this.userId,
      customId,
      fields,
      guildId,
    })
  }
}

export { DiscordGateway } from './gateway.js'
export { generateSnowflake } from './snowflake.js'
export type { GatewayState } from './gateway.js'
