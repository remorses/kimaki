// Shared plugin factory. OpenCode treats every export of a plugin module as
// an initializer, so this file must not be the registered entry.

import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { AutoModeClassifier } from './classify.ts'
import { CLASSIFIER_POLICY } from './classifier.ts'
import { getDefaultConfig, loadConfig } from './config.ts'
import { decide } from './decide.ts'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

type SessionMessage = {
  info: {
    role: string
    model?: { providerID: string; modelID: string }
    providerID?: string
    modelID?: string
    summary?: unknown
  }
  parts?: Array<{ type: string; text?: string }>
}

export function sessionContextFromMessages(messages: SessionMessage[]) {
  const message = messages.findLast((entry) => entry.info.role === 'user')
  if (!message?.info.model) return { kind: 'error' as const }
  const userText = (message.parts ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim())
    .map((part) => part.text)
    .join('\n')
  if (!userText) return { kind: 'error' as const }
  return { kind: 'ok' as const, userText, mainModel: message.info.model }
}

async function loadSessionContext({
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
  if (!messages?.data) return { kind: 'error' as const }
  return sessionContextFromMessages(messages.data)
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
        const context = await loadSessionContext({
          client: input.client,
          sessionID: toolInput.sessionID,
          directory: input.directory,
        })
        if (context.kind === 'error') {
          throw new Error(
            '[auto-mode] The current user turn could not be loaded; auto mode fails closed.',
          )
        }
        const result = await classifier
          .classify({
            config,
            input: {
              tool: toolInput.tool,
              args: output.args,
              userText: context.userText,
            },
            mainModel: context.mainModel,
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
