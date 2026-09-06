import { describe, expect, test } from 'vitest'
import {
  extendBashToolDefinition,
  type ToolDefinitionOutput,
} from './bash-tool-schema-plugin.js'

describe('extendBashToolDefinition', () => {
  test('keeps parameters and assigns jsonSchema from bashParameters', () => {
    const parameters = { keep: true }
    const output: ToolDefinitionOutput = {
      description: 'Execute a shell command',
      parameters,
    }

    extendBashToolDefinition(output)

    expect(output.parameters).toBe(parameters)
    expect(output.jsonSchema).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
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
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer",
          },
          "workdir": {
            "description": "Working directory. Defaults to the current directory.",
            "type": "string",
          },
        },
        "required": [
          "command",
          "description",
          "hasSideEffect",
        ],
        "type": "object",
      }
    `)
  })
})
