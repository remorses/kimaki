import { goke } from 'goke'
import { z } from 'zod'
import { createLogger, LogPrefix } from '../logger.js'
import { initDatabase } from '../discord-bot.js'
import { createDiscordRest } from '../discord-urls.js'
import { EXIT_NO_RESTART, resolveBotCredentials } from '../cli-runner.js'
import { listDiscordChannelThreads } from '../list-channel-threads.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'thread list',
    'List Discord threads in a channel. Use this to find a thread on another computer, then send with --thread.',
  )
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option('--json', 'Output as JSON')
  .option(
    '--limit <n>',
    z.number().default(50).describe('Maximum threads to show'),
  )
  .example('kimaki thread list --channel 123456789012345678')
  .example('kimaki thread list --channel 123456789012345678 --json')
  .action(async (options, { console, process }) => {
    try {
      if (!options.channel) {
        cliLogger.error(
          'Channel ID is required. Use --channel <channelId>. Find remote channels with `kimaki project list --all --json`.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      await initDatabase()
      const { token: botToken } = await resolveBotCredentials({})
      const rest = createDiscordRest(botToken)
      const listed = await listDiscordChannelThreads({
        rest,
        channelId: options.channel,
      })
      if (!listed.ok) {
        cliLogger.error(listed.error.message)
        process.exit(EXIT_NO_RESTART)
        return
      }

      const limited = listed.threads.slice(0, options.limit)
      if (options.json) {
        console.log(
          JSON.stringify(
            limited.map((thread) => ({
              thread_id: thread.id,
              name: thread.name,
              channel_id: thread.parentId,
              guild_id: thread.guildId,
              archived: thread.archived,
              archive_state: thread.archiveState,
              last_message_id: thread.lastMessageId,
            })),
            null,
            2,
          ),
        )
        process.exit(0)
      }

      if (limited.length === 0) {
        console.log(`No threads found in channel ${options.channel}`)
        process.exit(0)
      }

      for (const thread of limited) {
        const archivedTag = thread.archived ? ' [archived]' : ''
        console.log(`${thread.id} | ${thread.name}${archivedTag}`)
      }
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

export default cli
