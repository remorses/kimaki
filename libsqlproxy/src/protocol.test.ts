import { describe, test, expect } from 'vitest'
import { evaluateHranaCondition } from './protocol.ts'
import type { HranaExecuteResult, HranaError } from './types.ts'

const okResult: HranaExecuteResult = {
  cols: [],
  rows: [],
  affected_row_count: 0,
  last_insert_rowid: null,
}

const err: HranaError = { message: 'fail', code: 'SQLITE_ERROR' }

describe('evaluateHranaCondition', () => {
  test('null condition returns true', () => {
    expect(evaluateHranaCondition(null, [], [])).toBe(true)
  })

  test('ok — step succeeded', () => {
    expect(evaluateHranaCondition(
      { type: 'ok', step: 0 },
      [okResult],
      [null],
    )).toBe(true)
  })

  test('ok — step failed', () => {
    expect(evaluateHranaCondition(
      { type: 'ok', step: 0 },
      [null],
      [err],
    )).toBe(false)
  })

  test('not — inverts ok', () => {
    expect(evaluateHranaCondition(
      { type: 'not', cond: { type: 'ok', step: 0 } },
      [null],
      [err],
    )).toBe(true)
  })

  test('and — all true', () => {
    expect(evaluateHranaCondition(
      {
        type: 'and',
        conds: [
          { type: 'ok', step: 0 },
          { type: 'ok', step: 1 },
        ],
      },
      [okResult, okResult],
      [null, null],
    )).toBe(true)
  })

  test('and — one false', () => {
    expect(evaluateHranaCondition(
      {
        type: 'and',
        conds: [
          { type: 'ok', step: 0 },
          { type: 'ok', step: 1 },
        ],
      },
      [okResult, null],
      [null, err],
    )).toBe(false)
  })

  test('or — one true', () => {
    expect(evaluateHranaCondition(
      {
        type: 'or',
        conds: [
          { type: 'ok', step: 0 },
          { type: 'ok', step: 1 },
        ],
      },
      [null, okResult],
      [err, null],
    )).toBe(true)
  })

  test('or — all false', () => {
    expect(evaluateHranaCondition(
      {
        type: 'or',
        conds: [
          { type: 'ok', step: 0 },
          { type: 'ok', step: 1 },
        ],
      },
      [null, null],
      [err, err],
    )).toBe(false)
  })

  test('error — step errored', () => {
    expect(evaluateHranaCondition(
      { type: 'error', step: 0 },
      [null],
      [err],
    )).toBe(true)
  })

  test('error — step succeeded', () => {
    expect(evaluateHranaCondition(
      { type: 'error', step: 0 },
      [okResult],
      [null],
    )).toBe(false)
  })

  test('is_autocommit returns protocol error', () => {
    const result = evaluateHranaCondition(
      { type: 'is_autocommit' },
      [],
      [],
    )
    expect(result).toEqual({
      message: 'is_autocommit condition is not supported',
      code: 'HRANA_PROTO_ERROR',
    })
  })

  test('unknown condition type returns protocol error', () => {
    const result = evaluateHranaCondition(
      { type: 'bogus' as 'ok' },
      [],
      [],
    )
    expect(result).toEqual({
      message: 'Unknown condition type: bogus',
      code: 'HRANA_PROTO_ERROR',
    })
  })
})
