// Adds description and hasSideEffect to the built-in bash tool schema.
// Uses tool.definition so OpenCode keeps the real bash execute.
// Assign jsonSchema only. Leave parameters as the Effect Schema used to decode
// args before execute. Extra fields stay in the model-facing schema and in
// Discord input; they never reach the shell.

import type { Plugin } from '@opencode-ai/plugin'
import { z } from 'zod'

export const bashParameters = z.object({
  command: z.string().describe('The command to execute'),
  description: z
    .string()
    .describe(
      'Short 5-10 word summary shown in Discord when the command is longer than 50 characters',
    ),
  hasSideEffect: z
    .boolean()
    .describe(
      'True if the command writes files, modifies state, installs packages, or triggers external effects',
    ),
  workdir: z
    .string()
    .optional()
    .describe('Working directory. Defaults to the current directory.'),
  timeout: z.number().int().optional().describe('Optional timeout in milliseconds'),
})

export type ToolDefinitionOutput = {
  description: string
  parameters: unknown
  jsonSchema?: unknown
}

export function extendBashToolDefinition(output: ToolDefinitionOutput) {
  output.jsonSchema = z.toJSONSchema(bashParameters)
}

export const bashToolSchemaPlugin: Plugin = async () => {
  return {
    'tool.definition': async (input, output) => {
      if (input.toolID !== 'bash') return
      extendBashToolDefinition(output)
    },
  }
}
