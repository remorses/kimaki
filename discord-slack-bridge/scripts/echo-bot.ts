// Echo bot script for testing discord-slack-bridge against a real Slack workspace.
//
// Boots a SlackBridge connected to real Slack APIs (via doppler secrets),
// starts a stable tunnel so Slack can deliver webhook events, then connects
// a discord.js Client through the bridge. The bot echoes every non-bot
// message back into the same channel prefixed with "echo: ".
//
// Requires doppler env vars:
//   SLACK_BOT_TOKEN       - xoxb-... bot token
//   SLACK_SIGNING_SECRET  - signing secret for webhook verification
//
// Usage:
//   cd discord-slack-bridge && pnpm echo-bot
//
// The tunnel URL is stable across restarts (uses a fixed tunnel ID), so
// you only need to configure it once in your Slack app's Event Subscriptions:
//   Request URL: <printed tunnel url>/slack/events

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { WebClient } from '@slack/web-api'
import { TunnelClient } from 'traforo/client'
import { SlackBridge } from '../src/index.js'

// Stable tunnel ID so the URL doesn't change between restarts.
// Configure this URL once in Slack app settings and it stays valid.
const TUNNEL_ID = 'dsb-echo-bot'
const BRIDGE_PORT = 3710

async function main(): Promise<void> {
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')

  // Resolve workspace ID from Slack auth.test
  const tempClient = new WebClient(slackBotToken)
  const authResult = await tempClient.auth.test()
  const workspaceId = authResult.team_id
  if (!workspaceId) {
    throw new Error('Could not resolve workspace ID from auth.test')
  }
  console.log(`Slack workspace: ${authResult.team} (${workspaceId})`)
  console.log(`Bot user: ${authResult.user} (${authResult.user_id})`)

  // Start the bridge (Discord REST + Gateway locally, Slack Web API remotely)
  const bridge = new SlackBridge({
    slackBotToken,
    slackSigningSecret,
    workspaceId,
    port: BRIDGE_PORT,
  })
  await bridge.start()
  console.log(`\nBridge started:`)
  console.log(`  REST:    ${bridge.restUrl}`)
  console.log(`  Gateway: ${bridge.gatewayUrl}`)
  console.log(`  Webhook: ${bridge.webhookUrl}`)

  // Start tunnel so Slack can deliver events to the bridge webhook
  const tunnel = new TunnelClient({
    localPort: bridge.port,
    tunnelId: TUNNEL_ID,
  })
  await tunnel.connect()
  const webhookUrl = `${tunnel.url}/slack/events`
  console.log(`\nTunnel active:`)
  console.log(`  Public URL:  ${tunnel.url}`)
  console.log(`  Webhook URL: ${webhookUrl}`)
  console.log(`\nSet this as your Slack app's Event Subscriptions Request URL:`)
  console.log(`  ${webhookUrl}`)

  // Create a discord.js client pointed at the bridge
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { api: bridge.restUrl, version: '10' },
  })

  const readyPromise = new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })

  await client.login(bridge.discordToken)
  await readyPromise

  const guild = client.guilds.cache.first()
  console.log(`\nBot ready! Guild: ${guild?.name} (${guild?.id})`)
  const channels = await guild?.channels.fetch()
  const channelNames = channels?.map((c) => {
    return c?.name
  }).filter(Boolean)
  console.log(`Channels: ${channelNames?.join(', ')}`)

  // Echo handler — reply to every non-bot message
  client.on('messageCreate', (message) => {
    if (message.author.bot) {
      return
    }
    console.log(`[echo] "${message.content}" from ${message.author.username}`)
    void message.channel.send(`echo: ${message.content}`)
  })

  console.log('\nEcho bot running. Send a message in Slack to test.')
  console.log('Press Ctrl+C to stop.\n')

  const shutdown = (): void => {
    console.log('\nShutting down...')
    client.destroy()
    tunnel.close()
    void bridge.stop().then(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
