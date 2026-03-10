// Tests encoding/decoding Discord component metadata into Slack action IDs.

import { describe, expect, test } from 'vitest'
import { ComponentType } from 'discord-api-types/v10'
import {
  decodeComponentActionId,
  encodeComponentActionId,
} from '../src/component-id-codec.js'
import {
  buildDiscordComponentDataFromSlackAction,
  buildResolvedData,
} from '../src/server.js'
import type { NormalizedSlackAction } from '../src/types.js'

describe('component-id-codec', () => {
  test('roundtrips encoded action ids', () => {
    const encoded = encodeComponentActionId({
      componentType: ComponentType.UserSelect,
      customId: 'pick-user',
    })
    expect(encoded).toBe('dsbcmp:5:pick-user')

    expect(decodeComponentActionId(encoded)).toEqual({
      componentType: ComponentType.UserSelect,
      customId: 'pick-user',
    })
  })

  test('passes through legacy action ids', () => {
    expect(decodeComponentActionId('plain-custom-id')).toEqual({
      customId: 'plain-custom-id',
    })
  })

  test('maps Slack button action to Discord button interaction data', () => {
    const action: NormalizedSlackAction = {
      actionId: 'plain-custom-id',
      type: 'button',
      value: 'clicked',
      selectedOptionValues: [],
      selectedUsers: [],
      selectedChannels: [],
      selectedConversations: [],
    }

    const interactionData = buildDiscordComponentDataFromSlackAction({ action })
    expect(interactionData).toMatchInlineSnapshot(`
      {
        "componentType": 2,
        "values": [],
      }
    `)
    expect(
      buildResolvedData({
        componentType: interactionData.componentType,
        values: interactionData.values,
      }),
    ).toBeUndefined()
  })

  test('maps static select action to string select values', () => {
    const action: NormalizedSlackAction = {
      actionId: 'dsbcmp:3:pick-model',
      type: 'static_select',
      selectedOptionValue: 'claude-sonnet',
      selectedOptionValues: [],
      selectedUsers: [],
      selectedChannels: [],
      selectedConversations: [],
    }

    const interactionData = buildDiscordComponentDataFromSlackAction({ action })
    expect(interactionData).toMatchInlineSnapshot(`
      {
        "componentType": 3,
        "values": [
          "claude-sonnet",
        ],
      }
    `)
  })

  test('maps multi static select action to string select values', () => {
    const action: NormalizedSlackAction = {
      actionId: 'dsbcmp:3:pick-many-models',
      type: 'multi_static_select',
      selectedOptionValues: ['claude-sonnet', 'gpt-5'],
      selectedUsers: [],
      selectedChannels: [],
      selectedConversations: [],
    }

    const interactionData = buildDiscordComponentDataFromSlackAction({ action })
    expect(interactionData).toMatchInlineSnapshot(`
      {
        "componentType": 3,
        "values": [
          "claude-sonnet",
          "gpt-5",
        ],
      }
    `)
  })

  test('maps users select action to user select resolved payload', () => {
    const action: NormalizedSlackAction = {
      actionId: 'dsbcmp:5:pick-user',
      type: 'users_select',
      selectedUser: 'U123',
      selectedOptionValues: [],
      selectedUsers: [],
      selectedChannels: [],
      selectedConversations: [],
    }

    const interactionData = buildDiscordComponentDataFromSlackAction({ action })
    expect(interactionData).toMatchInlineSnapshot(`
      {
        "componentType": 5,
        "values": [
          "U123",
        ],
      }
    `)
    expect(
      buildResolvedData({
        componentType: interactionData.componentType,
        values: interactionData.values,
      }),
    ).toMatchInlineSnapshot(`
      {
        "resolved": {
          "users": {
            "U123": {
              "avatar": null,
              "discriminator": "0",
              "id": "U123",
              "username": "U123",
            },
          },
        },
      }
    `)
  })

  test('maps conversations select action to channel select resolved payload', () => {
    const action: NormalizedSlackAction = {
      actionId: 'dsbcmp:8:pick-channel',
      type: 'conversations_select',
      selectedConversation: 'C123',
      selectedOptionValues: [],
      selectedUsers: [],
      selectedChannels: [],
      selectedConversations: [],
    }

    const interactionData = buildDiscordComponentDataFromSlackAction({ action })
    expect(interactionData).toMatchInlineSnapshot(`
      {
        "componentType": 8,
        "values": [
          "C123",
        ],
      }
    `)
    expect(
      buildResolvedData({
        componentType: interactionData.componentType,
        values: interactionData.values,
      }),
    ).toMatchInlineSnapshot(`
      {
        "resolved": {
          "channels": {
            "C123": {
              "id": "C123",
              "name": "C123",
              "permissions": "0",
              "type": 0,
            },
          },
        },
      }
    `)
  })
})
