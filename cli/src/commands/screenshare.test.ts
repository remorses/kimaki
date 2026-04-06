import { describe, expect, test } from 'vitest'
import { buildNoVncUrl, createScreenshareTunnelId } from './screenshare.js'

describe('screenshare security defaults', () => {
  test('generates a 128-bit tunnel id', () => {
    const ids = new Set(
      Array.from({ length: 32 }, () => {
        return createScreenshareTunnelId()
      }),
    )

    expect(ids.size).toBe(32)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  test('builds a secure noVNC URL', () => {
    const url = new URL(
      buildNoVncUrl({ tunnelHost: '0123456789abcdef-tunnel.kimaki.xyz' }),
    )

    expect(url.origin).toBe('https://novnc.com')
    expect(url.searchParams.get('host')).toBe(
      '0123456789abcdef-tunnel.kimaki.xyz',
    )
    expect(url.searchParams.get('port')).toBe('443')
    expect(url.searchParams.get('encrypt')).toBe('1')
  })
})
