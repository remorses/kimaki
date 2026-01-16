// Prefixed logging utility using @clack/prompts.
// Creates loggers with consistent prefixes for different subsystems
// (DISCORD, VOICE, SESSION, etc.) for easier debugging.

import { log } from '@clack/prompts'
import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import util from 'node:util'

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

export function createLogger(prefix: string) {
  return {
    log: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      log.info([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    error: (...args: unknown[]) => {
      writeToFile('ERROR', prefix, args)
      log.error([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    warn: (...args: unknown[]) => {
      writeToFile('WARN', prefix, args)
      log.warn([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    info: (...args: unknown[]) => {
      writeToFile('INFO', prefix, args)
      log.info([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
    debug: (...args: unknown[]) => {
      writeToFile('DEBUG', prefix, args)
      log.info([`[${prefix}]`, ...args.map(formatArg)].join(' '))
    },
  }
}
