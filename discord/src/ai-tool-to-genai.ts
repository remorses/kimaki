// AI SDK to Google GenAI tool converter.
// Transforms Vercel AI SDK tool definitions into Google GenAI CallableTool format
// for use with Gemini's function calling in the voice assistant.

import type { Tool, jsonSchema as JsonSchemaType } from 'ai'
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
function jsonSchemaToGenAISchema(jsonSchema: any): Schema {
  const schema: Schema = {}

  // Map JSON Schema type to GenAI Type
  if (jsonSchema.type) {
    switch (jsonSchema.type) {
      case 'string':
        schema.type = Type.STRING
        break
      case 'number':
        schema.type = Type.NUMBER
        schema.format = jsonSchema.format || 'float'
        break
      case 'integer':
        schema.type = Type.INTEGER
        schema.format = jsonSchema.format || 'int32'
        break
      case 'boolean':
        schema.type = Type.BOOLEAN
        break
      case 'array':
        schema.type = Type.ARRAY
        if (jsonSchema.items) {
          schema.items = jsonSchemaToGenAISchema(jsonSchema.items)
        }
        if (jsonSchema.minItems !== undefined) {
          schema.minItems = jsonSchema.minItems
        }
        if (jsonSchema.maxItems !== undefined) {
          schema.maxItems = jsonSchema.maxItems
        }
        break
      case 'object':
        schema.type = Type.OBJECT
        if (jsonSchema.properties) {
          schema.properties = {}
          for (const [key, value] of Object.entries(jsonSchema.properties)) {
            schema.properties[key] = jsonSchemaToGenAISchema(value)
          }
        }
        if (jsonSchema.required) {
          schema.required = jsonSchema.required
        }
        // Note: GenAI Schema doesn't have additionalProperties field
        // We skip it for now
        break
      default:
        // For unknown types, keep as-is
        schema.type = jsonSchema.type
    }
  }

  // Copy over common properties
  if (jsonSchema.description) {
    schema.description = jsonSchema.description
  }
  if (jsonSchema.enum) {
    schema.enum = jsonSchema.enum.map(String)
  }
  if (jsonSchema.default !== undefined) {
    schema.default = jsonSchema.default
  }
  if (jsonSchema.example !== undefined) {
    schema.example = jsonSchema.example
  }
  if (jsonSchema.nullable) {
    schema.nullable = true
  }

  // Handle anyOf/oneOf as anyOf in GenAI
  if (jsonSchema.anyOf) {
    schema.anyOf = jsonSchema.anyOf.map((s: any) => jsonSchemaToGenAISchema(s))
  } else if (jsonSchema.oneOf) {
    schema.anyOf = jsonSchema.oneOf.map((s: any) => jsonSchemaToGenAISchema(s))
  }

  // Handle number/string specific properties
  if (jsonSchema.minimum !== undefined) {
    schema.minimum = jsonSchema.minimum
  }
  if (jsonSchema.maximum !== undefined) {
    schema.maximum = jsonSchema.maximum
  }
  if (jsonSchema.minLength !== undefined) {
    schema.minLength = jsonSchema.minLength
  }
  if (jsonSchema.maxLength !== undefined) {
    schema.maxLength = jsonSchema.maxLength
  }
  if (jsonSchema.pattern) {
    schema.pattern = jsonSchema.pattern
  }

  return schema
}

/**
 * Convert AI SDK Tool to GenAI FunctionDeclaration
 */
export function aiToolToGenAIFunction(tool: Tool<any, any>): FunctionDeclaration {
  // Extract the input schema - assume it's a Zod schema
  const inputSchema = tool.inputSchema as z.ZodType<any>

  // Get the tool name from the schema or generate one
  let toolName = 'tool'
  let jsonSchema: any = {}

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
  const functionDeclaration: FunctionDeclaration = {
    name: toolName,
    description: tool.description || jsonSchema.description || 'Tool function',
    parameters: genAISchema,
  }

  return functionDeclaration
}

/**
 * Convert AI SDK Tool to GenAI CallableTool
 */
export function aiToolToCallableTool(
  tool: Tool<any, any>,
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
            const result = await tool.execute(functionCall.args || {}, {
              toolCallId: functionCall.id || '',
              messages: [],
            })

            // Convert the result to a Part
            parts.push({
              functionResponse: {
                id: functionCall.id,
                name: functionCall.name || toolName,
                response: {
                  output: result,
                },
              },
            } as Part)
          } catch (error) {
            // Handle errors
            parts.push({
              functionResponse: {
                id: functionCall.id,
                name: functionCall.name || toolName,
                response: {
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            } as Part)
          }
        }
      }

      return parts
    },
  }
}

/**
 * Helper to extract schema from AI SDK tool
 */
export function extractSchemaFromTool(tool: Tool<any, any>): any {
  const inputSchema = tool.inputSchema as z.ZodType<any>

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
  tools: Record<string, Tool<any, any>>,
): Array<CallableTool & { name: string }> {
  return Object.entries(tools).map(([name, tool]) => aiToolToCallableTool(tool, name))
}
