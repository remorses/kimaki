// /screenshare command - Start screen sharing via VNC + WebSocket bridge + kimaki tunnel.
// On macOS: uses built-in Screen Sharing (port 5900).
// On Linux: spawns x11vnc against the current $DISPLAY.
// Exposes the VNC stream via an in-process websockify bridge and a traforo tunnel,
// then sends the user a noVNC URL they can open in a browser.
//
// /screenshare-stop command - Stops the active screen share for this guild.

import { MessageFlags } from 'discord.js'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { TunnelClient } from 'traforo/client'
import type { CommandContext } from './types.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { startWebsockify } from '../websockify.js'
import { createLogger } from '../logger.js'
import { execAsync } from '../worktrees.js'
import type { WebSocketServer } from 'ws'

const logger = createLogger('SCREEN')
const SECURE_REPLY_FLAGS = MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS

export type ScreenshareSession = {
  tunnelClient: TunnelClient
  wss: WebSocketServer
  /** x11vnc child process, only on Linux */
  vncProcess: ChildProcess | undefined
  url: string
  noVncUrl: string
  startedBy: string
  startedAt: number
  /** Auto-kill timer */
  timeoutTimer: ReturnType<typeof setTimeout>
}

/** One active screenshare per guild (Discord) or per machine (CLI) */
const activeSessions = new Map<string, ScreenshareSession>()

const VNC_PORT = 5900
const MAX_SESSION_MINUTES = 30
const MAX_SESSION_MS = MAX_SESSION_MINUTES * 60 * 1000
const TUNNEL_BASE_DOMAIN = 'kimaki.xyz'
const SCREENSHARE_TUNNEL_ID_BYTES = 16

// Public noVNC client — we point it at our tunnel URL
export function buildNoVncUrl({ tunnelHost }: { tunnelHost: string }): string {
  const params = new URLSearchParams({
    autoconnect: 'true',
    host: tunnelHost,
    port: '443',
    encrypt: '1',
    resize: 'scale',
    view_only: 'false',
  })
  return `https://novnc.com/noVNC/vnc.html?${params.toString()}`
}

export function createScreenshareTunnelId(): string {
  return crypto.randomBytes(SCREENSHARE_TUNNEL_ID_BYTES).toString('hex')
}

// macOS has two separate services:
// - "Screen Sharing" = view-only VNC (com.apple.screensharing)
// - "Remote Management" = full control VNC with mouse/keyboard (ARDAgent)
// We need Remote Management for interactive control, not just Screen Sharing.
export async function ensureMacRemoteManagement(): Promise<void> {
  // Check if port 5900 is listening via netstat (no sudo needed).
  // lsof and launchctl list both require sudo for system daemons.
  try {
    const { stdout } = await execAsync(
      'netstat -an | grep "\\.5900 " | grep LISTEN',
      { timeout: 5000 },
    )
    if (stdout.trim()) {
      return
    }
  } catch {
    // not listening
  }

  throw new Error(
    'macOS Remote Management is not enabled.\n' +
    'Enable it: **System Settings > General > Sharing > Remote Management**\n' +
    'Make sure "VNC viewers may control screen with password" is enabled.\n' +
    'Or via terminal:\n' +
    '```\nsudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \\\n' +
    '  -activate -configure -allowAccessFor -allUsers -privs -all \\\n' +
    '  -clientopts -setvnclegacy -vnclegacy yes \\\n' +
    '  -restart -agent -console\n```',
  )
}

