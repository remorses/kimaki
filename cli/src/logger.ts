// Prefixed logging utility using @clack/prompts for consistent stderr diagnostics and file logs.
// Never write logger output to stdout because many CLI subcommands print
// machine-readable data there, for example `kimaki project list --json`.

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
type LogArg = unknown

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + `… [truncated ${str.length - max} chars]`
}

function formatArg(arg: LogArg): string {
  if (typeof arg === 'string') {
    return truncate(sanitizeSensitiveText(arg, { redactPaths: false }), MAX_LOG_ARG_LENGTH)
  }
  const safeArg = sanitizeUnknownValue(arg, { redactPaths: false })
  return truncate(util.inspect(safeArg, { colors: true, depth: 4 }), MAX_LOG_ARG_LENGTH)
}

export function formatErrorWithStack<T>(error: T): string {
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

function writeToFile({
  level,
  prefix,
  args,
}: {
  level: string
  prefix: string
  args: LogArg[]
}) {
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

function formatMessage({
  timestamp,
  prefix,
  args,
}: {
  timestamp: string
  prefix: string
  args: LogArg[]
}): string {
  return [pc.dim(timestamp), prefix, ...args.map(formatArg)].join(' ')
}

const stderrLogOptions = { output: process.stderr, spacing: 0 }

// Suppress clack terminal output during vitest runs to avoid flooding
// test output with hundreds of log lines. File logging still works.
// Set KIMAKI_TEST_LOGS=1 when rerunning a failing test to see all
// kimaki logger output in the terminal for debugging.
const isVitest = !!process.env['KIMAKI_VITEST']
const showTestLogs = isVitest && !!process.env['KIMAKI_TEST_LOGS']

export function createLogger(prefix: LogPrefixType | string) {
  const paddedPrefix = prefix.padEnd(MAX_PREFIX_LENGTH)
  const suppressConsole = isVitest && !showTestLogs
  const log = (...args: LogArg[]) => {
    writeToFile({ level: 'LOG', prefix, args })
    if (suppressConsole) {
      return
    }
    clackLog.message(
      formatMessage({ timestamp: getTimestamp(), prefix: pc.cyan(paddedPrefix), args }),
      stderrLogOptions,
    )
  }
  return {
    log,
    error: (...args: LogArg[]) => {
      writeToFile({ level: 'ERROR', prefix, args })
      if (suppressConsole) {
        return
      }
      clackLog.error(
        formatMessage({ timestamp: getTimestamp(), prefix: pc.red(paddedPrefix), args }),
        stderrLogOptions,
      )
    },
    warn: (...args: LogArg[]) => {
      writeToFile({ level: 'WARN', prefix, args })
      if (suppressConsole) {
        return
      }
      clackLog.warn(
        formatMessage({
          timestamp: getTimestamp(),
          prefix: pc.yellow(paddedPrefix),
          args,
        }),
        stderrLogOptions,
      )
    },
    info: (...args: LogArg[]) => {
      writeToFile({ level: 'INFO', prefix, args })
      if (suppressConsole) {
        return
      }
      clackLog.info(
        formatMessage({ timestamp: getTimestamp(), prefix: pc.blue(paddedPrefix), args }),
        stderrLogOptions,
      )
    },
    debug: log,
  }
}
