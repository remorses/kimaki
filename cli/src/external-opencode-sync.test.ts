import { describe, expect, test } from 'vitest'
import { isExternalSyncCandidate } from './external-opencode-sync.js'

describe('isExternalSyncCandidate', () => {
  test('top-level CLI/TUI session is mirrored', () => {
    expect(isExternalSyncCandidate({ title: 'Refactor the auth module', parentID: undefined })).toBe(true)
  })

  test('top-level session without a title is still mirrored', () => {
    expect(isExternalSyncCandidate({ title: '', parentID: undefined })).toBe(true)
    expect(isExternalSyncCandidate({ title: null, parentID: undefined })).toBe(true)
  })

  test('placeholder "new session -" titles are skipped', () => {
    expect(isExternalSyncCandidate({ title: 'new session - 2f8a', parentID: undefined })).toBe(false)
    expect(isExternalSyncCandidate({ title: 'New Session - untitled', parentID: undefined })).toBe(false)
  })

  test('"(subagent)" title convention is skipped', () => {
    expect(
      isExternalSyncCandidate({ title: 'Survey memoir memory system (@explore subagent)', parentID: 'ses_parent' }),
    ).toBe(false)
    expect(isExternalSyncCandidate({ title: 'research (subagent)', parentID: undefined })).toBe(false)
  })

  test('sub-session with a parentID is skipped even without the (subagent) title', () => {
    // This is the regression being fixed: plugins that spawn internal
    // sub-sessions (memory recall, memory extraction, …) without following the
    // "(subagent)" naming convention previously each leaked a "Sync:" thread.
    expect(isExternalSyncCandidate({ title: 'opencode-memory recall selector', parentID: 'ses_parent' })).toBe(false)
    expect(isExternalSyncCandidate({ title: 'opencode-memory extraction', parentID: 'ses_parent' })).toBe(false)
    expect(isExternalSyncCandidate({ title: 'A normal-looking title', parentID: 'ses_parent' })).toBe(false)
  })

  test('empty/absent parentID does not by itself exclude a session', () => {
    expect(isExternalSyncCandidate({ title: 'A normal session', parentID: '' })).toBe(true)
    expect(isExternalSyncCandidate({ title: 'A normal session' })).toBe(true)
  })
})