export function spawnX11Vnc(): ChildProcess {
  const display = process.env['DISPLAY'] || ':0'
  const child = spawn('x11vnc', [
    '-display', display,
    '-nopw',
    '-localhost',
    '-rfbport', String(VNC_PORT),
    '-shared',
    '-forever',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (data: Buffer) => {
    logger.log(`x11vnc: ${data.toString().trim()}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    logger.error(`x11vnc: ${data.toString().trim()}`)
  })

  return child
}

function waitForPort({
  port,
  process: proc,
  timeoutMs,
}: {
  port: number
  process: ChildProcess
  timeoutMs: number
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const maxAttempts = Math.ceil(timeoutMs / 100)
    let attempts = 0
    const check = () => {
      if (proc.exitCode !== null) {
        reject(new Error(`x11vnc exited with code ${proc.exitCode} before becoming ready`))
        return
      }
      const sock = net.createConnection(port, 'localhost')
      sock.on('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        if (++attempts >= maxAttempts) {
          reject(new Error(`Port ${port} not reachable after ${timeoutMs}ms`))
        } else {
          setTimeout(check, 100)
        }
      })
    }
    check()
  })
}

export function cleanupSession(session: ScreenshareSession): void {
  clearTimeout(session.timeoutTimer)
  try {
    session.tunnelClient.close()
  } catch {}
  try {
    session.wss.close()
  } catch {}
  if (session.vncProcess) {
    try {
      session.vncProcess.kill()
    } catch {}
  }
}

/**
 * Core screenshare start logic, reused by both Discord command and CLI.
 * Returns the session or throws on failure.
 */
export async function startScreenshare({
  sessionKey,
  startedBy,
}: {
  sessionKey: string
  startedBy: string
}): Promise<ScreenshareSession> {
  const existing = activeSessions.get(sessionKey)
  if (existing) {
    throw new Error(`Screen sharing is already active: ${existing.noVncUrl}`)
  }

  const platform = process.platform
  let vncProcess: ChildProcess | undefined

  // Step 1: ensure VNC server is running
  if (platform === 'darwin') {
    await ensureMacRemoteManagement()
  } else if (platform === 'linux') {
    if (!process.env['DISPLAY']) {
      throw new Error('No $DISPLAY found. Screen sharing requires a running X11 display.')
    }
    try {
      await execAsync('which x11vnc', { timeout: 3000 })
    } catch {
      throw new Error('x11vnc is not installed. Install it with: sudo apt install x11vnc')
    }
    vncProcess = spawnX11Vnc()
    // Wait for x11vnc to actually be ready (port 5900 accepting connections)
    // instead of a blind 1s sleep. Polls every 100ms, fails if process exits first.
    await waitForPort({ port: VNC_PORT, process: vncProcess, timeoutMs: 3000 })
  } else {
    throw new Error(`Screen sharing is not supported on ${platform}. Only macOS and Linux are supported.`)
  }

  // Step 2: start in-process websockify bridge
  let wsInstance: Awaited<ReturnType<typeof startWebsockify>>
  try {
    wsInstance = await startWebsockify({
      wsPort: 0,
      tcpHost: 'localhost',
      tcpPort: VNC_PORT,
    })
  } catch (err) {
    if (vncProcess) {
      vncProcess.kill()
    }
    throw err
  }

  // Step 3: create tunnel
  const tunnelId = createScreenshareTunnelId()
  const tunnelClient = new TunnelClient({
    localPort: wsInstance.port,
    tunnelId,
    baseDomain: TUNNEL_BASE_DOMAIN,
  })

  try {
    await Promise.race([
      tunnelClient.connect(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Tunnel connection timed out after 15s'))
        }, 15000)
      }),
    ])
  } catch (err) {
    tunnelClient.close()
    wsInstance.close()
    if (vncProcess) {
      vncProcess.kill()
    }
    throw err
  }

  const tunnelHost = `${tunnelId}-tunnel.${TUNNEL_BASE_DOMAIN}`
  const tunnelUrl = `https://${tunnelHost}`
  const noVncUrl = buildNoVncUrl({ tunnelHost })

  // Auto-kill after a short session so a leaked URL does not stay usable all day.
  const timeoutTimer = setTimeout(() => {
    logger.log(
      `Screen share auto-stopped after ${MAX_SESSION_MINUTES} minutes (key: ${sessionKey})`,
    )
    stopScreenshare({ sessionKey })
  }, MAX_SESSION_MS)
  // Don't keep the process alive just for this timer
  timeoutTimer.unref()

  const session: ScreenshareSession = {
    tunnelClient,
    wss: wsInstance.wss,
    vncProcess,
    url: tunnelUrl,
    noVncUrl,
    startedBy,
    startedAt: Date.now(),
    timeoutTimer,
  }

  activeSessions.set(sessionKey, session)
  logger.log(`Screen share started by ${startedBy}: ${tunnelUrl}`)

  return session
}

/**
 * Core screenshare stop logic, reused by both Discord command and CLI.
 */
export function stopScreenshare({ sessionKey }: { sessionKey: string }): boolean {
  const session = activeSessions.get(sessionKey)
  if (!session) {
    return false
  }
  cleanupSession(session)
  activeSessions.delete(sessionKey)
  logger.log(`Screen share stopped (key: ${sessionKey})`)
  return true
}

export async function handleScreenshareCommand({
  command,
}: CommandContext): Promise<void> {
  const guildId = command.guildId
  if (!guildId) {
    await command.reply({
      content: 'This command can only be used in a server',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SECURE_REPLY_FLAGS })

  try {
    const session = await startScreenshare({
      sessionKey: guildId,
      startedBy: command.user.tag,
    })
    await command.editReply({
      content:
        `Screen sharing started. This reply is private and the URL uses a high-entropy tunnel id. ` +
        `It will auto-stop after ${MAX_SESSION_MINUTES} minutes. Use /screenshare-stop to stop sooner.\n` +
        `${session.noVncUrl}`,
    })
  } catch (err) {
    logger.error('Failed to start screen share:', err)
    await command.editReply({
      content: `Failed to start screen share: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

export async function handleScreenshareStopCommand({
  command,
}: CommandContext): Promise<void> {
  const guildId = command.guildId
  if (!guildId) {
    await command.reply({
      content: 'This command can only be used in a server',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const stopped = stopScreenshare({ sessionKey: guildId })
  if (!stopped) {
    await command.reply({
      content: 'No active screen share to stop',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.reply({
    content: 'Screen sharing stopped',
    flags: SILENT_MESSAGE_FLAGS,
  })
}

/** Cleanup all sessions on bot shutdown */
export function cleanupAllScreenshares(): void {
  for (const [guildId, session] of activeSessions) {
    cleanupSession(session)
    activeSessions.delete(guildId)
  }
}

// Kill all screenshares when the process exits (Ctrl+C, SIGTERM, etc.)
function onProcessExit(): void {
  cleanupAllScreenshares()
}
process.on('SIGINT', onProcessExit)
process.on('SIGTERM', onProcessExit)
process.on('exit', onProcessExit)
