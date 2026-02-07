// Kimaki self-upgrade utilities.
// Detects the package manager used to install kimaki, checks npm for newer versions,
// and runs the global upgrade command. Used by both CLI `kimaki upgrade` and
// the Discord `/upgrade-and-restart` command, plus background auto-upgrade on startup.

import { createRequire } from 'node:module'
import { createLogger, LogPrefix } from './logger.js'
import { execAsync } from './worktree-utils.js'

const logger = createLogger(LogPrefix.CLI)

type Pm = 'bun' | 'pnpm' | 'npm'

export function detectPm(): Pm {
  const ua = process.env.npm_config_user_agent
  if (ua?.startsWith('bun/')) {
    return 'bun'
  }
  if (ua?.startsWith('pnpm/')) {
    return 'pnpm'
  }
  if (ua?.startsWith('npm/')) {
    return 'npm'
  }

  const exec = process.execPath.toLowerCase()
  if (exec.includes('bun')) {
    return 'bun'
  }
  if (exec.includes('pnpm')) {
    return 'pnpm'
  }
  if (exec.includes('npm')) {
    return 'npm'
  }

  return 'bun'
}

export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version: string }
  return pkg.version
}

export async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/kimaki/latest', {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

// Returns the new version string if upgraded, null if already up to date.
export async function upgrade(): Promise<string | null> {
  const current = getCurrentVersion()
  const latest = await getLatestNpmVersion()
  if (!latest) {
    throw new Error('Failed to check latest version from npm')
  }
  if (current === latest) {
    return null
  }

  const pm = detectPm()
  logger.log(`Upgrading kimaki from v${current} to v${latest} using ${pm}...`)
  await execAsync(`${pm} i -g kimaki@latest`, { timeout: 120_000 })

  return latest
}

// Fire-and-forget background upgrade check on bot startup.
// Only upgrades if a newer version is available. Errors are silently ignored.
export async function backgroundUpgradeKimaki(): Promise<void> {
  try {
    const current = getCurrentVersion()
    const latest = await getLatestNpmVersion()
    if (!latest || current === latest) {
      return
    }

    const pm = detectPm()
    logger.debug(`Background kimaki upgrade started: v${current} -> v${latest}`)
    await execAsync(`${pm} i -g kimaki@latest`, { timeout: 120_000 })
    logger.debug(`Background kimaki upgrade completed: v${latest}`)
  } catch {
    // silently ignored, non-critical
  }
}
