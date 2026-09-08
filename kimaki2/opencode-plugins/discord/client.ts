// Process-wide Discord Client. One record, refcounted across location setups.

import fs from 'node:fs'
import path from 'node:path'
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from 'discord.js'

type DiscordHost = {
  refs: number
  client: Client
  stop: () => void
}

declare global {
  var __kimaki2Discord: DiscordHost | undefined
  var __kimaki2DiscordStarting: Promise<DiscordHost> | undefined
}

export function getClient() {
  return globalThis.__kimaki2Discord?.client
}

export function logPluginError(error: unknown) {
  const file = process.env['KIMAKI2_PLUGIN_LOG']
  if (!file) return
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

async function startDiscord({
  token,
  restApi,
  onMessage,
  onInteraction,
}: {
  token: string
  restApi?: string
  onMessage: (message: Message) => Promise<void>
  onInteraction?: (interaction: Interaction) => Promise<void>
}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    rest: restApi ? { api: restApi, version: '10' } : undefined,
  })
  const messageHandler = (message: Message) => {
    void onMessage(message).catch(logPluginError)
  }
  const interactionHandler = (interaction: Interaction) => {
    if (!onInteraction) return
    void onInteraction(interaction).catch(logPluginError)
  }
  client.on(Events.MessageCreate, messageHandler)
  client.on(Events.InteractionCreate, interactionHandler)
  await client.login(token)
  let stopped = false
  return {
    client,
    stop() {
      if (stopped) return
      stopped = true
      client.off(Events.MessageCreate, messageHandler)
      client.off(Events.InteractionCreate, interactionHandler)
      void client.destroy()
    },
  }
}

export async function acquireDiscord({
  token,
  restApi,
  onMessage,
  onInteraction,
}: {
  token: string
  restApi?: string
  onMessage: (message: Message) => Promise<void>
  onInteraction?: (interaction: Interaction) => Promise<void>
}) {
  if (globalThis.__kimaki2Discord) {
    globalThis.__kimaki2Discord.refs++
    return
  }
  if (!globalThis.__kimaki2DiscordStarting) {
    globalThis.__kimaki2DiscordStarting = startDiscord({ token, restApi, onMessage, onInteraction })
      .then((started) => {
        const host: DiscordHost = { refs: 0, client: started.client, stop: started.stop }
        globalThis.__kimaki2Discord = host
        globalThis.__kimaki2DiscordStarting = undefined
        return host
      })
      .catch((error: unknown) => {
        globalThis.__kimaki2DiscordStarting = undefined
        throw error
      })
  }
  const host = await globalThis.__kimaki2DiscordStarting
  host.refs++
}

export function releaseDiscord() {
  const host = globalThis.__kimaki2Discord
  if (!host) return
  host.refs--
  if (host.refs > 0) return
  host.stop()
  globalThis.__kimaki2Discord = undefined
}

export function resetDiscord() {
  globalThis.__kimaki2Discord?.stop()
  globalThis.__kimaki2Discord = undefined
  globalThis.__kimaki2DiscordStarting = undefined
}
