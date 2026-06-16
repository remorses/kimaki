import { describe, test, expect } from 'vitest'
import { encodeHranaValue, decodeHranaValue, decodeHranaParams } from './values.ts'

describe('encodeHranaValue', () => {
  test('null', () => {
    expect(encodeHranaValue(null)).toMatchInlineSnapshot(`
      {
        "type": "null",
      }
    `)
  })

  test('undefined', () => {
    expect(encodeHranaValue(undefined)).toMatchInlineSnapshot(`
      {
        "type": "null",
      }
    `)
  })

  test('integer', () => {
    expect(encodeHranaValue(42)).toMatchInlineSnapshot(`
      {
        "type": "integer",
        "value": "42",
      }
    `)
  })

  test('float', () => {
    expect(encodeHranaValue(3.14)).toMatchInlineSnapshot(`
      {
        "type": "float",
        "value": 3.14,
      }
    `)
  })

  test('bigint', () => {
    expect(encodeHranaValue(BigInt('9007199254740993'))).toMatchInlineSnapshot(`
      {
        "type": "integer",
        "value": "9007199254740993",
      }
    `)
  })

  test('string', () => {
    expect(encodeHranaValue('hello')).toMatchInlineSnapshot(`
      {
        "type": "text",
        "value": "hello",
      }
    `)
  })

  test('Uint8Array', () => {
    const result = encodeHranaValue(new Uint8Array([1, 2, 3]))
    expect(result.type).toBe('blob')
    expect((result as { base64: string }).base64).toBe('AQID')
  })
})

describe('decodeHranaValue', () => {
  test('null', () => {
    expect(decodeHranaValue({ type: 'null' })).toBe(null)
  })

  test('safe integer', () => {
    expect(decodeHranaValue({ type: 'integer', value: '42' })).toBe(42)
  })

  test('unsafe integer returns bigint', () => {
    const result = decodeHranaValue({ type: 'integer', value: '9007199254740993' })
    expect(typeof result).toBe('bigint')
    expect(result).toBe(BigInt('9007199254740993'))
  })

  test('float', () => {
    expect(decodeHranaValue({ type: 'float', value: 3.14 })).toBe(3.14)
  })

  test('text', () => {
    expect(decodeHranaValue({ type: 'text', value: 'hello' })).toBe('hello')
  })

  test('blob roundtrip', () => {
    const original = new Uint8Array([1, 2, 3])
    const encoded = encodeHranaValue(original) as { type: 'blob'; base64: string }
    const decoded = decodeHranaValue(encoded)
    expect(decoded).toEqual(original)
  })
})

describe('decodeHranaParams', () => {
  test('positional args', () => {
    expect(decodeHranaParams({
      args: [
        { type: 'integer', value: '1' },
        { type: 'text', value: 'alice' },
      ],
    })).toMatchInlineSnapshot(`
      [
        1,
        "alice",
      ]
    `)
  })

  test('named args', () => {
    expect(decodeHranaParams({
      named_args: [
        { name: 'id', value: { type: 'integer', value: '1' } },
        { name: 'name', value: { type: 'text', value: 'alice' } },
      ],
    })).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "name": "alice",
        },
      ]
    `)
  })

  test('no args', () => {
    expect(decodeHranaParams({})).toMatchInlineSnapshot(`[]`)
  })
})
