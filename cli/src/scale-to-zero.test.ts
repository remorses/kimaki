// Tests for cloud scale-to-zero idle exit and wake-window gating.

import { afterEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_SCALE_TO_ZERO_IDLE_MS,
  attemptScaleToZeroExit,
  isScaleToZeroEnabled,
  parseScaleToZeroIdleMs,
  shouldExitScaleToZero,
} from './scale-to-zero.js'

describe('scale-to-zero', () => {
  afterEach(() => {
    delete process.env['KIMAKI_SCALE_TO_ZERO']
    delete process.env['KIMAKI_SCALE_TO_ZERO_IDLE_MS']
  })

  test('is disabled unless KIMAKI_SCALE_TO_ZERO=1', () => {
    expect(isScaleToZeroEnabled()).toBe(false)
    process.env['KIMAKI_SCALE_TO_ZERO'] = '1'
    expect(isScaleToZeroEnabled()).toBe(true)
    process.env['KIMAKI_SCALE_TO_ZERO'] = '0'
    expect(isScaleToZeroEnabled()).toBe(false)
  })

  test('idle ms defaults to 10 minutes and accepts env override', () => {
    expect(parseScaleToZeroIdleMs()).toBe(DEFAULT_SCALE_TO_ZERO_IDLE_MS)
    process.env['KIMAKI_SCALE_TO_ZERO_IDLE_MS'] = '15000'
    expect(parseScaleToZeroIdleMs()).toBe(15_000)
    process.env['KIMAKI_SCALE_TO_ZERO_IDLE_MS'] = 'nope'
    expect(parseScaleToZeroIdleMs()).toBe(DEFAULT_SCALE_TO_ZERO_IDLE_MS)
  })

  test('does not exit when disabled, busy, or still inside idle window', () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    expect(shouldExitScaleToZero({
      enabled: false,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: null,
      nowMs,
      idleMs,
    })).toBe(false)
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: true,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: null,
      nowMs,
      idleMs,
    })).toBe(false)
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: true,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: null,
      nowMs,
      idleMs,
    })).toBe(false)
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs + 1,
      soonestWakeAtMs: null,
      nowMs,
      idleMs,
    })).toBe(false)
  })

  test('exits after idle timeout when no task is due soon', () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: nowMs + idleMs + 1,
      nowMs,
      idleMs,
    })).toBe(true)
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: null,
      nowMs,
      idleMs,
    })).toBe(true)
  })

  test('stays up when a task or sleep is due inside the idle window', () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: nowMs + idleMs,
      nowMs,
      idleMs,
    })).toBe(false)
    expect(shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: false,
      hasBusyTaskRunner: false,
      lastActivityMs: nowMs - idleMs,
      soonestWakeAtMs: nowMs - 1,
      nowMs,
      idleMs,
    })).toBe(false)
  })

  test('does not exit when alarm sync fails', async () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    let exited = false
    const result = await attemptScaleToZeroExit({
      idleMs,
      startedAtMs: nowMs - idleMs,
      now: () => nowMs,
      getIdleState: () => ({ allIdle: true, lastActivityMs: nowMs - idleMs }),
      getSoonestWakeAt: async () => new Date(nowMs + idleMs + 1),
      isTaskRunnerBusy: () => false,
      syncWakeAt: async () => new Error('website down'),
      exitProcess: async () => {
        exited = true
      },
    })
    expect(result).toBe('stayed')
    expect(exited).toBe(false)
  })

  test('does not exit when work starts during alarm sync', async () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    let idleAfterSync = true
    let exited = false
    const result = await attemptScaleToZeroExit({
      idleMs,
      startedAtMs: nowMs - idleMs,
      now: () => nowMs,
      getIdleState: () => ({
        allIdle: idleAfterSync,
        lastActivityMs: nowMs - idleMs,
      }),
      getSoonestWakeAt: async () => new Date(nowMs + idleMs + 1),
      isTaskRunnerBusy: () => false,
      syncWakeAt: async () => {
        idleAfterSync = false
      },
      exitProcess: async () => {
        exited = true
      },
    })
    expect(result).toBe('stayed')
    expect(exited).toBe(false)
  })

  test('exits after a successful alarm sync when still idle', async () => {
    const nowMs = 1_000_000
    const idleMs = 10 * 60 * 1000
    let exited = false
    const result = await attemptScaleToZeroExit({
      idleMs,
      startedAtMs: nowMs - idleMs,
      now: () => nowMs,
      getIdleState: () => ({ allIdle: true, lastActivityMs: nowMs - idleMs }),
      getSoonestWakeAt: async () => new Date(nowMs + idleMs + 1),
      isTaskRunnerBusy: () => false,
      syncWakeAt: async () => {},
      exitProcess: async () => {
        exited = true
      },
    })
    expect(result).toBe('exited')
    expect(exited).toBe(true)
  })
})
