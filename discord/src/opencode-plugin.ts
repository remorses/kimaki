// OpenCode plugin for Kimaki Discord bot.
// Provides tools for Discord integration like listing users for mentions.

import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import { z } from 'zod'

// Inlined from '@opencode-ai/plugin/tool' because the subpath value import
// fails at runtime in global npm installs (#35). Opencode loads this plugin
// file in its own process and resolves modules from kimaki's install dir,
// but the '/tool' subpath export isn't found by opencode's module resolver.
// The type-only imports above are fine (erased at compile time).
// The opencode docs recommend `import { tool } from '@opencode-ai/plugin'`
// (main entry) but their index.d.ts uses `export * from "./tool"` which
// doesn't re-export the tool function under nodenext resolution because
// tool is a merged function+namespace declaration.
function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
}) {
  return input
}
import { createOpencodeClient } from '@opencode-ai/sdk'
import { REST, Routes } from 'discord.js'
import * as errore from 'errore'
import fs from 'node:fs'
import path from 'node:path'
import { getPrisma } from './database.js'
import { setDataDir } from './config.js'
import { ShareMarkdown } from './markdown.js'
import { reactToThread } from './discord-utils.js'

// Regex to match emoji characters (covers most common emojis)
// Includes: emoji presentation sequences, skin tone modifiers, ZWJ sequences, regional indicators
const EMOJI_REGEX =
  /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Regional_Indicator}{2}|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|[\u{1F3FB}-\u{1F3FF}]|(?:\p{Emoji}(?:\u{200D}\p{Emoji})+))$/u

function isEmoji(str: string): boolean {
  return EMOJI_REGEX.test(str)
}

