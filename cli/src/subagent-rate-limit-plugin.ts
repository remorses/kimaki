// OpenCode plugin that watches task-created subagent sessions for rate limits
// and resumes only that child session on a different model.

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

type PluginInput = Parameters<Plugin>[0]
type PluginClient = PluginInput['client']
type PluginEvent = Parameters<NonNullable<Hooks['event']>>[0]['event']
type PromptAsyncInput = Parameters<PluginClient['session']['promptAsync']>[0]
type ProviderListResponse = Awaited<ReturnType<PluginClient['provider']['list']>>

type ModelIdentifier = {
  providerID: string
  modelID: string
}

type SubagentSessionState = {
  parentSessionId: string
  subagentType?: string
  attemptedModelKeys: Set<string>
  currentModel?: ModelIdentifier
  switching: boolean
  ignoreRateLimitsUntil: number
}

const EMPTY_PROMPT_PARTS: NonNullable<PromptAsyncInput['body']>['parts'] = []

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

function modelKey(model: ModelIdentifier): string {
  return `${model.providerID}/${model.modelID}`
}

function appendToastSessionMarker({
  message,
  sessionId,
}: {
  message: string
  sessionId: string
}): string {
  return `${message} ${sessionId}`
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

function getTaskChildSessionId({
  event,
}: {
  event: PluginEvent
}): { childSessionId: string; parentSessionId: string; subagentType?: string } | undefined {
  if (event.type !== 'message.part.updated') {
    return undefined
  }
  const part = event.properties.part
  if (part.type !== 'tool' || part.tool !== 'task') {
    return undefined
  }

  const metadataValue = (() => {
    if (part.state.status === 'pending') {
      return undefined
    }
    return part.state.metadata
  })()
  const childSessionId =
    metadataValue && typeof metadataValue === 'object'
      ? (metadataValue as { sessionId?: unknown }).sessionId
      : undefined
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) {
    return undefined
  }

  const subagentType = part.state.input?.subagent_type
  return {
    childSessionId,
    parentSessionId: part.sessionID,
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
  if (event.type === 'session.created' || event.type === 'session.updated' || event.type === 'session.deleted') {
    return event.properties.info.id
  }
  return undefined
}

function getAssistantModel({
  event,
}: {
  event: PluginEvent
}): ModelIdentifier | undefined {
  if (event.type !== 'message.updated') {
    return undefined
  }
  const info = event.properties.info
  if (info.role !== 'assistant') {
    return undefined
  }
  if (!info.providerID || !info.modelID) {
    return undefined
  }
  return {
    providerID: info.providerID,
    modelID: info.modelID,
  }
}

function extractRateLimitReason({
  event,
}: {
  event: PluginEvent
}): string | undefined {
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
    return isRateLimitText(retryError.data.responseBody)
      ? retryError.data.responseBody
      : isRateLimitText(retryError.data.message)
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
  if (isRateLimitText(apiError.message)) {
    return apiError.message
  }
  return undefined
}

function listCandidateModels({
  providerData,
  currentModel,
}: {
  providerData: NonNullable<ProviderListResponse['data']>
  currentModel?: ModelIdentifier
}): ModelIdentifier[] {
  const providerById = new Map(
    providerData.all.map((provider) => {
      return [provider.id, provider] as const
    }),
  )

  const otherProviderDefaults = providerData.connected
    .filter((providerID) => {
      return providerID !== currentModel?.providerID
    })
    .map((providerID) => {
      const defaultModelID = providerData.default[providerID]
      if (!defaultModelID) {
        return undefined
      }
      return { providerID, modelID: defaultModelID }
    })
    .filter(isTruthy)

  const allConnectedModels = providerData.connected.flatMap((providerID) => {
    const provider = providerById.get(providerID)
    if (!provider) {
      return []
    }
    return Object.values(provider.models).map((model) => {
      return {
        providerID,
        modelID: model.id,
      }
    })
  })

  const seen = new Set<string>()
  return [...otherProviderDefaults, ...allConnectedModels].filter((candidate) => {
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

function createSubagentState() {
  const sessions = new Map<string, SubagentSessionState>()

  function getOrCreate({
    childSessionId,
    parentSessionId,
    subagentType,
  }: {
    childSessionId: string
    parentSessionId: string
    subagentType?: string
  }): SubagentSessionState {
    const existing = sessions.get(childSessionId)
    if (existing) {
      if (subagentType) {
        existing.subagentType = subagentType
      }
      return existing
    }
    const nextState: SubagentSessionState = {
      parentSessionId,
      subagentType,
      attemptedModelKeys: new Set<string>(),
      switching: false,
      ignoreRateLimitsUntil: 0,
    }
    sessions.set(childSessionId, nextState)
    return nextState
  }

  return {
    rememberTaskChild({
      childSessionId,
      parentSessionId,
      subagentType,
    }: {
      childSessionId: string
      parentSessionId: string
      subagentType?: string
    }): void {
      getOrCreate({ childSessionId, parentSessionId, subagentType })
    },

    rememberAssistantModel({
      sessionId,
      model,
    }: {
      sessionId: string
      model: ModelIdentifier
    }): void {
      const session = sessions.get(sessionId)
      if (!session) {
        return
      }
      session.currentModel = model
      session.attemptedModelKeys.add(modelKey(model))
    },

    getSubagent(sessionId: string): SubagentSessionState | undefined {
      return sessions.get(sessionId)
    },

    cleanup(sessionId: string): void {
      sessions.delete(sessionId)
    },
  }
}

export const subagentRateLimitPlugin: Plugin = async ({ client, directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const state = createSubagentState()

  return {
    event: async ({ event }) => {
      const taskChild = getTaskChildSessionId({ event })
      if (taskChild) {
        state.rememberTaskChild(taskChild)
      }

      const eventSessionId = getEventSessionId(event)
      if (!eventSessionId) {
        return
      }

      if (event.type === 'session.deleted') {
        state.cleanup(eventSessionId)
        return
      }

      const assistantModel = getAssistantModel({ event })
      if (assistantModel) {
        state.rememberAssistantModel({
          sessionId: eventSessionId,
          model: assistantModel,
        })
      }

      const rateLimitReason = extractRateLimitReason({ event })
      if (!rateLimitReason) {
        return
      }

      const subagent = state.getSubagent(eventSessionId)
      if (!subagent) {
        return
      }
      if (subagent.switching) {
        return
      }
      if (Date.now() < subagent.ignoreRateLimitsUntil) {
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

          await client.tui
            .showToast({
              body: {
                message: appendToastSessionMarker({
                  message:
                    `Switching ${subagent.subagentType || 'subagent'} to ${modelKey(nextModel)} after rate limit: ${rateLimitReason}`,
                  sessionId: eventSessionId,
                }),
                variant: 'info',
              },
            })
            .catch(() => {
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
