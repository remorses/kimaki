// Tests event translation from Slack payloads into Discord gateway payloads.

import { describe, expect, test } from 'vitest'
import {
  translateChannelDelete,
  translateChannelRename,
  translateMemberJoinedChannel,
  translateReaction,
} from '../src/event-translator.js'
import { GatewayDispatchEvents } from 'discord-api-types/v10'

describe('translateReaction', () => {
  test('uses parent channel for top-level message reactions', () => {
    const translated = translateReaction({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'thumbsup',
        item: {
          type: 'message',
          channel: 'C123',
          ts: '1700000000.123456',
        },
      },
      guildId: 'T123',
      threadTs: '1700000000.123456',
    })

    expect(translated.data.channel_id).toBe('C123')
  })

  test('uses encoded thread channel for threaded reactions', () => {
    const translated = translateReaction({
      event: {
        type: 'reaction_removed',
        user: 'U123',
        reaction: 'eyes',
        item: {
          type: 'message',
          channel: 'C123',
          ts: '1700000001.123456',
        },
      },
      guildId: 'T123',
      threadTs: '1700000000.123456',
    })

    expect(translated.data.channel_id).toBe('THR_C123_1700000000123456')
  })
})

describe('channel event translations', () => {
  test('translates channel delete', () => {
    const translated = translateChannelDelete({
      channelId: 'C999',
      guildId: 'T111',
    })

    expect(translated).toEqual({
      eventName: GatewayDispatchEvents.ChannelDelete,
      data: {
        id: 'C999',
        guild_id: 'T111',
      },
    })
    expect(translated.eventName).toBe(GatewayDispatchEvents.ChannelDelete)
  })

  test('translates channel rename', () => {
    const translated = translateChannelRename({
      channelId: 'C999',
      channelName: 'renamed-channel',
      guildId: 'T111',
    })

    expect(translated).toEqual({
      eventName: GatewayDispatchEvents.ChannelUpdate,
      data: {
        id: 'C999',
        type: 0,
        name: 'renamed-channel',
        guild_id: 'T111',
        position: 0,
      },
    })
  })

  test('translates member joined channel into guild member add', () => {
    const translated = translateMemberJoinedChannel({
      event: {
        type: 'member_joined_channel',
        channelId: 'C123',
        userId: 'U123',
      },
      user: {
        id: 'U123',
        name: 'tommy',
        realName: 'Tommy',
        isBot: false,
        avatar: 'https://example.com/u123.png',
      },
    })

    expect(translated.eventName).toBe(GatewayDispatchEvents.GuildMemberAdd)
    expect(translated.data.user?.id).toBe('U123')
    expect(translated.data.user?.global_name).toBe('Tommy')
  })
})