const kimakiPlugin: Plugin = async () => {
  const botToken = process.env.KIMAKI_BOT_TOKEN
  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
  }
  if (!botToken) {
    // No token available, skip Discord tools
    return {}
  }

  const rest = new REST().setToken(botToken)
  const port = process.env.OPENCODE_PORT
  const client = port
    ? createOpencodeClient({
        baseUrl: `http://127.0.0.1:${port}`,
      })
    : null

  return {
    tool: {
      kimaki_list_discord_users: tool({
        description:
          'Search for Discord users in a guild/server. Returns user IDs needed for mentions (<@userId>). Use the guildId from the system message.',
        args: {
          guildId: z.string().describe('Discord guild/server ID'),
          query: z
            .string()
            .optional()
            .describe(
              'Search query to filter users by name (optional, returns first 20 if not provided)',
            ),
        },
        async execute({ guildId, query }) {
          type GuildMember = {
            user: { id: string; username: string; global_name?: string }
            nick?: string
          }

          const members: GuildMember[] = await (async () => {
            if (query) {
              return (await rest.get(Routes.guildMembersSearch(guildId), {
                query: new URLSearchParams({ query, limit: '20' }),
              })) as GuildMember[]
            }
            // No query, list first 20 members
            return (await rest.get(Routes.guildMembers(guildId), {
              query: new URLSearchParams({ limit: '20' }),
            })) as GuildMember[]
          })()

          if (members.length === 0) {
            return query
              ? `No users found matching "${query}"`
              : 'No users found in guild'
          }

          const userList = members
            .map((m) => {
              const displayName =
                m.nick || m.user.global_name || m.user.username
              return `- ${displayName} (ID: ${m.user.id}) - mention: <@${m.user.id}>`
            })
            .join('\n')

          const header = query
            ? `Found ${members.length} users matching "${query}":`
            : `Found ${members.length} users:`

          return `${header}\n${userList}`
        },
      }),
      kimaki_list_sessions: tool({
        description:
          'List other OpenCode sessions in this project, showing IDs, titles, and whether they were started by Kimaki.',
        args: {},
        async execute() {
          if (!client) {
            return 'OpenCode client not available in plugin (missing OPENCODE_PORT)'
          }
          const sessionsResponse = await client.session.list()
          const sessions = sessionsResponse.data || []
          if (sessions.length === 0) {
            return 'No sessions found'
          }
          const prisma = await getPrisma()
          const threadSessions = await prisma.thread_sessions.findMany({
            select: { thread_id: true, session_id: true },
          })
          const sessionToThread = new Map(
            threadSessions
              .filter((row) => row.session_id !== '')
              .map((row) => {
                return [row.session_id, row.thread_id]
              }),
          )
          const lines = await Promise.all(
            sessions.map(async (session) => {
              const threadId = sessionToThread.get(session.id)
              const startedWithKimaki = Boolean(threadId)
              const origin = startedWithKimaki ? 'kimaki' : 'opencode'
              const updatedAt = new Date(session.time.updated).toISOString()
              if (!threadId) {
                return `- ${session.id} | ${session.title || 'Untitled Session'} | cwd: ${session.directory} | updated ${updatedAt} | source: ${origin}`
              }
              const channelId = await (async () => {
                const result = await errore.tryAsync({
                  try: async () => {
                    const channel = (await rest.get(Routes.channel(threadId))) as {
                      id: string
                      parent_id?: string
                    }
                    return channel.parent_id || channel.id
                  },
                  catch: (e) => new Error(`Failed to get channel ${threadId}`, { cause: e }),
                })
                if (errore.isError(result)) {
                  console.warn(`[kimaki_list_sessions] ${result.message}`)
                  return threadId
                }
                return result
              })()
              return `- ${session.id} | ${session.title || 'Untitled Session'} | cwd: ${session.directory} | updated ${updatedAt} | source: ${origin} | thread: ${threadId} | channel: ${channelId}`
            }),
          )
          return lines.join('\n')
        },
      }),
      kimaki_read_session: tool({
        description:
          "Read the full conversation of another OpenCode session as markdown, using Kimaki's markdown serializer.",
        args: {
          sessionId: z.string().describe('Session ID to read'),
        },
        async execute({ sessionId }) {
          if (!client) {
            return 'OpenCode client not available in plugin (missing OPENCODE_PORT)'
          }
          const markdown = new ShareMarkdown(client)
          const result = await markdown.generate({ sessionID: sessionId })
          if (result instanceof Error) {
            return result.message
          }
          if (result.length > 100000) {
            const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_')
            const outputDir = path.join(process.cwd(), 'tmp')
            const outputPath = path.join(outputDir, `session-${safeId}.md`)
            try {
              fs.mkdirSync(outputDir, { recursive: true })
              fs.writeFileSync(outputPath, result, 'utf8')
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              return `Session is over 100000 characters, but failed to write full output: ${message}`
            }
            const preview = result.split('\n').slice(0, 10).join('\n')
            return `${preview}\n\nFull session written to ${outputPath} to read in full.`
          }
          return result
        },
      }),
      kimaki_mark_thread: tool({
        description:
          'Mark the current Discord thread with emoji reactions and update the session title. Only pass emoji characters (e.g., "🚀", "🐛", "📦"). Do NOT use ✅ as it is reserved for "session completed" indicator. This lets users create custom tagging systems visible in both Discord and OpenCode.',
        args: {
          emojis: z
            .array(z.string())
            .describe(
              'Array of emoji characters to add as reactions and prepend to session title. Only emojis allowed, no text.',
            ),
        },
        async execute({ emojis }, context) {
          if (!emojis || emojis.length === 0) {
            return 'No emojis provided'
          }

          // Validate all inputs are emojis
          const invalidEmojis = emojis.filter((e) => {
            return !isEmoji(e)
          })
          if (invalidEmojis.length > 0) {
            throw new Error(
              `Invalid emoji characters: ${invalidEmojis.join(', ')}. Only emoji characters are allowed.`,
            )
          }

          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          // Add reactions to thread starter message (reactToThread handles errors internally)
          const addedEmojis: string[] = []
          for (const emoji of emojis) {
            await reactToThread({ rest, threadId: row.thread_id, emoji })
            addedEmojis.push(emoji)
          }

          // Update session title with emoji prefix
          if (client && addedEmojis.length > 0) {
            const updateResult = await errore.tryAsync({
              try: async () => {
                const sessionResponse = await client.session.get({
                  path: { id: context.sessionID },
                })
                if (sessionResponse.data) {
                  const currentTitle = sessionResponse.data.title || ''
                  const emojiPrefix = addedEmojis.join('')
                  // Avoid duplicating emojis if they're already at the start
                  const newTitle = currentTitle.startsWith(emojiPrefix)
                    ? currentTitle
                    : `${emojiPrefix} ${currentTitle}`.trim()
                  await client.session.update({
                    path: { id: context.sessionID },
                    body: { title: newTitle },
                  })
                }
              },
              catch: (e) => new Error('Failed to update session title', { cause: e }),
            })
            if (errore.isError(updateResult)) {
              console.warn(`[kimaki_mark_thread] ${updateResult.message}`)
            }
          }

          return addedEmojis.length > 0
            ? `Marked thread with: ${addedEmojis.join(' ')}`
            : 'Failed to add any emoji reactions'
        },
      }),
      kimaki_archive_thread: tool({
        description:
          'Archive the current Discord thread to hide it from the Discord left sidebar. Only call this when the user explicitly asks to close or archive the thread, typically after committing and pushing changes. This tool also aborts the current session, so it should ALWAYS be called as the last tool in your response.',
        args: {},
        async execute(_args, context) {
          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          // React with folder emoji on the thread starter message
          await reactToThread({ rest, threadId: row.thread_id, emoji: '📁' })

          // Update session title with folder emoji prefix
          if (client) {
            const updateResult = await errore.tryAsync({
              try: async () => {
                const sessionResponse = await client.session.get({
                  path: { id: context.sessionID },
                })
                if (sessionResponse.data) {
                  const currentTitle = sessionResponse.data.title || ''
                  const newTitle = currentTitle.startsWith('📁')
                    ? currentTitle
                    : `📁 ${currentTitle}`.trim()
                  await client.session.update({
                    path: { id: context.sessionID },
                    body: { title: newTitle },
                  })
                }
              },
              catch: (e) => new Error('Failed to update session title', { cause: e }),
            })
            if (errore.isError(updateResult)) {
              console.warn(`[kimaki_archive_thread] ${updateResult.message}`)
            }
          }

          await client?.session.abort({ path: { id: context.sessionID } })

          // close after we sent completed message
          setTimeout(async () => {
            await rest.patch(Routes.channel(row.thread_id), {
              body: { archived: true },
            })
          }, 1000 * 1)

          return 'Thread archived and session stopped'
        },
      }),
    },
  }
}

export { kimakiPlugin }
