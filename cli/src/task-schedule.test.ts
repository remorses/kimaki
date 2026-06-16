// Tests for scheduled task date/cron parsing and UTC validation rules.

import { describe, expect, test } from 'vitest'
import { parseSendAtValue } from './task-schedule.js'

describe('parseSendAtValue', () => {
  test('accepts UTC ISO date ending with Z', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00Z',
      now,
      timezone: 'UTC',
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) {
      throw result
    }

    expect(result.scheduleKind).toBe('at')
    expect(result.runAt?.toISOString()).toBe('2026-03-01T09:00:00.000Z')
    expect(result.nextRunAt.toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })

  test('rejects ISO date with non-UTC offset', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00+01:00',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be UTC ISO format ending with Z')
    }
  })

  test('rejects local ISO date without timezone suffix', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be UTC ISO format ending with Z')
    }
  })

  test('rejects UTC dates in the past', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-02-22T12:59:59Z',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be in the future (UTC)')
    }
  })

  test('accepts cron expressions', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '0 9 * * 1',
      now,
      timezone: 'UTC',
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) {
      throw result
    }

    expect(result.scheduleKind).toBe('cron')
    expect(result.cronExpr).toBe('0 9 * * 1')
    expect(result.nextRunAt.toISOString()).toBe('2026-02-23T09:00:00.000Z')
  })
})
