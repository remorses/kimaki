// SQLite database manager for persistent bot state.
// Stores thread-session mappings, bot tokens, channel directories,
// API keys, and model preferences in <dataDir>/discord-sessions.db.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { getDataDir, getDefaultVerbosity } from './config.js'

const dbLogger = createLogger(LogPrefix.DB)

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    const dataDir = getDataDir()

    const mkdirError = errore.tryFn({
      try: () => {
        fs.mkdirSync(dataDir, { recursive: true })
      },
      catch: (e) => e as Error,
    })
    if (mkdirError instanceof Error) {
      dbLogger.error(`Failed to create data directory ${dataDir}:`, mkdirError.message)
    }

    const dbPath = path.join(dataDir, 'discord-sessions.db')

    dbLogger.log(`Opening database at: ${dbPath}`)
    db = new Database(dbPath)

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS part_messages (
        part_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_tokens (
        app_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_directories (
        channel_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Migration: add app_id column to channel_directories for multi-bot support
    try {
      db.exec(`ALTER TABLE channel_directories ADD COLUMN app_id TEXT`)
    } catch (error) {
      dbLogger.debug(
        'Failed to add app_id column to channel_directories (likely exists):',
        error instanceof Error ? error.message : String(error),
      )
    }

    // Table for threads that should auto-start a session (created by CLI without --notify-only)
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_auto_start (
        thread_id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_api_keys (
        app_id TEXT PRIMARY KEY,
        gemini_api_key TEXT,
        xai_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Track worktrees created for threads (for /new-worktree command)
    // status: 'pending' while creating, 'ready' when done, 'error' if failed
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_worktrees (
        thread_id TEXT PRIMARY KEY,
        worktree_name TEXT NOT NULL,
        worktree_directory TEXT,
        project_directory TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    runModelMigrations(db)
    runWorktreeSettingsMigrations(db)
    runVerbosityMigrations(db)
  }

  return db
}

/**
 * Run migrations for model preferences tables.
 * Called on startup and can be called on-demand.
 */
export function runModelMigrations(database?: Database.Database): void {
  const targetDb = database || getDatabase()

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS channel_models (
      channel_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS session_models (
      session_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS channel_agents (
      channel_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS session_agents (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  dbLogger.log('Model preferences migrations complete')
}

/**
 * Get the model preference for a channel.
 * @returns Model ID in format "provider_id/model_id" or undefined
 */
export function getChannelModel(channelId: string): string | undefined {
  const db = getDatabase()
  const row = db
    .prepare('SELECT model_id FROM channel_models WHERE channel_id = ?')
    .get(channelId) as { model_id: string } | undefined
  return row?.model_id
}

/**
 * Set the model preference for a channel.
 * @param modelId Model ID in format "provider_id/model_id"
 */
export function setChannelModel(channelId: string, modelId: string): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO channel_models (channel_id, model_id, updated_at) 
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(channel_id) DO UPDATE SET model_id = ?, updated_at = CURRENT_TIMESTAMP`,
  ).run(channelId, modelId, modelId)
}

/**
 * Get the model preference for a session.
 * @returns Model ID in format "provider_id/model_id" or undefined
 */
export function getSessionModel(sessionId: string): string | undefined {
  const db = getDatabase()
  const row = db
    .prepare('SELECT model_id FROM session_models WHERE session_id = ?')
    .get(sessionId) as { model_id: string } | undefined
  return row?.model_id
}

/**
 * Set the model preference for a session.
 * @param modelId Model ID in format "provider_id/model_id"
 */
export function setSessionModel(sessionId: string, modelId: string): void {
  const db = getDatabase()
  db.prepare(`INSERT OR REPLACE INTO session_models (session_id, model_id) VALUES (?, ?)`).run(
    sessionId,
    modelId,
  )
}

/**
 * Clear the model preference for a session.
 * Used when switching agents so the agent's model takes effect.
 */
export function clearSessionModel(sessionId: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM session_models WHERE session_id = ?').run(sessionId)
}

/**
 * Get the agent preference for a channel.
 */
export function getChannelAgent(channelId: string): string | undefined {
  const db = getDatabase()
  const row = db
    .prepare('SELECT agent_name FROM channel_agents WHERE channel_id = ?')
    .get(channelId) as { agent_name: string } | undefined
  return row?.agent_name
}

/**
 * Set the agent preference for a channel.
 */
export function setChannelAgent(channelId: string, agentName: string): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO channel_agents (channel_id, agent_name, updated_at) 
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(channel_id) DO UPDATE SET agent_name = ?, updated_at = CURRENT_TIMESTAMP`,
  ).run(channelId, agentName, agentName)
}

/**
 * Get the agent preference for a session.
 */
export function getSessionAgent(sessionId: string): string | undefined {
  const db = getDatabase()
  const row = db
    .prepare('SELECT agent_name FROM session_agents WHERE session_id = ?')
    .get(sessionId) as { agent_name: string } | undefined
  return row?.agent_name
}

/**
 * Set the agent preference for a session.
 */
export function setSessionAgent(sessionId: string, agentName: string): void {
  const db = getDatabase()
  db.prepare(`INSERT OR REPLACE INTO session_agents (session_id, agent_name) VALUES (?, ?)`).run(
    sessionId,
    agentName,
  )
}

// Worktree status types
export type WorktreeStatus = 'pending' | 'ready' | 'error'

export type ThreadWorktree = {
  thread_id: string
  worktree_name: string
  worktree_directory: string | null
  project_directory: string
  status: WorktreeStatus
  error_message: string | null
}

/**
 * Get the worktree info for a thread.
 */
export function getThreadWorktree(threadId: string): ThreadWorktree | undefined {
  const db = getDatabase()
  return db.prepare('SELECT * FROM thread_worktrees WHERE thread_id = ?').get(threadId) as
    | ThreadWorktree
    | undefined
}

/**
 * Create a pending worktree entry for a thread.
 */
export function createPendingWorktree({
  threadId,
  worktreeName,
  projectDirectory,
}: {
  threadId: string
  worktreeName: string
  projectDirectory: string
}): void {
  const db = getDatabase()
  db.prepare(
    `INSERT OR REPLACE INTO thread_worktrees (thread_id, worktree_name, project_directory, status) VALUES (?, ?, ?, 'pending')`,
  ).run(threadId, worktreeName, projectDirectory)
}

/**
 * Mark a worktree as ready with its directory.
 */
export function setWorktreeReady({
  threadId,
  worktreeDirectory,
}: {
  threadId: string
  worktreeDirectory: string
}): void {
  const db = getDatabase()
  db.prepare(
    `UPDATE thread_worktrees SET worktree_directory = ?, status = 'ready' WHERE thread_id = ?`,
  ).run(worktreeDirectory, threadId)
}

/**
 * Mark a worktree as failed with error message.
 */
export function setWorktreeError({
  threadId,
  errorMessage,
}: {
  threadId: string
  errorMessage: string
}): void {
  const db = getDatabase()
  db.prepare(`UPDATE thread_worktrees SET status = 'error', error_message = ? WHERE thread_id = ?`).run(
    errorMessage,
    threadId,
  )
}

/**
 * Delete the worktree info for a thread.
 */
export function deleteThreadWorktree(threadId: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM thread_worktrees WHERE thread_id = ?').run(threadId)
}

/**
 * Run migrations for channel worktree settings table.
 * Called on startup. Allows per-channel opt-in for automatic worktree creation.
 */
export function runWorktreeSettingsMigrations(database?: Database.Database): void {
  const targetDb = database || getDatabase()

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS channel_worktrees (
      channel_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  dbLogger.log('Channel worktree settings migrations complete')
}

// Verbosity levels for controlling output detail
// - tools-and-text: shows all output including tool executions
// - text-and-essential-tools: shows text + edits + custom MCP tools, hides read/search/navigation tools
// - text-only: only shows text responses (⬥ diamond parts)
export type VerbosityLevel = 'tools-and-text' | 'text-and-essential-tools' | 'text-only'

export function runVerbosityMigrations(database?: Database.Database): void {
  const targetDb = database || getDatabase()

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS channel_verbosity (
      channel_id TEXT PRIMARY KEY,
      verbosity TEXT NOT NULL DEFAULT 'tools-and-text',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  dbLogger.log('Channel verbosity settings migrations complete')
}

/**
 * Get the verbosity setting for a channel.
 * Falls back to the global default set via --verbosity CLI flag if no per-channel override exists.
 */
export function getChannelVerbosity(channelId: string): VerbosityLevel {
  const db = getDatabase()
  const row = db
    .prepare('SELECT verbosity FROM channel_verbosity WHERE channel_id = ?')
    .get(channelId) as { verbosity: string } | undefined
  if (row?.verbosity) {
    return row.verbosity as VerbosityLevel
  }
  return getDefaultVerbosity()
}

/**
 * Set the verbosity setting for a channel.
 */
export function setChannelVerbosity(channelId: string, verbosity: VerbosityLevel): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO channel_verbosity (channel_id, verbosity, updated_at) 
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(channel_id) DO UPDATE SET verbosity = ?, updated_at = CURRENT_TIMESTAMP`,
  ).run(channelId, verbosity, verbosity)
}

/**
 * Check if automatic worktree creation is enabled for a channel.
 */
export function getChannelWorktreesEnabled(channelId: string): boolean {
  const db = getDatabase()
  const row = db
    .prepare('SELECT enabled FROM channel_worktrees WHERE channel_id = ?')
    .get(channelId) as { enabled: number } | undefined
  return row?.enabled === 1
}

/**
 * Enable or disable automatic worktree creation for a channel.
 */
export function setChannelWorktreesEnabled(channelId: string, enabled: boolean): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO channel_worktrees (channel_id, enabled, updated_at) 
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(channel_id) DO UPDATE SET enabled = ?, updated_at = CURRENT_TIMESTAMP`,
  ).run(channelId, enabled ? 1 : 0, enabled ? 1 : 0)
}

/**
 * Get the directory and app_id for a channel from the database.
 * This is the single source of truth for channel-project mappings.
 */
export function getChannelDirectory(channelId: string): {
  directory: string
  appId: string | null
} | undefined {
  const db = getDatabase()
  const row = db
    .prepare('SELECT directory, app_id FROM channel_directories WHERE channel_id = ?')
    .get(channelId) as { directory: string; app_id: string | null } | undefined

  if (!row) {
    return undefined
  }

  return {
    directory: row.directory,
    appId: row.app_id,
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
