// Validates screenshot coord-map parsing and reverse mapping edge cases.

import { describe, expect, test } from 'vitest'
import { mapPointFromCoordMap, parseCoordMapOrThrow } from './cli.js'

describe('coord-map reverse mapping', () => {
  test('maps full-display scaled screenshot coordinates to desktop coordinates', () => {
    const coordMap = parseCoordMapOrThrow('0,0,1600,900,1568,882')

    const mapped = [
      mapPointFromCoordMap({ point: { x: 0, y: 0 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 1567, y: 881 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 784, y: 441 }, coordMap }),
    ]

    expect(mapped).toMatchInlineSnapshot(`
      [
        {
          "x": 0,
          "y": 0,
        },
        {
          "x": 1599,
          "y": 899,
        },
        {
          "x": 800,
          "y": 450,
        },
      ]
    `)
  })

  test('maps correctly when display origin is non-zero', () => {
    const coordMap = parseCoordMapOrThrow('-1728,120,1728,1117,1568,1014')

    const mapped = [
      mapPointFromCoordMap({ point: { x: 0, y: 0 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 1567, y: 1013 }, coordMap }),
    ]

    expect(mapped).toMatchInlineSnapshot(`
      [
        {
          "x": -1728,
          "y": 120,
        },
        {
          "x": -1,
          "y": 1236,
        },
      ]
    `)
  })

  test('maps region capture coordinates including display offset', () => {
    const coordMap = parseCoordMapOrThrow('2200,80,640,360,640,360')

    const mapped = [
      mapPointFromCoordMap({ point: { x: 0, y: 0 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 639, y: 359 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 320, y: 180 }, coordMap }),
    ]

    expect(mapped).toMatchInlineSnapshot(`
      [
        {
          "x": 2200,
          "y": 80,
        },
        {
          "x": 2839,
          "y": 439,
        },
        {
          "x": 2520,
          "y": 260,
        },
      ]
    `)
  })

  test('clamps out-of-bounds screenshot coordinates to capture bounds', () => {
    const coordMap = parseCoordMapOrThrow('500,400,300,200,150,100')

    const mapped = [
      mapPointFromCoordMap({ point: { x: -10, y: -20 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 150, y: 100 }, coordMap }),
      mapPointFromCoordMap({ point: { x: 200, y: 1000 }, coordMap }),
    ]

    expect(mapped).toMatchInlineSnapshot(`
      [
        {
          "x": 500,
          "y": 400,
        },
        {
          "x": 799,
          "y": 599,
        },
        {
          "x": 799,
          "y": 599,
        },
      ]
    `)
  })

  test('rejects invalid coord-map payloads', () => {
    expect(() => {
      parseCoordMapOrThrow('0,0,10,10,20')
    }).toThrowError('Option --coord-map must be x,y,width,height,imageWidth,imageHeight')

    expect(() => {
      parseCoordMapOrThrow('0,0,0,10,20,20')
    }).toThrowError('Option --coord-map must have positive width and height values')
  })
})
