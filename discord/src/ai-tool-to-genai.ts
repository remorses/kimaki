// AI SDK to Google GenAI tool converter.
// Transforms Vercel AI SDK tool definitions into Google GenAI CallableTool format
// for use with Gemini's function calling in the voice assistant.

import type { AnyTool } from './ai-tool.js'
import type {
  FunctionDeclaration,
  Schema,
  Type as GenAIType,
  Tool as GenAITool,
  CallableTool,
  FunctionCall,
  Part,
} from '@google/genai'
import { Type } from '@google/genai'
import { z, toJSONSchema } from 'zod'

/**
 * Convert JSON Schema to GenAI Schema format
 * Based on the actual implementation used by the GenAI package:
 * https://github.com/googleapis/js-genai/blob/027f09db662ce6b30f737b10b4d2efcb4282a9b6/src/_transformers.ts#L294
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function jsonSchemaToGenAISchema(jsonSchema: unknown): Schema {
  const schema: Schema = {}

  // Map JSON Schema type to GenAI Type
  if (isRecord(jsonSchema) && typeof jsonSchema.type === 'string') {
    switch (jsonSchema.type) {
      case 'string':
        schema.type = Type.STRING
        break
      case 'number':
        schema.type = Type.NUMBER
        schema.format = typeof jsonSchema.format === 'string' ? jsonSchema.format : 'float'
        break
      case 'integer':
        schema.type = Type.INTEGER
        schema.format = typeof jsonSchema.format === 'string' ? jsonSchema.format : 'int32'
        break
      case 'boolean':
        schema.type = Type.BOOLEAN
        break
      case 'array':
        schema.type = Type.ARRAY
        if (isRecord(jsonSchema) && jsonSchema.items) {
          schema.items = jsonSchemaToGenAISchema(jsonSchema.items)
        }
        if (typeof jsonSchema.minItems === 'number') {
          schema.minItems = String(jsonSchema.minItems)
        }
        if (typeof jsonSchema.maxItems === 'number') {
          schema.maxItems = String(jsonSchema.maxItems)
        }
        break
      case 'object':
        schema.type = Type.OBJECT
        if (isRecord(jsonSchema) && isRecord(jsonSchema.properties)) {
          schema.properties = {}
          for (const [key, value] of Object.entries(jsonSchema.properties)) {
            schema.properties[key] = jsonSchemaToGenAISchema(value)
          }
        }
        if (Array.isArray(jsonSchema.required)) {
          schema.required = jsonSchema.required.filter((x): x is string => typeof x === 'string')
        }
        // Note: GenAI Schema doesn't have additionalProperties field
        // We skip it for now
        break
      default:
        // For unknown types, omit `type` so GenAI can interpret defaults.
        break
    }
  }

  // Copy over common properties
  if (isRecord(jsonSchema) && typeof jsonSchema.description === 'string') {
    schema.description = jsonSchema.description
  }
  if (isRecord(jsonSchema) && Array.isArray(jsonSchema.enum)) {
    schema.enum = jsonSchema.enum.map((x) => String(x))
  }
  if (isRecord(jsonSchema) && 'default' in jsonSchema) {
    schema.default = jsonSchema.default
  }
  if (isRecord(jsonSchema) && 'example' in jsonSchema) {
    schema.example = jsonSchema.example
  }
  if (isRecord(jsonSchema) && jsonSchema.nullable === true) {
    schema.nullable = true
  }

  // Handle anyOf/oneOf as anyOf in GenAI
  if (isRecord(jsonSchema) && Array.isArray(jsonSchema.anyOf)) {
    schema.anyOf = jsonSchema.anyOf.map((s) => jsonSchemaToGenAISchema(s))
  } else if (isRecord(jsonSchema) && Array.isArray(jsonSchema.oneOf)) {
    schema.anyOf = jsonSchema.oneOf.map((s) => jsonSchemaToGenAISchema(s))
  }

  // Handle number/string specific properties
  if (isRecord(jsonSchema) && typeof jsonSchema.minimum === 'number') {
    schema.minimum = jsonSchema.minimum
  }
  if (isRecord(jsonSchema) && typeof jsonSchema.maximum === 'number') {
    schema.maximum = jsonSchema.maximum
  }
  if (isRecord(jsonSchema) && typeof jsonSchema.minLength === 'number') {
    schema.minLength = String(jsonSchema.minLength)
  }
  if (isRecord(jsonSchema) && typeof jsonSchema.maxLength === 'number') {
    schema.maxLength = String(jsonSchema.maxLength)
  }
  if (isRecord(jsonSchema) && typeof jsonSchema.pattern === 'string') {
    schema.pattern = jsonSchema.pattern
  }

  return schema
}

/**
 * Convert AI SDK Tool to GenAI FunctionDeclaration
 */
