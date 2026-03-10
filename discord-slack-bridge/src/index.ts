// discord-slack-bridge — main entry point.
// Lets any discord.js bot control a Slack workspace without code changes.
// Creates a local server that speaks Discord REST + Gateway on one side
// and Slack Web API + Events on the other.
//
// Usage:
//   const bridge = new SlackBridge({
//     slackBotToken: 'xoxb-...',
//     slackSigningSecret: '...',
//     workspaceId: 'T04ABC123',
//   })
//   await bridge.start()
//
//   // Connect discord.js:
//   const client = new Client({ ... })
//   client.rest.api = `http://localhost:${bridge.port}/api/v10`
//   await client.login(bridge.discordToken)

import { WebClient } from '@slack/web-api'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
} from './server.js'
import type { SlackBridgeConfig } from './types.js'

export type { SlackBridgeConfig } from './types.js'
export {
  encodeThreadId,
  decodeThreadId,
  encodeMessageId,
  decodeMessageId,
  isThreadChannelId,
  resolveSlackTarget,
  slackTsToIso,
  resolveDiscordChannelId,
} from './id-converter.js'
export { mrkdwnToMarkdown, markdownToMrkdwn } from './format-converter.js'
export { componentsToBlocks } from './component-converter.js'
export { uploadAttachmentsToSlack } from './file-upload.js'

export class SlackBridge {
  readonly port: number
  /** Token that discord.js should use to connect to this bridge's gateway */
  readonly discordToken: string
  /** REST API base URL for discord.js */
  readonly restUrl: string
  /** Gateway WebSocket URL for discord.js */
  readonly gatewayUrl: string

  private slack: WebClient
  private config: SlackBridgeConfig
  private server: ServerComponents | null = null
  private botUserId: string | null = null
  private botUsername: string | null = null

  constructor(config: SlackBridgeConfig) {
    this.config = config
    this.port = config.port ?? 3710
    // Use the Slack bot token as the discord.js "token" so the gateway
    // can authenticate the connection
    this.discordToken = config.slackBotToken
    this.restUrl = `http://127.0.0.1:${this.port}/api/v10`
    this.gatewayUrl = config.gatewayUrlOverride ?? `ws://127.0.0.1:${this.port}/gateway`
    this.slack = new WebClient(config.slackBotToken)
  }

  /**
   * Start the bridge server.
   * Fetches bot identity from Slack, then starts HTTP + WebSocket server.
   */
  async start(): Promise<void> {
    // Resolve bot identity
    const authResult = await this.slack.auth.test()
    this.botUserId = authResult.user_id as string
    this.botUsername = (authResult.user as string) ?? 'bot'

    this.server = createServer({
      slack: this.slack,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
      botToken: this.config.slackBotToken,
      signingSecret: this.config.slackSigningSecret,
      workspaceId: this.config.workspaceId,
      port: this.port,
      gatewayUrlOverride: this.config.gatewayUrlOverride,
    })

    await startServer(this.server, this.port)
  }

  /**
   * Stop the bridge server and clean up.
   */
  async stop(): Promise<void> {
    if (this.server) {
      await stopServer(this.server)
      this.server = null
    }
  }

  /**
   * The Slack webhook URL that should be configured in Slack's Event
   * Subscriptions and Interactivity settings.
   * For local development, expose this via ngrok or similar.
   */
  get webhookUrl(): string {
    return `http://127.0.0.1:${this.port}/slack/events`
  }
}
