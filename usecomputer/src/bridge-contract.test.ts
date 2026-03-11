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
    await bridge.press({ key: 'backspace', count: 1 })
    const scrollResult = await bridge.scroll({ direction: 'down', amount: 1 }).then(
      () => {
        return 'ok'
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error)
      },
    )
    const scrollAtResult = await bridge.scroll({ direction: 'right', amount: 1, at: safeTarget }).then(
      () => {
        return 'ok'
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error)
      },
    )
    const displays = await bridge.displayList()
    const windows = await bridge.windowList()
    const clipboardGetResult = await bridge.clipboardGet().then(
      () => {
        return 'ok'
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error)
      },
    )
    const clipboardSetResult = await bridge.clipboardSet({ text: 'copied' }).then(
      () => {
        return 'ok'
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error)
      },
    )
    const isOkOrTodo = ({ value }: { value: string }): boolean => {
      return value === 'ok' || value.includes('TODO not implemented')
    }

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
      firstWindowShape: windows[0]
        ? {
            id: typeof windows[0].id,
            ownerName: typeof windows[0].ownerName,
            desktopIndex: typeof windows[0].desktopIndex,
          }
        : null,
      optionalCommandOutcomes: {
        scrollResult: isOkOrTodo({ value: scrollResult }),
        scrollAtResult: isOkOrTodo({ value: scrollAtResult }),
        clipboardGetResult: isOkOrTodo({ value: clipboardGetResult }),
        clipboardSetResult: isOkOrTodo({ value: clipboardSetResult }),
      },
    }).toMatchInlineSnapshot(`
      {
        "firstDisplayShape": {
          "height": true,
          "id": "number",
          "index": "number",
          "width": true,
        },
        "firstWindowShape": {
          "desktopIndex": "number",
          "id": "number",
          "ownerName": "string",
        },
        "optionalCommandOutcomes": {
          "clipboardGetResult": true,
          "clipboardSetResult": true,
          "scrollAtResult": true,
          "scrollResult": true,
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
    expect(windows.length).toBeGreaterThan(0)
  })
})
