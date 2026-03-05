// Runtime/server inactivity sweeper.
// Periodically disposes thread runtimes that stayed idle past a timeout and
// stops OpenCode servers that no longer have active runtimes.

import { createLogger, LogPrefix } from './logger.js'
import {
  disposeInactiveRuntimes,
  getActiveRuntimeProjectDirectories,
} from './session-handler/thread-session-runtime.js'
import { stopOpencodeServersWithoutRuntimeDirectories } from './opencode.js'

const logger = createLogger(LogPrefix.SESSION)

export const DEFAULT_RUNTIME_IDLE_MS = 60 * 60 * 1000
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

export function startRuntimeIdleSweeper({
  runtimeIdleMs = DEFAULT_RUNTIME_IDLE_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
}: {
  runtimeIdleMs?: number
  sweepIntervalMs?: number
} = {}): () => Promise<void> {
  let stopped = false
  let sweeping = false
  let sweepPromise: Promise<void> | null = null

  const sweep = async (): Promise<void> => {
    if (stopped || sweeping) {
      return
    }
    sweeping = true

    const currentSweepPromise = (async () => {
      const nowMs = Date.now()
      const disposeResult = disposeInactiveRuntimes({
        idleMs: runtimeIdleMs,
        nowMs,
      })
      if (disposeResult.disposedThreadIds.length > 0) {
        logger.log(
          `[IDLE SWEEP] Disposed ${disposeResult.disposedThreadIds.length} inactive runtime(s) after ${runtimeIdleMs}ms`,
        )
      }

      const activeDirectories = getActiveRuntimeProjectDirectories()
      const stoppedDirectories = await stopOpencodeServersWithoutRuntimeDirectories({
        activeDirectories,
      })
      if (stoppedDirectories.length > 0) {
        logger.log(
          `[IDLE SWEEP] Stopped ${stoppedDirectories.length} idle opencode server(s) with no active runtimes`,
        )
      }
    })()

    sweepPromise = currentSweepPromise
    await currentSweepPromise.finally(() => {
      sweeping = false
      sweepPromise = null
    })
  }

  const interval = setInterval(() => {
    void sweep()
  }, sweepIntervalMs)

  void sweep()

  logger.log(
    `[IDLE SWEEP] Started (runtimeIdleMs=${runtimeIdleMs}, intervalMs=${sweepIntervalMs})`,
  )

  return async () => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(interval)
    if (sweepPromise) {
      await sweepPromise
      sweepPromise = null
    }
    logger.log('[IDLE SWEEP] Stopped')
  }
}
