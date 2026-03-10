// E2E parity checks for edge REST routes and Discord-shaped errors.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { TextChannel } from 'discord.js'
import { Routes } from 'discord-api-types/v10'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('rest parity edge routes', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E()
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('getMessage fetches exact target message by id', async () => {
    const projectId = ctx.twin.resolveChannelId('project')
    const projectChannel = (await ctx.client.channels.fetch(projectId)) as TextChannel

    const first = await projectChannel.send('single-fetch-target')
    await projectChannel.send('single-fetch-other')

    const fetched = await projectChannel.messages.fetch(first.id)
    expect(fetched.id).toBe(first.id)
    expect(fetched.content).toBe('single-fetch-target')
  })

  test('guild-scoped routes reject mismatched guild id with Discord 404 shape', async () => {
    const badGuildId = 'T_WRONG_GUILD'
    const base = `${ctx.bridge.restUrl}/v10/guilds/${badGuildId}`
    const routes: Array<{ method: 'GET' | 'POST'; path: string }> = [
      { method: 'GET', path: '' },
      { method: 'GET', path: '/channels' },
      { method: 'POST', path: '/channels' },
      { method: 'GET', path: '/members' },
      { method: 'GET', path: '/members/U123' },
      { method: 'GET', path: '/roles' },
    ]

    const responses = await Promise.all(
      routes.map(async (route) => {
        const response = await fetch(`${base}${route.path}`, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          body:
            route.method === 'POST'
              ? JSON.stringify({ name: 'should-not-create' })
              : undefined,
        })
        const body = await response.json()
        return {
          status: response.status,
          body,
        }
      }),
    )

    expect(responses).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
        {
          "body": {
            "code": 10004,
            "error": "unknown_guild",
            "error_description": "Unknown Guild: T_WRONG_GUILD",
            "message": "Unknown Guild: T_WRONG_GUILD",
          },
          "status": 404,
        },
      ]
    `)
  })

  test('webhook message PATCH/DELETE routes exist and honor token checks', async () => {
    const messageId = '1700000000000001'
    const patchResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/webhooks/WH/random-token/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'updated-content' }),
      },
    )
    const patchBody = await patchResponse.text()

    const deleteResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/webhooks/WH/random-token/messages/${messageId}`,
      {
        method: 'DELETE',
      },
    )
    const deleteBody = await deleteResponse.text()

    expect({
      patch: { status: patchResponse.status, body: patchBody },
      delete: { status: deleteResponse.status, body: deleteBody },
    }).toMatchInlineSnapshot(`
      {
        "delete": {
          "body": "{"error":"unknown_webhook_token","message":"Unknown webhook token","error_description":"Unknown webhook token"}",
          "status": 404,
        },
        "patch": {
          "body": "{"error":"unknown_webhook_token","message":"Unknown webhook token","error_description":"Unknown webhook token"}",
          "status": 404,
        },
      }
    `)
  })

  test('discord.js surfaces bridge error payload in thrown DiscordAPIError', async () => {
    await expect(
      ctx.client.rest.patch(
        Routes.webhookMessage('WH', 'random-token', '1700000000000001'),
        {
          body: { content: 'updated-content' },
        },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[DiscordAPIError[unknown_webhook_token]: Unknown webhook token]`)
  })
})
