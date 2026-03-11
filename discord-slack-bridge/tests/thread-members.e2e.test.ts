// E2E coverage for Discord thread member routes exposed by the bridge.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { TextChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('thread member routes', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'thread-members-test' }],
    })
    const channelId = ctx.twin.resolveChannelId('thread-members-test')
    channel = (await ctx.client.channels.fetch(channelId)) as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('list + @me routes are available for active thread', async () => {
    const thread = await channel.threads.create({ name: 'thread-members' })
    await thread.send('reply to create participants')

    const listResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/channels/${thread.id}/thread-members`,
    )
    const listBody = await listResponse.json()

    expect(listResponse.status).toBe(200)
    expect(Array.isArray(listBody)).toBe(true)
    expect(
      listBody.some((member) => {
        if (!isThreadMember(member)) {
          return false
        }
        return member.id === thread.id && member.user_id === ctx.client.user?.id
      }),
    ).toBe(true)

    const getMeResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/channels/${thread.id}/thread-members/@me`,
    )
    const getMeBody = await getMeResponse.json()
    expect(getMeResponse.status).toBe(200)
    expect(isThreadMember(getMeBody)).toBe(true)
    if (isThreadMember(getMeBody)) {
      expect(getMeBody.id).toBe(thread.id)
      expect(getMeBody.user_id).toBe(ctx.client.user?.id)
    }

    const putMeResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/channels/${thread.id}/thread-members/@me`,
      { method: 'PUT' },
    )
    const deleteMeResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/channels/${thread.id}/thread-members/@me`,
      { method: 'DELETE' },
    )
    expect({
      putStatus: putMeResponse.status,
      deleteStatus: deleteMeResponse.status,
    }).toMatchInlineSnapshot(`
      {
        "deleteStatus": 204,
        "putStatus": 204,
      }
    `)
  })

  test('unknown thread returns Discord unknown channel error payload', async () => {
    const unknownThreadId = 'C_UNKNOWN_THREAD'
    const response = await fetch(
      `${ctx.bridge.restUrl}/v10/channels/${unknownThreadId}/thread-members`,
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toMatchObject({
      code: 10003,
      message: expect.stringContaining('Unknown Channel'),
    })
  })
})

function isThreadMember(value: unknown): value is {
  id: string
  user_id: string
  join_timestamp: string
  flags: number
} {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.id === 'string' &&
    typeof value.user_id === 'string' &&
    typeof value.join_timestamp === 'string' &&
    typeof value.flags === 'number'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
