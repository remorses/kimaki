import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import {
  buildNoVncUrl,
  createScreenshareTunnelId,
  detectDisplayServer,
  detectWaylandCompositor,
  spawnWaylandVncGnome,
  spawnWaylandVncWlroots,
} from './screenshare.js'

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
      buildNoVncUrl({ tunnelHost: '0123456789abcdef-tunnel.kimaki.dev' }),
    )

    expect(url.origin).toBe('https://novnc.com')
    expect(url.searchParams.get('host')).toBe(
      '0123456789abcdef-tunnel.kimaki.dev',
    )
    expect(url.searchParams.get('port')).toBe('443')
    expect(url.searchParams.get('encrypt')).toBe('1')
  })
})

describe('display server detection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env['DISPLAY']
    delete process.env['WAYLAND_DISPLAY']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('detects X11 when DISPLAY is set', () => {
    process.env['DISPLAY'] = ':0'
    expect(detectDisplayServer()).toBe('x11')
  })

  test('detects Wayland when WAYLAND_DISPLAY is set', () => {
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    expect(detectDisplayServer()).toBe('wayland')
  })

  test('prefers Wayland when both are set', () => {
    process.env['DISPLAY'] = ':0'
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    expect(detectDisplayServer()).toBe('wayland')
  })

  test('returns unknown when neither is set', () => {
    expect(detectDisplayServer()).toBe('unknown')
  })
})

describe('Wayland compositor detection', () => {
  test('detects GNOME from ps output', async () => {
    const { execAsync } = await import('../worktrees.js')
    vi.mocked(execAsync).mockResolvedValue({
      stdout: 'user 1234 0.0 0.1 gnome-shell --session',
      stderr: '',
    })
    expect(await detectWaylandCompositor()).toBe('gnome')
  })

  test('detects Sway from ps output', async () => {
    const { execAsync } = await import('../worktrees.js')
    vi.mocked(execAsync).mockResolvedValue({
      stdout: 'user 1234 0.0 0.1 sway --config /etc/sway/config',
      stderr: '',
    })
    expect(await detectWaylandCompositor()).toBe('wlroots')
  })

  test('detects River from ps output', async () => {
    const { execAsync } = await import('../worktrees.js')
    vi.mocked(execAsync).mockResolvedValue({
      stdout: 'user 1234 0.0 0.1 river',
      stderr: '',
    })
    expect(await detectWaylandCompositor()).toBe('wlroots')
  })

  test('returns unknown for unrecognized compositor', async () => {
    const { execAsync } = await import('../worktrees.js')
    vi.mocked(execAsync).mockResolvedValue({
      stdout: 'user 1234 0.0 0.1 some-other-compositor',
      stderr: '',
    })
    expect(await detectWaylandCompositor()).toBe('unknown')
  })

  test('returns unknown when ps fails', async () => {
    const { execAsync } = await import('../worktrees.js')
    vi.mocked(execAsync).mockRejectedValue(new Error('command not found'))
    expect(await detectWaylandCompositor()).toBe('unknown')
  })
})

describe('Wayland VNC spawn functions', () => {
  test('spawnWaylandVncGnome spawns w0vncserver with correct args', () => {
    const proc = spawnWaylandVncGnome()
    expect(proc.spawnfile).toBe('w0vncserver')
    expect(proc.spawnargs).toContain('-SecurityTypes')
    expect(proc.spawnargs).toContain('None')
    expect(proc.spawnargs).toContain('-localhost')
    expect(proc.spawnargs).toContain('-rfbport')
    expect(proc.spawnargs).toContain('5900')
    proc.kill()
  })

  test('spawnWaylandVncWlroots spawns wayvnc with correct args', () => {
    const proc = spawnWaylandVncWlroots()
    expect(proc.spawnfile).toBe('wayvnc')
    expect(proc.spawnargs).toContain('localhost')
    expect(proc.spawnargs).toContain('5900')
    proc.kill()
  })
})
