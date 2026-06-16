import { describe, it, expect } from 'vitest'
import { tool } from './ai-tool.js'
import { z } from 'zod'
import { Type } from '@google/genai'
import type { FunctionDeclaration, FunctionCall } from '@google/genai'
import {
  aiToolToGenAIFunction,
  aiToolToCallableTool,
  extractSchemaFromTool,
} from './ai-tool-to-genai.js'

describe('AI Tool to GenAI Conversion', () => {
  it('should convert a simple Zod-based tool', () => {
    const weatherTool = tool({
      description: 'Get the current weather for a location',
      inputSchema: z.object({
        location: z.string().describe('The city name'),
        unit: z.enum(['celsius', 'fahrenheit']).optional(),
      }),
      execute: async ({ location, unit }) => {
        return {
          temperature: 72,
          unit: unit || 'fahrenheit',
          condition: 'sunny',
        }
      },
    })

    const genAIFunction = aiToolToGenAIFunction(weatherTool)

    expect(genAIFunction).toMatchInlineSnapshot(`
      {
        "description": "Get the current weather for a location",
        "name": "tool",
        "parameters": {
          "properties": {
            "location": {
              "description": "The city name",
              "type": "STRING",
            },
            "unit": {
              "enum": [
                "celsius",
                "fahrenheit",
              ],
              "type": "STRING",
            },
          },
          "required": [
            "location",
          ],
          "type": "OBJECT",
        },
      }
    `)
  })

  it('should handle complex nested schemas', () => {
    const complexTool = tool({
      description: 'Process complex data',
      inputSchema: z.object({
        user: z.object({
          name: z.string(),
          age: z.number().int().min(0).max(150),
          email: z.string().email(),
        }),
        preferences: z.array(z.string()),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => input,
    })

    const genAIFunction = aiToolToGenAIFunction(complexTool)

    expect(genAIFunction.parameters).toMatchInlineSnapshot(`
      {
        "properties": {
          "metadata": {
            "type": "OBJECT",
          },
          "preferences": {
            "items": {
              "type": "STRING",
            },
            "type": "ARRAY",
          },
          "user": {
            "properties": {
              "age": {
                "format": "int32",
                "maximum": 150,
                "minimum": 0,
                "type": "INTEGER",
              },
              "email": {
                "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
                "type": "STRING",
              },
              "name": {
                "type": "STRING",
              },
            },
            "required": [
              "name",
              "age",
              "email",
            ],
            "type": "OBJECT",
          },
        },
        "required": [
          "user",
          "preferences",
        ],
        "type": "OBJECT",
      }
    `)
  })

  it('should extract schema from tool', () => {
    const testTool = tool({
      inputSchema: z.object({
        test: z.string(),
      }),
      execute: async () => {},
    })

    const schema = extractSchemaFromTool(testTool)

    expect(schema).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "test": {
            "type": "string",
          },
        },
        "required": [
          "test",
        ],
        "type": "object",
      }
    `)
  })

  it('should handle tools with no input schema', () => {
    const simpleTool = tool({
      description: 'Simple tool with no inputs',
      inputSchema: z.object({}),
      execute: async () => ({ result: 'done' }),
    })

    const genAIFunction = aiToolToGenAIFunction(simpleTool)

    expect(genAIFunction).toMatchInlineSnapshot(`
      {
        "description": "Simple tool with no inputs",
        "name": "tool",
        "parameters": {
          "properties": {},
          "type": "OBJECT",
        },
      }
    `)
  })

  it('should handle union types', () => {
    const unionTool = tool({
      description: 'Tool with union types',
      inputSchema: z.object({
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
      execute: async ({ value }) => ({ received: value }),
    })

    const genAIFunction = aiToolToGenAIFunction(unionTool)

    expect(genAIFunction.parameters?.properties?.value).toMatchInlineSnapshot(`
      {
        "anyOf": [
          {
            "type": "STRING",
          },
          {
            "format": "float",
            "type": "NUMBER",
          },
          {
            "type": "BOOLEAN",
          },
        ],
      }
    `)
  })

  it('should create a CallableTool', async () => {
    const weatherTool = tool({
      description: 'Get weather',
      inputSchema: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => ({
        temperature: 72,
        location,
      }),
    })

    const callableTool = aiToolToCallableTool(weatherTool, 'weather')

    // Test tool() method
    const genAITool = await callableTool.tool()
    expect(genAITool.functionDeclarations).toMatchInlineSnapshot(`
      [
        {
          "description": "Get weather",
          "name": "weather",
          "parameters": {
            "properties": {
              "location": {
                "type": "STRING",
              },
            },
            "required": [
              "location",
            ],
            "type": "OBJECT",
          },
        },
      ]
    `)

    // Test callTool() method
    const functionCall: FunctionCall = {
      id: 'call_123',
      name: 'weather',
      args: { location: 'San Francisco' },
    }

    const parts = await callableTool.callTool([functionCall])
    expect(parts).toMatchInlineSnapshot(`
      [
        {
          "functionResponse": {
            "id": "call_123",
            "name": "weather",
            "response": {
              "output": {
                "location": "San Francisco",
                "temperature": 72,
              },
            },
          },
        },
      ]
    `)
  })

  it('should handle tool execution errors', async () => {
    const errorTool = tool({
      description: 'Tool that throws',
      inputSchema: z.object({
        trigger: z.boolean(),
      }),
      execute: async ({ trigger }) => {
        if (trigger) {
          throw new Error('Tool execution failed')
        }
        return { success: true }
      },
    })

    const callableTool = aiToolToCallableTool(errorTool, 'error_tool')

    const functionCall: FunctionCall = {
      id: 'call_error',
      name: 'error_tool',
      args: { trigger: true },
    }

    const parts = await callableTool.callTool([functionCall])
    expect(parts).toMatchInlineSnapshot(`
      [
        {
          "functionResponse": {
            "id": "call_error",
            "name": "error_tool",
            "response": {
              "error": "Tool execution failed",
            },
          },
        },
      ]
    `)
  })
})
