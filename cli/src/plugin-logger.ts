import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { sanitizeSensitiveText, sanitizeUnknownValue } from './privacy-sanitizer.js'

let pluginLogFilePath: string | null = null

export function setPluginLogFilePath(dataDir: string): void {
  pluginLogFilePath = path.join(dataDir, 'kimaki.log')
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return sanitizeSensitiveText(arg, { redactPaths: false })
  }
  const safeArg = sanitizeUnknownValue(arg, { redactPaths: false })
  return util.inspect(safeArg, { colors: false, depth: 4 })
}

export function formatPluginErrorWithStack(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeSensitiveText(
      error.stack ?? `${error.name}: ${error.message}`,
      { redactPaths: false },
    )
  }
  if (typeof error === 'string') {
    return sanitizeSensitiveText(error, { redactPaths: false })
  }

  const safeError = sanitizeUnknownValue(error, { redactPaths: false })
  return sanitizeSensitiveText(util.inspect(safeError, { colors: false, depth: 4 }), {
    redactPaths: false,
  })
}

function writeToFile(level: string, prefix: string, args: unknown[]) {
  if (!pluginLogFilePath) {
    return
  }
  const timestamp = new Date().toISOString()
  const message = `[${timestamp}] [${level}] [${prefix}] ${args.map(formatArg).join(' ')}\n`
  try {
    fs.appendFileSync(pluginLogFilePath, message)
  } catch {
    // Plugin logging must never break the OpenCode plugin process.
  }
}

type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

// Minimal interface for the app.log method so we don't import the full SDK
// type in this lightweight logger module.
type AppLogClient = {
  app: {
    log: (input: {
      service: string
      level: AppLogLevel
      message: string
      extra: Record<string, string | number | boolean>
    }) => Promise<unknown>
  }
}

const LOG_LEVEL_MAP: Record<string, AppLogLevel> = {
  LOG: 'info',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
}

export type PluginLogger = ReturnType<typeof createPluginLogger>

export function createPluginLogger(prefix: string) {
  let boundClient: AppLogClient | null = null
  let boundService: string = prefix

  function writeToOpencode(level: string, args: unknown[]) {
    if (!boundClient) return
    const message = args.map(formatArg).join(' ')
    void boundClient.app
      .log({
        service: boundService,
        level: LOG_LEVEL_MAP[level] || 'info',
        message,
        extra: {},
      })
      .catch(() => {
        // Logging must never break plugin logic.
      })
  }

  return {
    // Bind an OpenCode v2 client so log calls also emit to OpenCode's
    // structured logger via client.app.log. Call once after creating the
    // client. The service name groups all entries from this plugin.
    bindClient(client: AppLogClient, service?: string) {
      boundClient = client
      if (service) boundService = service
    },
    log: (...args: unknown[]) => {
      writeToFile('LOG', prefix, args)
      writeToOpencode('LOG', args)
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      writeToOpencode('INFO', args)
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
      writeToOpencode('WARN', args)
    },
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
      writeToOpencode('ERROR', args)
    },
    debug: (...args: unknown[]) => {
      writeToFile('DEBUG', prefix, args)
      writeToOpencode('DEBUG', args)
    },
  }
}

// Append a session ID marker at the end of a toast message so the bot-side
// handleTuiToast can route the toast to the correct Discord thread.
// Without this marker the toast is silently dropped.
export function appendToastSessionMarker({
  message,
  sessionId,
}: {
  message: string
  sessionId: string | undefined
}): string {
  if (!sessionId) {
    return message
  }
  return `${message} ${sessionId}`
}
