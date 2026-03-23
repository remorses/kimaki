// Voice assistant customization via ~/.kimaki/voice-config.json
//
// Users can customize the voice assistant by creating a config file at
// ~/.kimaki/voice-config.json with:
//
// - systemPrompt: Extra text appended to the default voice system prompt
// - enableRunCommand: boolean (default false) — adds a generic shell execution tool
// - tools: Array of custom shell-based tool definitions
//
// Example ~/.kimaki/voice-config.json:
// {
//   "systemPrompt": "You are a helpful assistant for Jane. You can check emails, manage notes, etc.",
//   "enableRunCommand": true,
//   "tools": [
//     {
//       "name": "checkEmail",
//       "description": "Check recent emails using the gog CLI",
//       "command": "gog gmail search '{{query}}' --max {{max}} --json",
//       "parameters": {
//         "query": { "type": "string", "description": "Search query for emails" },
//         "max": { "type": "number", "description": "Max results to return", "default": 10 }
//       },
//       "env": { "GOG_ACCOUNT": "jane@example.com" },
//       "timeoutSeconds": 60
//     }
//   ]
// }

import { readFileSync, existsSync } from 'node:fs'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { tool } from './ai-tool.js'
import type { AnyTool } from './ai-tool.js'
import { createLogger, LogPrefix } from './logger.js'

const execAsync = promisify(execCb)
const voiceConfigLogger = createLogger(LogPrefix.VOICE)

// ── Config schema ──────────────────────────────────────────────

interface ToolParameter {
  type: 'string' | 'number' | 'boolean'
  description: string
  default?: string | number | boolean
  required?: boolean
}

interface CustomToolConfig {
  name: string
  description: string
  command: string
  parameters?: Record<string, ToolParameter>
  env?: Record<string, string>
  timeoutSeconds?: number
  workingDirectory?: string
}

interface VoiceConfig {
  systemPrompt?: string
  enableRunCommand?: boolean
  tools?: CustomToolConfig[]
}

// ── Config loading ─────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.kimaki', 'voice-config.json')

export function loadVoiceConfig(): VoiceConfig {
  if (!existsSync(CONFIG_PATH)) {
    voiceConfigLogger.log(
      `No voice config found at ${CONFIG_PATH}, using defaults`,
    )
    return {}
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw) as VoiceConfig
    voiceConfigLogger.log(
      `Loaded voice config: ${config.tools?.length ?? 0} custom tool(s), runCommand=${config.enableRunCommand ?? false}`,
    )
    return config
  } catch (error) {
    voiceConfigLogger.error(`Failed to load voice config from ${CONFIG_PATH}:`, error)
    return {}
  }
}

// ── Tool generation ────────────────────────────────────────────

/**
 * Build a Zod schema from declarative parameter definitions.
 */
function buildZodSchema(
  parameters?: Record<string, ToolParameter>,
): z.ZodTypeAny {
  if (!parameters || Object.keys(parameters).length === 0) {
    return z.object({})
  }

  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [name, param] of Object.entries(parameters)) {
    let field: z.ZodTypeAny

    switch (param.type) {
      case 'number':
        field = z.number().describe(param.description)
        break
      case 'boolean':
        field = z.boolean().describe(param.description)
        break
      case 'string':
      default:
        field = z.string().describe(param.description)
        break
    }

    if (param.default !== undefined) {
      field = field.default(param.default)
    }

    if (param.required === false) {
      field = field.optional()
    }

    shape[name] = field
  }

  return z.object(shape)
}

/**
 * Interpolate {{param}} placeholders in a command template.
 */
function interpolateCommand(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = args[key]
    if (value === undefined || value === null) return ''
    return String(value)
  })
}

/**
 * Create an AnyTool from a declarative custom tool config.
 */
function createCustomTool(config: CustomToolConfig): AnyTool {
  const inputSchema = buildZodSchema(config.parameters)

  return tool({
    description: config.description,
    inputSchema,
    execute: async (args: unknown) => {
      const params = args as Record<string, unknown>
      const command = interpolateCommand(config.command, params)
      const timeout = (config.timeoutSeconds ?? 120) * 1000

      voiceConfigLogger.log(
        `[custom-tool:${config.name}] Running: ${command}`,
      )

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout,
          maxBuffer: 1024 * 1024,
          cwd: config.workingDirectory || os.homedir(),
          env: {
            ...process.env,
            ...config.env,
          },
        })
        const output = stdout.trim()
        if (output.length > 50000) {
          return output.slice(0, 50000) + '\n\n... (output truncated)'
        }
        return output || stderr?.trim() || '(no output)'
      } catch (error: any) {
        if (error.killed) {
          return `Error: command timed out after ${config.timeoutSeconds ?? 120} seconds`
        }
        const stderr = error.stderr?.trim() || ''
        const stdout = error.stdout?.trim() || ''
        return `Exit code ${error.code || 1}${stderr ? `\nStderr: ${stderr}` : ''}${stdout ? `\nStdout: ${stdout}` : ''}`
      }
    },
  })
}

/**
 * The built-in runCommand tool — a generic shell execution tool
 * that users can opt into via enableRunCommand: true.
 */
function createRunCommandTool(): AnyTool {
  return tool({
    description:
      'Run a shell command on the local machine and return the output. Use for CLI tools, reading files, file management, running scripts.',
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          'The shell command to execute. Example: "cat /path/to/file", "ls -la"',
        ),
      timeoutSeconds: z
        .number()
        .optional()
        .describe('Max execution time in seconds (default 120)'),
    }),
    execute: async (args: unknown) => {
      const { command, timeoutSeconds = 120 } = args as {
        command: string
        timeoutSeconds?: number
      }
      voiceConfigLogger.log(`[runCommand] Running: ${command}`)
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeoutSeconds * 1000,
          maxBuffer: 1024 * 1024,
          cwd: os.homedir(),
          env: process.env,
        })
        const output = stdout.trim()
        if (output.length > 50000) {
          return output.slice(0, 50000) + '\n\n... (output truncated)'
        }
        return output || stderr?.trim() || '(no output)'
      } catch (error: any) {
        if (error.killed) {
          return `Error: command timed out after ${timeoutSeconds} seconds`
        }
        const stderr = error.stderr?.trim() || ''
        const stdout = error.stdout?.trim() || ''
        return `Exit code ${error.code || 1}${stderr ? `\nStderr: ${stderr}` : ''}${stdout ? `\nStdout: ${stdout}` : ''}`
      }
    },
  })
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Load voice config and return custom tools and system prompt additions.
 */
export function getVoiceCustomization(): {
  customTools: Record<string, AnyTool>
  extraSystemPrompt: string
} {
  const config = loadVoiceConfig()

  const customTools: Record<string, AnyTool> = {}

  // Add runCommand if enabled
  if (config.enableRunCommand) {
    customTools.runCommand = createRunCommandTool()
  }

  // Add user-defined custom tools
  if (config.tools) {
    for (const toolConfig of config.tools) {
      if (!toolConfig.name || !toolConfig.command) {
        voiceConfigLogger.error(
          `Skipping invalid custom tool (missing name or command):`,
          toolConfig,
        )
        continue
      }
      customTools[toolConfig.name] = createCustomTool(toolConfig)
    }
  }

  return {
    customTools,
    extraSystemPrompt: config.systemPrompt || '',
  }
}
