// Prefixed logger. Writes plain lines to <dataDir>/kimaki.log and colored
// clack-style lines to stderr, never stdout (CLI subcommands print
// machine-readable output there).
// Under vitest (KIMAKI_VITEST=1) stderr is silent unless KIMAKI_TEST_LOGS=1.
//
//   ●  12:03:44  MAIN        bot ready as Kimaki#1234
//   │  12:03:51  EVENTS      run started in thread 1557795126569476209 (ses_ee39ba467ff)
//   ▲  12:03:52  EFFECTS     send failed in 1557795126569476209: Discord send failed: Missing Permissions
//
// Error arguments are logged with their cause chain: tagged errors like
// "Discord send failed" say nothing without the cause.

import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { log as clackLog, S_BAR, S_ERROR, S_INFO, S_WARN } from '@clack/prompts'
import * as errore from 'errore'

import { ConfigError } from './errors.ts'

type LogArg = string | number | Error
type Level = 'log' | 'info' | 'warn' | 'error'
type Color = Parameters<typeof util.styleText>[0]

// One fd for the whole run. writeSync keeps lines ordered and on disk when the
// process crashes; a line costs a few microseconds and the bot logs little.
const logTarget: { fd: number | null } = { fd: null }

// Starts a fresh kimaki.log on every bot start. The previous run moves to
// kimaki.previous.log, so the reason of a crash survives the restart.
export function setLogFile({ dataDir }: { dataDir: string }): ConfigError | void {
  const file = path.join(dataDir, 'kimaki.log')
  const opened = errore.try(
    () => {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dataDir, 0o700)
      if (fs.existsSync(file)) fs.renameSync(file, path.join(dataDir, 'kimaki.previous.log'))
      const fd = fs.openSync(file, 'a', 0o600)
      fs.writeSync(fd, `--- kimaki log started at ${new Date().toISOString()} (PID ${process.pid}) ---\n`)
      return fd
    },
    (e) => new ConfigError({ reason: `Cannot write ${file}. Check --data-dir permissions`, cause: e }),
  )
  if (opened instanceof Error) return opened
  if (logTarget.fd !== null) fs.closeSync(logTarget.fd)
  logTarget.fd = opened
}

function stderrEnabled(): boolean {
  if (process.env['KIMAKI_VITEST'] !== '1') return true
  return process.env['KIMAKI_TEST_LOGS'] === '1'
}

// Respects NO_COLOR, FORCE_COLOR and a non-TTY stderr. Validated against
// stderr: the default stream is stdout, which is often piped.
function paint(color: Color, text: string): string {
  return util.styleText(color, text, { stream: process.stderr })
}

// "Discord send failed: Missing Permissions", like Go error wrapping.
function errorChain(error: Error): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current)
    messages.push(current.message)
  }
  return messages.join(': ')
}

// The deepest error carries the stack of the real failure.
function rootStack(error: Error): string | undefined {
  let current = error
  const seen = new Set<Error>([error])
  while (current.cause instanceof Error && !seen.has(current.cause)) {
    current = current.cause
    seen.add(current)
  }
  return current.stack?.split('\n').slice(1).join('\n')
}

const PREFIX_WIDTH = 10
const PREFIX_COLORS: Color[] = ['cyan', 'magenta', 'blue', 'green', 'cyanBright', 'magentaBright', 'blueBright']

// Stable per prefix, so each module keeps its color across lines and runs.
function prefixColor(prefix: string): Color {
  let hash = 0
  for (const char of prefix) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PREFIX_COLORS[hash % PREFIX_COLORS.length]!
}

const LEVELS: Record<Level, { symbol: string; color: Color; text: Color | null }> = {
  log: { symbol: S_BAR, color: 'gray', text: null },
  info: { symbol: S_INFO, color: 'blue', text: null },
  warn: { symbol: S_WARN, color: 'yellow', text: 'yellow' },
  error: { symbol: S_ERROR, color: 'red', text: 'red' },
}

// Session IDs and Discord snowflakes are dimmed so the words stand out.
const ID_PATTERN = /\bses_[A-Za-z0-9]+\b|\b\d{17,20}\b/g

function time(): string {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

function write({ level, prefix, args }: { level: Level; prefix: string; args: LogArg[] }) {
  // Strings joined by spaces; an Error after text is joined with ": ".
  const text = args
    .map((arg, index) => `${index === 0 ? '' : arg instanceof Error ? ': ' : ' '}${arg instanceof Error ? errorChain(arg) : String(arg)}`)
    .join('')
  const error = level === 'error' ? args.find((arg): arg is Error => arg instanceof Error) : undefined
  const stack = error && rootStack(error)
  const fd = logTarget.fd
  if (fd !== null) {
    const body = stack ? `${text}\n${stack}` : text
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${prefix}] ${body}\n`
    // A full disk must not crash the bot: stop file logging, stderr still gets the lines.
    const written = errore.try(() => fs.writeSync(fd, line))
    if (written instanceof Error) {
      logTarget.fd = null
      process.stderr.write(`Cannot write kimaki.log, file logging stopped: ${errorChain(written)}\n`)
    }
  }
  if (!stderrEnabled()) return
  const style = LEVELS[level]
  const highlighted = text.replace(ID_PATTERN, (id) => paint('dim', id))
  const head = `${paint('gray', time())}  ${paint(prefixColor(prefix), prefix.padEnd(PREFIX_WIDTH))}  `
  const lines = (style.text ? paint(style.text, highlighted) : highlighted).split('\n')
  if (stack) lines.push(...stack.split('\n').map((line) => paint('gray', line)))
  // Continuation lines align under the message.
  const indent = ' '.repeat(time().length + PREFIX_WIDTH + 4)
  clackLog.message(
    lines.map((line, index) => (index === 0 ? head + line : indent + line)),
    { symbol: paint(style.color, style.symbol), secondarySymbol: paint('gray', S_BAR), output: process.stderr, spacing: 0, withGuide: true },
  )
}

export function createLogger(prefix: string) {
  return {
    log: (...args: LogArg[]) => write({ level: 'log', prefix, args }),
    // Milestones: startup, connections, ready.
    info: (...args: LogArg[]) => write({ level: 'info', prefix, args }),
    warn: (...args: LogArg[]) => write({ level: 'warn', prefix, args }),
    error: (...args: LogArg[]) => write({ level: 'error', prefix, args }),
  }
}

export type Logger = ReturnType<typeof createLogger>
