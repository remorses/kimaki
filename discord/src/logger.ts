// Prefixed logging utility using @clack/prompts.
// Creates loggers with consistent prefixes for different subsystems
// (DISCORD, VOICE, SESSION, etc.) for easier debugging.

import { log } from '@clack/prompts'
import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function writeToFile(level: string, prefix: string, args: any[]) {
  if (!isDev) {
    return
  }
  const timestamp = new Date().toISOString()
  const message = `[${timestamp}] [${level}] [${prefix}] ${args.map((arg) => String(arg)).join(' ')}\n`
  fs.appendFileSync(logFilePath, message)
}

export function createLogger(prefix: string) {
  return {
    log: (...args: any[]) => {
      writeToFile('INFO', prefix, args)
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' '))
    },
    error: (...args: any[]) => {
      writeToFile('ERROR', prefix, args)
      log.error([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' '))
    },
    warn: (...args: any[]) => {
      writeToFile('WARN', prefix, args)
      log.warn([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' '))
    },
    info: (...args: any[]) => {
      writeToFile('INFO', prefix, args)
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' '))
    },
    debug: (...args: any[]) => {
      writeToFile('DEBUG', prefix, args)
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' '))
    },
  }
}
