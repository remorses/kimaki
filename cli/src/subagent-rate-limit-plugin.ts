// OpenCode plugin that watches task-created subagent sessions for rate limits
// and resumes only that child session on a different provider/model.

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import * as errore from 'errore'
import {
  createPluginLogger,
  formatPluginErrorWithStack,
  setPluginLogFilePath,
} from './plugin-logger.js'
import { initSentry, notifyError } from './sentry.js'

const logger = createPluginLogger('SUBMODEL')
const RATE_LIMIT_SWITCH_COOLDOWN_MS = 10_000

const RATE_LIMIT_TEXT_PATTERNS = [
  'rate_limit',
  'rate limit',
  'resource exhausted',
  'retry after',
  'too many requests',
  'quota exceeded',
] as const

const CHEAP_FALLBACK_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5', 'claude-3-5-haiku-latest'],
  google: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
  openai: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5-nano'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
  mistral: ['mistral-small-latest'],
  xai: ['grok-4-1-fast-reasoning'],
  deepseek: ['deepseek-chat'],
} as const

type PluginClient = Parameters<Plugin>[0]['client']
type PluginEvent = Parameters<NonNullable<Hooks['event']>>[0]['event']

type ModelIdentifier = {
  providerID: string
  modelID: string
}

type SubagentSessionState = {
  subagentType?: string
  attemptedModelKeys: Set<string>
  currentModel?: ModelIdentifier
  switching: boolean
  ignoreRateLimitsUntil: number
}

const EMPTY_PROMPT_PARTS: NonNullable<
  Parameters<PluginClient['session']['promptAsync']>[0]['body']
>['parts'] = []

function modelKey(model: ModelIdentifier): string {
  return `${model.providerID}/${model.modelID}`
}

function isRateLimitText(text: string | undefined): boolean {
  if (!text) {
    return false
  }
  const haystack = text.toLowerCase()
  return RATE_LIMIT_TEXT_PATTERNS.some((pattern) => {
    return haystack.includes(pattern)
  })
}

function getTaskChildSessionId(event: PluginEvent) {
  if (event.type !== 'message.part.updated') {
    return undefined
  }

  const part = event.properties.part
  if (part.type !== 'tool' || part.tool !== 'task') {
    return undefined
  }

  const metadata = part.state.status === 'pending' ? undefined : part.state.metadata
  const childSessionId = metadata?.sessionId
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) {
    return undefined
  }

  const subagentType = part.state.input?.subagent_type
  return {
    childSessionId,
    subagentType: typeof subagentType === 'string' ? subagentType : undefined,
  }
}

function getEventSessionId(event: PluginEvent): string | undefined {
  if (event.type === 'session.status' || event.type === 'session.idle') {
    return event.properties.sessionID
  }
  if (event.type === 'session.error') {
    return event.properties.sessionID
  }
  if (event.type === 'message.updated') {
    return event.properties.info.sessionID
  }
  if (event.type === 'message.part.updated') {
    return event.properties.part.sessionID
  }
  if (
    event.type === 'session.created'
    || event.type === 'session.updated'
    || event.type === 'session.deleted'
  ) {
    return event.properties.info.id
  }
  return undefined
}

function getAssistantModel(event: PluginEvent): ModelIdentifier | undefined {
  if (event.type !== 'message.updated') {
    return undefined
  }

  const info = event.properties.info
  if (info.role !== 'assistant' || !info.providerID || !info.modelID) {
    return undefined
  }

  return {
    providerID: info.providerID,
    modelID: info.modelID,
  }
}

function extractRateLimitReason(event: PluginEvent): string | undefined {
  if (event.type === 'session.status' && event.properties.status.type === 'retry') {
    return isRateLimitText(event.properties.status.message)
      ? event.properties.status.message
      : undefined
  }

  if (event.type === 'message.part.updated' && event.properties.part.type === 'retry') {
    const retryError = event.properties.part.error
    if (retryError.data.statusCode === 429) {
      return retryError.data.message
    }
    if (isRateLimitText(retryError.data.responseBody)) {
      return retryError.data.responseBody
    }
    return isRateLimitText(retryError.data.message)
      ? retryError.data.message
      : undefined
  }

  const apiError = (() => {
    if (event.type === 'session.error' && event.properties.error?.name === 'APIError') {
      return event.properties.error.data
    }
    if (
      event.type === 'message.updated'
      && event.properties.info.role === 'assistant'
      && event.properties.info.error?.name === 'APIError'
    ) {
      return event.properties.info.error.data
    }
    return undefined
  })()

  if (!apiError) {
    return undefined
  }
  if (apiError.statusCode === 429) {
    return apiError.message
  }
  if (isRateLimitText(apiError.responseBody)) {
    return apiError.responseBody
  }
  return isRateLimitText(apiError.message) ? apiError.message : undefined
}

