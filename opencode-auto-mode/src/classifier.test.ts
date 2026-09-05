import { describe, expect, test } from 'vitest'
import { parseDetailedDecision, parseFastDecision } from './classifier.ts'

describe('parseFastDecision', () => {
  test('accepts 0 and 1 only', () => {
    expect(parseFastDecision('0')).toBe('allow')
    expect(parseFastDecision('1\n')).toBe('review')
    expect(parseFastDecision('YES')).toBe('invalid')
    expect(parseFastDecision('0 extra')).toBe('invalid')
  })
})

describe('parseDetailedDecision', () => {
  test('accepts exact json', () => {
    expect(parseDetailedDecision('{"decision":"allow","reason":"read only"}')).toEqual({
      decision: 'allow',
      reason: 'read only',
    })
    expect(parseDetailedDecision('{"decision":"block","reason":"force push"}')).toEqual({
      decision: 'block',
      reason: 'force push',
    })
  })

  test('fails closed on extra keys or wrappers', () => {
    expect(parseDetailedDecision('{"decision":"allow","reason":"ok","extra":true}')).toBeUndefined()
    expect(parseDetailedDecision('```json\n{"decision":"allow","reason":"ok"}\n```')).toBeUndefined()
    expect(parseDetailedDecision('{"shouldBlock":true}')).toBeUndefined()
  })
})
