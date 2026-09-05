import { describe, expect, test } from 'vitest'
import {
  extendBashToolDefinition,
  type ToolDefinitionOutput,
} from './bash-tool-schema-plugin.js'

describe('extendBashToolDefinition', () => {
  test('keeps parameters and merges extra fields into jsonSchema', () => {
    const parameters = { keep: true }
    const output: ToolDefinitionOutput = {
      description: 'Execute a shell command',
      parameters,
      jsonSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: { type: 'integer' },
        },
        required: ['command'],
      },
    }

    extendBashToolDefinition(output)

    expect(output.parameters).toBe(parameters)
    expect(output.jsonSchema).toMatchInlineSnapshot(`
      {
        "properties": {
          "command": {
            "description": "The command to execute",
            "type": "string",
          },
          "description": {
            "description": "Short 5-10 word summary shown in Discord when the command is longer than 50 characters",
            "type": "string",
          },
          "hasSideEffect": {
            "description": "True if the command writes files, modifies state, installs packages, or triggers external effects",
            "type": "boolean",
          },
          "timeout": {
            "type": "integer",
          },
        },
        "required": [
          "command",
        ],
        "type": "object",
      }
    `)
  })

  test('synthesizes jsonSchema when it is missing', () => {
    const parameters = { keep: true }
    const output: ToolDefinitionOutput = {
      description: 'Execute a shell command',
      parameters,
    }

    extendBashToolDefinition(output)

    expect(output.parameters).toBe(parameters)
    expect(output.jsonSchema).toMatchInlineSnapshot(`
      {
        "properties": {
          "command": {
            "description": "The command to execute",
            "type": "string",
          },
          "description": {
            "description": "Short 5-10 word summary shown in Discord when the command is longer than 50 characters",
            "type": "string",
          },
          "hasSideEffect": {
            "description": "True if the command writes files, modifies state, installs packages, or triggers external effects",
            "type": "boolean",
          },
          "timeout": {
            "description": "Optional timeout in milliseconds",
            "type": "integer",
          },
          "workdir": {
            "description": "Working directory. Defaults to the current directory.",
            "type": "string",
          },
        },
        "required": [
          "command",
        ],
        "type": "object",
      }
    `)
  })
})
