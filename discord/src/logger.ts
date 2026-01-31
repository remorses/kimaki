// Prefixed logging utility using @clack/prompts for consistent visual style.
// All log methods use clack's log.message() with appropriate symbols to prevent
// output interleaving from concurrent async operations.

import { log as clackLog } from '@clack/prompts'
import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import util from 'node:util'
import pc from 'picocolors'

// All known log prefixes - add new ones here to keep alignment consistent
export const LogPrefix = {
  ABORT: 'ABORT',
  ADD_PROJECT: 'ADD_PROJ',
  AGENT: 'AGENT',
  ASK_QUESTION: 'QUESTION',
  CLI: 'CLI',
  COMPACT: 'COMPACT',
  CREATE_PROJECT: 'NEW_PROJ',
  DB: 'DB',
  DISCORD: 'DISCORD',
  FORK: 'FORK',
  FORMATTING: 'FORMAT',
  GENAI: 'GENAI',
  GENAI_WORKER: 'GENAI_W',
  INTERACTION: 'INTERACT',
  LOGIN: 'LOGIN',
  MARKDOWN: 'MARKDOWN',
  MODEL: 'MODEL',
  OPENAI: 'OPENAI',
  OPENCODE: 'OPENCODE',
  PERMISSIONS: 'PERMS',
  QUEUE: 'QUEUE',
  REMOVE_PROJECT: 'RM_PROJ',
  RESUME: 'RESUME',
  SESSION: 'SESSION',
  SHARE: 'SHARE',
  TOOLS: 'TOOLS',
  UNDO_REDO: 'UNDO',
  USER_CMD: 'USER_CMD',
  VERBOSITY: 'VERBOSE',
  VOICE: 'VOICE',
  WORKER: 'WORKER',
  WORKTREE: 'WORKTREE',
  XML: 'XML',
} as const

export type LogPrefixType = (typeof LogPrefix)[keyof typeof LogPrefix]

// compute max length from all known prefixes for alignment
const MAX_PREFIX_LENGTH = Math.max(...Object.values(LogPrefix).map((p) => p.length))

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const isDev = !__dirname.includes('node_modules')

const logFilePath = path.join(__dirname, '..', 'tmp', 'kimaki.log')

// reset log file on startup in dev mode
if (isDev) {
  const logDir = path.dirname(logFilePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  fs.writeFileSync(logFilePath, `--- kimaki log started at ${new Date().toISOString()} ---\n`)
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg
  }
  return util.inspect(arg, { colors: true, depth: 4 })
}

function writeToFile(level: string, prefix: string, args: unknown[]) {
  if (!isDev) {
    return
  }
  const timestamp = new Date().toISOString()
  const message = `[${timestamp}] [${level}] [${prefix}] ${args.map(formatArg).join(' ')}\n`
  fs.appendFileSync(logFilePath, message)
}

function getTimestamp(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function padPrefix(prefix: string): string {
  return prefix.padEnd(MAX_PREFIX_LENGTH)
}

function formatMessage(timestamp: string, prefix: string, args: unknown[]): string {
  return [pc.dim(timestamp), prefix, ...args.map(formatArg)].join(' ')
}

const noSpacing = { spacing: 0 }

export function createLogger(prefix: LogPrefixType | string) {
  const paddedPrefix = padPrefix(prefix)
  const log = (...args: unknown[]) => {
    writeToFile('LOG', prefix, args)
    clackLog.message(formatMessage(getTimestamp(), pc.cyan(paddedPrefix), args), {
      ...noSpacing,
      // symbol: `|`,
    })
  }
  return {
    log,
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
      clackLog.error(formatMessage(getTimestamp(), pc.red(paddedPrefix), args), noSpacing)
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
      clackLog.warn(formatMessage(getTimestamp(), pc.yellow(paddedPrefix), args), noSpacing)
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      clackLog.info(formatMessage(getTimestamp(), pc.blue(paddedPrefix), args), noSpacing)
    },
    debug: log,
  }
}
