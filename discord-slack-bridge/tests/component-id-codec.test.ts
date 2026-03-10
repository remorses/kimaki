// Tests encoding/decoding Discord component metadata into Slack action IDs.

import { describe, expect, test } from 'vitest'
import { ComponentType } from 'discord-api-types/v10'
import {
  decodeComponentActionId,
  encodeComponentActionId,
} from '../src/component-id-codec.js'

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
})
