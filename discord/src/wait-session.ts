// Wait utilities for polling session completion.
// Used by `kimaki send --wait` to block until a session finishes,
// then output the session markdown to stdout.

import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { ShareMarkdown } from './markdown.js'
import { createLogger, LogPrefix } from './logger.js'

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

  throw new Error(`Timed out waiting for session ID (thread: ${threadId}, timeout: ${timeoutMs}ms)`)
}

/**
 * Poll the OpenCode SDK until the session's last assistant message
 * has `time.completed` set, meaning the model finished responding.
 */
export async function waitForSessionComplete({
  projectDirectory,
  sessionId,
  timeoutMs = 30 * 60 * 1000,
}: {
  projectDirectory: string
  sessionId: string
  timeoutMs?: number
}): Promise<void> {
  const pollIntervalMs = 3_000
  const startTime = Date.now()

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(`Failed to connect to OpenCode server: ${getClient.message}`, { cause: getClient })
  }

  while (Date.now() - startTime < timeoutMs) {
    const messagesResponse = await getClient().session.messages({
      path: { id: sessionId },
    })
    const messages = messagesResponse.data || []

    // Find the last assistant message
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.info.role === 'assistant')

    if (lastAssistant && lastAssistant.info.role === 'assistant' && lastAssistant.info.time.completed) {
      waitLogger.log(`Session ${sessionId} completed`)
      return
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  throw new Error(`Timed out waiting for session completion (session: ${sessionId}, timeout: ${timeoutMs}ms)`)
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
}: {
  threadId: string
  projectDirectory: string
  sessionIdTimeoutMs?: number
  completionTimeoutMs?: number
}): Promise<void> {
  waitLogger.log('Waiting for session ID...')
  const sessionId = await waitForSessionId({ threadId, timeoutMs: sessionIdTimeoutMs })

  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({ projectDirectory, sessionId, timeoutMs: completionTimeoutMs })

  waitLogger.log('Generating session output...')
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(`Failed to connect to OpenCode server: ${getClient.message}`, { cause: getClient })
  }

  const markdown = new ShareMarkdown(getClient())
  const result = await markdown.generate({ sessionID: sessionId })
  if (result instanceof Error) {
    throw new Error(`Failed to generate session markdown: ${result.message}`, { cause: result })
  }

  process.stdout.write(result)
}
