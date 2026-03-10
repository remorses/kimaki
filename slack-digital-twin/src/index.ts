// SlackDigitalTwin - Local Slack API test server.
// Creates a fake Slack Web API server that @slack/web-api WebClient can
// connect to. Used for automated testing of Slack bots and integrations
// without hitting real Slack servers.
//
// Architecture:
//   - Spiceflow HTTP server implementing Slack Web API routes (/api/*)
//   - In-memory Prisma + libsql database for state
//   - Webhook sender for simulating Events API delivery
//   - No WebSocket/Socket Mode — Slack Events API uses HTTP webhooks

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createPrismaClient, type PrismaClient } from './db.js'
import {
  generateWorkspaceId,
  generateChannelId,
  generateUserId,
  generateMessageTs,
  resetIds,
} from './slack-ids.js'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
} from './server.js'
import { messageToSlack } from './serializers.js'
import type { SlackMessage } from './types.js'

export type { SlackMessage }

export type SlackDigitalTwinChannelOption = {
  id?: string
  name: string
  isPrivate?: boolean
  topic?: string
  purpose?: string
}

export type SlackDigitalTwinUserOption = {
  id?: string
  name: string
  realName?: string
  isBot?: boolean
  avatar?: string
}

export interface SlackDigitalTwinOptions {
  workspaceName?: string
  workspaceId?: string
  channels?: SlackDigitalTwinChannelOption[]
  users?: SlackDigitalTwinUserOption[]
  botUser?: {
    id?: string
    name?: string
  }
  botToken?: string
  dbUrl?: string
}

export class SlackDigitalTwin {
  prisma: PrismaClient
  botToken: string
  botUserId: string
  workspaceId: string

  private server: ServerComponents | null = null
  private options: SlackDigitalTwinOptions
  private seeded = false
  private userIds: Map<string, string> = new Map() // name → id
  private channelIds: Map<string, string> = new Map() // name → id

