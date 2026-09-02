// Shared plugin factory. OpenCode treats every export of a plugin module as
// an initializer, so this file must not be the registered entry.

import type { Plugin } from '@opencode-ai/plugin'
import { AutoModeClassifier } from './classify.ts'
import { getDefaultConfig, loadConfig, resolveModel } from './config.ts'
import { decide } from './decide.ts'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function createAutoModePlugin({ alwaysEnabled }: { alwaysEnabled: boolean }): Plugin {
  return async (input) => {
    const fileConfig = loadConfig({ projectDir: input.directory })
    if (!alwaysEnabled && !fileConfig) return {}

    const config = fileConfig ?? getDefaultConfig()
    const classifier = new AutoModeClassifier({
      client: input.client,
      directory: input.directory,
    })
    let modelResolved = false
    let resolvedModel = config.model

    const resolveModelOnce = async () => {
      if (modelResolved) return
      modelResolved = true
      const providers = await input.client.provider.list({
        query: { directory: input.directory },
      })
      const availableModels = new Set<string>()
      for (const provider of providers.data?.all ?? []) {
        for (const modelId of Object.keys(provider.models ?? {})) {
          availableModels.add(`${provider.id}/${modelId}`)
        }
      }
      resolvedModel = resolveModel({ config, availableModels })
    }

    return {
      'tool.execute.before': async (toolInput, output) => {
        const decision = decide({
          tool: toolInput.tool,
          args: asRecord(output.args),
          cwd: input.directory,
        })
        if (decision.kind === 'skip') return
        if (decision.kind === 'deny') {
          throw new Error(`[auto-mode] ${decision.reason}`)
        }
        await resolveModelOnce()
        const result = await classifier
          .classify({
            config: { ...config, model: resolvedModel },
            input: {
              tool: toolInput.tool,
              args: output.args,
              userText: '',
            },
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error)
            return { decision: 'block' as const, reason }
          })
        if (result.decision === 'block') {
          throw new Error(`[auto-mode] ${result.reason}`)
        }
      },
    }
  }
}
