// Forum sync configuration from SQLite database.
// Reads forum_sync_configs table and resolves relative output dirs.
// On first run, migrates any existing forum-sync.json into the DB.

import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { getDataDir } from '../config.js'
import { getForumSyncConfigs, upsertForumSyncConfig } from '../database.js'
import { createLogger } from '../logger.js'
import type { ForumSyncDirection, LoadedForumConfig } from './types.js'

const forumLogger = createLogger('FORUM')

const LEGACY_CONFIG_FILE = 'forum-sync.json'

function isForumSyncDirection(value: unknown): value is ForumSyncDirection {
  return value === 'discord-to-files' || value === 'bidirectional'
}

function resolveOutputDir(outputDir: string): string {
  if (path.isAbsolute(outputDir)) return outputDir
  return path.resolve(getDataDir(), outputDir)
}

/**
 * One-time migration: if the legacy forum-sync.json exists, import its entries
 * into the DB and rename the file so it's not re-imported on next startup.
 */
async function migrateLegacyConfig({ appId }: { appId: string }) {
  const configPath = path.join(getDataDir(), LEGACY_CONFIG_FILE)
  if (!fs.existsSync(configPath)) return

  forumLogger.log(`Migrating legacy ${LEGACY_CONFIG_FILE} into database...`)

  const raw = fs.readFileSync(configPath, 'utf8')
  let parsed: unknown
  try {
    parsed = YAML.parse(raw)
  } catch {
    forumLogger.warn(
      `Failed to parse legacy ${LEGACY_CONFIG_FILE}, skipping migration`,
    )
    return
  }

  if (!parsed || typeof parsed !== 'object') return
  const forums = (parsed as Record<string, unknown>).forums
  if (!Array.isArray(forums)) return

  for (const item of forums) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const forumChannelId =
      typeof entry.forumChannelId === 'string' ? entry.forumChannelId : ''
    const outputDir = typeof entry.outputDir === 'string' ? entry.outputDir : ''
    const direction = isForumSyncDirection(entry.direction)
      ? entry.direction
      : 'bidirectional'
    if (!forumChannelId || !outputDir) continue

    await upsertForumSyncConfig({
      appId,
      forumChannelId,
      outputDir: resolveOutputDir(outputDir),
      direction,
    })
  }

  // Rename so we don't re-import next time
  const backupPath = configPath + '.migrated'
  fs.renameSync(configPath, backupPath)
  forumLogger.log(
    `Legacy config migrated and renamed to ${path.basename(backupPath)}`,
  )
}

export async function readForumSyncConfig({ appId }: { appId?: string }) {
  if (!appId) return []

  // Migrate legacy JSON file on first run
  await migrateLegacyConfig({ appId })

  const rows = await getForumSyncConfigs({ appId })
  return rows.map<LoadedForumConfig>((row) => ({
    forumChannelId: row.forumChannelId,
    outputDir: resolveOutputDir(row.outputDir),
    direction: isForumSyncDirection(row.direction)
      ? row.direction
      : 'bidirectional',
  }))
}
