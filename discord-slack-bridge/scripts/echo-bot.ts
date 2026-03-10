// Echo bot: tests discord-slack-bridge against a real Slack workspace.
// Requires doppler env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET.
// Usage: cd discord-slack-bridge && pnpm echo-bot
// Tunnel URL is stable — configure once in Slack Event Subscriptions.

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { WebClient } from '@slack/web-api'
import { TunnelClient } from 'traforo/client'
import { SlackBridge } from '../src/index.js'

const TUNNEL_ID = 'dsb-echo-bot'
const BRIDGE_PORT = 3710

async function main(): Promise<void> {
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')

  const tempClient = new WebClient(slackBotToken)
  const authResult = await tempClient.auth.test()
  const workspaceId = authResult.team_id
  if (!workspaceId) {
    throw new Error('Could not resolve workspace ID from auth.test')
  }
  console.log(`Slack workspace: ${authResult.team} (${workspaceId})`)
  console.log(`Bot user: ${authResult.user} (${authResult.user_id})`)

  const bridge = new SlackBridge({
    slackBotToken,
    slackSigningSecret,
    workspaceId,
    port: BRIDGE_PORT,
  })
  await bridge.start()
  console.log(`Bridge: REST=${bridge.restUrl} Gateway=${bridge.gatewayUrl}`)

  const tunnel = new TunnelClient({
    localPort: bridge.port,
    tunnelId: TUNNEL_ID,
  })
  await tunnel.connect()
  const webhookUrl = `${tunnel.url}/slack/events`
  console.log(`Tunnel: ${tunnel.url}`)
  console.log(`Slack Event Subscriptions URL: ${webhookUrl}`)

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
  console.log(`Bot ready! Guild: ${guild?.name} (${guild?.id})`)
  const channels = await guild?.channels.fetch()
  const channelNames = channels?.map((c) => {
    return c?.name
  }).filter(Boolean)
  console.log(`Channels: ${channelNames?.join(', ')}`)

  client.on('messageCreate', (message) => {
    const isSelf = client.user && message.author.id === client.user.id
    if (isSelf) {
      return
    }
    console.log(`[echo] "${message.content}" from ${message.author.username}`)
    void message.channel.send(`echo: ${message.content}`)
  })

  console.log('\nEcho bot running. Press Ctrl+C to stop.\n')

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
