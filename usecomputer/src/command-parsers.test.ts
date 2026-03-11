// Tests for parsing coordinates, regions, directions, and keyboard modifiers.

import { describe, expect, test } from 'vitest'
import { parseDirection, parseModifiers, parsePoint, parseRegion } from './command-parsers.js'

describe('command parsers', () => {
  test('parses x,y points', () => {
    const result = parsePoint('100,200')
    expect(result).toMatchInlineSnapshot(`
      {
        "x": 100,
        "y": 200,
      }
    `)
  })

  test('rejects invalid points', () => {
    const result = parsePoint('100')
    expect(result instanceof Error).toBe(true)
    expect(result instanceof Error ? result.message : '').toMatchInlineSnapshot(`"Invalid point "100". Expected x,y"`)
  })

  test('parses x,y,width,height regions', () => {
    const result = parseRegion('10,20,300,400')
    expect(result).toMatchInlineSnapshot(`
      {
        "height": 400,
        "width": 300,
        "x": 10,
        "y": 20,
      }
    `)
  })

  test('parses modifiers with normalization', () => {
    expect(parseModifiers(' CMD,shift, alt ')).toMatchInlineSnapshot(`
      [
        "cmd",
        "shift",
        "alt",
      ]
    `)
  })

  test('validates scroll direction', () => {
    expect(parseDirection('down')).toBe('down')
    const invalid = parseDirection('diagonal')
    expect(invalid instanceof Error).toBe(true)
  })
})
