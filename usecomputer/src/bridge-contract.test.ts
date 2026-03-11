// Contract tests for command names and payloads emitted to the native bridge.

import { describe, expect, test } from 'vitest'
import { createBridgeFromNative } from './bridge.js'
import type { NativeModule } from './native-lib.js'

type Call = {
  command: string
  payload: unknown
}

function createFakeNative({ calls }: { calls: Call[] }): NativeModule {
  return {
    execute(command: string, payloadJson: string): string {
      const payload = JSON.parse(payloadJson) as unknown
      calls.push({ command, payload })
      if (command === 'mouse-position') {
        return JSON.stringify({ ok: true, data: { x: 10, y: 20 } })
      }
      if (command === 'display-list') {
        return JSON.stringify({
          ok: true,
          data: [
            { id: 1, name: 'Built-in', x: 0, y: 0, width: 1512, height: 982, scale: 2, isPrimary: true },
          ],
        })
      }
      if (command === 'clipboard-get') {
        return JSON.stringify({ ok: true, data: { text: 'hello' } })
      }
      if (command === 'screenshot') {
        return JSON.stringify({ ok: true, data: { path: '/tmp/test.png' } })
      }
      return JSON.stringify({ ok: true, data: null })
    },
  }
}

describe('native bridge contract', () => {
  test('maps high-level calls to native commands', async () => {
    const calls: Call[] = []
    const bridge = createBridgeFromNative({ nativeModule: createFakeNative({ calls }) })

    await bridge.click({
      point: { x: 100, y: 200 },
      button: 'left',
      count: 2,
      modifiers: ['cmd'],
    })
    await bridge.typeText({ text: 'hello', delayMs: 30 })
    await bridge.press({ key: 'enter', count: 1 })
    await bridge.scroll({ direction: 'down', amount: 300 })
    await bridge.drag({ from: { x: 10, y: 10 }, to: { x: 200, y: 120 }, button: 'left' })
    await bridge.hover({ x: 33, y: 44 })
    await bridge.mouseMove({ x: 60, y: 70 })
    await bridge.mouseDown({ button: 'left' })
    await bridge.mouseUp({ button: 'left' })
    await bridge.mousePosition()
    await bridge.displayList()
    await bridge.clipboardGet()
    await bridge.clipboardSet({ text: 'copied' })
    await bridge.screenshot({ path: './out.png' })

    expect(calls.map((call) => {
      return call.command
    })).toMatchInlineSnapshot(`
      [
        "click",
        "type-text",
        "press",
        "scroll",
        "drag",
        "hover",
        "mouse-move",
        "mouse-down",
        "mouse-up",
        "mouse-position",
        "display-list",
        "clipboard-get",
        "clipboard-set",
        "screenshot",
      ]
    `)
  })
})
