import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'

export const RESTART_REQUEST_MESSAGE_TYPE = 'kimaki:restart-requested'

export interface RestartRequestMessage {
  type: typeof RESTART_REQUEST_MESSAGE_TYPE
  reason: string
}

export function isRestartRequestMessage(message: unknown): message is RestartRequestMessage {
  if (typeof message !== 'object' || message === null) {
    return false
  }

  const candidate = message as Record<string, unknown>
  return candidate.type === RESTART_REQUEST_MESSAGE_TYPE && typeof candidate.reason === 'string'
}

type SupervisorChild = EventEmitter & Pick<ChildProcess, 'kill'>

interface RestartSupervisorOptions {
  spawnChild: () => SupervisorChild
  exitProcess: (code: number) => void
  logError: (message: string) => void
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  restartDeadlineMs?: number
  restartDelayMs?: number
  rapidRestartWindowMs?: number
  maxRapidRestarts?: number
}

export function createRestartSupervisor({
  spawnChild,
  exitProcess,
  logError,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  restartDeadlineMs = 15_000,
  restartDelayMs = 2_000,
  rapidRestartWindowMs = 60_000,
  maxRapidRestarts = 5,
}: RestartSupervisorOptions) {
  const EXIT_NO_RESTART = 64
  const restartTimestamps: number[] = []
  let child: SupervisorChild | null = null
  let childExitDeadline: ReturnType<typeof setTimeout> | null = null
  let scheduledRestart: ReturnType<typeof setTimeout> | null = null
  let shutdownRequested = false

  function clearChildExitDeadline() {
    if (childExitDeadline) {
      clearTimer(childExitDeadline)
      childExitDeadline = null
    }
  }

  function clearScheduledRestart() {
    if (scheduledRestart) {
      clearTimer(scheduledRestart)
      scheduledRestart = null
    }
  }

  function armChildExitDeadline(currentChild: SupervisorChild, reason: string) {
    if (child !== currentChild || childExitDeadline) {
      return
    }

    // The deadline belongs to this child generation and is never extended.
    // An external shutdown therefore preserves any self-restart countdown
    // that is already in progress.
    logError(`[kimaki] Waiting up to ${restartDeadlineMs / 1000}s for child shutdown (${reason})`)
    childExitDeadline = setTimer(() => {
      childExitDeadline = null
      if (child !== currentChild) {
        return
      }

      logError(
        `[kimaki] Child did not exit within ${restartDeadlineMs / 1000}s (${reason}); force-killing it`,
      )
      currentChild.kill('SIGKILL')
    }, restartDeadlineMs)
    childExitDeadline.unref?.()
  }

  function start() {
    if (shutdownRequested) {
      return
    }

    scheduledRestart = null
    const currentChild = spawnChild()
    child = currentChild

    currentChild.on('message', (message: unknown) => {
      if (shutdownRequested || !isRestartRequestMessage(message)) return
      armChildExitDeadline(currentChild, `restart requested: ${message.reason}`)
    })

    currentChild.on('exit', (code, signal) => {
      if (child !== currentChild) {
        return
      }

      child = null
      clearChildExitDeadline()

      if (code === 0 || code === EXIT_NO_RESTART || shutdownRequested) {
        exitProcess(code ?? 0)
        return
      }

      const timestamp = now()
      restartTimestamps.push(timestamp)
      while (
        restartTimestamps.length > 0 &&
        restartTimestamps[0]! < timestamp - rapidRestartWindowMs
      ) {
        restartTimestamps.shift()
      }

      if (restartTimestamps.length > maxRapidRestarts) {
        logError(
          `[kimaki] Crash loop detected (${maxRapidRestarts} crashes in ${rapidRestartWindowMs / 1000}s), exiting`,
        )
        exitProcess(1)
        return
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`
      const delay = Math.min(restartDelayMs * 2 ** (restartTimestamps.length - 1), 30_000)
      logError(
        `[kimaki] Process exited with ${reason}, restarting in ${(delay / 1000).toFixed(0)}s...`,
      )
      scheduledRestart = setTimer(start, delay)
    })
  }

  function requestShutdown(signal: 'SIGTERM' | 'SIGINT') {
    if (shutdownRequested) {
      return
    }

    shutdownRequested = true
    clearScheduledRestart()
    if (child) {
      armChildExitDeadline(child, `received ${signal}`)
      child.kill(signal)
    } else {
      exitProcess(0)
    }
  }

  function forwardSignal(signal: 'SIGUSR1' | 'SIGUSR2') {
    child?.kill(signal)
  }

  return { forwardSignal, requestShutdown, start }
}
