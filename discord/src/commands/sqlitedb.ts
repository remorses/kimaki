// /sqlitedb command.
// Prints the current location of the SQLite database to the console.

import path from 'node:path'
import type { CommandContext } from './types.js'
import { getDataDir } from '../config.js'

/**
 * Handle the /sqlitedb slash command.
 * Displays the path to the SQLite database file.
 */
export async function handleSqliteDbCommand({ command }: CommandContext): Promise<void> {
  const dataDir = getDataDir()
  const dbPath = path.join(dataDir, 'discord-sessions.db')

  await command.reply({
    content: `SQLite database location:\n\`${dbPath}\``,
    ephemeral: true,
  })
}
