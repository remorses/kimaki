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

export function createPluginLogger(prefix: string) {
  return {
    log: (...args: unknown[]) => {
      writeToFile('LOG', prefix, args)
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
    },
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
    },
    debug: (...args: unknown[]) => {
      writeToFile('DEBUG', prefix, args)
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
