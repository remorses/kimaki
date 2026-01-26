// Prefixed logging utility.
// Uses picocolors for compact frequent logs (log, info, debug).
// Uses @clack/prompts only for important events (warn, error) with visual distinction.

import { log as clackLog } from '@clack/prompts'
import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import util from 'node:util'
import pc from 'picocolors'

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
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}

export function createLogger(prefix: string) {
  return {
    log: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      console.log(pc.dim(getTimestamp()), pc.cyan(`[${prefix}]`), ...args.map(formatArg))
    },
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
      // use clack for errors - visually distinct
      clackLog.error([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
      // use clack for warnings - visually distinct
      clackLog.warn([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      console.log(pc.dim(getTimestamp()), pc.blue(`[${prefix}]`), ...args.map(formatArg))
    },
    debug: (...args: unknown[]) => {
      writeToFile('DEBUG', prefix, args)
      console.log(pc.dim(getTimestamp()), pc.dim(`[${prefix}]`), ...args.map(formatArg))
    },
  }
}
