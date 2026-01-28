// Voice assistant tool definitions for the GenAI worker.
// Provides tools for managing OpenCode sessions (create, submit, abort),
// listing chats, searching files, and reading session messages.

import { tool } from 'ai'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  createOpencodeClient,
  type OpencodeClient,
  type AssistantMessage,
  type Provider,
} from '@opencode-ai/sdk'
import { createLogger, LogPrefix } from './logger.js'
import * as errore from 'errore'

const toolsLogger = createLogger(LogPrefix.TOOLS)

import { ShareMarkdown } from './markdown.js'
import { formatDistanceToNow } from './utils.js'
import pc from 'picocolors'
import { initializeOpencodeForDirectory, getOpencodeSystemMessage } from './discord-bot.js'

export async function getTools({
  onMessageCompleted,
  directory,
}: {
  directory: string
  onMessageCompleted?: (params: {
    sessionId: string
    messageId: string
    data?: { info: AssistantMessage }
    error?: unknown
    markdown?: string
  }) => void
}) {
  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    throw new Error(getClient.message)
  }
  const client = getClient()

  const markdownRenderer = new ShareMarkdown(client)

  const providersResponse = await client.config.providers({})
  const providers: Provider[] = providersResponse.data?.providers || []

  // Helper: get last assistant model for a session (non-summary)
  const getSessionModel = async (
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> => {
    const res = await getClient().session.messages({ path: { id: sessionId } })
    const data = res.data
    if (!data || data.length === 0) return undefined
    for (let i = data.length - 1; i >= 0; i--) {
      const info = data?.[i]?.info
      if (info?.role === 'assistant') {
        const ai = info as AssistantMessage
        if (!ai.summary && ai.providerID && ai.modelID) {
          return { providerID: ai.providerID, modelID: ai.modelID }
        }
      }
    }
    return undefined
  }

  const tools = {
    submitMessage: tool({
      description:
        'Submit a message to an existing chat session. Does not wait for the message to complete',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to send message to'),
        message: z.string().describe('The message text to send'),
      }),
      execute: async ({ sessionId, message }) => {
        const sessionModel = await getSessionModel(sessionId)

        // do not await
        getClient()
          .session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text', text: message }],
              model: sessionModel,
              system: getOpencodeSystemMessage({ sessionId }),
            },
          })
          .then(async (response) => {
            const markdownResult = await markdownRenderer.generate({
              sessionID: sessionId,
              lastAssistantOnly: true,
            })
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              data: response.data,
              markdown: errore.unwrapOr(markdownResult, ''),
            })
          })
          .catch((error) => {
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              error,
            })
          })
        return {
          success: true,
          sessionId,
          directive: 'Tell user that message has been sent successfully',
        }
      },
    }),

    createNewChat: tool({
      description:
        'Start a new chat session with an initial message. Does not wait for the message to complete',
      inputSchema: z.object({
        message: z.string().describe('The initial message to start the chat with'),
        title: z.string().optional().describe('Optional title for the session'),
        model: z
          .object({
            providerId: z.string().describe('The provider ID (e.g., "anthropic", "openai")'),
            modelId: z.string().describe('The model ID (e.g., "claude-opus-4-20250514", "gpt-5")'),
          })
          .optional()
          .describe('Optional model to use for this session'),
      }),
      execute: async ({ message, title }) => {
        if (!message.trim()) {
          throw new Error(`message must be a non empty string`)
        }

        try {
          const session = await getClient().session.create({
            body: {
              title: title || message.slice(0, 50),
            },
          })

          if (!session.data) {
            throw new Error('Failed to create session')
          }

          // do not await
          getClient()
            .session.prompt({
              path: { id: session.data.id },
              body: {
                parts: [{ type: 'text', text: message }],
                system: getOpencodeSystemMessage({ sessionId: session.data.id }),
              },
            })
            .then(async (response) => {
              const markdownResult = await markdownRenderer.generate({
                sessionID: session.data.id,
                lastAssistantOnly: true,
              })
              onMessageCompleted?.({
                sessionId: session.data.id,
                messageId: '',
                data: response.data,
                markdown: errore.unwrapOr(markdownResult, ''),
              })
            })
            .catch((error) => {
              onMessageCompleted?.({
                sessionId: session.data.id,
                messageId: '',
                error,
              })
            })

          return {
            success: true,
            sessionId: session.data.id,
            title: session.data.title,
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create chat session',
          }
        }
      },
    }),

    listChats: tool({
      description: 'Get a list of available chat sessions sorted by most recent',
      inputSchema: z.object({}),
      execute: async () => {
        toolsLogger.log(`Listing opencode sessions`)
        const sessions = await getClient().session.list()

        if (!sessions.data) {
          return { success: false, error: 'No sessions found' }
        }

        const sortedSessions = [...sessions.data]
          .sort((a, b) => {
            return b.time.updated - a.time.updated
          })
          .slice(0, 20)

        const sessionList = sortedSessions.map(async (session) => {
          const finishedAt = session.time.updated
          const status = await (async () => {
            if (session.revert) return 'error'
            const messagesResponse = await getClient().session.messages({
              path: { id: session.id },
            })
            const messages = messagesResponse.data || []
            const lastMessage = messages[messages.length - 1]
            if (lastMessage?.info.role === 'assistant' && !lastMessage.info.time.completed) {
              return 'in_progress'
            }
            return 'finished'
          })()

          return {
            id: session.id,
            folder: session.directory,
            status,
            finishedAt: formatDistanceToNow(new Date(finishedAt)),
            title: session.title,
            prompt: session.title,
          }
        })

        const resolvedList = await Promise.all(sessionList)

        return {
          success: true,
          sessions: resolvedList,
        }
      },
    }),

    searchFiles: tool({
      description: 'Search for files in a folder',
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe(
            'The folder path to search in, optional. only use if user specifically asks for it',
          ),
        query: z.string().describe('The search query for files'),
      }),
      execute: async ({ folder, query }) => {
        const results = await getClient().find.files({
          query: {
            query,
            directory: folder,
          },
        })

        return {
          success: true,
          files: results.data || [],
        }
      },
    }),

    readSessionMessages: tool({
      description: 'Read messages from a chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to read messages from'),
        lastAssistantOnly: z.boolean().optional().describe('Only read the last assistant message'),
      }),
      execute: async ({ sessionId, lastAssistantOnly = false }) => {
        if (lastAssistantOnly) {
          const messages = await getClient().session.messages({
            path: { id: sessionId },
          })

          if (!messages.data) {
            return { success: false, error: 'No messages found' }
          }

          const assistantMessages = messages.data.filter((m) => m.info.role === 'assistant')

          if (assistantMessages.length === 0) {
            return {
              success: false,
              error: 'No assistant messages found',
            }
          }

          const lastMessage = assistantMessages[assistantMessages.length - 1]
          const status =
            'completed' in lastMessage!.info.time && lastMessage!.info.time.completed
              ? 'completed'
              : 'in_progress'

          const markdownResult = await markdownRenderer.generate({
            sessionID: sessionId,
            lastAssistantOnly: true,
          })
          if (markdownResult instanceof Error) {
            throw new Error(markdownResult.message)
          }

          return {
            success: true,
            markdown: markdownResult,
            status,
          }
        } else {
          const markdownResult = await markdownRenderer.generate({
            sessionID: sessionId,
          })
          if (markdownResult instanceof Error) {
            throw new Error(markdownResult.message)
          }

          const messages = await getClient().session.messages({
            path: { id: sessionId },
          })
          const lastMessage = messages.data?.[messages.data.length - 1]
          const status =
            lastMessage?.info.role === 'assistant' &&
            lastMessage?.info.time &&
            'completed' in lastMessage.info.time &&
            !lastMessage.info.time.completed
              ? 'in_progress'
              : 'completed'

          return {
            success: true,
            markdown: markdownResult,
            status,
          }
        }
      },
    }),

    abortChat: tool({
      description: 'Abort/stop an in-progress chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to abort'),
      }),
      execute: async ({ sessionId }) => {
        try {
          toolsLogger.log(`[ABORT] reason=voice-tool sessionId=${sessionId} - user requested abort via voice assistant tool`)
          const result = await getClient().session.abort({
            path: { id: sessionId },
          })

          if (!result.data) {
            return {
              success: false,
              error: 'Failed to abort session',
            }
          }

          return {
            success: true,
            sessionId,
            message: 'Session aborted successfully',
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
          }
        }
      },
    }),

    getModels: tool({
      description: 'Get all available AI models from all providers',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const providersResponse = await getClient().config.providers({})
          const providers: Provider[] = providersResponse.data?.providers || []

          const models: Array<{ providerId: string; modelId: string }> = []

          providers.forEach((provider) => {
            if (provider.models && typeof provider.models === 'object') {
              Object.entries(provider.models).forEach(([modelId, model]) => {
                models.push({
                  providerId: provider.id,
                  modelId: modelId,
                })
              })
            }
          })

          return {
            success: true,
            models,
            totalCount: models.length,
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch models',
            models: [],
          }
        }
      },
    }),
  }

  return {
    tools,
    providers,
  }
}
