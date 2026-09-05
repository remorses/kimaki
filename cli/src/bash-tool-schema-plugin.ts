// Adds description and hasSideEffect to the built-in bash tool schema.
// Uses tool.definition so OpenCode keeps the real bash execute.
// Mutate jsonSchema only. Leave parameters as the Effect Schema used to decode
// args before execute. Extra fields stay in the model-facing schema and in
// Discord input; they never reach the shell.

import type { Plugin } from '@opencode-ai/plugin'
import type { JSONSchema7 } from 'json-schema'

export type ToolDefinitionOutput = {
  description: string
  parameters: unknown
  jsonSchema?: JSONSchema7
}

const DESCRIPTION_PROPERTY: JSONSchema7 = {
  type: 'string',
  description:
    'Short 5-10 word summary shown in Discord when the command is longer than 50 characters',
}

const SIDE_EFFECT_PROPERTY: JSONSchema7 = {
  type: 'boolean',
  description:
    'True if the command writes files, modifies state, installs packages, or triggers external effects',
}

const DEFAULT_BASH_JSON_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The command to execute',
    },
    workdir: {
      type: 'string',
      description: 'Working directory. Defaults to the current directory.',
    },
    timeout: {
      type: 'integer',
      description: 'Optional timeout in milliseconds',
    },
  },
  required: ['command'],
}

function cloneJsonSchema(schema: JSONSchema7): JSONSchema7 {
  const properties = schema.properties
    ? { ...schema.properties }
    : undefined
  return {
    ...schema,
    properties,
    required: schema.required ? [...schema.required] : undefined,
  }
}

export function extendBashToolDefinition(output: ToolDefinitionOutput) {
  const jsonSchema = output.jsonSchema
    ? cloneJsonSchema(output.jsonSchema)
    : cloneJsonSchema(DEFAULT_BASH_JSON_SCHEMA)
  jsonSchema.properties = {
    ...jsonSchema.properties,
    description: DESCRIPTION_PROPERTY,
    hasSideEffect: SIDE_EFFECT_PROPERTY,
  }
  output.jsonSchema = jsonSchema
}

export const bashToolSchemaPlugin: Plugin = async () => {
  return {
    'tool.definition': async (input, output) => {
      if (input.toolID !== 'bash') return
      extendBashToolDefinition(output)
    },
  }
}
