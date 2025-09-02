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
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

async function getOpenPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, () => {
            const address = server.address()
            if (address && typeof address === 'object') {
                const port = address.port
                server.close(() => {
                    resolve(port)
                })
            } else {
                reject(new Error('Failed to get port'))
            }
        })
        server.on('error', reject)
    })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const endpoints = [
                `http://localhost:${port}/api/health`,
                `http://localhost:${port}/`,
                `http://localhost:${port}/api`,
            ]

            for (const endpoint of endpoints) {
                try {
                    const response = await fetch(endpoint)
                    if (response.status < 500) {
                        console.log(
                            pc.green(`OpenCode server ready on port ${port}`),
                        )
                        return true
                    }
                } catch (e) {
                    // Continue to next endpoint
                }
            }
        } catch (e) {
            // Server not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(
        `Server did not start on port ${port} after ${maxAttempts} seconds`,
    )
}

async function startOpencodeServer(port: number): Promise<ChildProcess> {
    console.log(pc.cyan(`Starting OpenCode server on port ${port}...`))

    const serverProcess = spawn(
        'opencode',
        ['serve', '--port', port.toString()],
        {
            stdio: 'pipe',
            detached: false,
            env: {
                ...process.env,
                OPENCODE_PORT: port.toString(),
            },
        },
    )

    serverProcess.stdout?.on('data', (data) => {
        console.log(pc.gray(`[OpenCode] ${data.toString().trim()}`))
    })

    serverProcess.stderr?.on('data', (data) => {
        console.error(pc.yellow(`[OpenCode Error] ${data.toString().trim()}`))
    })

    serverProcess.on('error', (error) => {
        console.error(pc.red('Failed to start OpenCode server:'), error)
    })

    serverProcess.on('exit', (code, signal) => {
        if (code !== 0) {
            console.error(
                pc.red(
                    `OpenCode server exited with code ${code}, signal ${signal}`,
                ),
            )
        }
    })

    await waitForServer(port)
    return serverProcess
}

async function getTools() {
    const port = await getOpenPort()
    const serverProcess = await startOpencodeServer(port)

    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })
    const markdownRenderer = new ShareMarkdown(client)

    const tools = {
        submitMessage: tool({
            description: 'Submit a message to an existing chat session',
            inputSchema: z.object({
                sessionId: z
                    .string()
                    .describe('The session ID to send message to'),
                message: z.string().describe('The message text to send'),
            }),
            execute: async ({ sessionId, message }) => {
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
            },
        }),

        listChats: tool({
            description:
                'Get a list of available chat sessions sorted by most recent',
            inputSchema: z.object({}),
            execute: async () => {
                const sessions = await client.session.list()

                if (!sessions.data) {
                    return { success: false, error: 'No sessions found' }
                }

                // Sort sessions by updated time in descending order (most recent first)
                const sortedSessions = [...sessions.data].sort((a, b) => {
                    // Get completed values for a and b
                    const aCompleted = ('completed' in a.time) ? a.time.completed : null
                    const bCompleted = ('completed' in b.time) ? b.time.completed : null

                    // Put sessions with completed === null first
                    if (aCompleted === null && bCompleted !== null) {
                        return -1
                    }
                    if (aCompleted !== null && bCompleted === null) {
                        return 1
                    }
                    // Otherwise, sort by updated time descending
                    return b.time.updated - a.time.updated
                }).slice(0, 20)

                const sessionList = sortedSessions.map(async (session) => {
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
            },
        }),

        searchFiles: tool({
            description: 'Search for files in a folder',
            inputSchema: z.object({
                folder: z.string().describe('The folder path to search in'),
                query: z.string().describe('The search query for files'),
            }),
            execute: async ({ folder, query }) => {
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

                    const markdown = await markdownRenderer.generate({
                        sessionID: sessionId,
                        lastAssistantOnly: true,
                    })

                    return {
                        success: true,
                        markdown,
                        status,
                    }
                } else {
                    const markdown = await markdownRenderer.generate({
                        sessionID: sessionId,
                    })

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
            },
        }),
    }

    // Cleanup handler
    process.on('exit', () => {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGTERM')
        }
    })

    process.on('SIGINT', () => {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGTERM')
        }
        process.exit(0)
    })

    process.on('SIGTERM', () => {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGTERM')
        }
        process.exit(0)
    })

    return tools
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

            const tools = await getTools()

            const newClient = new LiveAPIClient({
                apiKey: token!,
                config: {
                    tools: callableToolsFromObject(tools),
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: {
                        parts: [
                            {
                                text: dedent`
                                You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines. Speak fast.

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
