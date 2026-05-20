import { afterEach, describe, expect, test } from 'vitest'
import { stopExternalOpencodeSessionSync, externalOpencodeSyncInternals } from './external-opencode-sync.js'

afterEach(() => {
  delete process.env.KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC
  stopExternalOpencodeSessionSync()
})

describe('external OpenCode session sync feature flag', () => {
  test('is disabled by default in production', () => {
    delete process.env.KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC

    expect(externalOpencodeSyncInternals.isExternalOpencodeSessionSyncEnabled()).toBe(false)
  })

  test('only enables when explicitly set to 1', () => {
    process.env.KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC = '0'
    expect(externalOpencodeSyncInternals.isExternalOpencodeSessionSyncEnabled()).toBe(false)

    process.env.KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC = '1'
    expect(externalOpencodeSyncInternals.isExternalOpencodeSessionSyncEnabled()).toBe(true)
  })
})
