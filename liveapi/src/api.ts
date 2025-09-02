import type { Tool } from 'ai'
import { GoogleGenAI, Modality } from '@google/genai'
import { extractSchemaFromTool } from './ai-tool-to-genai.js'

export interface CreateAudioChatAPIOptions {
  geminiApiKey: string
  tools: Record<string, Tool<any, any>>
  onRequest?: (params: { request: Request }) => Promise<void> | void
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: any
}

export interface ToolsAndTokenResponse {
  token: string
  tools: ToolDefinition[]
}

export interface ToolExecutionRequest {
  tool: string
  input: any
}

export function createAudioChatAPI(options: CreateAudioChatAPIOptions) {
  const { geminiApiKey, tools, onRequest } = options

  // Initialize GoogleGenAI client for token generation
  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    apiVersion: 'v1alpha', // Required for ephemeral tokens
  })

  return async function handler(request: Request): Promise<Response> {
    try {
      // Call onRequest hook if provided (for auth, etc.)
      if (onRequest) {
        await onRequest({ request })
      }

      const method = request.method.toUpperCase()

      if (method === 'GET') {
        // Get model from query parameters
        const url = new URL(request.url)
        const model =
          url.searchParams.get('model') || 'gemini-2.0-flash-live-001'

        // Generate ephemeral token
        let token: string
        try {
          const authToken = await ai.authTokens.create({
            config: {
              uses: 1, // Single session only
              expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
              newSessionExpireTime: new Date(
                Date.now() + 60 * 1000,
              ).toISOString(), // Must start within 1 minute
              liveConnectConstraints: {
                model,
                config: {
                  responseModalities: [Modality.AUDIO, Modality.TEXT],
                  sessionResumption: {}, // Allow reconnects
                  temperature: 0.7,
                },
              },
            },
          })
          token = authToken.name || ''
        } catch (error) {
          console.error('Error generating token:', error)
          return new Response(
            JSON.stringify({ error: 'Failed to generate token' }),
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        // Return tools metadata along with token
        const toolDefinitions: ToolDefinition[] = Object.entries(tools).map(
          ([name, tool]) => ({
            name,
            description: tool.description || `Tool: ${name}`,
            inputSchema: extractSchemaFromTool(tool),
          }),
        )

        const response: ToolsAndTokenResponse = {
          token,
          tools: toolDefinitions,
        }

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      if (method === 'POST') {
        const body = await request.json()

        // Handle tool execution
        const toolRequest = body as ToolExecutionRequest
        const { tool: toolName, input } = toolRequest

        if (!toolName) {
          return new Response(JSON.stringify({ error: 'Missing tool name' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          })
        }

        const tool = tools[toolName]

        if (!tool) {
          return new Response(
            JSON.stringify({ error: `Tool not found: ${toolName}` }),
            {
              status: 404,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        if (!tool.execute) {
          return new Response(
            JSON.stringify({
              error: `Tool ${toolName} has no execute function`,
            }),
            {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        try {
          // Execute the tool with the provided input
          const result = await tool.execute(input || {}, {
            toolCallId: crypto.randomUUID(),
            messages: [],
          })

          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          })
        } catch (error) {
          console.error(`Error executing tool ${toolName}:`, error)
          return new Response(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Tool execution failed',
            }),
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }
      }

      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    } catch (error) {
      console.error('API handler error:', error)

      // If onRequest threw an error (e.g., unauthorized), return appropriate response
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes('unauthorized')
      ) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      return new Response(
        JSON.stringify({
          error:
            error instanceof Error ? error.message : 'Internal server error',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }
  }
}
