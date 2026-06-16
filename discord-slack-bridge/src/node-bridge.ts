// Node runtime wrapper for discord-slack-bridge.
// Keeps Node server lifecycle out of the package root exports.

import { WebClient } from '@slack/web-api'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
} from './server.js'
import type { SlackBridgeConfig } from './types.js'

export class SlackBridge {
  /** Token that discord.js should use to connect to this bridge's gateway */
  readonly discordToken: string

  private _port: number
  private slack: WebClient
  private config: SlackBridgeConfig
  private server: ServerComponents | null = null
  private botUserId: string | null = null
  private botUsername: string | null = null

  constructor(config: SlackBridgeConfig) {
    this.config = config
    this._port = config.port ?? 3710
    this.discordToken = config.discordToken ?? config.slackBotToken
    this.slack = new WebClient(config.slackBotToken, {
      ...(config.slackApiUrl ? { slackApiUrl: config.slackApiUrl } : {}),
    })
  }

  /** Actual bound port. Reflects OS-assigned port after start() when port=0. */
  get port(): number {
    return this._port
  }

  /** REST API base URL for discord.js (without /v10 — discord.js appends the version) */
  get restUrl(): string {
    return buildHttpUrl({
      baseUrl: this.resolvePublicBaseUrl(),
      path: '/api',
    })
  }

  /** Gateway WebSocket URL for discord.js */
  get gatewayUrl(): string {
    if (this.config.gatewayUrlOverride) {
      return this.config.gatewayUrlOverride
    }
    return buildWebSocketUrl({
      baseUrl: this.resolvePublicBaseUrl(),
      path: '/slack/gateway',
    })
  }

  get webhookUrl(): string {
    return buildHttpUrl({
      baseUrl: this.resolvePublicBaseUrl(),
      path: '/slack/events',
    })
  }

  async start(): Promise<void> {
    const authResult = await this.slack.auth.test()
    const botIdentity = normalizeAuthIdentity(authResult)
    this.botUserId = botIdentity.userId
    this.botUsername = botIdentity.username

    this.server = createServer({
      slack: this.slack,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
      botToken: this.config.slackBotToken,
      signingSecret: this.config.slackSigningSecret,
      workspaceId: this.config.workspaceId,
      port: this._port,
      gatewayUrlOverride: this.config.gatewayUrlOverride,
      publicBaseUrl: this.config.publicBaseUrl,
      authorize: this.config.authorize,
    })

    await startServer(this.server, this._port)

    const addr = this.server.httpServer.address()
    if (typeof addr === 'object' && addr) {
      this._port = addr.port
      this.server.gateway.setPort?.(addr.port)
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }
    await stopServer(this.server)
    this.server = null
  }

  private resolvePublicBaseUrl(): string {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl
    }
    return `http://127.0.0.1:${this._port}`
  }
}

function normalizeAuthIdentity(value: unknown): {
  userId: string
  username: string
} {
  if (!isRecord(value)) {
    throw new Error('Slack auth.test returned unexpected payload')
  }
  const userId = readString(value, 'user_id')
  if (!userId) {
    throw new Error('Slack auth.test missing user_id')
  }
  return {
    userId,
    username: readString(value, 'user') ?? 'bot',
  }
}

function buildHttpUrl({ baseUrl, path }: { baseUrl: string; path: string }): string {
  return new URL(path, baseUrl).toString()
}

function buildWebSocketUrl({
  baseUrl,
  path,
}: {
  baseUrl: string
  path: string
}): string {
  const origin = new URL(baseUrl)
  const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL(path, `${protocol}//${origin.host}`)
  return url.toString()
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
