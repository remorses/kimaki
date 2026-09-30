// Prefixed logger. Writes to <dataDir>/kimaki.log and stderr, never stdout
// (CLI subcommands print machine-readable output there).
// Under vitest (KIMAKI_VITEST=1) stderr is silent unless KIMAKI_TEST_LOGS=1.

import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

const logTarget: { file: string | null } = { file: null }

// Reset the log file on every bot start, like V1.
export function setLogFile({ dataDir }: { dataDir: string }): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'kimaki.log')
  fs.writeFileSync(file, '')
  logTarget.file = file
}

function stderrEnabled(): boolean {
  if (process.env['KIMAKI_VITEST'] !== '1') return true
  return process.env['KIMAKI_TEST_LOGS'] === '1'
}

function write({ level, prefix, args }: { level: string; prefix: string; args: unknown[] }) {
  const text = util.format(...args)
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${prefix.padEnd(8)}] ${text}\n`
  if (logTarget.file) {
    fs.appendFile(logTarget.file, line, () => {})
  }
  if (stderrEnabled()) {
    process.stderr.write(line)
  }
}

export function createLogger(prefix: string) {
  return {
    log: (...args: unknown[]) => write({ level: 'info', prefix, args }),
    warn: (...args: unknown[]) => write({ level: 'warn', prefix, args }),
    error: (...args: unknown[]) => write({ level: 'error', prefix, args }),
  }
}

export type Logger = ReturnType<typeof createLogger>