  constructor(options: SlackDigitalTwinOptions = {}) {
    this.options = options
    this.prisma = createPrismaClient(options.dbUrl)
    this.botToken = options.botToken ?? 'xoxb-fake-bot-token'
    this.botUserId = options.botUser?.id ?? generateUserId()
    this.workspaceId = options.workspaceId ?? generateWorkspaceId()
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  // URL for @slack/web-api WebClient's slackApiUrl option.
  // Point WebClient at this to use the twin instead of real Slack.
  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/api/`
  }

  async start(): Promise<void> {
    await this.prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
    await this.prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
    await this.applySchema()

    if (!this.seeded) {
      await this.seed()
      this.seeded = true
    }

    this.server = createServer({
      prisma: this.prisma,
      workspaceId: this.workspaceId,
      botUserId: this.botUserId,
      botToken: this.botToken,
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

  channel(channelIdOrName: string): ChannelScope {
    const channelId = this.channelIds.get(channelIdOrName) ?? channelIdOrName
    return new ChannelScope({ twin: this, channelId })
  }

  user(userIdOrName: string): UserActor {
    const userId = this.userIds.get(userIdOrName) ?? userIdOrName
    return new UserActor({ twin: this, userId })
  }

  // Resolve a user name to its ID
  resolveUserId(nameOrId: string): string {
    return this.userIds.get(nameOrId) ?? nameOrId
  }

  // Resolve a channel name to its ID
  resolveChannelId(nameOrId: string): string {
    return this.channelIds.get(nameOrId) ?? nameOrId
  }

  // --- Schema & Seeding ---

  private async applySchema(): Promise<void> {
    // Read the generated schema.sql (created by `pnpm generate:sql` from
    // schema.prisma via prisma db push + sqlite3 .schema). This avoids
    // hand-writing CREATE TABLE statements that can drift from the prisma schema.
    // src/ is always shipped in the package, so ../src/schema.sql works from
    // both src/ (dev with tsx) and dist/ (built with tsc).
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const schemaPath = path.resolve(__dirname, '../src/schema.sql')

    const sql = fs.readFileSync(schemaPath, 'utf-8')

    // Same parsing approach as discord/src/db.ts migrateSchema():
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
    const workspaceName = opts.workspaceName ?? 'test-workspace'

    // Create workspace
    await this.prisma.workspace.create({
      data: {
        id: this.workspaceId,
        name: workspaceName,
        domain: workspaceName.toLowerCase().replace(/\s+/g, '-'),
      },
    })

    // Create bot user
    const botName = opts.botUser?.name ?? 'test-bot'
    await this.prisma.user.create({
      data: {
        id: this.botUserId,
        workspaceId: this.workspaceId,
        name: botName,
        realName: botName,
        isBot: true,
      },
    })

    // Create configured users
    for (const userOpt of opts.users ?? []) {
      const userId = userOpt.id ?? generateUserId()
      this.userIds.set(userOpt.name, userId)
      await this.prisma.user.create({
        data: {
          id: userId,
          workspaceId: this.workspaceId,
          name: userOpt.name,
          realName: userOpt.realName ?? userOpt.name,
          isBot: userOpt.isBot ?? false,
          avatar: userOpt.avatar,
        },
      })
    }

    // Create configured channels
    for (const chanOpt of opts.channels ?? []) {
      const channelId = chanOpt.id ?? generateChannelId()
      this.channelIds.set(chanOpt.name, channelId)
      await this.prisma.channel.create({
        data: {
          id: channelId,
          workspaceId: this.workspaceId,
          name: chanOpt.name,
          isPrivate: chanOpt.isPrivate ?? false,
          topic: chanOpt.topic ?? '',
          purpose: chanOpt.purpose ?? '',
        },
      })
    }
  }
}

// --- ChannelScope ---

export class ChannelScope {
  private twin: SlackDigitalTwin
  private channelId: string

  constructor({ twin, channelId }: { twin: SlackDigitalTwin; channelId: string }) {
    this.twin = twin
    this.channelId = channelId
  }

  // Get all non-deleted messages in this channel, ordered by ts ascending
  async getMessages(): Promise<SlackMessage[]> {
    const messages = await this.twin.prisma.message.findMany({
      where: { channelId: this.channelId, isDeleted: false },
      orderBy: { ts: 'asc' },
      include: { reactions: true },
    })
    return messages.map((m) => messageToSlack({ message: m, reactions: m.reactions }))
  }

  // Get a markdown-like text snapshot of all messages for inline assertions.
  // Format: "username: message text" per line, threads indented.
  async text(): Promise<string> {
    const messages = await this.twin.prisma.message.findMany({
      where: { channelId: this.channelId, isDeleted: false },
      orderBy: { ts: 'asc' },
      include: { reactions: true },
    })

    const lines: string[] = []
    for (const msg of messages) {
      const user = await this.twin.prisma.user.findUnique({
        where: { id: msg.userId },
      })
      const name = user?.name ?? msg.userId
      const prefix = msg.threadTs && msg.threadTs !== msg.ts ? '  ↳ ' : ''
      const reactionsStr = msg.reactions.length > 0
        ? ` [${msg.reactions.map((r) => `:${r.name}:`).join(' ')}]`
        : ''
      lines.push(`${prefix}${name}: ${msg.text}${reactionsStr}`)
    }
    return lines.join('\n')
  }

  // Wait for a message matching an optional predicate
  async waitForMessage({
    timeout = 3000,
    predicate,
  }: {
    timeout?: number
    predicate?: (msg: SlackMessage) => boolean
  } = {}): Promise<SlackMessage> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const messages = await this.getMessages()
      const match = predicate ? messages.find(predicate) : messages[messages.length - 1]
      if (match) return match
      await sleep(50)
    }
    throw new Error(`waitForMessage timed out after ${timeout}ms in channel ${this.channelId}`)
  }

  // Wait for a message from a bot
  async waitForBotReply({ timeout = 3000 }: { timeout?: number } = {}): Promise<SlackMessage> {
    return this.waitForMessage({
      timeout,
      predicate: (msg) => msg.bot_id != null,
    })
  }
}

// --- UserActor ---

export class UserActor {
  private twin: SlackDigitalTwin
  private userId: string

  constructor({ twin, userId }: { twin: SlackDigitalTwin; userId: string }) {
    this.twin = twin
    this.userId = userId
  }

  // Send a message as this user to a channel
  async sendMessage({
    channel,
    text,
    threadTs,
  }: {
    channel: string
    text: string
    threadTs?: string
  }): Promise<SlackMessage> {
    const channelId = this.twin.resolveChannelId(channel)
    const ts = generateMessageTs()

    await this.twin.prisma.message.create({
      data: {
        channelId,
        userId: this.userId,
        text,
        ts,
        threadTs,
      },
    })

    return {
      type: 'message',
      user: this.userId,
      text,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }
  }

  // Add a reaction as this user
  async addReaction({
    channel,
    messageTs,
    name,
  }: {
    channel: string
    messageTs: string
    name: string
  }): Promise<void> {
    const channelId = this.twin.resolveChannelId(channel)
    await this.twin.prisma.reaction.create({
      data: {
        channelId,
        messageTs,
        userId: this.userId,
        name,
      },
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Re-exports
export { createPrismaClient } from './db.js'
export { generateWorkspaceId, generateChannelId, generateUserId, generateMessageTs, resetIds } from './slack-ids.js'
export { userToSlack, channelToSlack, messageToSlack } from './serializers.js'
export type { WebhookSenderConfig } from './webhook-sender.js'
export { sendWebhookEvent, sendSlashCommand, sendInteractivePayload } from './webhook-sender.js'
export type { ServerConfig, ServerComponents } from './server.js'
