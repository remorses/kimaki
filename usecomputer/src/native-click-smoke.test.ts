// Optional host smoke test for direct native mouse methods.

import { describe, expect, test } from 'vitest'
import { native } from './native-lib.js'

const runNativeSmoke = process.env.USECOMPUTER_NATIVE_SMOKE === '1'

describe('native click smoke', () => {
  const smokeTest = runNativeSmoke ? test : test.skip

  smokeTest('executes click command without crashing', () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const response = native.click({
      point: { x: 10, y: 10 },
      button: 'left',
      count: 1,
    })

    expect(response).toMatchInlineSnapshot(`
      {
        "error": null,
        "ok": true,
      }
    `)
    expect(response.ok).toBe(true)
  })

  smokeTest('executes mouse-move/down/up/position/hover/drag without crashing', () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const moveResponse = native.mouseMove({ x: 0, y: 0 })
    const downResponse = native.mouseDown({ button: 'left' })
    const upResponse = native.mouseUp({ button: 'left' })
    const positionResponse = native.mousePosition()
    const hoverResponse = native.hover({ x: 0, y: 0 })
    const dragResponse = native.drag({
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      button: 'left',
      durationMs: 10,
    })
    const typeResponse = native.typeText({ text: 'hello', delayMs: 1 })
    const pressResponse = native.press({ key: 'enter', count: 1, delayMs: 1 })

    expect({
      moveResponse,
      downResponse,
      upResponse,
      positionResponse,
      hoverResponse,
      dragResponse,
      typeResponse,
      pressResponse,
    }).toMatchInlineSnapshot(`
      {
        "downResponse": {
          "error": null,
          "ok": true,
        },
        "dragResponse": {
          "error": null,
          "ok": true,
        },
        "hoverResponse": {
          "error": null,
          "ok": true,
        },
        "moveResponse": {
          "error": null,
          "ok": true,
        },
        "positionResponse": {
          "data": {
            "x": 0,
            "y": 0,
          },
          "error": null,
          "ok": true,
        },
        "pressResponse": {
          "error": null,
          "ok": true,
        },
        "typeResponse": {
          "error": null,
          "ok": true,
        },
        "upResponse": {
          "error": null,
          "ok": true,
        },
      }
    `)
    expect(moveResponse.ok).toBe(true)
    expect(downResponse.ok).toBe(true)
    expect(upResponse.ok).toBe(true)
    expect(positionResponse.ok).toBe(true)
    expect(hoverResponse.ok).toBe(true)
    expect(dragResponse.ok).toBe(true)
    expect(typeResponse.ok).toBe(true)
    expect(pressResponse.ok).toBe(true)
  })

  smokeTest('returns structured TODO error objects for unimplemented commands', () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const result = native.displayList()
    expect(result).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "TODO_NOT_IMPLEMENTED",
          "command": "display-list",
          "message": "TODO not implemented",
        },
        "ok": false,
      }
    `)
    expect(result.ok).toBe(false)
  })
})
