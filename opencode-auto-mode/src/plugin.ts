// Shared plugin factory. OpenCode treats every export of a plugin module as
// an initializer, so this file must not be the registered entry.

import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { AutoModeClassifier } from './classify.ts'
import { CLASSIFIER_POLICY } from './classifier.ts'
import { getDefaultConfig, loadConfig, resolveModel } from './config.ts'
import { decide } from './decide.ts'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function loadUserText({
  client,
  sessionID,
  directory,
}: {
  client: PluginInput['client']
  sessionID: string
  directory: string
}) {
  const messages = await client.session
    .messages({
      path: { id: sessionID },
      query: { directory },
    })
    .catch(() => undefined)
  const texts: string[] = []
  for (const message of messages?.data ?? []) {
    const info = (message as { info?: { role?: string } }).info
    if (info?.role !== 'user') continue
    for (const part of message.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text)
      }
    }
  }
  return texts.at(-1) ?? ''
}

export function createAutoModePlugin({ alwaysEnabled }: { alwaysEnabled: boolean }): Plugin {
  return async (input) => {
    const loaded = loadConfig({ projectDir: input.directory })
    if (loaded.kind === 'disabled' && !alwaysEnabled) return {}
    const invalidReason = loaded.kind === 'invalid' ? loaded.reason : undefined
    const config = loaded.kind === 'enabled' ? loaded.config : getDefaultConfig()
    const classifier = new AutoModeClassifier({
      client: input.client,
      directory: input.directory,
    })
    const resolvedModelPromise = input.client.provider
      .list({ query: { directory: input.directory } })
      .then((providers) => {
        const availableModels = new Set<string>()
        for (const provider of providers.data?.all ?? []) {
          for (const modelId of Object.keys(provider.models ?? {})) {
            availableModels.add(`${provider.id}/${modelId}`)
          }
        }
        return resolveModel({ config, availableModels })
      })
      .catch(() => config.model)

    return {
      'experimental.chat.system.transform': async (transformInput, output) => {
        if (!transformInput.sessionID) return
        if (!classifier.isClassifierSession(transformInput.sessionID)) return
        output.system = [CLASSIFIER_POLICY]
      },
      'tool.execute.before': async (toolInput, output) => {
        if (invalidReason) {
          throw new Error(`[auto-mode] ${invalidReason}`)
        }
        if (classifier.isClassifierSession(toolInput.sessionID)) {
          throw new Error('[auto-mode] Classifier sessions cannot execute tools')
        }
        const decision = decide({
          tool: toolInput.tool,
          args: asRecord(output.args),
          cwd: input.directory,
        })
        if (decision.kind === 'skip') return
        if (decision.kind === 'deny') {
          throw new Error(`[auto-mode] ${decision.reason}`)
        }
        const resolvedModel = await resolvedModelPromise
        const userText = await loadUserText({
          client: input.client,
          sessionID: toolInput.sessionID,
          directory: input.directory,
        })
        const result = await classifier
          .classify({
            config: { ...config, model: resolvedModel },
            input: {
              tool: toolInput.tool,
              args: output.args,
              userText,
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
