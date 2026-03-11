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

    await expect(bridge.typeText({ text: 'hello', delayMs: 30 })).rejects.toThrowError('TODO not implemented')
    await expect(bridge.press({ key: 'enter', count: 1 })).rejects.toThrowError('TODO not implemented')
    await expect(bridge.scroll({ direction: 'down', amount: 300 })).rejects.toThrowError('TODO not implemented')
    await expect(bridge.displayList()).rejects.toThrowError('TODO not implemented')
    await expect(bridge.clipboardGet()).rejects.toThrowError('TODO not implemented')
    await expect(bridge.clipboardSet({ text: 'copied' })).rejects.toThrowError('TODO not implemented')

    expect({
      screenshot,
    }).toMatchInlineSnapshot(`
      {
        "screenshot": {
          "path": "/Users/morse/Documents/GitHub/kimakivoice/usecomputer/tmp/bridge-contract-shot.png",
        },
      }
    `)
  })
})
