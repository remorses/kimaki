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

let discord: DigitalDiscord

beforeAll(async () => {
  discord = new DigitalDiscord({
    gatewayProxy: true,
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
