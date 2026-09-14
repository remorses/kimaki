import { describe, expect, test } from 'vitest'
import { extractSdkErrorMessage } from './opencode.js'

describe('extractSdkErrorMessage', () => {
  test('includes UnknownError name, message, and ref from session.create', () => {
    expect(
      extractSdkErrorMessage({
        name: 'UnknownError',
        data: {
          message: 'Unexpected server error. Check server logs for details.',
          ref: 'err_58d6c6cf',
        },
      }),
    ).toMatchInlineSnapshot(
      `"UnknownError: Unexpected server error. Check server logs for details. (err_58d6c6cf)"`,
    )
  })
})
