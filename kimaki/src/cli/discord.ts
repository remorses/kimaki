// Discord-facing commands: agent UI (buttons, upload requests) through the
// running bot, plus thread/user lookups and uploads with the saved bot token.

import path from 'node:path'
import { ChannelType } from 'discord-api-types/v10'
import { wrapJsonSchema, type Goke } from 'goke'

import { action, DATA_DIR_HELP, discordApi, fail, isThread, printRows, SESSION_HELP, targetOrEnv } from './shared.ts'

// From an agent shell the bot waits for this shell's tool line, so the UI posts after it.
function agentShell() {
  return { fromShell: Boolean(process.env['OPENCODE_SESSION_ID']), toolCall: process.env['KIMAKI_TOOL_CALL'] }
}

// buttons, upload-request
export function registerAgentUiCommands(cli: Goke) {
  cli.command('buttons', 'Show 1-3 action buttons. Call last, after visible text')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .option('-b, --button <spec>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: "Repeatable: Label[:white|blue|green|red]" }))
    .action(async (options) => {
      await action({ route: 'buttons', dataDir: options.dataDir, input: { ...targetOrEnv(options.session), buttons: options.button ?? [], ...agentShell() } })
    })

  cli.command('upload-request', 'Ask for file uploads; waits up to 6 minutes. Shell timeout must be 10 minutes')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .option('-p, --prompt <text>', 'Text above the upload button')
    .option('--max-files <n>', '1 to 10 (default: 5)')
    .action(async (options) => {
      const input = { ...targetOrEnv(options.session), prompt: options.prompt ?? '', maxFiles: Number(options.maxFiles ?? 5), ...agentShell() }
      await action({ route: 'upload-request', dataDir: options.dataDir, input, signal: AbortSignal.timeout(7 * 60_000) })
    })
}

// thread list, user list, upload-to-discord
export function registerDiscordCommands(cli: Goke) {
  cli.command('thread list', 'List active and optionally archived threads in a channel')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Channel to list')
    .option('--archived', 'Include archived threads')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const channelId = options.channel
      if (!channelId) fail(new Error('Pass --channel <id>'))
      const { api } = await discordApi(options.dataDir)
      const channel = await api.channels.get(channelId).catch((error: Error) => error)
      if (channel instanceof Error) fail(channel)
      if (channel.type !== ChannelType.GuildText || !channel.guild_id) fail(new Error('Use a guild text channel'))
      const active = await api.guilds.getActiveThreads(channel.guild_id).catch((error: Error) => error)
      if (active instanceof Error) fail(active)
      const threads = active.threads.filter((thread) => isThread(thread) && thread.parent_id === channelId)
      // Archived threads come in pages of 100, keyed by the last archive timestamp.
      if (options.archived) {
        let before: string | undefined
        do {
          const archived = await api.channels.getArchivedThreads(channelId, 'public', { limit: 100, before }).catch((error: Error) => error)
          if (archived instanceof Error) fail(archived)
          threads.push(...archived.threads)
          const last = archived.threads.at(-1)
          before = archived.has_more && last && isThread(last) ? last.thread_metadata?.archive_timestamp : undefined
        } while (before)
      }
      printRows({ json: options.json, rows: threads, line: (thread) => `${thread.id} ${thread.name}` })
    })

  cli.command('user list', 'Find Discord users for mentions')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-g, --guild <id>', 'Guild to search')
    .option('-q, --query <text>', 'Name filter')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      if (!options.guild) fail(new Error('Pass --guild <id>'))
      const { api } = await discordApi(options.dataDir)
      const members = options.query
        ? await api.guilds.searchForMembers(options.guild, { query: options.query, limit: 1000 }).catch((error: Error) => error)
        : await api.guilds.getMembers(options.guild, { limit: 1000 }).catch((error: Error) => error)
      if (members instanceof Error) fail(members)
      const users = members.map((member) => ({ id: member.user.id, username: member.user.username, name: member.nick ?? member.user.global_name }))
      printRows({ json: options.json, rows: users, line: (user) => `${user.id} ${user.username}${user.name ? ` (${user.name})` : ''}` })
    })

  cli.command('upload-to-discord <...files>', 'Attach local files to a session thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .action(async (files, options) => {
      const target = targetOrEnv(options.session)
      const id = target.sessionId ?? target.threadId
      if (!id) fail(new Error('Use --session or run inside an OpenCode session'))
      const input = { id, files: files.map((file) => ({ path: path.resolve(file), name: path.basename(file) })) }
      // Waits for Discord: big files and a busy thread take longer than the 30s default.
      await action({ route: 'upload', dataDir: options.dataDir, input, signal: AbortSignal.timeout(5 * 60_000) })
    })
}
