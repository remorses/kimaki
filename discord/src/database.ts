// SQLite database manager for persistent bot state.
// Stores thread-session mappings, bot tokens, channel directories,
// API keys, and model preferences in <dataDir>/discord-sessions.db.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'
import { getDataDir } from './config.js'

const dbLogger = createLogger('DB')

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    const dataDir = getDataDir()

    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch (error) {
      dbLogger.error(`Failed to create data directory ${dataDir}:`, error)
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
    } catch {
      // Column already exists, ignore
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_api_keys (
        app_id TEXT PRIMARY KEY,
        gemini_api_key TEXT,
        xai_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    runModelMigrations(db)
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

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
