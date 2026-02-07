// /upgrade-and-restart command - Upgrade kimaki to the latest version and restart the bot.
// Checks npm for a newer version, installs it globally, then restarts via SIGUSR2.

import type { CommandContext } from './types.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentVersion, upgrade } from '../upgrade.js'

const logger = createLogger(LogPrefix.CLI)

export async function handleUpgradeAndRestartCommand({ command }: CommandContext): Promise<void> {
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  logger.log('[UPGRADE] /upgrade-and-restart triggered')

  try {
    const currentVersion = getCurrentVersion()
    const newVersion = await upgrade()

    if (!newVersion) {
      await command.editReply({
        content: `Already on latest version: **v${currentVersion}**`,
      })
      return
    }

    await command.editReply({
      content: `Upgraded kimaki **v${currentVersion}** -> **v${newVersion}**. Restarting bot...`,
    })

    // Give Discord a moment to deliver the message, then restart
    setTimeout(() => {
      process.kill(process.pid, 'SIGUSR2')
    }, 1000)
  } catch (error) {
    logger.error('[UPGRADE] Failed:', error)
    await command.editReply({
      content: `Upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
