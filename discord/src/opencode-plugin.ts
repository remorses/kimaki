// OpenCode plugin for Kimaki Discord bot.
// Provides tools for Discord integration like listing users for mentions.

import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { REST, Routes } from 'discord.js'
import { getPrisma } from './database.js'
import { setDataDir } from './config.js'
import { ShareMarkdown } from './markdown.js'

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
          guildId: tool.schema.string().describe('Discord guild/server ID'),
          query: tool.schema
            .string()
            .optional()
            .describe('Search query to filter users by name (optional, returns first 20 if not provided)'),
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
            return query ? `No users found matching "${query}"` : 'No users found in guild'
          }

          const userList = members
            .map((m) => {
              const displayName = m.nick || m.user.global_name || m.user.username
              return `- ${displayName} (ID: ${m.user.id}) - mention: <@${m.user.id}>`
            })
            .join('\n')

          const header = query ? `Found ${members.length} users matching "${query}":` : `Found ${members.length} users:`

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
                try {
                  const channel = (await rest.get(Routes.channel(threadId))) as {
                    id: string
                    parent_id?: string
                  }
                  return channel.parent_id || channel.id
                } catch {
                  return threadId
                }
              })()
              return `- ${session.id} | ${session.title || 'Untitled Session'} | cwd: ${session.directory} | updated ${updatedAt} | source: ${origin} | thread: ${threadId} | channel: ${channelId}`
            }),
          )
          return lines.join('\n')
        },
      }),
      kimaki_read_session: tool({
        description:
          'Read the full conversation of another OpenCode session as markdown, using Kimaki\'s markdown serializer.',
        args: {
          sessionId: tool.schema.string().describe('Session ID to read'),
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
          return result
        },
      }),
    },
  }
}

export { kimakiPlugin }
