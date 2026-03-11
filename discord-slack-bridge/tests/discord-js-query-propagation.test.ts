// Verifies current discord.js behavior for REST base URL query parameters.

import http from 'node:http'
import { describe, expect, test } from 'vitest'
import { Client, GatewayIntentBits } from 'discord.js'

describe('discord.js query propagation', () => {
  test('keeps REST base URL query params in a malformed path position', async () => {
    const restUrls: string[] = []

    const server = http.createServer((req, res) => {
      const requestUrl = req.url ?? '/'
      restUrls.push(requestUrl)

      if (requestUrl.startsWith('/api/v10/users/@me')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: '123456789012345678',
            username: 'query-tester',
            discriminator: '0001',
            global_name: 'query-tester',
            avatar: null,
            bot: true,
          }),
        )
        return
      }

      if (requestUrl.startsWith('/api/v10/gateway/bot')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            url: 'ws://127.0.0.1:65535/gateway?clientId=test-client&via=bot-response',
            shards: 1,
            session_start_limit: {
              total: 1000,
              remaining: 1000,
              reset_after: 0,
              max_concurrency: 1,
            },
          }),
        )
        return
      }

      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', (error?: Error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    const address = server.address()
    if (!(address && typeof address === 'object')) {
      throw new Error('Could not resolve probe server address')
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: {
        api: `http://127.0.0.1:${String(address.port)}/api?clientId=rest-client&scope=test`,
        version: '10',
      },
    })

    client.rest.setToken('discord-js-query-test-token')
    const usersResponse = await client.rest.get('/users/@me').catch(() => {
      return undefined
    })
    const gatewayBotRaw = await client.rest.get('/gateway/bot').catch(() => {
      return undefined
    })

    client.destroy()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })

    expect(restUrls).toMatchInlineSnapshot(`
      [
        "/api?clientId=rest-client&scope=test/v10/users/@me",
        "/api?clientId=rest-client&scope=test/v10/gateway/bot",
      ]
    `)

    expect(
      restUrls.includes('/api?clientId=rest-client&scope=test/v10/users/@me'),
    ).toBe(true)
    expect(
      restUrls.includes('/api?clientId=rest-client&scope=test/v10/gateway/bot'),
    ).toBe(true)

    if (
      gatewayBotRaw
      && typeof gatewayBotRaw === 'object'
      && 'url' in gatewayBotRaw
      && typeof gatewayBotRaw.url === 'string'
    ) {
      const gatewayUrl = new URL(gatewayBotRaw.url)
      expect(gatewayUrl.searchParams.get('clientId')).toBe('test-client')
      expect(gatewayUrl.searchParams.get('via')).toBe('bot-response')
    }

    expect(usersResponse === undefined || typeof usersResponse === 'object').toBe(true)
  })
})
