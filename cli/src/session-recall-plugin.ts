// OpenCode plugin that provides session_recall tool for searching
// compacted/pruned conversation history in the current session.
//
// Exported from kimaki-opencode-plugin.ts.

import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import dedent from 'string-dedent'
import { z } from 'zod'
import { createPluginLogger } from './plugin-logger.js'

function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<string>
}) {
  return input
}

const logger = createPluginLogger('SESSION_RECALL')

async function loadDatabaseModule() {
  return import('./database.js')
}

const sessionRecallPlugin: Plugin = async () => {
  return {
    tools: {
      session_recall: tool({
        description: dedent`
          Search current session's conversation history, including messages
          that were compacted or summarized by OpenCode. Use when you've lost
          context about what was discussed earlier in this session — file paths,
          decisions, tool outputs, or specific details that may have been pruned.
          Returns matching text snippets with timestamps and role (user/assistant).
        `,
        args: {
          query: z
            .string()
            .min(1)
            .describe('Keyword or phrase to search for in session history'),
          role: z
            .enum(['user', 'assistant', 'tool'])
            .optional()
            .describe('Filter by message role'),
          limit: z
            .number()
            .optional()
            .describe('Max results to return (default 10, max 50)'),
        },
        async execute({ query, role, limit }, context) {
          try {
            const { searchSessionArchive } = await loadDatabaseModule()
            const results = await searchSessionArchive({
              sessionId: context.sessionID,
              query,
              role,
              limit,
            })
            if (results.length === 0) {
              return JSON.stringify({
                results: [],
                message: `No matches found for "${query}" in session history`,
              })
            }
            return JSON.stringify({
              results: results.map((r) => ({
                role: r.role,
                timestamp: new Date(r.timestamp).toISOString(),
                snippet: r.snippet,
              })),
              total: results.length,
            })
          } catch (error) {
            logger.error('session_recall failed', error)
            return JSON.stringify({
              results: [],
              error: error instanceof Error ? error.message : 'Session recall failed',
            })
          }
        },
      }),
    },
  }
}

export { sessionRecallPlugin }
