// Optional host smoke test for direct native mouse methods.

import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { native } from './native-lib.js'

const runNativeSmoke = process.env.USECOMPUTER_NATIVE_SMOKE === '1'

const displayListSchema = z.array(
  z.object({
    id: z.number(),
    index: z.number(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    scale: z.number(),
    isPrimary: z.boolean(),
  }),
)

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
    const typeResponse = native.typeText({ text: 'h', delayMs: 1 })
    const pressResponse = native.press({ key: 'backspace', count: 1, delayMs: 1 })

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

  smokeTest('returns display payload for desktop list command', () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const result = native.displayList()
    expect(result.ok).toBe(true)
    if (!result.ok || !result.data) {
      return
    }

    const parsedJson: unknown = JSON.parse(result.data)
    const parsed = displayListSchema.safeParse(parsedJson)
    expect(parsed.success).toBe(true)
    if (!parsed.success) {
      return
    }

    expect(parsed.data.length).toBeGreaterThan(0)
    expect(parsed.data[0]?.width).toBeGreaterThan(0)
    expect(parsed.data[0]?.height).toBeGreaterThan(0)
  })
})
