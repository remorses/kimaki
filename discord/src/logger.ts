// Prefixed logging utility using @clack/prompts.
// Creates loggers with consistent prefixes for different subsystems
// (DISCORD, VOICE, SESSION, etc.) for easier debugging.

import { log } from '@clack/prompts'

export function createLogger(prefix: string) {
  return {
    log: (...args: any[]) =>
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' ')),
    error: (...args: any[]) =>
      log.error([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' ')),
    warn: (...args: any[]) =>
      log.warn([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' ')),
    info: (...args: any[]) =>
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' ')),
    debug: (...args: any[]) =>
      log.info([`[${prefix}]`, ...args.map((arg) => String(arg))].join(' ')),
  }
}
