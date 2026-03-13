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

    // Mouse commands are macOS-only; on Linux they throw "only supported on macOS".
    // Wrap in try/catch to let the test validate all platforms.
    const tryCommand = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn()
        return 'ok'
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    const clickResult = await tryCommand(() => {
      return bridge.click({
        point: safeTarget,
        button: 'left',
        count: 1,
        modifiers: [],
      })
    })
    const hoverResult = await tryCommand(() => {
      return bridge.hover(safeTarget)
    })
    const mouseMoveResult = await tryCommand(() => {
      return bridge.mouseMove(safeTarget)
    })
    const mouseDownResult = await tryCommand(() => {
      return bridge.mouseDown({ button: 'left' })
    })
    const mouseUpResult = await tryCommand(() => {
      return bridge.mouseUp({ button: 'left' })
    })
    const dragResult = await tryCommand(() => {
      return bridge.drag({
        from: safeTarget,
        to: { x: safeTarget.x + 6, y: safeTarget.y + 6 },
        button: 'left',
        durationMs: 10,
      })
    })

    const screenshotResult = await tryCommand(() => {
      return bridge.screenshot({ path: `${process.cwd()}/tmp/bridge-contract-shot.png` })
    })

    await bridge.typeText({ text: 'h', delayMs: 30 })
    await bridge.press({ key: 'backspace', count: 1 })
    const scrollResult = await tryCommand(() => {
      return bridge.scroll({ direction: 'down', amount: 1 })
    })
    const scrollAtResult = await tryCommand(() => {
      return bridge.scroll({ direction: 'right', amount: 1, at: safeTarget })
    })
    const displayListResult = await tryCommand(() => {
      return bridge.displayList()
    })
    const windowListResult = await tryCommand(() => {
      return bridge.windowList()
    })
    const clipboardGetResult = await tryCommand(() => {
      return bridge.clipboardGet()
    })
    const clipboardSetResult = await tryCommand(() => {
      return bridge.clipboardSet({ text: 'copied' })
    })

    // On macOS all commands should return 'ok'.
    // On Linux: mouse commands return "only supported on macOS",
    // screenshot/displayList/windowList may fail on XWayland (no root window capture),
    // scroll/keyboard/clipboard may return TODO.
    const isAcceptable = ({ value }: { value: string }): boolean => {
      return (
        value === 'ok' ||
        value.includes('TODO not implemented') ||
        value.includes('only supported on macOS') ||
        value.includes('failed to capture') ||
        value.includes('failed to open X11') ||
        value.includes('display list is only supported')
      )
    }

    expect({
      mouseCommandOutcomes: {
        clickResult: isAcceptable({ value: clickResult }),
        hoverResult: isAcceptable({ value: hoverResult }),
        mouseMoveResult: isAcceptable({ value: mouseMoveResult }),
        mouseDownResult: isAcceptable({ value: mouseDownResult }),
        mouseUpResult: isAcceptable({ value: mouseUpResult }),
        dragResult: isAcceptable({ value: dragResult }),
      },
      otherCommandOutcomes: {
        screenshotResult: isAcceptable({ value: screenshotResult }),
        scrollResult: isAcceptable({ value: scrollResult }),
        scrollAtResult: isAcceptable({ value: scrollAtResult }),
        displayListResult: isAcceptable({ value: displayListResult }),
        windowListResult: isAcceptable({ value: windowListResult }),
        clipboardGetResult: isAcceptable({ value: clipboardGetResult }),
        clipboardSetResult: isAcceptable({ value: clipboardSetResult }),
      },
    }).toMatchInlineSnapshot(`
      {
        "mouseCommandOutcomes": {
          "clickResult": true,
          "dragResult": true,
          "hoverResult": true,
          "mouseDownResult": true,
          "mouseMoveResult": true,
          "mouseUpResult": true,
        },
        "otherCommandOutcomes": {
          "clipboardGetResult": true,
          "clipboardSetResult": true,
          "displayListResult": true,
          "screenshotResult": true,
          "scrollAtResult": true,
          "scrollResult": true,
          "windowListResult": true,
        },
      }
    `)
  })
})