export function listCandidateModels({
  providerData,
  currentModel,
}: {
  providerData: NonNullable<Awaited<ReturnType<PluginClient['provider']['list']>>['data']>
  currentModel?: ModelIdentifier
}): ModelIdentifier[] {
  const availableModelIds = new Map(
    providerData.all.map((provider) => {
      return [provider.id, new Set(Object.keys(provider.models))] as const
    }),
  )
  const otherProviders = providerData.connected.filter((providerID) => {
    return providerID !== currentModel?.providerID
  })

  const preferredModels = otherProviders.flatMap((providerID) => {
    const providerModels = availableModelIds.get(providerID)
    if (!providerModels) {
      return []
    }
    return (CHEAP_FALLBACK_MODELS[providerID] || []).flatMap((modelID) => {
      if (!providerModels.has(modelID)) {
        return []
      }
      return [{ providerID, modelID }]
    })
  })

  const defaultModels = otherProviders.flatMap((providerID) => {
    const modelID = providerData.default[providerID]
    if (!modelID) {
      return []
    }
    return [{ providerID, modelID }]
  })

  const remainingModels = otherProviders.flatMap((providerID) => {
    const providerModels = availableModelIds.get(providerID)
    if (!providerModels) {
      return []
    }
    return [...providerModels]
      .sort((a, b) => {
        return a.localeCompare(b)
      })
      .map((modelID) => {
        return { providerID, modelID }
      })
  })

  const seen = new Set<string>()
  return [...preferredModels, ...defaultModels, ...remainingModels].filter((candidate) => {
    const key = modelKey(candidate)
    if (currentModel && key === modelKey(currentModel)) {
      return false
    }
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export const subagentRateLimitPlugin: Plugin = async ({ client, directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const subagentSessions = new Map<string, SubagentSessionState>()

  return {
    event: async ({ event }) => {
      const taskChild = getTaskChildSessionId(event)
      if (taskChild) {
        const existing = subagentSessions.get(taskChild.childSessionId)
        if (existing) {
          if (taskChild.subagentType) {
            existing.subagentType = taskChild.subagentType
          }
        } else {
          subagentSessions.set(taskChild.childSessionId, {
            subagentType: taskChild.subagentType,
            attemptedModelKeys: new Set<string>(),
            switching: false,
            ignoreRateLimitsUntil: 0,
          })
        }
      }

      const eventSessionId = getEventSessionId(event)
      if (!eventSessionId) {
        return
      }

      if (event.type === 'session.deleted') {
        subagentSessions.delete(eventSessionId)
        return
      }

      const assistantModel = getAssistantModel(event)
      if (assistantModel) {
        const session = subagentSessions.get(eventSessionId)
        if (session) {
          session.currentModel = assistantModel
          session.attemptedModelKeys.add(modelKey(assistantModel))
        }
      }

      const rateLimitReason = extractRateLimitReason(event)
      if (!rateLimitReason) {
        return
      }

      const subagent = subagentSessions.get(eventSessionId)
      if (!subagent) {
        return
      }
      if (subagent.switching || Date.now() < subagent.ignoreRateLimitsUntil) {
        return
      }

      subagent.switching = true
      const switchResult = await errore.tryAsync({
        try: async () => {
          const providerResponse = await client.provider.list({
            query: { directory },
          })
          if (!providerResponse.data) {
            return
          }

          const nextModel = listCandidateModels({
            providerData: providerResponse.data,
            currentModel: subagent.currentModel,
          }).find((candidate) => {
            return !subagent.attemptedModelKeys.has(modelKey(candidate))
          })
          if (!nextModel) {
            logger.info(
              `No alternate model available for subagent ${eventSessionId}${subagent.subagentType ? ` (${subagent.subagentType})` : ''}`,
            )
            return
          }

          subagent.currentModel = nextModel
          subagent.attemptedModelKeys.add(modelKey(nextModel))
          subagent.ignoreRateLimitsUntil = Date.now() + RATE_LIMIT_SWITCH_COOLDOWN_MS

          await client.session.promptAsync({
            path: { id: eventSessionId },
            body: {
              model: nextModel,
              parts: EMPTY_PROMPT_PARTS,
            },
          })

          await client.tui.showToast({
            body: {
              message: `Switching ${subagent.subagentType || 'subagent'} to ${modelKey(nextModel)} after rate limit: ${rateLimitReason} ${eventSessionId}`,
              variant: 'info',
            },
          }).catch(() => {
            return
          })

          logger.info(
            `Switched subagent ${eventSessionId} to ${modelKey(nextModel)} after rate limit`,
          )
        },
        catch: (error) => {
          return new Error('Subagent rate-limit model switch failed', {
            cause: error,
          })
        },
      })

      subagent.switching = false
      if (!(switchResult instanceof Error)) {
        return
      }

      logger.warn(`[subagent-rate-limit-plugin] ${formatPluginErrorWithStack(switchResult)}`)
      void notifyError(switchResult, 'subagent rate-limit plugin switch failed')
    },
  }
}
