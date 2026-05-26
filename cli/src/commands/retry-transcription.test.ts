// Unit tests for the retry-transcription button.
// We only test the pure customId-encoding helper here. The handler itself
// requires a live Discord ButtonInteraction so it's covered by e2e tests.

import { describe, expect, test } from 'vitest'
import { buildRetryTranscriptionRow } from './retry-transcription.js'

describe('buildRetryTranscriptionRow', () => {
  test('encodes channelId and messageId into the customId with the expected prefix', () => {
    const row = buildRetryTranscriptionRow({
      id: '1508877325930987611',
      channelId: '1508804737179324469',
    })
    const button = row.components[0]
    expect(button).toBeDefined()
    expect(button!.data).toMatchObject({
      custom_id: 'retry_transcription:1508804737179324469:1508877325930987611',
      label: 'Retry transcription',
      style: 2, // ButtonStyle.Secondary
    })
  })

  test('produced customId fits comfortably under Discord 100-char limit', () => {
    // Discord snowflakes are at most 19 digits; even with very long IDs the
    // customId stays well under the 100-char hard limit.
    const row = buildRetryTranscriptionRow({
      id: '9999999999999999999',
      channelId: '9999999999999999999',
    })
    const customId = row.components[0]!.data.custom_id as string
    expect(customId.length).toBeLessThanOrEqual(100)
  })
})
