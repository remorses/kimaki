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

// Detect proxy env vars. When set, inject Node.js flags so all HTTP and
// WebSocket connections route through the proxy. This is required in
// environments where Discord is blocked (e.g. GFW) and a local VPN/proxy
// is running on 127.0.0.1. Only activates when the user has explicitly
// configured a proxy — zero impact on default usage.
const PROXY_URL =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY

// First arg after node + script is either a subcommand or a flag.
// If it doesn't start with '-', it's a subcommand (e.g. "send", "tunnel", "project").
const firstArg = process.argv[2]
const isSubcommand = firstArg && !firstArg.startsWith('-')
const isHelpFlag = process.argv.includes('--help')

// When running as the child process and proxy is configured, apply the
// ws module monkey-patch so discord.js WebSocket connections go through
// the proxy. HTTP requests are handled by --use-env-proxy instead.
if (PROXY_URL) {
  try {
    require('./proxy-bootstrap.cjs')
  } catch {
    // proxy-bootstrap.cjs may not exist in some builds — non-critical
  }
}

if (process.env.__KIMAKI_CHILD || isSubcommand || isHelpFlag) {
  await import('./cli.js')
} else {
  console.error('no subcommand detected. kimaki will automatically restart on crash')
  console.error()
  const EXIT_NO_RESTART = 64
  const MAX_RAPID_RESTARTS = 5
  const RAPID_RESTART_WINDOW_MS = 60_000
  const RESTART_DELAY_MS = 2_000

  const restartTimestamps: number[] = []
  let child: ReturnType<typeof spawn> | null = null
  // Track when we forwarded a termination signal so we don't restart after graceful shutdown
  let shutdownRequested = false

  function start() {
    if (!fs.existsSync(HEAP_SNAPSHOT_DIR)) {
      fs.mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true })
    }
    const heapArgs = [
      `--heapsnapshot-near-heap-limit=3`,
      `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`,
    ]
    // When a proxy is configured, inject --use-env-proxy so Node.js native
    // fetch/HTTP uses the proxy, and --require proxy-bootstrap.cjs so the
    // ws module (used by discord.js for Gateway WebSocket) is also proxied.
    const proxyArgs: string[] = []
    if (PROXY_URL) {
      const bootstrapPath = path.join(__dirname, 'proxy-bootstrap.cjs')
      if (fs.existsSync(bootstrapPath)) {
        proxyArgs.push('--require', bootstrapPath)
      }
      proxyArgs.push('--use-env-proxy')
    }
    const args = [...heapArgs, ...proxyArgs, ...process.execArgv, ...process.argv.slice(1)]
    child = spawn(
      process.argv[0]!,
      args,
      {
        stdio: 'inherit',
        env: { ...process.env, __KIMAKI_CHILD: '1' },
      },
    )

    child.on('exit', (code, signal) => {
      if (code === 0 || code === EXIT_NO_RESTART || shutdownRequested) {
        process.exit(code ?? 0)
        return
      }

      const now = Date.now()
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

      const reason = signal ? `signal ${signal}` : `code ${code}`
      console.error(
        `[kimaki] Process exited with ${reason}, restarting in ${RESTART_DELAY_MS / 1000}s...`,
      )
      setTimeout(start, RESTART_DELAY_MS)
    })
  }

  // Forward signals to child so graceful shutdown and heap snapshots work.
  // SIGTERM/SIGINT mark shutdownRequested so we don't restart after graceful exit.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      shutdownRequested = true
      child?.kill(sig)
    })
  }
  for (const sig of ['SIGUSR1', 'SIGUSR2'] as const) {
    process.on(sig, () => {
      child?.kill(sig)
    })
  }

  start()
}
