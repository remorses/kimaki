// Prefixed logger. Writes to <dataDir>/kimaki.log and stderr, never stdout
// (CLI subcommands print machine-readable output there).
// Under vitest (KIMAKI_VITEST=1) stderr is silent unless KIMAKI_TEST_LOGS=1.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'

import { ConfigError } from './errors.ts'

const logTarget: { file: string | null } = { file: null }

// Reset the log file on every bot start, like V1.
export function setLogFile({ dataDir }: { dataDir: string }): ConfigError | void {
  const file = path.join(dataDir, 'kimaki.log')
  const created = errore.try(
    () => {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dataDir, 0o700)
      fs.writeFileSync(file, '')
    },
    (e) => new ConfigError({ reason: `Cannot write ${file}. Check --data-dir permissions`, cause: e }),
  )
  if (created instanceof Error) return created
  logTarget.file = file
}

function stderrEnabled(): boolean {
  if (process.env['KIMAKI_VITEST'] !== '1') return true
  return process.env['KIMAKI_TEST_LOGS'] === '1'
}

function write({ level, prefix, args }: { level: string; prefix: string; args: string[] }) {
  const text = args.join(' ')
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
    log: (...args: string[]) => write({ level: 'info', prefix, args }),
    warn: (...args: string[]) => write({ level: 'warn', prefix, args }),
    error: (...args: string[]) => write({ level: 'error', prefix, args }),
  }
}

export type Logger = ReturnType<typeof createLogger>
