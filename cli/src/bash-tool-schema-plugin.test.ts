import { describe, expect, test } from 'vitest'
import {
  extendBashToolDefinition,
  injectKimakiSessionEnv,
  KIMAKI_SESSION_ID_ENV,
  resolveUploadToDiscordSessionId,
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

describe('upload-to-discord session targeting', () => {
  test('bash env uses the live OpenCode session, not a copied --session flag', () => {
    const env: Record<string, string> = {}
    injectKimakiSessionEnv({ sessionID: 'ses_child', env })
    expect(env).toEqual({ [KIMAKI_SESSION_ID_ENV]: 'ses_child' })
    expect(
      resolveUploadToDiscordSessionId({
        flagSessionId: 'ses_parent',
        envSessionId: env[KIMAKI_SESSION_ID_ENV],
      }),
    ).toBe('ses_child')
  })

  test('falls back to --session when bash is not inside an OpenCode session', () => {
    expect(
      resolveUploadToDiscordSessionId({
        flagSessionId: 'ses_parent',
      }),
    ).toBe('ses_parent')
  })

  test('returns undefined when neither live session nor flag is set', () => {
    expect(resolveUploadToDiscordSessionId({})).toBeUndefined()
  })
})
