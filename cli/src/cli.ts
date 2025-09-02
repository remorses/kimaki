import { cac } from 'cac'
import dedent from 'string-dedent'
import { tool } from 'ai'
import { z } from 'zod'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'
import { Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
import pc from 'picocolors'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { formatDistanceToNow } from 'date-fns'
import { ShareMarkdown } from './markdown'

const client = createOpencodeClient()
const markdownRenderer = new ShareMarkdown(client)

const tools = {
    submitMessage: tool({
        description: 'Submit a message to an existing chat session',
        inputSchema: z.object({
            sessionId: z.string().describe('The session ID to send message to'),
            message: z.string().describe('The message text to send'),
        }),
        execute: async ({ sessionId, message }) => {
            try {
                const response = await client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        parts: [{ type: 'text', text: message }],
                    },
                })
                return {
                    success: true,
                    messageId: response.data?.info.id,
                    status: response.data?.info.time.completed
                        ? 'completed'
                        : 'in_progress',
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: error.message || 'Failed to submit message',
                }
            }
        },
    }),

    createNewChat: tool({
        description: 'Start a new chat session with an initial message',
        inputSchema: z.object({
            message: z
                .string()
                .describe('The initial message to start the chat with'),
            title: z
                .string()
                .optional()
                .describe('Optional title for the session'),
        }),
        execute: async ({ message, title }) => {
            try {
                const session = await client.session.create({
                    body: {
                        title: title || message.slice(0, 50),
                    },
                })

                if (!session.data) {
                    throw new Error('Failed to create session')
                }

                const response = await client.session.prompt({
                    path: { id: session.data.id },
                    body: {
                        parts: [{ type: 'text', text: message }],
                    },
                })

                return {
                    success: true,
                    sessionId: session.data.id,
                    messageId: response.data?.info.id,
                    title: session.data.title,
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: error.message || 'Failed to create new chat',
                }
            }
        },
    }),

    listChats: tool({
        description: 'Get a list of available chat sessions',
        inputSchema: z.object({}),
        execute: async () => {
            try {
                const sessions = await client.session.list()

                if (!sessions.data) {
                    return { success: false, error: 'No sessions found' }
                }

                const sessionList = sessions.data.map(async (session) => {
                    const finishedAt = session.time.updated
                    const status = await (async () => {
                        if (session.revert) return 'error'
                        const messagesResponse = await client.session.messages({
                            path: { id: session.id },
                        })
                        const messages = messagesResponse.data || []
                        const lastMessage = messages[messages.length - 1]
                        if (
                            lastMessage?.info.role === 'assistant' &&
                            !lastMessage.info.time.completed
                        ) {
                            return 'in_progress'
                        }
                        return 'finished'
                    })()

                    return {
                        id: session.id,
                        folder: session.directory,
                        status,
                        finishedAt: formatDistanceToNow(new Date(finishedAt), {
                            addSuffix: true,
                        }),
                        title: session.title,
                        prompt: session.title,
                    }
                })

                const resolvedList = await Promise.all(sessionList)

                return {
                    success: true,
                    sessions: resolvedList,
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: error.message || 'Failed to list chats',
                }
            }
        },
    }),

    searchFiles: tool({
        description: 'Search for files in a folder',
        inputSchema: z.object({
            folder: z.string().describe('The folder path to search in'),
            query: z.string().describe('The search query for files'),
        }),
        execute: async ({ folder, query }) => {
            try {
                const results = await client.find.files({
                    query: {
                        query,
                        directory: folder,
                    },
                })

                return {
                    success: true,
                    files: results.data || [],
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: error.message || 'Failed to search files',
                }
            }
        },
    }),

    readSessionMessages: tool({
        description: 'Read messages from a chat session',
        inputSchema: z.object({
            sessionId: z
                .string()
                .describe('The session ID to read messages from'),
            lastAssistantOnly: z
                .boolean()
                .optional()
                .describe('Only read the last assistant message'),
        }),
        execute: async ({ sessionId, lastAssistantOnly = false }) => {
            try {
                if (lastAssistantOnly) {
                    const messages = await client.session.messages({
                        path: { id: sessionId },
                    })

                    if (!messages.data) {
                        return { success: false, error: 'No messages found' }
                    }

                    const assistantMessages = messages.data.filter(
                        (m) => m.info.role === 'assistant',
                    )

                    if (assistantMessages.length === 0) {
                        return {
                            success: false,
                            error: 'No assistant messages found',
                        }
                    }

                    const lastMessage =
                        assistantMessages[assistantMessages.length - 1]
                    const status =
                        'completed' in lastMessage.info.time &&
                        lastMessage.info.time.completed
                            ? 'completed'
                            : 'in_progress'

                    const markdown = await markdownRenderer.generate(sessionId)
                    const lines = markdown.split('\n')
                    const lastAssistantIndex =
                        lines.lastIndexOf('### 🤖 Assistant')
                    const lastAssistantContent =
                        lastAssistantIndex >= 0
                            ? lines.slice(lastAssistantIndex).join('\n')
                            : ''

                    return {
                        success: true,
                        markdown: lastAssistantContent,
                        status,
                    }
                } else {
                    const markdown = await markdownRenderer.generate(sessionId)

                    const messages = await client.session.messages({
                        path: { id: sessionId },
                    })
                    const lastMessage =
                        messages.data?.[messages.data.length - 1]
                    const status =
                        lastMessage?.info.role === 'assistant' &&
                        lastMessage?.info.time &&
                        'completed' in lastMessage.info.time &&
                        !lastMessage.info.time.completed
                            ? 'in_progress'
                            : 'completed'

                    return {
                        success: true,
                        markdown,
                        status,
                    }
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: error.message || 'Failed to read messages',
                }
            }
        },
    }),
}

export const cli = cac('kimaki')

cli.help()

// Check if running in TTY environment
const isTTY = process.stdout.isTTY && process.stdin.isTTY

cli.command('', 'Spawn Kimaki to orchestrate code agents').action(
    async (options) => {
        try {
            const token = process.env.TOKEN

            Object.assign(globalThis, webAudioApi)
            // @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
            navigator.mediaDevices = mediaDevices

            const { LiveAPIClient, callableToolsFromObject } = await import(
                'liveapi/src/index'
            )

            const newClient = new LiveAPIClient({
                apiKey: token!,
                config: {
                    tools: callableToolsFromObject(tools),
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: {
                        parts: [
                            {
                                text: dedent`

                                You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines.

                                Your job is to manage many opencode agent chat instances. Opencode is the agent used to write the code, it is similar to Claude Code.

                                You can
                                - start new chats on a given project
                                - read the chats to report progress to the user
                                - submit messages to the chat
                                - list files for a given projects, so you can translate imprecise user prompts to precise messages that mention filename paths using @
                                `,
                            },
                        ],
                    },
                },
                onStateChange: (state) => {},
            })

            // Connect to the API
            const connected = await newClient.connect()
        } catch (error) {
            console.error(pc.red('\nError initializing project:'))
            console.error(pc.red(error))
            process.exit(1)
        }
    },
)
