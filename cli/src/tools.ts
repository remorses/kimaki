// Voice assistant tool definitions for the GenAI worker.
// Provides tools for managing OpenCode sessions (create, submit, abort),
// listing chats, searching files, and reading session messages.

import { tool } from './ai-tool.js'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { SessionLogOutput } from '@opencode/client'
import type { OpencodeClient } from './opencode.js'
import { createLogger, LogPrefix } from './logger.js'
import * as errore from 'errore'
import { getDataDir } from './config.js'
import {
  getOpencodeSystemMessage,
  KIMAKI_INSTRUCTION_ENTRY_KEY,
} from './system-message.js'
import { OpenCodeSdkError } from './errors.js'

const toolsLogger = createLogger(LogPrefix.TOOLS)

class VoicePromptExecutionError extends errore.createTaggedError({
  name: 'VoicePromptExecutionError',
}) {}

export function deriveVoicePromptTerminal({
  events,
  sessionId,
  inboxId,
}: {
  events: SessionLogOutput[]
  sessionId: string
  inboxId: string
}) {
  const delivered = events.find((event) => {
    return event.type === 'session.inbox.delivered'
      && event.data.sessionID === sessionId
      && event.data.inboxID === inboxId
  })
  if (!delivered || delivered.type !== 'session.inbox.delivered') {
    return new VoicePromptExecutionError({
      message: `Voice prompt inbox item ${inboxId} was not delivered`,
    })
  }

  const terminal = events.find((event) => {
    if (event.type === 'log.synced' || event.durable.seq <= delivered.durable.seq) return false
    if (event.type !== 'session.execution.succeeded'
      && event.type !== 'session.execution.failed'
      && event.type !== 'session.execution.interrupted') return false
    return event.data.sessionID === sessionId
  })
  if (!terminal) {
    return new VoicePromptExecutionError({
      message: `Voice prompt inbox item ${inboxId} has no terminal execution`,
    })
  }
  if (terminal.type === 'session.execution.failed') {
    return new VoicePromptExecutionError({
      message: `Voice prompt execution failed: ${terminal.data.error.message}`,
    })
  }
  if (terminal.type === 'session.execution.interrupted') {
    return new VoicePromptExecutionError({
      message: `Voice prompt execution was interrupted: ${terminal.data.reason}`,
    })
  }
  return terminal
}

import { ShareMarkdown } from './markdown.js'
import { formatDistanceToNow } from './utils.js'
import pc from 'picocolors'
import {
  initializeOpencodeForDirectory,
} from './discord-bot.js'

