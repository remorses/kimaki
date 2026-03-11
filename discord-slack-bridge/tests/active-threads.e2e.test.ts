// E2E coverage for active thread discovery route.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { TextChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext, waitFor } from './e2e-setup.js'

describe('active threads route', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'active-threads-test' }],
    })
    const channelId = ctx.twin.resolveChannelId('active-threads-test')
    channel = (await ctx.client.channels.fetch(channelId)) as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('returns active thread list with members', async () => {
    const thread = await channel.threads.create({ name: 'active-thread-route' })
    await thread.send('reply to mark as active')

    const list = await waitFor({
      label: 'active threads list',
      fn: async () => {
        const response = await fetch(
          `${ctx.bridge.restUrl}/v10/guilds/${ctx.twin.workspaceId}/threads/active`,
        )
        if (response.status !== 200) {
          return undefined
        }
        const body = (await response.json()) as {
          threads?: Array<{ id: string }>
          members?: Array<{ id: string; user_id: string }>
        }
        const foundThread = (body.threads ?? []).some((entry) => {
          return entry.id === thread.id
        })
        if (!foundThread) {
          return undefined
        }
        return body
      },
    })

    expect(
      (list.members ?? []).some((member) => {
        return member.id === thread.id && member.user_id === ctx.client.user?.id
      }),
    ).toBe(true)
  })

  test('mismatched guild id returns unknown guild payload', async () => {
    const response = await fetch(
      `${ctx.bridge.restUrl}/v10/guilds/T_WRONG_GUILD/threads/active`,
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toMatchObject({
      code: 10004,
      error: 'unknown_guild',
      message: 'Unknown Guild: T_WRONG_GUILD',
    })
  })
})
