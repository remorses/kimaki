// E2E test setup helper for discord-slack-bridge.
// Wires up: discord.js Client → SlackBridge → SlackDigitalTwin
// No real Discord or Slack APIs are called.

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { SlackBridge } from '../src/index.js'
import { SlackDigitalTwin } from 'slack-digital-twin/src'
import type { SlackDigitalTwinChannelOption, SlackDigitalTwinUserOption } from 'slack-digital-twin/src'

const DEFAULT_SIGNING_SECRET = 'e2e-test-signing-secret'

export interface E2EContext {
  twin: SlackDigitalTwin
  bridge: SlackBridge
  client: Client
}

export interface E2ESetupOptions {
  channels?: SlackDigitalTwinChannelOption[]
  users?: SlackDigitalTwinUserOption[]
  signingSecret?: string
}

export async function setupE2E(options: E2ESetupOptions = {}): Promise<E2EContext> {
  const signingSecret = options.signingSecret ?? DEFAULT_SIGNING_SECRET

  const twin = new SlackDigitalTwin({
    workspaceName: 'E2E Workspace',
    channels: options.channels ?? [{ name: 'general' }, { name: 'project' }],
    users: options.users ?? [
      { name: 'alice', realName: 'Alice Smith' },
      { name: 'bob', realName: 'Bob Jones' },
    ],
    webhookConfig: { signingSecret },
  })
  await twin.start()

  const bridge = new SlackBridge({
    slackBotToken: twin.botToken,
    slackSigningSecret: signingSecret,
    workspaceId: twin.workspaceId,
    port: 0, // OS-assigned for parallel test safety
    slackApiUrl: twin.apiUrl,
  })
  await bridge.start()

  // Wire webhook target now that bridge port is known
  twin.setWebhookUrl(bridge.webhookUrl)

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    rest: { api: bridge.restUrl, version: '10' },
  })

  // Set up ready listener BEFORE login — the event can fire before login() resolves
  const readyPromise = new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })

  await client.login(bridge.discordToken)
  await readyPromise

  return { twin, bridge, client }
}

export async function teardownE2E(ctx: E2EContext): Promise<void> {
  ctx.client.destroy()
  await ctx.bridge.stop()
  await ctx.twin.stop()
}

// Poll helper: wait for a condition with timeout
export async function waitFor<T>({
  fn,
  timeout = 4000,
  interval = 100,
  label = 'waitFor',
}: {
  fn: () => Promise<T | undefined | null | false>
  timeout?: number
  interval?: number
  label?: string
}): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await fn()
    if (result) {
      return result
    }
    await new Promise((resolve) => {
      setTimeout(resolve, interval)
    })
  }
  throw new Error(`${label} timed out after ${timeout}ms`)
}