export async function getTools({
  onMessageCompleted,
  directory,
}: {
  directory: string
  onMessageCompleted?: (params: {
    sessionId: string
    messageId: string
    data?: { info: { role: string } }
    error?: Error
    markdown?: string
  }) => void
}) {
  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    throw new Error(getClient.message)
  }
  const client = getClient()

  const markdownRenderer = new ShareMarkdown(client)

  const completeVoicePrompt = async ({
    sessionId,
    inboxId,
  }: {
    sessionId: string
    inboxId: string
  }) => {
    const waitResult = await getClient().session.wait({
      sessionID: sessionId,
    }).catch((cause) => new OpenCodeSdkError({
      operation: `session.wait.${sessionId}`,
      cause,
    }))
    if (waitResult instanceof Error) {
      onMessageCompleted?.({ sessionId, messageId: '', error: waitResult })
      return
    }

    const events: SessionLogOutput[] = []
    const logResult = await (async () => {
      for await (const event of getClient().session.log({ sessionID: sessionId })) {
        events.push(event)
      }
    })().catch((cause) => new OpenCodeSdkError({
      operation: `session.log.${sessionId}`,
      cause,
    }))
    if (logResult instanceof Error) {
      onMessageCompleted?.({ sessionId, messageId: '', error: logResult })
      return
    }

    const terminal = deriveVoicePromptTerminal({ events, sessionId, inboxId })
    if (terminal instanceof Error) {
      onMessageCompleted?.({ sessionId, messageId: '', error: terminal })
      return
    }

    const markdownResult = await markdownRenderer.generate({
      sessionID: sessionId,
      lastAssistantOnly: true,
    })
    if (markdownResult instanceof Error) {
      onMessageCompleted?.({ sessionId, messageId: '', error: markdownResult })
      return
    }
    onMessageCompleted?.({
      sessionId,
      messageId: '',
      markdown: markdownResult,
    })
  }

  const submitVoicePrompt = async ({
    sessionId,
    message,
  }: {
    sessionId: string
    message: string
  }) => {
    const inbox = await getClient().session.prompt({
      sessionID: sessionId,
      text: message,
    }).catch((cause) => new OpenCodeSdkError({
      operation: `session.prompt.${sessionId}`,
      cause,
    }))
    if (inbox instanceof Error) {
      onMessageCompleted?.({ sessionId, messageId: '', error: inbox })
      return
    }
    await completeVoicePrompt({ sessionId, inboxId: inbox.id })
  }

  const modelsResponse = await client.model.list({
    location: { directory },
  })
  const providers = [...new Set(modelsResponse.data.map((model) => model.providerID))]

  // Helper: get last assistant model for a session (non-summary)
  const getSessionModel = async (
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> => {
    const res = await getClient().message.list({
      sessionID: sessionId,
      order: 'asc',
    })
    const data = res.data
    if (data.length === 0) return undefined
    for (let i = data.length - 1; i >= 0; i--) {
      const info = data[i]
      if (info?.type === 'assistant' && info.model.providerID && info.model.id) {
        return { providerID: info.model.providerID, modelID: info.model.id }
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

        void submitVoicePrompt({ sessionId, message })
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
        message: z
          .string()
          .describe('The initial message to start the chat with'),
        title: z.string().optional().describe('Optional title for the session'),
        model: z
          .object({
            providerId: z
              .string()
              .describe('The provider ID (e.g., "anthropic", "openai")'),
            modelId: z
              .string()
              .describe(
                'The model ID (e.g., "claude-opus-4-20250514", "gpt-5")',
              ),
          })
          .optional()
          .describe('Optional model to use for this session'),
      }),
      execute: async ({ message, title, model }) => {
        if (!message.trim()) {
          throw new Error(`message must be a non empty string`)
        }

        try {
          const session = await getClient().session.create({
            title: title || undefined,
            model: model
              ? { providerID: model.providerId, id: model.modelId }
              : undefined,
            location: { directory },
          })

          const instructionsResult = await getClient().session.instructions.entry.put({
            sessionID: session.id,
            key: KIMAKI_INSTRUCTION_ENTRY_KEY,
            value: getOpencodeSystemMessage({
              sessionId: session.id,
              dataDir: getDataDir(),
            }),
          }).catch((cause) => new OpenCodeSdkError({
            operation: 'session.instructions.entry.put',
            cause,
          }))
          if (instructionsResult instanceof Error) {
            return { success: false, error: instructionsResult.message }
          }

          void submitVoicePrompt({ sessionId: session.id, message })

          return {
            success: true,
            sessionId: session.id,
            title: session.title,
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to create chat session',
          }
        }
      },
    }),

    listChats: tool({
      description:
        'Get a list of available chat sessions sorted by most recent',
      inputSchema: z.object({}),
      execute: async () => {
        toolsLogger.log(`Listing opencode sessions`)
        const sessions = await getClient().session.list({ directory })

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
            const messagesResponse = await getClient().message.list({
              sessionID: session.id,
              order: 'asc',
            })
            const messages = messagesResponse.data
            const lastMessage = messages[messages.length - 1]
            if (
              lastMessage?.type === 'assistant' &&
              !lastMessage.time.completed
            ) {
              return 'in_progress'
            }
            return 'finished'
          })()

          return {
            id: session.id,
            folder: session.location.directory,
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
        const results = await getClient().file.find({
          query,
          location: folder ? { directory: folder } : { directory },
        })

        return {
          success: true,
          files: results.data.map((entry) => entry.path),
        }
      },
    }),

    readSessionMessages: tool({
      description: 'Read messages from a chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to read messages from'),
        lastAssistantOnly: z
          .boolean()
          .optional()
          .describe('Only read the last assistant message'),
      }),
      execute: async ({ sessionId, lastAssistantOnly = false }) => {
        if (lastAssistantOnly) {
          const messages = await getClient().message.list({
            sessionID: sessionId,
            order: 'asc',
          })

          if (!messages.data) {
            return { success: false, error: 'No messages found' }
          }

          const assistantMessages = messages.data.filter(
            (m) => m.type === 'assistant',
          )

          if (assistantMessages.length === 0) {
            return {
              success: false,
              error: 'No assistant messages found',
            }
          }

          const lastMessage = assistantMessages[assistantMessages.length - 1]
          const status =
            lastMessage && lastMessage.type === 'assistant' && lastMessage.time.completed
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

          const messages = await getClient().message.list({
            sessionID: sessionId,
            order: 'asc',
          })
          const lastMessage = messages.data[messages.data.length - 1]
          const status =
            lastMessage?.type === 'assistant' && !lastMessage.time.completed
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
          toolsLogger.log(
            `[ABORT] reason=voice-tool sessionId=${sessionId} - user requested abort via voice assistant tool`,
          )
          await getClient().session.interrupt({
            sessionID: sessionId,
          })

          return {
            success: true,
            sessionId,
            message: 'Session aborted successfully',
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Unknown error occurred',
          }
        }
      },
    }),

    getModels: tool({
      description: 'Get all available AI models from all providers',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const listed = await getClient().model.list({
            location: { directory },
          })

          const models: Array<{ providerId: string; modelId: string }> = listed.data.map((model) => ({
            providerId: model.providerID,
            modelId: model.modelID,
          }))

          return {
            success: true,
            models,
            totalCount: models.length,
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Failed to fetch models',
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
