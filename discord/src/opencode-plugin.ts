// OpenCode plugin for Kimaki Discord bot.
// Provides tools for Discord integration like listing users for mentions.

import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { REST, Routes } from 'discord.js'

const kimakiPlugin: Plugin = async () => {
  const botToken = process.env.KIMAKI_BOT_TOKEN
  if (!botToken) {
    // No token available, skip Discord tools
    return {}
  }

  const rest = new REST().setToken(botToken)

  return {
    tool: {
      discord_list_users: tool({
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
    },
  }
}

export { kimakiPlugin }
