// OpenCode plugin that guards task-created subagent sessions:
// - Auto-rejects permission requests so tasks don't hang waiting for user input
// - Aborts subagent sessions after rate limits so the parent task can recover

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import type { Event as V2Event } from '@opencode-ai/sdk/v2'
import {
  appendToastSessionMarker,
  createPluginLogger,
  formatPluginErrorWithStack,
  setPluginLogFilePath,
} from './plugin-logger.js'
import { createPluginClient } from './plugin-opencode-client.js'
import { initSentry } from './sentry.js'

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
  | Extract<V2Event, { type: 'permission.asked' }>

function getPermissionAskedEvent(event: PluginEvent) {
  if (event.type !== 'permission.asked') {
    return undefined
  }
  return event.properties
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

function getTaskLaunch(event: PluginEvent) {
  if (event.type !== 'message.part.updated') {
    return undefined
  }

  const part = event.properties.part
  if (part.type !== 'tool' || part.tool !== 'task' || part.state.status !== 'running') {
    return undefined
  }

  const subagentType = part.state.input?.subagent_type
  return {
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

export const subagentRateLimitPlugin: Plugin = async ({ serverUrl, directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  // Build our own v2 client. The plugin-provided ctx.client (v1) does not
  // reliably make REST calls (session.abort silently no-ops) from inside the
  // plugin process. See plugin-opencode-client.ts.
  const client = createPluginClient({ serverUrl, directory })
  logger.bindClient(client)

  const subagentSessions = new Map<string, {
    subagentType?: string
    aborting: boolean
  }>()
  let pendingTaskLaunch: { subagentType?: string } | undefined
  let unclaimedSessionId: string | undefined

  const trackSubagentSession = ({
    sessionId,
    subagentType,
  }: {
    sessionId: string
    subagentType?: string
  }) => {
    if (subagentSessions.has(sessionId)) {
      return
    }
    subagentSessions.set(sessionId, {
      subagentType,
      aborting: false,
    })
  }

  const abortSubagentSession = async ({
    sessionId,
    subagent,
    reason,
  }: {
    sessionId: string
    subagent: { subagentType?: string; aborting: boolean }
    reason: string
  }) => {
    if (subagent.aborting) {
      return
    }

    subagent.aborting = true
    const abortResult = await (async () => {
      await client.session.abort({ sessionID: sessionId, directory })

      // TODO: after aborting, send a followup prompt into the child session
      // telling the model the permission was denied and to continue another way
      // or end with a summary. promptAsync right after abort does not work
      // reliably because the abort event hasn't propagated yet.

      await client.tui.showToast({
        message: appendToastSessionMarker({
          message: `Aborting ${subagent.subagentType || 'subagent'} so the parent task can recover: ${reason}`,
          sessionId,
        }),
        variant: 'info',
      }).catch(() => {
        return
      })

      logger.info(`Aborted subagent ${sessionId}: ${reason}`)
    })()
      .catch((error) => {
        return new Error('Subagent abort failed', { cause: error })
      })

    subagentSessions.delete(sessionId)
    if (abortResult instanceof Error) {
      logger.warn(`[subagent-rate-limit-plugin] ${formatPluginErrorWithStack(abortResult)}`)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'message.updated' && event.properties.info.role === 'user') {
        if (unclaimedSessionId === event.properties.info.sessionID) {
          unclaimedSessionId = undefined
        }
      }

      const taskLaunch = getTaskLaunch(event)
      if (taskLaunch) {
        // OpenCode can emit the child session.created before the parent task
        // part exposes metadata.sessionId, so pair the task with the newest
        // session that has not produced a user message yet.
        if (unclaimedSessionId) {
          trackSubagentSession({
            sessionId: unclaimedSessionId,
            subagentType: taskLaunch.subagentType,
          })
          unclaimedSessionId = undefined
        } else {
          pendingTaskLaunch = { subagentType: taskLaunch.subagentType }
        }
      }

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

      if (event.type === 'session.created') {
        if (pendingTaskLaunch) {
          trackSubagentSession({
            sessionId: event.properties.info.id,
            subagentType: pendingTaskLaunch.subagentType,
          })
          pendingTaskLaunch = undefined
        } else {
          unclaimedSessionId = event.properties.info.id
        }
      }

      // Auto-reject permission requests for subagent sessions.
      // OpenCode's continue_loop_on_deny only works in the main processor
      // loop. Task/subtask permissions use Effect.orDie which turns rejections
      // into fatal defects, crashing the task. We reject immediately so the
      // task fails fast, then abort the child because denied task permissions
      // can otherwise keep emitting repeated permission requests.
      // TODO: remove the abort once OpenCode fixes task permission denial:
      // https://github.com/anomalyco/opencode/issues/31108
      //
      // This block runs BEFORE getEventSessionId() because the v1 SDK Event
      // union doesn't include permission.asked, so getEventSessionId() returns
      // undefined for these events and would early-return before we can act.
      const perm = getPermissionAskedEvent(event)
      if (perm) {
        const subagent = subagentSessions.get(perm.sessionID)
        if (subagent) {
          const replyResult = await client.permission.reply({
            requestID: perm.id,
            directory,
            reply: 'reject',
            message:
              'This task does not have interactive permission approval. ' +
              'Work around this restriction or report to the parent task ' +
              'that you need a different approach.',
          }).catch((error) => {
            logger.warn(`Failed to auto-reject subagent permission: ${formatPluginErrorWithStack(error)}`)
            return error
          })
          if (!(replyResult instanceof Error)) {
            logger.info(
              `Auto-rejected permission ${perm.id} for subagent ${perm.sessionID} (${perm.permission}: ${perm.patterns.join(', ')})`,
            )
          }
          await abortSubagentSession({
            sessionId: perm.sessionID,
            subagent,
            reason: `permission denied (${perm.permission}: ${perm.patterns.join(', ')})`,
          })
          return
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
      if (!subagent) {
        return
      }

      await abortSubagentSession({
        sessionId: eventSessionId,
        subagent,
        reason: `rate limit: ${rateLimitReason}`,
      })
    },
  }
}
