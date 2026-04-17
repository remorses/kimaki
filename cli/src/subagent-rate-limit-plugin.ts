// OpenCode plugin that aborts task-created subagent sessions after rate limits.

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import * as errore from 'errore'
import {
  createPluginLogger,
  formatPluginErrorWithStack,
  setPluginLogFilePath,
} from './plugin-logger.js'
import { initSentry, notifyError } from './sentry.js'

const logger = createPluginLogger('SUBMODEL')

const RATE_LIMIT_TEXT_PATTERNS = [
  'rate_limit',
  'rate limit',
  'resource exhausted',
  'retry after',
  'too many requests',
  'quota exceeded',
] as const

type PluginEvent = Parameters<NonNullable<Hooks['event']>>[0]['event']

function isRateLimitText(text: string | undefined): boolean {
  if (!text) {
    return false
  }

  const haystack = text.toLowerCase()
  return RATE_LIMIT_TEXT_PATTERNS.some((pattern) => {
    return haystack.includes(pattern)
  })
}

function getTaskChildSession(event: PluginEvent) {
  if (event.type !== 'message.part.updated') {
    return undefined
  }

  const part = event.properties.part
  if (part.type !== 'tool' || part.tool !== 'task' || part.state.status === 'pending') {
    return undefined
  }

  const childSessionId = part.state.metadata?.sessionId
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

export const subagentRateLimitPlugin: Plugin = async ({ client, directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const subagentSessions = new Map<string, {
    subagentType?: string
    aborting: boolean
  }>()

  return {
    event: async ({ event }) => {
      const taskChild = getTaskChildSession(event)
      if (taskChild) {
        const existing = subagentSessions.get(taskChild.childSessionId)
        if (existing) {
          if (taskChild.subagentType) {
            existing.subagentType = taskChild.subagentType
          }
        } else {
          subagentSessions.set(taskChild.childSessionId, {
            subagentType: taskChild.subagentType,
            aborting: false,
          })
        }
      }

      const eventSessionId = getEventSessionId(event)
      if (!eventSessionId) {
        return
      }

      if (event.type === 'session.deleted' || event.type === 'session.idle') {
        subagentSessions.delete(eventSessionId)
        return
      }

      const rateLimitReason = extractRateLimitReason(event)
      if (!rateLimitReason) {
        return
      }

      const subagent = subagentSessions.get(eventSessionId)
      if (!subagent || subagent.aborting) {
        return
      }

      subagent.aborting = true
      const abortResult = await errore.tryAsync({
        try: async () => {
          await client.session.abort({
            path: { id: eventSessionId },
            query: { directory },
          })

          await client.tui.showToast({
            body: {
              message: `Aborting ${subagent.subagentType || 'subagent'} after rate limit so the parent task can recover: ${rateLimitReason} ${eventSessionId}`,
              variant: 'info',
            },
          }).catch(() => {
            return
          })

          logger.info(
            `Aborted subagent ${eventSessionId} after rate limit`,
          )
        },
        catch: (error) => {
          return new Error('Subagent rate-limit abort failed', {
            cause: error,
          })
        },
      })

      subagentSessions.delete(eventSessionId)
      if (!(abortResult instanceof Error)) {
        return
      }

      logger.warn(`[subagent-rate-limit-plugin] ${formatPluginErrorWithStack(abortResult)}`)
      void notifyError(abortResult, 'subagent rate-limit plugin abort failed')
    },
  }
}
