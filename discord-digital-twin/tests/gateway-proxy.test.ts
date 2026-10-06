// gatewayProxy mode: the twin plays kimaki's gateway-proxy. Client tokens see
// only their authorized guilds over the WebSocket, and REST follows the
// rest_proxy.rs scope rules (fail closed).

import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits } from 'discord.js'
import { DigitalDiscord, resolveRouteScope } from '../src/index.js'

const OWN_GUILD = '300000000000000001'
const OTHER_GUILD = '300000000000000002'
const OWN_CHANNEL = '300000000000000011'
const OTHER_CHANNEL = '300000000000000012'
const TOKEN = 'client-1:secret-1'
const USER = '300000000000000021'

let discord: DigitalDiscord

beforeAll(async () => {
  discord = new DigitalDiscord({
    gatewayProxy: true,
    users: [{ id: USER, username: 'tommy' }],
    guilds: [
      { id: OWN_GUILD, name: 'Own', channels: [{ id: OWN_CHANNEL, name: 'own', type: ChannelType.GuildText }] },
      { id: OTHER_GUILD, name: 'Other', channels: [{ id: OTHER_CHANNEL, name: 'other', type: ChannelType.GuildText }] },
    ],
  })
  await discord.start()
  discord.authorizeGatewayClient({ token: TOKEN, guildIds: [OWN_GUILD] })
})

afterAll(async () => {
  await discord.stop()
})

async function status(path: string, { token = TOKEN, method = 'GET' }: { token?: string; method?: string } = {}) {
  const response = await fetch(`${discord.restUrl}/v10${path}`, { method, headers: { authorization: `Bot ${token}` } })
  return response.status
}

test('REST scope follows rest_proxy.rs', async () => {
  expect({
    gatewayBot: await status('/gateway/bot'),
    usersMe: await status('/users/@me'),
    ownGuildChannels: await status(`/guilds/${OWN_GUILD}/channels`),
    otherGuildChannels: await status(`/guilds/${OTHER_GUILD}/channels`),
    ownChannel: await status(`/channels/${OWN_CHANNEL}`),
    otherChannel: await status(`/channels/${OTHER_CHANNEL}`),
    unknownChannel: await status('/channels/399999999999999999'),
    globalCommands: await status('/applications/123/commands'),
    guildCommands: await status(`/applications/123/guilds/${OTHER_GUILD}/commands`),
    unknownToken: await status(`/guilds/${OWN_GUILD}/channels`, { token: 'nobody:nothing' }),
  }).toMatchInlineSnapshot(`
    {
      "gatewayBot": 200,
      "globalCommands": 403,
      "guildCommands": 403,
      "otherChannel": 403,
      "otherGuildChannels": 403,
      "ownChannel": 200,
      "ownGuildChannels": 200,
      "unknownChannel": 404,
      "unknownToken": 401,
      "usersMe": 200,
    }
  `)
  expect(resolveRouteScope('/api/v10/webhooks/123/token/messages')).toEqual({ kind: 'allowed-without-auth' })
  expect(resolveRouteScope('/api/v10/webhooks/123')).toEqual({ kind: 'denied' })
})

test('client sees only its authorized guilds; unknown tokens cannot connect', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: discord.restUrl, version: '10' } })
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(TOKEN)
  await ready
  expect([...client.guilds.cache.keys()]).toEqual([OWN_GUILD])
  await client.destroy()

  const rejected = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: discord.restUrl, version: '10' } })
  const login = await rejected.login('nobody:nothing').catch((error: Error) => error)
  expect(login instanceof Error).toBe(true)
  await rejected.destroy()
})

test('messages sent while the client is offline are replayed after READY', async () => {
  // No client connected for TOKEN: these go to its offline buffer.
  await discord.channel(OWN_CHANNEL).user(USER).sendMessage({ content: 'missed 1' })
  await discord.channel(OTHER_CHANNEL).user(USER).sendMessage({ content: 'other guild' })
  await discord.channel(OWN_CHANNEL).user(USER).sendMessage({ content: 'missed 2' })

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    rest: { api: discord.restUrl, version: '10' },
  })
  const received: string[] = []
  // Registered before login, like the kimaki bot: replayed events are emitted right after clientReady.
  client.on('messageCreate', (message) => void received.push(message.content))
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(TOKEN)
  await ready
  await discord.channel(OWN_CHANNEL).user(USER).sendMessage({ content: 'live' })
  await expect.poll(() => received.length, { timeout: 4_000, interval: 50 }).toBe(3)
  expect(received).toMatchInlineSnapshot(`
    [
      "missed 1",
      "missed 2",
      "live",
    ]
  `)
  await client.destroy()

  // The buffer was drained: a second connect replays nothing.
  const again = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    rest: { api: discord.restUrl, version: '10' },
  })
  const replayed: string[] = []
  again.on('messageCreate', (message) => void replayed.push(message.id))
  const againReady = new Promise<void>((resolve) => again.once('clientReady', () => resolve()))
  await again.login(TOKEN)
  await againReady
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(replayed).toEqual([])
  await again.destroy()
})
