import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from './logger.js'

const dbLogger = createLogger('DB')

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    const kimakiDir = path.join(os.homedir(), '.kimaki')

    try {
      fs.mkdirSync(kimakiDir, { recursive: true })
    } catch (error) {
      dbLogger.error('Failed to create ~/.kimaki directory:', error)
    }

    const dbPath = path.join(kimakiDir, 'discord-sessions.db')

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

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_api_keys (
        app_id TEXT PRIMARY KEY,
        gemini_api_key TEXT,
        xai_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
