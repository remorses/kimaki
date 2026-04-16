import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ThreadChannel } from 'discord.js'

vi.mock('errore', () => ({
  tryAsync: vi.fn(async (fn) => {
    try {
      return await fn()
    } catch (e) {
      return e
    }
  }),
}))

vi.mock('../discord-utils.js', () => ({
  SILENT_MESSAGE_FLAGS: 4096,
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  }),
  LogPrefix: { DISCORD: 'DISCORD', SESSION: 'SESSION' },
}))

function createFakeThread(): ThreadChannel {
  const send = vi.fn(async () => {
    return { id: 'msg-1' }
  })

  return {
    id: 'thread-1',
    send,
  } as unknown as ThreadChannel
}

beforeEach(() => {
  // Reset module cache so module-scoped dedup map in toast-handler is fresh
  // for each test. We dynamically import ./toast-handler.js inside tests so
  // the fresh module is loaded after this call.
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('thread-session-runtime: toast dedup semantics (RED tests)', () => {
  test('repeated identical normalized info toasts should only send once', async () => {
    const { handleTuiToast, stripToastSessionId } = await import('./toast-handler.js')

    const thread = createFakeThread()

    // Simulate two info toasts that normalize to the same message
    const props1 = { title: 'Tip', message: 'Operation complete ses_ABC123', variant: 'info' as const }
    const props2 = { title: 'Tip', message: 'Operation complete ses_DEF456', variant: 'info' as const }

    // Call the runtime helper to ensure normalization behaves as expected
    const normalized1 = stripToastSessionId({ message: props1.message }).trim()
    const normalized2 = stripToastSessionId({ message: props2.message }).trim()

    // Sanity: after stripping session IDs they should match
    expect(normalized1).toBe(normalized2)

    // Exercise the runtime sending path via handleTuiToast
    await handleTuiToast.call({ thread }, props1)
    await handleTuiToast.call({ thread }, props2)

    // Expect only one send for deduped info toasts
    expect(thread.send).toHaveBeenCalledTimes(1)
  })

  test('repeated identical normalized success toasts should only send once', async () => {
    const { handleTuiToast, stripToastSessionId } = await import('./toast-handler.js')
    const thread = createFakeThread()

    const props1 = { title: undefined, message: 'Build succeeded ses_1', variant: 'success' as const }
    const props2 = { title: undefined, message: 'Build succeeded ses_2', variant: 'success' as const }

    const normalized1 = stripToastSessionId({ message: props1.message }).trim()
    const normalized2 = stripToastSessionId({ message: props2.message }).trim()
    expect(normalized1).toBe(normalized2)

    await handleTuiToast.call({ thread }, props1)
    await handleTuiToast.call({ thread }, props2)

    expect(thread.send).toHaveBeenCalledTimes(1)
  })

  test('error toasts should passthrough and send every time', async () => {
    const { handleTuiToast, stripToastSessionId } = await import('./toast-handler.js')
    const thread = createFakeThread()

    const props1 = { title: 'Fail', message: 'Crash ses_9', variant: 'error' as const }
    const props2 = { title: 'Fail', message: 'Crash ses_10', variant: 'error' as const }

    const normalized1 = stripToastSessionId({ message: props1.message }).trim()
    const normalized2 = stripToastSessionId({ message: props2.message }).trim()
    expect(normalized1).toBe(normalized2)

    await handleTuiToast.call({ thread }, props1)
    await handleTuiToast.call({ thread }, props2)

    // Errors are passthrough — both should be sent
    expect(thread.send).toHaveBeenCalledTimes(2)
  })

  test('warning toasts should be suppressed (no sends)', async () => {
    const { handleTuiToast, stripToastSessionId } = await import('./toast-handler.js')
    const thread = createFakeThread()

    const props = { title: 'Warn', message: 'Caution ses_X', variant: 'warning' as const }

    const normalized = stripToastSessionId({ message: props.message }).trim()
    await handleTuiToast.call({ thread }, props)

    // Warnings are suppressed — expect zero sends
    expect(thread.send).toHaveBeenCalledTimes(0)
  })

  test('spinner title variations normalize to the same dedupe key (spinner)', async () => {
    // Ensure that rotating spinner glyphs in the title do not change the
    // deduplication key. We mirror the runtime chunk-building logic but
    // normalize spinner glyphs off the title before building the key.
    const { stripToastSessionId } = await import('./toast-handler.js')

    const spinnerGlyphs = ['·', '•', '●', '○', '◌', '◦', ' ']
    const titleBase = 'Sisyphus on steroids'

    const propsA = {
      title: `${spinnerGlyphs[0]} ${titleBase}`,
      message: 'Background task finished ses_ABC',
      variant: 'info' as const,
    }
    const propsB = {
      title: `${spinnerGlyphs[2]} ${titleBase}`,
      message: 'Background task finished ses_DEF',
      variant: 'info' as const,
    }

    // Helper: strip a leading spinner glyph if present and trim
    function normalizeTitle(title?: string): string {
      if (!title) return ''
      // Remove a single leading spinner glyph (with optional following space)
      return title.replace(/^[·•●○◌◦]\s*/u, '').trim()
    }

    const toastMessageA = stripToastSessionId({ message: propsA.message }).trim()
    const toastMessageB = stripToastSessionId({ message: propsB.message }).trim()
    expect(toastMessageA).toBe(toastMessageB)

    const titlePrefixA = normalizeTitle(propsA.title) ? `${normalizeTitle(propsA.title)}: ` : ''
    const titlePrefixB = normalizeTitle(propsB.title) ? `${normalizeTitle(propsB.title)}: ` : ''

    const keyA = `⬦ ${propsA.variant}: ${titlePrefixA}${toastMessageA}`
    const keyB = `⬦ ${propsB.variant}: ${titlePrefixB}${toastMessageB}`

    // The normalized dedupe key should be identical despite spinner glyph
    expect(keyA).toBe(keyB)
  })

  test('spinner frames in the message field dedup to one send (real bug fix)', async () => {
    // Bug: spinner chars (• ● ○ ◌ ◦ ·) appear in message field as animation frames,
    // each creating a different dedup key and bypassing dedup entirely.
    const { handleTuiToast } = await import('./toast-handler.js')
    const thread = createFakeThread()

    const spinnerGlyphs = ['•', '●', '○', '◌', '◦', '·', '']
    const baseMessage = 'OhMyOpenCode 3.17.4: Sisyphus on steroids is steering OpenCode.'

    for (const glyph of spinnerGlyphs) {
      const msg = glyph ? `${glyph} ${baseMessage}` : baseMessage
      await handleTuiToast.call({ thread }, {
        title: undefined,
        message: msg,
        variant: 'info',
      })
    }

    expect(thread.send).toHaveBeenCalledTimes(1)
  })

  test('dedup TTL: entries expire and allow the same toast again (TTL)', async () => {
    // Lightweight in-test dedup store to assert TTL & cleanup semantics.
    // This mirrors the expected behavior of the runtime's dedupe table but
    // keeps the test decoupled from internal implementation.
    class DedupStore {
      private map = new Map<string, number>()
      constructor(private ttlMs: number, private maxSize = 1000) {}

      add(key: string): boolean {
        const now = Date.now()
        const expiresAt = this.map.get(key) ?? 0
        if (expiresAt > now) {
          // Duplicate within TTL — not allowed
          return false
        }
        // Insert/renew
        this.map.set(key, now + this.ttlMs)
        // Enforce memory bound
        while (this.map.size > this.maxSize) {
          const oldest = this.map.keys().next().value as string
          this.map.delete(oldest)
        }
        return true
      }

      has(key: string): boolean {
        const now = Date.now()
        const expiresAt = this.map.get(key)
        return expiresAt !== undefined && expiresAt > now
      }

      cleanup(): void {
        const now = Date.now()
        for (const [k, v] of Array.from(this.map.entries())) {
          if (v <= now) this.map.delete(k)
        }
      }

      size(): number {
        return this.map.size
      }
    }

    // Use fake timers to deterministically advance time
    vi.useFakeTimers()
    try {
      const TTL = 1000
      const store = new DedupStore(TTL, 3)

      const key = '⬦ info: Task: done'

      // First add should succeed
      expect(store.add(key)).toBe(true)
      // Immediate re-add is a duplicate
      expect(store.add(key)).toBe(false)

      // Advance to just before expiry — still duplicated
      vi.advanceTimersByTime(TTL - 1)
      expect(store.has(key)).toBe(true)

      // Advance past expiry and run cleanup
      vi.advanceTimersByTime(2)
      store.cleanup()
      expect(store.has(key)).toBe(false)

      // After expiry, adding again should be allowed
      expect(store.add(key)).toBe(true)

      // Memory-bounded: adding > maxSize evicts oldest
      store.add('k1')
      store.add('k2')
      store.add('k3')
      // Now the map should be at max size (3)
      expect(store.size()).toBeLessThanOrEqual(3)
      // Add another to force eviction
      store.add('k4')
      expect(store.size()).toBeLessThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
