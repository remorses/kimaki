// Prefixed logging utility using @clack/prompts for consistent visual style.
// All log methods use clack's log.message() with appropriate symbols to prevent
// output interleaving from concurrent async operations.

import { log as clackLog } from '@clack/prompts'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import pc from 'picocolors'
import { sanitizeSensitiveText, sanitizeUnknownValue } from './privacy-sanitizer.js'

// All known log prefixes - add new ones here to keep alignment consistent
export const LogPrefix = {
  ABORT: 'ABORT',
  ADD_PROJECT: 'ADD_PROJ',
  AGENT: 'AGENT',
  ASK_QUESTION: 'QUESTION',
  CHANNEL: 'CHANNEL',
  CLI: 'CLI',
  COMPACT: 'COMPACT',
  CREATE_PROJECT: 'NEW_PROJ',
  DB: 'DB',
  DIFF: 'DIFF',
  FILE_UPLOAD: 'FILEUP',
  DISCORD: 'DISCORD',
  FORK: 'FORK',
  FORMATTING: 'FORMAT',
  GENAI: 'GENAI',
  HEAP: 'HEAP',
  GENAI_WORKER: 'GENAI_W',
  INTERACTION: 'INTERACT',
  IPC: 'IPC',
  LOGIN: 'LOGIN',
  MARKDOWN: 'MARKDOWN',
  MCP: 'MCP',
  MODEL: 'MODEL',
  OPENAI: 'OPENAI',
  OPENCODE: 'OPENCODE',
  PERMISSIONS: 'PERMS',
  QUEUE: 'QUEUE',
  REMOVE_PROJECT: 'RM_PROJ',
  RESUME: 'RESUME',
  SESSION: 'SESSION',
  SHARE: 'SHARE',
  TASK: 'TASK',
  TOOLS: 'TOOLS',
  UNDO_REDO: 'UNDO',
  USER_CMD: 'USER_CMD',
  VERBOSITY: 'VERBOSE',
  VOICE: 'VOICE',
  WORKER: 'WORKER',
  THINKING: 'THINK',
  WORKTREE: 'WORKTREE',
  XML: 'XML',
} as const

export type LogPrefixType = (typeof LogPrefix)[keyof typeof LogPrefix]

// compute max length from all known prefixes for alignment
const MAX_PREFIX_LENGTH = Math.max(
  ...Object.values(LogPrefix).map((p) => p.length),
)

// Log file path is set by initLogFile() after the data directory is known.
// Before initLogFile() is called, file logging is skipped.
let logFilePath: string | null = null

/**
 * Initialize file logging. Call this after setDataDir() so the log file
 * is written to `<dataDir>/kimaki.log`. The log file is truncated on
 * every bot startup so it contains only the current run's logs.
 */
export function initLogFile(dataDir: string): void {
  logFilePath = path.join(dataDir, 'kimaki.log')
  const logDir = path.dirname(logFilePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  fs.writeFileSync(
    logFilePath,
    `--- kimaki log started at ${new Date().toISOString()} ---\n`,
  )
}

/**
 * Set the log file path without truncating. Use this in child processes
 * (like the opencode plugin) that should append to the same log file
 * the bot process already created with initLogFile().
 */
export function setLogFilePath(dataDir: string): void {
  logFilePath = path.join(dataDir, 'kimaki.log')
}

export function getLogFilePath(): string | null {
  return logFilePath
}

const MAX_LOG_ARG_LENGTH = 1000

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + `… [truncated ${str.length - max} chars]`
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return truncate(sanitizeSensitiveText(arg, { redactPaths: false }), MAX_LOG_ARG_LENGTH)
  }
  const safeArg = sanitizeUnknownValue(arg, { redactPaths: false })
  return truncate(util.inspect(safeArg, { colors: true, depth: 4 }), MAX_LOG_ARG_LENGTH)
}

export function formatErrorWithStack(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeSensitiveText(
      error.stack ?? `${error.name}: ${error.message}`,
      { redactPaths: false },
    )
  }
  if (typeof error === 'string') {
    return sanitizeSensitiveText(error, { redactPaths: false })
  }

  // Keep this stable and safe for unknown values (handles circular structures).
  const safeError = sanitizeUnknownValue(error, { redactPaths: false })
  return sanitizeSensitiveText(util.inspect(safeError, { colors: false, depth: 4 }), {
    redactPaths: false,
  })
}

function writeToFile(level: string, prefix: string, args: unknown[]) {
  const timestamp = new Date().toISOString()
  const message = `[${timestamp}] [${level}] [${prefix}] ${args.map(formatArg).join(' ')}\n`
  if (!logFilePath) {
    return
  }
  fs.appendFileSync(logFilePath, message)
}

function getTimestamp(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function padPrefix(prefix: string): string {
  return prefix.padEnd(MAX_PREFIX_LENGTH)
}

function formatMessage(
  timestamp: string,
  prefix: string,
  args: unknown[],
): string {
  return [pc.dim(timestamp), prefix, ...args.map(formatArg)].join(' ')
}

const noSpacing = { spacing: 0 }

// Suppress clack terminal output during vitest runs to avoid flooding
// test output with hundreds of log lines. File logging still works.
// Set KIMAKI_TEST_LOGS=1 when rerunning a failing test to see all
// kimaki logger output in the terminal for debugging.
const isVitest = !!process.env['KIMAKI_VITEST']
const showTestLogs = isVitest && !!process.env['KIMAKI_TEST_LOGS']

export function createLogger(prefix: LogPrefixType | string) {
  const paddedPrefix = padPrefix(prefix)
  const suppressConsole = isVitest && !showTestLogs
  const log = (...args: unknown[]) => {
    writeToFile('LOG', prefix, args)
    if (suppressConsole) {
      return
    }
    clackLog.message(
      formatMessage(getTimestamp(), pc.cyan(paddedPrefix), args),
      {
        ...noSpacing,
      },
    )
  }
  return {
    log,
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
      if (suppressConsole) {
        return
      }
      clackLog.error(
        formatMessage(getTimestamp(), pc.red(paddedPrefix), args),
        noSpacing,
      )
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
      if (suppressConsole) {
        return
      }
      clackLog.warn(
        formatMessage(getTimestamp(), pc.yellow(paddedPrefix), args),
        noSpacing,
      )
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      if (suppressConsole) {
        return
      }
      clackLog.info(
        formatMessage(getTimestamp(), pc.blue(paddedPrefix), args),
        noSpacing,
      )
    },
    debug: log,
  }
}
