// Wait utilities for polling session completion.
// Used by `kimaki send --wait` and `kimaki session wait` to block until a
// session completes (idle, latest turn finished naturally, no pending
// permission) OR pauses for a user question. A session parked on a `question`
// tool never completes on its own, so it is treated as done for automation.

import type { Message as OpenCodeMessage } from '@opencode-ai/sdk/v2'
import { getSessionEventSnapshot, getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { ShareMarkdown } from './markdown.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  derivePendingPermissionRequests,
  isAssistantMessageNaturalCompletion,
  type EventBufferEntry,
  type EventBufferEvent,
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

    const messagesResponse = await getClient().message.list({
      sessionID: sessionId,
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
    try {
      return [{
        event: JSON.parse(row.event_json) as EventBufferEvent,
        timestamp: Number(row.timestamp),
        eventIndex: Number(row.event_index),
      }]
    } catch (error) {
      waitLogger.warn(
        `Skipping invalid persisted session event for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  })
}

function hasCompletedUserTurn({
  messages,
  waitStartedAtMs,
}: {
  messages: Array<{ type: string; time: { created: number; completed?: number } }>
  sessionId: string
  waitStartedAtMs: number
}): boolean {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => {
      return message.type === 'user'
        && message.time.created >= waitStartedAtMs
    })
  if (!latestUserMessage) {
    return false
  }

  const latestAssistant = [...messages]
    .reverse()
    .find((message) => {
      return message.type === 'assistant'
        && typeof message.time.completed === 'number'
        && message.time.created >= latestUserMessage.time.created
    })
  return Boolean(latestAssistant)
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
