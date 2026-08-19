import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRestartSupervisor, RESTART_REQUEST_MESSAGE_TYPE } from './restart-supervisor.js'

class FakeChild extends EventEmitter {
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    return true
  }
}

function createHarness() {
  const children: FakeChild[] = []
  const exitProcess = vi.fn<(code: number) => void>()
  const logError = vi.fn<(message: string) => void>()
  const supervisor = createRestartSupervisor({
    spawnChild: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    exitProcess,
    logError,
    restartDeadlineMs: 1_000,
    restartDelayMs: 100,
  })

  supervisor.start()
  return { children, exitProcess, logError, supervisor }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('restart supervisor', () => {
  test('force-kills and replaces a child stuck after requesting restart', () => {
    vi.useFakeTimers()
    const { children } = createHarness()
    const firstChild = children[0]!

    firstChild.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'gateway-reconnect-limit',
    })
    vi.advanceTimersByTime(1_000)

    expect(firstChild.killSignals).toEqual(['SIGKILL'])

    firstChild.emit('exit', null, 'SIGKILL')
    vi.advanceTimersByTime(99)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(2)
  })

  test('keeps the first deadline when duplicate restart requests arrive', () => {
    vi.useFakeTimers()
    const { children } = createHarness()
    const child = children[0]!

    child.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'gateway-reconnect-limit',
    })
    vi.advanceTimersByTime(750)
    child.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'SIGUSR2',
    })
    vi.advanceTimersByTime(250)

    expect(child.killSignals).toEqual(['SIGKILL'])
  })

  test('clears the deadline when the child exits normally', () => {
    vi.useFakeTimers()
    const { children, exitProcess } = createHarness()
    const child = children[0]!

    child.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'SIGUSR2',
    })
    child.emit('exit', 0, null)
    vi.runAllTimers()

    expect(child.killSignals).toEqual([])
    expect(children).toHaveLength(1)
    expect(exitProcess).toHaveBeenCalledWith(0)
  })

  test('uses normal backoff when a restart-requesting child exits by itself', () => {
    vi.useFakeTimers()
    const { children } = createHarness()
    const firstChild = children[0]!

    firstChild.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'SIGUSR2',
    })
    firstChild.emit('exit', 1, null)
    vi.advanceTimersByTime(100)

    expect(firstChild.killSignals).toEqual([])
    expect(children).toHaveLength(2)
  })

  test('clears the shutdown deadline when external graceful shutdown completes', () => {
    vi.useFakeTimers()
    const { children, exitProcess, supervisor } = createHarness()
    const child = children[0]!

    supervisor.requestShutdown('SIGTERM')
    expect(child.killSignals).toEqual(['SIGTERM'])

    vi.advanceTimersByTime(999)
    child.emit('exit', null, 'SIGTERM')
    vi.advanceTimersByTime(1)

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(children).toHaveLength(1)
    expect(exitProcess).toHaveBeenCalledWith(0)
  })

  test('force-kills a child stuck during external shutdown without respawning', () => {
    vi.useFakeTimers()
    const { children, exitProcess, supervisor } = createHarness()
    const child = children[0]!

    supervisor.requestShutdown('SIGTERM')
    vi.advanceTimersByTime(1_000)

    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])

    child.emit('exit', null, 'SIGKILL')
    vi.runAllTimers()
    expect(children).toHaveLength(1)
    expect(exitProcess).toHaveBeenCalledWith(0)
  })

  test('preserves an armed self-restart deadline when external shutdown arrives', () => {
    vi.useFakeTimers()
    const { children, exitProcess, supervisor } = createHarness()
    const child = children[0]!

    child.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'gateway-reconnect-limit',
    })
    vi.advanceTimersByTime(750)
    supervisor.requestShutdown('SIGTERM')
    vi.advanceTimersByTime(250)

    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])

    child.emit('exit', null, 'SIGKILL')
    vi.runAllTimers()
    expect(children).toHaveLength(1)
    expect(exitProcess).toHaveBeenCalledWith(0)
  })

  test('preserves progressive restart backoff for ordinary crashes', () => {
    vi.useFakeTimers()
    const { children } = createHarness()

    children[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(100)
    expect(children).toHaveLength(2)

    children[1]!.emit('exit', 1, null)
    vi.advanceTimersByTime(199)
    expect(children).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(3)
  })

  test('does not restart after the no-restart exit code', () => {
    vi.useFakeTimers()
    const { children, exitProcess } = createHarness()

    children[0]!.emit('exit', 64, null)
    vi.runAllTimers()

    expect(children).toHaveLength(1)
    expect(exitProcess).toHaveBeenCalledWith(64)
  })

  test('exits after the rapid crash-loop cutoff', () => {
    vi.useFakeTimers()
    const { children, exitProcess } = createHarness()

    for (let index = 0; index < 5; index++) {
      children[index]!.emit('exit', 1, null)
      vi.runOnlyPendingTimers()
    }
    children[5]!.emit('exit', 1, null)

    expect(children).toHaveLength(6)
    expect(exitProcess).toHaveBeenCalledWith(1)
  })

  test('ignores malformed IPC and messages from a stale child generation', () => {
    vi.useFakeTimers()
    const { children } = createHarness()
    const firstChild = children[0]!

    firstChild.emit('message', { type: RESTART_REQUEST_MESSAGE_TYPE })
    vi.advanceTimersByTime(1_000)
    expect(firstChild.killSignals).toEqual([])

    firstChild.emit('exit', 1, null)
    vi.advanceTimersByTime(100)
    firstChild.emit('message', {
      type: RESTART_REQUEST_MESSAGE_TYPE,
      reason: 'stale-generation',
    })
    vi.advanceTimersByTime(1_000)

    expect(firstChild.killSignals).toEqual([])
    expect(children).toHaveLength(2)
  })

  test('forwards SIGUSR signals to the current child', () => {
    const { children, supervisor } = createHarness()

    supervisor.forwardSignal('SIGUSR1')
    supervisor.forwardSignal('SIGUSR2')

    expect(children[0]!.killSignals).toEqual(['SIGUSR1', 'SIGUSR2'])
  })
})
