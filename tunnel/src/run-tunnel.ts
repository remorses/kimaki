import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { TunnelClient } from './client.js'

export const CLI_NAME = 'kimaki-tunnel'

export type RunTunnelOptions = {
  port: number
  tunnelId?: string
  localHost?: string
  serverUrl?: string
  command?: string[]
}

/**
 * Wait for a port to be available (accepting connections).
 * Used when spawning a child process to wait for the server to start.
 */
async function waitForPort(
  port: number,
  host = 'localhost',
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now()
  const checkInterval = 500

  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for port ${port} to be available`))
        return
      }

      const socket = new net.Socket()

      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })

      socket.once('error', () => {
        socket.destroy()
        setTimeout(check, checkInterval)
      })

      socket.connect(port, host)
    }

    check()
  })
}

/**
 * Parse argv to extract command after `--` separator.
 * Returns the command array and remaining argv without the command.
 */
export function parseCommandFromArgv(argv: string[]): {
  command: string[]
  argv: string[]
} {
  const dashDashIndex = argv.indexOf('--')

  if (dashDashIndex === -1) {
    return { command: [], argv }
  }

  return {
    command: argv.slice(dashDashIndex + 1),
    argv: argv.slice(0, dashDashIndex),
  }
}

/**
 * Run the tunnel, optionally spawning a child process first.
 */
export async function runTunnel(options: RunTunnelOptions): Promise<void> {
  const tunnelId = options.tunnelId || crypto.randomUUID().slice(0, 8)
  const localHost = options.localHost || 'localhost'
  const port = options.port

  let child: ChildProcess | null = null

  // If command provided, spawn child process with PORT env
  if (options.command && options.command.length > 0) {
    const cmd = options.command[0]!
    const args = options.command.slice(1)

    console.log(`Starting: ${options.command.join(' ')}`)
    console.log(`PORT=${port}\n`)

    const spawnedChild = spawn(cmd, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        // Disable clear/animations for common tools without lying about CI
        FORCE_COLOR: '1',
        VITE_CLS: 'false',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    })
    child = spawnedChild

    spawnedChild.on('error', (err) => {
      console.error(`Failed to start command: ${err.message}`)
      process.exit(1)
    })

    spawnedChild.on('exit', (code) => {
      console.log(`\nCommand exited with code ${code}`)
      process.exit(code || 0)
    })

    // Wait for port to be available before connecting tunnel
    console.log(`Waiting for port ${port}...`)
    try {
      await waitForPort(port, localHost)
      console.log(`Port ${port} is ready!\n`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      spawnedChild.kill()
      process.exit(1)
    }
  }

  const client = new TunnelClient({
    localPort: port,
    tunnelId,
    localHost,
    serverUrl: options.serverUrl,
  })

  // Handle shutdown
  const cleanup = () => {
    console.log('\nShutting down...')
    client.close()
    if (child) {
      child.kill()
    }
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  try {
    await client.connect()
  } catch (err) {
    console.error('Failed to connect:', err instanceof Error ? err.message : String(err))
    if (child) {
      child.kill()
    }
    process.exit(1)
  }
}
