// Contract tests for direct native method calls emitted by the TS bridge.
// These tests intentionally call the real Zig native module.

import fs from 'node:fs'
import os from 'node:os'
import { describe, expect, test } from 'vitest'
import { createBridgeFromNative } from './bridge.js'
import { native } from './native-lib.js'

const isMacOS = os.platform() === 'darwin'

describe('native bridge contract', () => {
  test('bridge calls hit real Zig module', async () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const bridge = createBridgeFromNative({ nativeModule: native })

    const safeTarget = { x: 0, y: 0 }

    // -- Mouse commands --
    await bridge.click({ point: safeTarget, button: 'left', count: 1, modifiers: [] })
    await bridge.hover(safeTarget)
    await bridge.mouseMove(safeTarget)
    await bridge.mouseDown({ button: 'left' })
    await bridge.mouseUp({ button: 'left' })
    await bridge.drag({
      from: safeTarget,
      to: { x: safeTarget.x + 6, y: safeTarget.y + 6 },
      button: 'left',
      durationMs: 10,
    })

    // -- Screenshot --
    const screenshotPath = `${process.cwd()}/tmp/bridge-contract-shot.png`
    const shot = await bridge.screenshot({ path: screenshotPath })
    expect(shot.captureWidth).toBeGreaterThan(0)
    expect(shot.captureHeight).toBeGreaterThan(0)
    expect(shot.imageWidth).toBeGreaterThan(0)
    expect(shot.imageHeight).toBeGreaterThan(0)
    expect(shot.coordMap.split(',').length).toBe(6)
    expect(shot.hint).toContain('--coord-map')
    expect(fs.existsSync(screenshotPath)).toBe(true)
    const stat = fs.statSync(screenshotPath)
    expect(stat.size).toBeGreaterThan(100)

    // -- Keyboard (works on both platforms) --
    await bridge.typeText({ text: 'h', delayMs: 30 })
    await bridge.press({ key: 'backspace', count: 1 })

    // -- Scroll --
    await bridge.scroll({ direction: 'down', amount: 1 })
    await bridge.scroll({ direction: 'right', amount: 1, at: safeTarget })

    // -- Display list --
    const displayList = await bridge.displayList()
    expect(displayList.length).toBeGreaterThan(0)
    const firstDisplay = displayList[0]!
    expect(firstDisplay.width).toBeGreaterThan(0)
    expect(firstDisplay.height).toBeGreaterThan(0)
    expect(typeof firstDisplay.id).toBe('number')
    expect(typeof firstDisplay.index).toBe('number')

    // -- Window list --
    if (isMacOS) {
      const windowList = await bridge.windowList()
      expect(windowList.length).toBeGreaterThan(0)
      const firstWindow = windowList[0]!
      expect(typeof firstWindow.id).toBe('number')
      expect(typeof firstWindow.ownerName).toBe('string')
      expect(typeof firstWindow.desktopIndex).toBe('number')
    }

    // -- Clipboard (TODO on all platforms — Zig returns "TODO not implemented") --
    await expect(bridge.clipboardSet({ text: 'bridge-contract-test' })).rejects.toThrow('TODO not implemented')
    await expect(bridge.clipboardGet()).rejects.toThrow('TODO not implemented')
  })
})
