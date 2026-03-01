// Runtime configuration for Kimaki bot.
// Thin re-export layer over the centralized zustand store (store.ts).
// Getter/setter functions are kept for backwards compatibility so existing
// import sites don't need to change. They delegate to store.getState() and
// store.setState() under the hood.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from './store.js'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.kimaki')

/**
 * Get the data directory path.
 * Falls back to ~/.kimaki if not explicitly set.
 * Under vitest (KIMAKI_VITEST env var), auto-creates an isolated temp dir so
 * tests never touch the real ~/.kimaki/ database. Tests that need a specific
 * dir can still call setDataDir() before any DB access to override this.
 */
export function getDataDir(): string {
  const current = store.getState().dataDir
  if (current) {
    return current
  }
  if (process.env.KIMAKI_VITEST) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-test-'))
    store.setState({ dataDir: tmpDir })
    return tmpDir
  }
  store.setState({ dataDir: DEFAULT_DATA_DIR })
  return DEFAULT_DATA_DIR
}

/**
 * Set the data directory path.
 * Creates the directory if it doesn't exist.
 * Must be called before any database or path-dependent operations.
 */
export function setDataDir(dir: string): void {
  const resolvedDir = path.resolve(dir)

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
  }

  store.setState({ dataDir: resolvedDir })
}

/**
 * Get the projects directory path (for /create-new-project command).
 * Returns <dataDir>/projects
 */
export function getProjectsDir(): string {
  return path.join(getDataDir(), 'projects')
}

export type { RegisteredUserCommand } from './store.js'

const DEFAULT_LOCK_PORT = 29988

/**
 * Derive a lock port from the data directory path.
 * If KIMAKI_LOCK_PORT is set to a valid TCP port, it takes precedence.
 * Returns 29988 for the default ~/.kimaki directory (backwards compatible).
 * For custom data dirs, uses a hash to generate a port in the range 30000-39999.
 */
export function getLockPort(): number {
  const envPortRaw = process.env['KIMAKI_LOCK_PORT']
  if (envPortRaw) {
    const envPort = Number.parseInt(envPortRaw, 10)
    if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
      return envPort
    }
  }

  const dir = getDataDir()

  // Use original port for default data dir (backwards compatible)
  if (dir === DEFAULT_DATA_DIR) {
    return DEFAULT_LOCK_PORT
  }

  // Hash-based port for custom data dirs
  let hash = 0
  for (let i = 0; i < dir.length; i++) {
    const char = dir.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  // Map to port range 30000-39999
  return 30000 + (Math.abs(hash) % 10000)
}
