import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { TunnelClient } from 'traforo/client'
import type { CommandContext } from './types.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'

const logger = createLogger('VSCODE')
const SECURE_REPLY_FLAGS = MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS
const MAX_SESSION_MINUTES = 30
const MAX_SESSION_MS = MAX_SESSION_MINUTES * 60 * 1000
const TUNNEL_BASE_DOMAIN = 'kimaki.dev'
const TUNNEL_ID_BYTES = 16
const READY_TIMEOUT_MS = 60_000
const LOCAL_HOST = '127.0.0.1'

export type VscodeSession = {
  coderaftProcess: ChildProcess
  tunnelClient: TunnelClient
  url: string
  workingDirectory: string
  startedBy: string
  startedAt: number
  timeoutTimer: ReturnType<typeof setTimeout>
}

const activeSessions = new Map<string, VscodeSession>()

export function createVscodeTunnelId(): string {
  return crypto.randomBytes(TUNNEL_ID_BYTES).toString('hex')
}

export function buildCoderaftArgs({
  port,
  workingDirectory,
}: {
  port: number
  workingDirectory: string
}): string[] {
  return [
    'coderaft',
    '--port',
    String(port),
    '--host',
    LOCAL_HOST,
    '--without-connection-token',
    '--disable-workspace-trust',
    '--default-folder',
    workingDirectory,
  ]
}

function createPortWaiter({
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

    const check = (): void => {
      if (proc.exitCode !== null) {
        reject(new Error(`coderaft exited with code ${proc.exitCode} before becoming ready`))
        return
      }

      const socket = net.createConnection(port, LOCAL_HOST)
      socket.on('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()
        attempts += 1
        if (attempts >= maxAttempts) {
          reject(new Error(`Port ${port} not reachable after ${timeoutMs}ms`))
          return
        }
        setTimeout(check, 100)
      })
    }

    check()
  })
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to resolve an available port'))
        })
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

function cleanupSession(session: VscodeSession): void {
  clearTimeout(session.timeoutTimer)
  try {
    session.tunnelClient.close()
  } catch {}
  if (session.coderaftProcess.exitCode === null) {
    try {
      session.coderaftProcess.kill('SIGTERM')
    } catch {}
  }
}

export function getActiveVscodeSession({ sessionKey }: { sessionKey: string }): VscodeSession | undefined {
  return activeSessions.get(sessionKey)
}

export function stopVscode({ sessionKey }: { sessionKey: string }): boolean {
  const session = activeSessions.get(sessionKey)
  if (!session) {
    return false
  }

  activeSessions.delete(sessionKey)
  cleanupSession(session)
  logger.log(`VS Code stopped (key: ${sessionKey})`)
  return true
}

export async function startVscode({
  sessionKey,
  startedBy,
  workingDirectory,
}: {
  sessionKey: string
  startedBy: string
  workingDirectory: string
}): Promise<VscodeSession> {
  const existing = activeSessions.get(sessionKey)
  if (existing) {
    return existing
  }

  const port = await getAvailablePort()
  const tunnelId = createVscodeTunnelId()
  const args = buildCoderaftArgs({
    port,
    workingDirectory,
  })
  const coderaftProcess = spawn('bunx', args, {
    cwd: workingDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
    },
  })

  coderaftProcess.stdout?.on('data', (data: Buffer) => {
    logger.log(data.toString().trim())
  })
  coderaftProcess.stderr?.on('data', (data: Buffer) => {
    logger.error(data.toString().trim())
  })

  try {
    await createPortWaiter({
      port,
      process: coderaftProcess,
      timeoutMs: READY_TIMEOUT_MS,
    })
  } catch (error) {
    if (coderaftProcess.exitCode === null) {
      coderaftProcess.kill('SIGTERM')
    }
    throw error
  }

  const tunnelClient = new TunnelClient({
    localPort: port,
    localHost: LOCAL_HOST,
    tunnelId,
    baseDomain: TUNNEL_BASE_DOMAIN,
  })

  try {
    await Promise.race([
      tunnelClient.connect(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Tunnel connection timed out after 15s'))
        }, 15_000)
      }),
    ])
  } catch (error) {
    tunnelClient.close()
    if (coderaftProcess.exitCode === null) {
      coderaftProcess.kill('SIGTERM')
    }
    throw error
  }

  const url = tunnelClient.url

  const timeoutTimer = setTimeout(() => {
    logger.log(`VS Code auto-stopped after ${MAX_SESSION_MINUTES} minutes (key: ${sessionKey})`)
    stopVscode({ sessionKey })
  }, MAX_SESSION_MS)
  timeoutTimer.unref()

  const session: VscodeSession = {
    coderaftProcess,
    tunnelClient,
    url,
    workingDirectory,
    startedBy,
    startedAt: Date.now(),
    timeoutTimer,
  }

  coderaftProcess.once('exit', (code, signal) => {
    const current = activeSessions.get(sessionKey)
    if (current !== session) {
      return
    }
    logger.log(`VS Code process exited (key: ${sessionKey}, code: ${code}, signal: ${signal ?? 'none'})`)
    stopVscode({ sessionKey })
  })

  activeSessions.set(sessionKey, session)
  logger.log(`VS Code started by ${startedBy}: ${url}`)
  return session
}

export async function handleVscodeCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel
  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel.',
      flags: SECURE_REPLY_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)
  const isTextChannel = channel.type === ChannelType.GuildText
  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in a text channel or thread.',
      flags: SECURE_REPLY_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel.',
      flags: SECURE_REPLY_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SECURE_REPLY_FLAGS })

  const sessionKey = channel.id
  const existing = getActiveVscodeSession({ sessionKey })
  if (existing) {
    await command.editReply({
      content:
        `VS Code is already running for this thread. ` +
        `This unique tunnel auto-stops after ${MAX_SESSION_MINUTES} minutes from startup.\n` +
        `${existing.url}`,
    })
    return
  }

  try {
    const session = await startVscode({
      sessionKey,
      startedBy: command.user.tag,
      workingDirectory: resolved.workingDirectory,
    })
    await command.editReply({
      content:
        `VS Code started for \`${session.workingDirectory}\`. ` +
        `This unique tunnel auto-stops after ${MAX_SESSION_MINUTES} minutes, so open it before it expires.\n` +
        `${session.url}`,
    })
  } catch (error) {
    logger.error('Failed to start VS Code:', error)
    await command.editReply({
      content: `Failed to start VS Code: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

export function cleanupAllVscodeSessions(): void {
  for (const sessionKey of activeSessions.keys()) {
    stopVscode({ sessionKey })
  }
}

function onProcessExit(): void {
  cleanupAllVscodeSessions()
}

process.on('SIGINT', onProcessExit)
process.on('SIGTERM', onProcessExit)
process.on('exit', onProcessExit)
