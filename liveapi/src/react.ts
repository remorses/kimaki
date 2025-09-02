import { useState, useCallback, useRef, useEffect } from 'react'
import { LiveAPIClient } from './live-api-client.js'
import type {
    LiveServerMessage,
    FunctionCall,
    Part,
    CallableTool,
} from '@google/genai'
import type { ToolsAndTokenResponse } from './api.js'

interface ToolCall {
    toolCallId: string
    toolName: string
    args: any
}

interface ToolResult {
    tool: string
    toolCallId: string
    output: any
}

interface UseAudioChatOptions {
    url: string
    headers?: Record<string, string>
    model?: string
    saveUserAudio?: boolean
    onToolCall?: (params: { toolCall: ToolCall }) => Promise<void> | void
}

interface UseAudioChatResult {
    connect: () => Promise<void>
    disconnect: () => void
    addToolResult: (result: ToolResult) => void
    isConnected: boolean
}

export function useAudioChat(options: UseAudioChatOptions): UseAudioChatResult {
    const { url, headers, model, saveUserAudio, onToolCall } = options
    const clientRef = useRef<LiveAPIClient | null>(null)
    const [isConnected, setIsConnected] = useState(false)
    const pendingToolResults = useRef<Map<string, ToolResult>>(new Map())

    const connect = useCallback(async () => {
        if (clientRef.current) {
            console.warn('Already connected or connecting')
            return
        }

        try {
            // Fetch tools and token in a single GET request
            const urlWithModel = new URL(url)
            if (model) {
                urlWithModel.searchParams.set('model', model)
            }

            const response = await fetch(urlWithModel.toString(), {
                method: 'GET',
                headers,
            })

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch tools and token: ${response.statusText}`,
                )
            }

            const { token, tools: toolsData }: ToolsAndTokenResponse =
                await response.json()

            // Create callable tools that execute via server API
            const callableTools: Array<CallableTool & { name: string }> =
                toolsData.map((toolDef) => ({
                    name: toolDef.name,
                    async tool() {
                        return {
                            functionDeclarations: [
                                {
                                    name: toolDef.name,
                                    description: toolDef.description,
                                    parameters: toolDef.inputSchema,
                                },
                            ],
                        }
                    },
                    async callTool(
                        functionCalls: FunctionCall[],
                    ): Promise<Part[]> {
                        const parts: Part[] = []

                        for (const functionCall of functionCalls) {
                            if (functionCall.name !== toolDef.name) continue

                            try {
                                // Check if client wants to handle this tool call
                                if (onToolCall) {
                                    const toolCall: ToolCall = {
                                        toolCallId: functionCall.id || '',
                                        toolName: functionCall.name || '',
                                        args: functionCall.args || {},
                                    }

                                    // Clear any existing result for this tool call
                                    pendingToolResults.current.delete(
                                        toolCall.toolCallId,
                                    )

                                    // Let client optionally handle the tool call
                                    await Promise.resolve(
                                        onToolCall({ toolCall }),
                                    )

                                    // Check if a result was added via addToolResult
                                    const pendingResult =
                                        pendingToolResults.current.get(
                                            toolCall.toolCallId,
                                        )
                                    if (pendingResult) {
                                        pendingToolResults.current.delete(
                                            toolCall.toolCallId,
                                        )
                                        parts.push({
                                            functionResponse: {
                                                id: functionCall.id,
                                                name:
                                                    functionCall.name ||
                                                    toolDef.name,
                                                response: {
                                                    output: pendingResult.output,
                                                },
                                            },
                                        })
                                        continue
                                    }
                                }

                                // Call server API to execute the tool
                                const response = await fetch(url, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        ...headers,
                                    },
                                    body: JSON.stringify({
                                        tool: functionCall.name,
                                        input: functionCall.args || {},
                                    }),
                                })

                                if (!response.ok) {
                                    throw new Error(
                                        `Tool execution failed: ${response.statusText}`,
                                    )
                                }

                                const result = await response.json()

                                parts.push({
                                    functionResponse: {
                                        id: functionCall.id,
                                        name: functionCall.name || toolDef.name,
                                        response: {
                                            output: result,
                                        },
                                    },
                                })
                            } catch (error) {
                                parts.push({
                                    functionResponse: {
                                        id: functionCall.id,
                                        name: functionCall.name || toolDef.name,
                                        response: {
                                            error:
                                                error instanceof Error
                                                    ? error.message
                                                    : String(error),
                                        },
                                    },
                                })
                            }
                        }

                        return parts
                    },
                }))

            // Create the LiveAPIClient with ephemeral token
            const newClient = new LiveAPIClient({
                apiKey: token, // Use ephemeral token as API key
                saveUserAudio,
                config: {
                    tools: callableTools,
                },
            })

            // Store client reference
            clientRef.current = newClient

            // Connect to the API
            const connected = await newClient.connect()
            if (connected) {
                setIsConnected(true)
            } else {
                throw new Error('Failed to connect to Live API')
            }
        } catch (error) {
            console.error('Error connecting:', error)
            clientRef.current = null
            setIsConnected(false)
            throw error
        }
    }, [url, headers, model, onToolCall])

    const disconnect = useCallback(() => {
        if (clientRef.current) {
            clientRef.current.disconnect()
            clientRef.current.destroy()
            clientRef.current = null
            setIsConnected(false)
            pendingToolResults.current.clear()
        }
    }, [])

    const addToolResult = useCallback((result: ToolResult) => {
        // If connected and we have a session, send immediately
        if (clientRef.current && clientRef.current.session) {
            clientRef.current.sendToolResponse({
                functionResponses: [
                    {
                        response: { output: result.output },
                        id: result.toolCallId,
                        name: result.tool,
                    },
                ],
            })
        } else {
            // Otherwise, store for later use during tool call handling
            pendingToolResults.current.set(result.toolCallId, result)
        }
    }, [])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (clientRef.current) {
                disconnect()
            }
        }
    }, [disconnect])

    return {
        connect,
        disconnect,
        addToolResult,
        isConnected,
    }
}