export function aiToolToGenAIFunction(tool: AnyTool): FunctionDeclaration {
  // Extract the input schema - assume it's a Zod schema
  const inputSchema = tool.inputSchema as z.ZodType<unknown>

  // Get the tool name from the schema or generate one
  let toolName = 'tool'
  let jsonSchema: unknown = {}

  if (inputSchema) {
    // Convert Zod schema to JSON Schema
    jsonSchema = toJSONSchema(inputSchema)

    // Extract name from Zod description if available
    const description = inputSchema.description
    if (description) {
      const nameMatch = description.match(/name:\s*(\w+)/)
      if (nameMatch) {
        toolName = nameMatch[1] || ''
      }
    }
  }

  // Convert JSON Schema to GenAI Schema
  const genAISchema = jsonSchemaToGenAISchema(jsonSchema)

  // Create the FunctionDeclaration
  const jsonSchemaDescription: string | undefined = (() => {
    if (!isRecord(jsonSchema)) {
      return undefined
    }
    if (typeof jsonSchema.description !== 'string') {
      return undefined
    }
    return jsonSchema.description
  })()

  const functionDeclaration: FunctionDeclaration = {
    name: toolName,
    description: tool.description || jsonSchemaDescription || 'Tool function',
    parameters: genAISchema,
  }

  return functionDeclaration
}

/**
 * Convert AI SDK Tool to GenAI CallableTool
 */
export function aiToolToCallableTool(
  tool: AnyTool,
  name: string,
): CallableTool & { name: string } {
  const toolName = name || 'tool'

  return {
    name,
    async tool(): Promise<GenAITool> {
      const functionDeclaration = aiToolToGenAIFunction(tool)
      if (name) {
        functionDeclaration.name = name
      }

      return {
        functionDeclarations: [functionDeclaration],
      }
    },

    async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
      const parts: Part[] = []

      for (const functionCall of functionCalls) {
        // Check if this function call matches our tool
        if (functionCall.name !== toolName && name && functionCall.name !== name) {
          continue
        }

        // Execute the tool if it has an execute function
        if (tool.execute) {
          try {
            const args: unknown = isRecord(functionCall.args) ? functionCall.args : {}
            const result = await tool.execute(args, {
              toolCallId: functionCall.id || '',
              messages: [],
            })

            // Convert the result to a Part
            const part: Part = {
              functionResponse: {
                id: functionCall.id,
                name: functionCall.name || toolName,
                response: {
                  output: result,
                },
              },
            }
            parts.push(part)
          } catch (error) {
            // Handle errors
            const part: Part = {
              functionResponse: {
                id: functionCall.id,
                name: functionCall.name || toolName,
                response: {
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            }
            parts.push(part)
          }
        }
      }

      return parts
    },
  }
}

export function extractSchemaFromTool(tool: AnyTool): unknown {
  const inputSchema = tool.inputSchema as z.ZodType<unknown>

  if (!inputSchema) {
    return {}
  }

  // Convert Zod schema to JSON Schema
  return toJSONSchema(inputSchema)
}

/**
 * Given an object of tools, creates an array of CallableTool
 */
export function callableToolsFromObject(
  tools: Record<string, AnyTool>,
): Array<CallableTool & { name: string }> {
  return Object.entries(tools).map(([name, tool]) => aiToolToCallableTool(tool, name))
}
