// Respawn wrapper for the kimaki bot process.
// When running the default command (no subcommand) with --auto-restart,
// spawns cli.js as a child process and restarts it on non-zero exit codes
// (crash, OOM kill, etc). Intentional exits (code 0 or EXIT_NO_RESTART=64)
// are not restarted.
//
// Subcommands (send, tunnel, project, etc.) run directly without the wrapper
// since they are short-lived and don't need crash recovery.
//
// When __KIMAKI_CHILD is set, we're the child process -- just run cli.js directly.
//
// V8 heap snapshot flags:
// Injects --heapsnapshot-near-heap-limit=3 and --diagnostic-dir so V8 writes
// heap snapshots internally as it approaches the heap limit. This catches OOM
// situations where SIGKILL (exit 137) would kill the process before our
// heap-monitor.ts polling can react. The polling monitor is kept as an early
// warning system at 85% usage; the V8 flag is the last-resort safety net.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAP_SNAPSHOT_DIR = path.join(os.homedir(), '.kimaki', 'heap-snapshots')

// First arg after node + script is either a subcommand or a flag.
// If it doesn't start with '-', it's a subcommand (e.g. "send", "tunnel", "project").
const firstArg = process.argv[2]
const isSubcommand = firstArg && !firstArg.startsWith('-')
const isHelpFlag = process.argv.includes('--help')

if (process.env.__KIMAKI_CHILD || isSubcommand || isHelpFlag) {
  await import('./cli.js')
} else {
  console.error('no subcommand detected. kimaki will automatically restart on crash')
  console.error()
  const EXIT_NO_RESTART = 64
  // Keep in sync with EXIT_TEMPFAIL in cli-runner.ts. Network-down login
  // failures use this so a long outage cannot trip the crash-loop detector.
  const EXIT_TEMPFAIL = 75
  const MAX_RAPID_RESTARTS = 5
  const RAPID_RESTART_WINDOW_MS = 60_000
  const RESTART_DELAY_MS = 2_000

  const CHILD_EXIT_DEADLINE_MS = 15_000
  const restartTimestamps: number[] = []
  let tempFailAttempts = 0
  let child: ReturnType<typeof spawn> | null = null
  // Track when we forwarded a termination signal so we don't restart after graceful shutdown
  let shutdownRequested = false
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledRestart: ReturnType<typeof setTimeout> | null = null

  function clearForceKillTimer() {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = null
  }

  function clearScheduledRestart() {
    if (!scheduledRestart) return
    clearTimeout(scheduledRestart)
    scheduledRestart = null
  }

  function killChild(signal: NodeJS.Signals) {
    const target = child
    if (!target) {
      if (shutdownRequested) {
        clearScheduledRestart()
        process.exit(0)
      }
      return
    }

    const sent = target.kill(signal)
    if (!sent || forceKillTimer) return

    forceKillTimer = setTimeout(() => {
      forceKillTimer = null
      if (child !== target) return
      console.error(
        `[kimaki] Child did not exit within ${CHILD_EXIT_DEADLINE_MS / 1000}s, force-killing it`,
      )
      target.kill('SIGKILL')
    }, CHILD_EXIT_DEADLINE_MS)
    forceKillTimer.unref()
  }

  function start() {
    if (shutdownRequested) return
    scheduledRestart = null
    if (!fs.existsSync(HEAP_SNAPSHOT_DIR)) {
      fs.mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true })
    }
    const heapArgs = [
      `--heapsnapshot-near-heap-limit=3`,
      `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`,
    ]
    const args = [...heapArgs, ...process.execArgv, ...process.argv.slice(1)]
    const currentChild = spawn(
      process.argv[0]!,
      args,
      {
        stdio: 'inherit',
        env: { ...process.env, __KIMAKI_CHILD: '1' },
      },
    )
    child = currentChild

    currentChild.on('exit', (code, signal) => {
      if (child === currentChild) child = null
      clearForceKillTimer()
      if (code === 0 || code === EXIT_NO_RESTART || shutdownRequested) {
        process.exit(code ?? 0)
        return
      }

      const now = Date.now()
      const isTempFail = code === EXIT_TEMPFAIL
      if (!isTempFail) {
        restartTimestamps.push(now)
        while (
          restartTimestamps.length > 0 &&
          restartTimestamps[0]! < now - RAPID_RESTART_WINDOW_MS
        ) {
          restartTimestamps.shift()
        }

        if (restartTimestamps.length > MAX_RAPID_RESTARTS) {
          console.error(
            `[kimaki] Crash loop detected (${MAX_RAPID_RESTARTS} crashes in ${RAPID_RESTART_WINDOW_MS / 1000}s), exiting`,
          )
          process.exit(1)
          return
        }
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`
      // Progressive backoff: 2s, 4s, 8s, 16s, capped at 30s.
      // Prevents hammering DNS/gateway during sustained network outages.
      const backoffStep = isTempFail
        ? Math.min(tempFailAttempts++, 4)
        : restartTimestamps.length - 1
      const delay = Math.min(RESTART_DELAY_MS * 2 ** backoffStep, 30_000)
      console.error(
        `[kimaki] Process exited with ${reason}, restarting in ${(delay / 1000).toFixed(0)}s...`,
      )
      scheduledRestart = setTimeout(start, delay)
    })
  }

  // Forward signals to child so graceful shutdown and heap snapshots work.
  // SIGTERM/SIGINT mark shutdownRequested so we don't restart after graceful exit.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      shutdownRequested = true
      killChild(sig)
    })
  }
  process.on('SIGUSR1', () => {
    child?.kill('SIGUSR1')
  })
  process.on('SIGUSR2', () => {
    killChild('SIGUSR2')
  })

  start()
}
