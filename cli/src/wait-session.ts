// Wait utilities for polling session completion.
// Used by `kimaki send --wait` and `kimaki session wait` to block until a
// session completes (idle, latest turn finished naturally, no pending
// permission) OR pauses for a user question. A session parked on a `question`
// tool never completes on its own, so it is treated as done for automation.

import type { SessionMessageInfo } from '@opencode/client'
import { getSessionEventSnapshot, getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { ShareMarkdown } from './markdown.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  derivePendingPermissionRequests,
  getEventBufferSessionId,
  parseEventBufferEvent,
  type EventBufferEntry,
} from './session-handler/event-stream-state.js'

const waitLogger = createLogger(LogPrefix.SESSION)

/**
 * Poll the kimaki database until a session ID appears for the given thread.
 * The bot writes this mapping in session-handler.ts:551 when it picks up
 * the thread and creates/reuses a session.
 */
export async function waitForSessionId({
  threadId,
  timeoutMs = 120_000,
}: {
  threadId: string
  timeoutMs?: number
}): Promise<string> {
  const startTime = Date.now()
  const pollIntervalMs = 2_000

  while (Date.now() - startTime < timeoutMs) {
    const sessionId = await getThreadSession(threadId)
    if (sessionId) {
      waitLogger.log(`Session ID resolved: ${sessionId}`)
      return sessionId
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  throw new Error(
    `Timed out waiting for session ID (thread: ${threadId}, timeout: ${timeoutMs}ms)`,
  )
}

/**
 * Poll the OpenCode SDK and persisted Kimaki events until the session is idle,
 * its latest user turn completed naturally, and no permission prompt is pending
 * -- or until the session pauses on a user question (which never completes on
 * its own and is treated as done for automation).
 */
export async function waitForSessionComplete({
  projectDirectory,
  sessionId,
  timeoutMs = 30 * 60 * 1000,
  waitStartedAtMs = 0,
}: {
  projectDirectory: string
  sessionId: string
  timeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  const pollIntervalMs = 5_000
  const startTime = Date.now()
  let completedSinceMs: number | null = null

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(
      `Failed to connect to OpenCode server: ${getClient.message}`,
      {
        cause: getClient,
      },
    )
  }

  while (Date.now() - startTime < timeoutMs) {
    const activeSessions = await getClient().session.active()
    const sessionStatus = activeSessions[sessionId]
    const isBusy = Boolean(sessionStatus)

    // A session parked on a form reports active but will never complete
    // on its own, so treat a live form as done for automation and stop
    // waiting. Guard on busy: an orphaned form left after an abort
    // (session idle) must fall through to the normal idle/completion checks.
    if (isBusy) {
      const pendingForms = await getClient().form
        .list({ sessionID: sessionId })
        .catch(() => [])
      if (Array.isArray(pendingForms) && pendingForms.length > 0) {
        waitLogger.log(`Session ${sessionId} is showing a user question; treating as complete`)
        return
      }
    }

    const messagesResponse = await getClient().message.list({
      sessionID: sessionId,
      order: 'asc',
    })
    const messages = messagesResponse.data
    const events = await loadPersistedSessionEvents({ sessionId })
    const pendingPermissions = derivePendingPermissionRequests({
      events,
      sessionId,
    })

    const isIdle = !sessionStatus
    const hasPendingPermissions = pendingPermissions.length > 0
    const hasCompletedTurn = hasCompletedUserTurn({
      messages,
      events,
      sessionId,
      waitStartedAtMs,
    })

    if (isIdle && hasCompletedTurn && !hasPendingPermissions) {
      completedSinceMs ??= Date.now()
      if (Date.now() - completedSinceMs >= pollIntervalMs) {
        waitLogger.log(`Session ${sessionId} completed`)
        return
      }
    } else {
      completedSinceMs = null
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  throw new Error(
    `Timed out waiting for session completion (session: ${sessionId}, timeout: ${timeoutMs}ms)`,
  )
}

export async function waitAndOutputExistingSession({
  sessionId,
  projectDirectory,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  sessionId: string
  projectDirectory: string
  completionTimeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({
    projectDirectory,
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId, projectDirectory })
}

async function outputSessionMarkdown({
  sessionId,
  projectDirectory,
}: {
  sessionId: string
  projectDirectory: string
}): Promise<void> {
  waitLogger.log('Generating session output...')
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(
      `Failed to connect to OpenCode server: ${getClient.message}`,
      {
        cause: getClient,
      },
    )
  }

  const markdown = new ShareMarkdown(getClient())
  const result = await markdown.generate({ sessionID: sessionId })
  if (result instanceof Error) {
    throw new Error(`Failed to generate session markdown: ${result.message}`, {
      cause: result,
    })
  }

  process.stdout.write(result)
}

async function loadPersistedSessionEvents({
  sessionId,
}: {
  sessionId: string
}): Promise<EventBufferEntry[]> {
  const rows = await getSessionEventSnapshot({ sessionId })
  return rows.flatMap((row) => {
    const event = parseEventBufferEvent(row.event_json)
    if (event instanceof Error) {
      waitLogger.warn(
        `Skipping invalid persisted session event for ${sessionId}: ${event.message}`,
      )
      return []
    }
    return [{
      event,
      timestamp: Number(row.timestamp),
      eventIndex: Number(row.event_index),
    }]
  })
}

export function hasCompletedUserTurn({
  messages,
  events,
  sessionId,
  waitStartedAtMs,
}: {
  messages: SessionMessageInfo[]
  events: EventBufferEntry[]
  sessionId: string
  waitStartedAtMs: number
}): boolean {
  const ascending = [...messages].sort((left, right) => {
    return left.time.created - right.time.created
  })
  const latestUserMessage = [...ascending]
    .reverse()
    .find((message) => {
      return message.type === 'user'
        && message.time.created >= waitStartedAtMs
    })
  if (!latestUserMessage) {
    return false
  }

  const latestAssistant = [...ascending]
    .reverse()
    .find((message) => {
      return message.type === 'assistant'
        && message.time.created >= latestUserMessage.time.created
    })
  if (!latestAssistant || latestAssistant.type !== 'assistant') return false
  const assistantCompletedAt = latestAssistant.time.completed
  if (typeof assistantCompletedAt !== 'number') return false
  if (latestAssistant.error || latestAssistant.finish === 'error') return false
  if (latestAssistant.finish !== 'stop' && latestAssistant.finish !== 'tool-calls') return false
  if (latestAssistant.content.length === 0) return false
  const hasOutput = latestAssistant.content.some((part) => {
    if (part.type === 'text') return Boolean(part.text.trim())
    return part.type === 'tool'
  })
  if (!hasOutput) return false
  const hasIncompleteTool = latestAssistant.content.some((part) => {
    return part.type === 'tool' && part.state.status !== 'completed'
  })
  if (hasIncompleteTool) return false

  const latestTerminalExecution = [...events].reverse().find(({ event }) => {
    if (getEventBufferSessionId(event) !== sessionId) return false
    return event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.failed'
      || event.type === 'session.execution.interrupted'
  })
  if (latestTerminalExecution?.event.type !== 'session.execution.succeeded') return false
  return latestTerminalExecution.event.created >= assistantCompletedAt
}

/**
 * Wait for session completion and output the session markdown to stdout.
 * Orchestrates the full wait flow: session ID resolution -> completion -> output.
 */
export async function waitAndOutputSession({
  threadId,
  projectDirectory,
  sessionIdTimeoutMs,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  threadId: string
  projectDirectory: string
  sessionIdTimeoutMs?: number
  completionTimeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  waitLogger.log('Waiting for session ID...')
  const sessionId = await waitForSessionId({
    threadId,
    timeoutMs: sessionIdTimeoutMs,
  })

  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({
    projectDirectory,
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId, projectDirectory })
}
