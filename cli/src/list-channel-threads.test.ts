import { ChannelType } from 'discord.js'
import { describe, expect, test } from 'vitest'
import {
  mergeDiscordChannelThreads,
  parseDiscordThreadPayload,
} from './list-channel-threads.js'

describe('list-channel-threads', () => {
  test('parses public threads and skips other channel types', () => {
    const parsed = parseDiscordThreadPayload({
      payload: {
        id: 'thread-1',
        name: 'Fix auth timeout',
        type: ChannelType.PublicThread,
        parent_id: 'channel-1',
        guild_id: 'guild-1',
        last_message_id: 'msg-9',
        thread_metadata: { archived: false },
      },
      parentId: 'channel-1',
      guildId: 'guild-1',
    })

    expect(parsed).toMatchInlineSnapshot(`
      {
        "archiveState": "active",
        "archived": false,
        "guildId": "guild-1",
        "id": "thread-1",
        "lastMessageId": "msg-9",
        "name": "Fix auth timeout",
        "parentId": "channel-1",
      }
    `)

    expect(
      parseDiscordThreadPayload({
        payload: {
          id: 'not-a-thread',
          name: 'website',
          type: ChannelType.GuildText,
          parent_id: 'category-1',
        },
        parentId: 'channel-1',
        guildId: 'guild-1',
      }),
    ).toBe(null)
  })

  test('keeps active threads first and drops duplicate ids', () => {
    const merged = mergeDiscordChannelThreads({
      threads: [
        {
          id: 'thread-old',
          name: 'Old work',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: true,
          archiveState: 'archived',
          lastMessageId: '2',
        },
        {
          id: 'thread-new',
          name: 'New work',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: false,
          archiveState: 'active',
          lastMessageId: '1',
        },
        {
          id: 'thread-new',
          name: 'New work duplicate',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: false,
          archiveState: 'active',
          lastMessageId: '9',
        },
      ],
    })

    expect(merged.map((thread) => thread.id)).toMatchInlineSnapshot(`
      [
        "thread-new",
        "thread-old",
      ]
    `)
  })
})
