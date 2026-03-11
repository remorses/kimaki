// Contract tests for direct native method calls emitted by the TS bridge.
// These tests intentionally call the real Zig native module.

import { describe, expect, test } from 'vitest'
import { createBridgeFromNative } from './bridge.js'
import { native } from './native-lib.js'

describe('native bridge contract', () => {
  test('bridge calls hit real Zig module', async () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const bridge = createBridgeFromNative({ nativeModule: native })

    const safeTarget = {
      x: 0,
      y: 0,
    }

    await bridge.click({
      point: safeTarget,
      button: 'left',
      count: 1,
      modifiers: [],
    })
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

    const screenshot = await bridge.screenshot({ path: `${process.cwd()}/tmp/bridge-contract-shot.png` })

    await bridge.typeText({ text: 'h', delayMs: 30 })
    await bridge.press({ key: 'h', count: 1 })
    await expect(bridge.scroll({ direction: 'down', amount: 300 })).rejects.toThrowError('TODO not implemented')
    const displays = await bridge.displayList()
    await expect(bridge.clipboardGet()).rejects.toThrowError('TODO not implemented')
    await expect(bridge.clipboardSet({ text: 'copied' })).rejects.toThrowError('TODO not implemented')

    expect({
      screenshotShape: {
        path: screenshot.path,
        desktopIndex: typeof screenshot.desktopIndex,
        captureX: typeof screenshot.captureX,
        captureY: typeof screenshot.captureY,
        captureWidth: screenshot.captureWidth > 0,
        captureHeight: screenshot.captureHeight > 0,
        imageWidth: screenshot.imageWidth > 0,
        imageHeight: screenshot.imageHeight > 0,
        coordMapHasSixValues: screenshot.coordMap.split(',').length === 6,
        hint: screenshot.hint,
      },
      firstDisplayShape: displays[0]
        ? {
            id: typeof displays[0].id,
            index: typeof displays[0].index,
            width: displays[0].width > 0,
            height: displays[0].height > 0,
          }
        : null,
    }).toMatchInlineSnapshot(`
      {
        "firstDisplayShape": {
          "height": true,
          "id": "number",
          "index": "number",
          "width": true,
        },
        "screenshotShape": {
          "captureHeight": true,
          "captureWidth": true,
          "captureX": "number",
          "captureY": "number",
          "coordMapHasSixValues": true,
          "desktopIndex": "number",
          "hint": "use --coord-map coordmap to use command like click, move etc on the coordinate system of this screenshot",
          "imageHeight": true,
          "imageWidth": true,
          "path": "/Users/morse/Documents/GitHub/kimakivoice/usecomputer/tmp/bridge-contract-shot.png",
        },
      }
    `)

    expect(displays.length).toBeGreaterThan(0)
  })
})
