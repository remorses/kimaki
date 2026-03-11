// Optional host smoke test for the real native click command.

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

    const response = native.execute(
      'click',
      JSON.stringify({
        point: { x: 10, y: 10 },
        button: 'left',
        count: 1,
      }),
    )

    const parsed = JSON.parse(response) as { ok: boolean; data?: null; error?: string }
    expect(parsed).toMatchInlineSnapshot(`
      {
        "data": null,
        "ok": true,
      }
    `)
    expect(typeof parsed.ok).toBe('boolean')
  })

  smokeTest('executes mouse-move/down/up/position/hover/drag without crashing', () => {
    expect(native).toBeTruthy()
    if (!native) {
      return
    }

    const moveResponse = JSON.parse(
      native.execute(
        'mouse-move',
        JSON.stringify({
          x: 20,
          y: 20,
        }),
      ),
    ) as { ok: boolean; data?: null; error?: string }

    const downResponse = JSON.parse(
      native.execute('mouse-down', JSON.stringify({ button: 'left' })),
    ) as { ok: boolean; data?: null; error?: string }

    const upResponse = JSON.parse(
      native.execute('mouse-up', JSON.stringify({ button: 'left' })),
    ) as { ok: boolean; data?: null; error?: string }

    const positionResponse = JSON.parse(
      native.execute('mouse-position', JSON.stringify({})),
    ) as { ok: boolean; data?: { x: number; y: number }; error?: string }

    const hoverResponse = JSON.parse(
      native.execute(
        'hover',
        JSON.stringify({
          x: 24,
          y: 24,
        }),
      ),
    ) as { ok: boolean; data?: null; error?: string }

    const dragResponse = JSON.parse(
      native.execute(
        'drag',
        JSON.stringify({
          from: { x: 24, y: 24 },
          to: { x: 30, y: 30 },
          button: 'left',
          durationMs: 10,
        }),
      ),
    ) as { ok: boolean; data?: null; error?: string }

    expect({
      moveResponse,
      downResponse,
      upResponse,
      positionResponse,
      hoverResponse,
      dragResponse,
    }).toMatchInlineSnapshot(`
      {
        "downResponse": {
          "data": null,
          "ok": true,
        },
        "dragResponse": {
          "data": null,
          "ok": true,
        },
        "hoverResponse": {
          "data": null,
          "ok": true,
        },
        "moveResponse": {
          "data": null,
          "ok": true,
        },
        "positionResponse": {
          "data": {
            "x": 20,
            "y": 20,
          },
          "ok": true,
        },
        "upResponse": {
          "data": null,
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
  })
})
