// Runtime configuration for Kimaki bot.
// Stores data directory path and provides accessors for other modules.
// Must be initialized before database or other path-dependent modules are used.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.kimaki')

let dataDir: string | null = null

/**
 * Get the data directory path.
 * Falls back to ~/.kimaki if not explicitly set.
 */
export function getDataDir(): string {
  if (!dataDir) {
    dataDir = DEFAULT_DATA_DIR
  }
  return dataDir
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

  dataDir = resolvedDir
}

/**
 * Get the projects directory path (for /create-new-project command).
 * Returns <dataDir>/projects
 */
export function getProjectsDir(): string {
  return path.join(getDataDir(), 'projects')
}

// Default verbosity for channels that haven't set a per-channel override.
// Set via --verbosity CLI flag at startup.
import type { VerbosityLevel } from './database.js'

let defaultVerbosity: VerbosityLevel = 'tools-and-text'

export function getDefaultVerbosity(): VerbosityLevel {
  return defaultVerbosity
}

export function setDefaultVerbosity(level: VerbosityLevel): void {
  defaultVerbosity = level
}

const DEFAULT_LOCK_PORT = 29988

/**
 * Derive a lock port from the data directory path.
 * Returns 29988 for the default ~/.kimaki directory (backwards compatible).
 * For custom data dirs, uses a hash to generate a port in the range 30000-39999.
 */
export function getLockPort(): number {
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
