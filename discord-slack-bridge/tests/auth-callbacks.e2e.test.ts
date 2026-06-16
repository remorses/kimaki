// E2E coverage for callback-based bridge authorization.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { SlackBridge } from '../src/index.js'
import { SlackDigitalTwin } from 'slack-digital-twin/src'
import { sendInteractivePayload, sendSlashCommand } from 'slack-digital-twin/src'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('authorization callbacks', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'auth' }],
      users: [{ name: 'alice', realName: 'Alice' }],
      bridgeConfig: {
        authorize: async ({ kind, token, teamId }) => {
          if (kind === 'gateway-identify') {
            return {
              allow: true,
              clientId: 'gateway-client',
              authorizedTeamIds: teamId ? [teamId] : [],
            }
          }
          if (kind === 'rest') {
            const isBridgeBotToken = Boolean(token?.startsWith('xoxb-'))
            if (token !== 'client-1:secret-1' && !isBridgeBotToken) {
              return { allow: false }
            }
            return {
              allow: true,
              clientId: 'client-1',
              authorizedTeamIds: teamId ? [teamId] : [],
            }
          }
          if (kind === 'webhook-action' || kind === 'webhook-event') {
            if (teamId === 'T_UNAUTHORIZED') {
              return { allow: false }
            }
            return {
              allow: true,
              authorizedTeamIds: teamId ? [teamId] : [],
            }
          }
          return { allow: false }
        },
      },
    })
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('REST requires bearer token when authorize callback is configured', async () => {
    const unauthorized = await fetch(`${ctx.bridge.restUrl}/v10/users/@me`)
    expect(unauthorized.status).toBe(401)

    const wrongBearer = await fetch(`${ctx.bridge.restUrl}/v10/users/@me`, {
      headers: { authorization: 'Bearer client-1:wrong' },
    })
    expect(wrongBearer.status).toBe(401)

    const validBearer = await fetch(`${ctx.bridge.restUrl}/v10/users/@me`, {
      headers: { authorization: 'Bearer client-1:secret-1' },
    })
    expect(validBearer.status).toBe(200)
  })

  test('gateway/bot includes clientId query for client tokens', async () => {
    const response = await fetch(`${ctx.bridge.restUrl}/v10/gateway/bot`, {
      headers: { authorization: 'Bearer client-1:secret-1' },
    })
    expect(response.status).toBe(200)

    const payload = await response.json()
    if (!(payload && typeof payload === 'object' && 'url' in payload)) {
      throw new Error('Missing url in /gateway/bot response')
    }
    const gatewayUrlRaw = payload.url
    if (typeof gatewayUrlRaw !== 'string') {
      throw new Error('Invalid url in /gateway/bot response')
    }
    const gatewayUrl = new URL(gatewayUrlRaw)
    expect(gatewayUrl.searchParams.get('clientId')).toBe('client-1')
  })

  test('tokenized interaction/webhook routes bypass rest auth callback checks', async () => {
    const interactionCallback = await fetch(
      `${ctx.bridge.restUrl}/v10/interactions/123/token-abc/callback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 5 }),
      },
    )
    expect(interactionCallback.status).not.toBe(401)

    const webhookMessage = await fetch(
      `${ctx.bridge.restUrl}/v10/webhooks/123/token-abc/messages/@original`,
    )
    expect(webhookMessage.status).not.toBe(401)
  })

  test('non-tokenized webhook route still requires auth', async () => {
    const response = await fetch(`${ctx.bridge.restUrl}/v10/webhooks/123`)
    expect(response.status).toBe(401)
  })

  test('slash command rejects unauthorized team id', async () => {
    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    const response = await sendSlashCommand({
      config: {
        ...webhookConfig,
        workspaceId: 'T_UNAUTHORIZED',
      },
      command: '/kimaki',
      text: 'hello',
      userId: ctx.twin.resolveUserId('alice'),
      userName: 'alice',
      channelId: ctx.twin.resolveChannelId('auth'),
      channelName: 'auth',
      triggerId: 'trigger-auth-deny',
    })

    expect(response.status).toBe(403)
  })

  test('interactive payload rejects unauthorized team id', async () => {
    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    const response = await sendInteractivePayload({
      config: webhookConfig,
      payload: {
        type: 'block_actions',
        user: {
          id: ctx.twin.resolveUserId('alice'),
          username: 'alice',
          name: 'alice',
        },
        team: { id: 'T_UNAUTHORIZED' },
        channel: { id: ctx.twin.resolveChannelId('auth') },
        trigger_id: 'trigger-interactive-auth-deny',
        response_url: 'https://example.invalid/response',
        actions: [
          {
            action_id: 'action-auth-deny',
            type: 'button',
            value: 'clicked',
            block_id: 'b1',
            action_ts: '1700000000.000020',
          },
        ],
      },
    })

    expect(response.status).toBe(403)
  })

  test('interactive payload rejects missing team id', async () => {
    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    const response = await sendInteractivePayload({
      config: webhookConfig,
      payload: {
        type: 'block_actions',
        user: {
          id: ctx.twin.resolveUserId('alice'),
          username: 'alice',
          name: 'alice',
        },
        channel: { id: ctx.twin.resolveChannelId('auth') },
        trigger_id: 'trigger-interactive-auth-missing-team',
        response_url: 'https://example.invalid/response',
        actions: [
          {
            action_id: 'action-auth-missing-team',
            type: 'button',
            value: 'clicked',
            block_id: 'b1',
            action_ts: '1700000000.000021',
          },
        ],
      },
    })

    expect(response.status).toBe(403)
  })

  test('REST rejects callback results without authorized team ids', async () => {
    const twin = new SlackDigitalTwin({
      workspaceName: 'REST Auth Workspace',
      webhookConfig: { signingSecret: 'rest-auth-signing-secret' },
    })
    await twin.start()

    const bridge = new SlackBridge({
      slackBotToken: twin.botToken,
      slackSigningSecret: 'rest-auth-signing-secret',
      workspaceId: twin.workspaceId,
      port: 0,
      slackApiUrl: twin.apiUrl,
      authorize: async ({ kind, token }) => {
        if (kind !== 'rest' || token !== 'client-1:secret-1') {
          return { allow: false }
        }
        return { allow: true, clientId: 'client-1' }
      },
    })

    try {
      await bridge.start()

      const response = await fetch(`${bridge.restUrl}/v10/users/@me`, {
        headers: { authorization: 'Bearer client-1:secret-1' },
      })

      expect(response.status).toBe(403)
    } finally {
      await bridge.stop()
      await twin.stop()
    }
  })

  test('gateway rejects callback results without authorized team ids', async () => {
    const twin = new SlackDigitalTwin({
      workspaceName: 'Gateway Auth Workspace',
      webhookConfig: { signingSecret: 'gateway-auth-signing-secret' },
    })
    await twin.start()

    const bridge = new SlackBridge({
      slackBotToken: twin.botToken,
      slackSigningSecret: 'gateway-auth-signing-secret',
      workspaceId: twin.workspaceId,
      port: 0,
      slackApiUrl: twin.apiUrl,
      discordToken: 'client-1:secret-1',
      authorize: async ({ kind, token }) => {
        if (kind !== 'gateway-identify' || token !== 'client-1:secret-1') {
          return { allow: false }
        }
        return { allow: true, clientId: 'client-1' }
      },
    })

    try {
      await bridge.start()

      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(bridge.gatewayUrl)
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: 'client-1:secret-1',
                intents: 1,
                properties: {
                  os: 'linux',
                  browser: 'test',
                  device: 'test',
                },
              },
            }),
          )
        })
        ws.on('close', (code) => {
          resolve(code)
        })
        ws.on('error', (error) => {
          reject(error)
        })
      })

      expect(closeCode).toBe(4004)
    } finally {
      await bridge.stop()
      await twin.stop()
    }
  })
})
