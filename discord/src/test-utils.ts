// Shared e2e test utilities for session cleanup, server cleanup, and
// Discord message polling helpers.
// Uses directory + start timestamp double-filter to ensure we only
// delete sessions created by this specific test run, never real user sessions.
//
// Prefers using the existing opencode client (already running server) to avoid
// spawning a new server process during teardown. Falls back to initializing
// a new server only if no existing client is available.

import type { APIMessage } from 'discord.js'
import type { DigitalDiscord } from 'discord-digital-twin/src'
import {
  getOpencodeClient,
  getOpencodeServers,
  initializeOpencodeForDirectory,
} from './opencode.js'
import {
  getThreadState,
  type ThreadRunState,
} from './session-handler/thread-runtime-state.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'

/**
 * Kill all in-memory opencode server processes and clear the registry.
 * Does NOT delete sessions from the opencode DB — call cleanupTestSessions for that.
 */
export async function cleanupOpencodeServers() {
  const servers = getOpencodeServers()
  for (const [, server] of servers) {
    if (!server.process.killed) {
      server.process.kill('SIGTERM')
    }
  }
  servers.clear()
}

/**
 * Delete all opencode sessions created during a test run.
 * Uses directory + start timestamp to scope strictly to test sessions.
 * Prefers the existing in-memory client to avoid spawning a new server in teardown.
 * Errors are caught silently — cleanup should never fail tests.
 */
export async function cleanupTestSessions({
  projectDirectory,
  testStartTime,
}: {
  projectDirectory: string
  testStartTime: number
}) {
  // Prefer existing client to avoid spawning a new server during teardown
  const existingClient = getOpencodeClient(projectDirectory)
  const client = existingClient || await (async () => {
    const getClient = await initializeOpencodeForDirectory(projectDirectory).catch(() => {
      return null
    })
    if (!getClient || getClient instanceof Error) return null
    return getClient()
  })()
  if (!client) return

  const listResult = await client.session.list({
    directory: projectDirectory,
    start: testStartTime,
    limit: 1000,
  }).catch(() => {
    return null
  })
  const sessions = listResult?.data ?? []
  await Promise.all(
    sessions.map((s) => {
      return client.session.delete({
        sessionID: s.id,
        directory: projectDirectory,
      }).catch(() => {
        return
      })
    }),
  )
}

// ── Discord message polling helpers ──────────────────────────────
// Used by e2e tests to wait for bot responses. All poll at 100ms
// intervals with configurable timeouts.

/** Poll getMessages until we see at least `count` bot messages. */
export async function waitForBotMessageCount({
  discord,
  threadId,
  count,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  count: number
  timeout: number
}): Promise<APIMessage[]> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const botMessages = messages.filter((m) => {
      return m.author.id === discord.botUserId
    })
    if (botMessages.length >= count) {
      return messages
    }
    await new Promise((r) => {
      setTimeout(r, 100)
    })
  }
  throw new Error(
    `Timed out waiting for ${count} bot messages in thread ${threadId}`,
  )
}

/**
 * Poll until a bot message appears after a user message containing the given text.
 * Content-aware: finds the user message by content, then checks for a bot reply after it.
 */
export async function waitForBotReplyAfterUserMessage({
  discord,
  threadId,
  userId,
  userMessageIncludes,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  userId: string
  userMessageIncludes: string
  timeout: number
}): Promise<APIMessage[]> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const userMessageIndex = messages.findIndex((message) => {
      return (
        message.author.id === userId &&
        message.content.includes(userMessageIncludes)
      )
    })
    const botReplyIndex = messages.findIndex((message, index) => {
      return index > userMessageIndex && message.author.id === discord.botUserId
    })
    if (userMessageIndex >= 0 && botReplyIndex >= 0) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error(
    `Timed out waiting for bot reply after user message containing "${userMessageIncludes}" in thread ${threadId}`,
  )
}

/**
 * Poll until a bot message containing specific text appears.
 * Optionally scoped to appear after a specific user message.
 */
export async function waitForBotMessageContaining({
  discord,
  threadId,
  userId,
  text,
  afterUserMessageIncludes,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  userId: string
  text: string
  afterUserMessageIncludes?: string
  timeout: number
}): Promise<APIMessage[]> {
  const start = Date.now()
  let lastMessages: APIMessage[] = []
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    lastMessages = messages
    const afterIndex = afterUserMessageIncludes
      ? messages.findIndex((message) => {
          return (
            message.author.id === userId &&
            message.content.includes(afterUserMessageIncludes)
          )
        })
      : -1
    // If the anchor user message hasn't appeared yet, skip this iteration
    // to avoid false-positives from old bot messages matching `text`.
    if (afterUserMessageIncludes && afterIndex === -1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      continue
    }
    const match = messages.find((message, index) => {
      if (afterUserMessageIncludes && afterIndex >= 0 && index <= afterIndex) {
        return false
      }
      return (
        message.author.id === discord.botUserId &&
        message.content.includes(text)
      )
    })
    if (match) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  const recent = lastMessages
    .slice(-12)
    .map((message) => {
      const role = message.author.id === discord.botUserId ? 'bot' : 'user'
      return `${role}: ${message.content.slice(0, 120)}`
    })
    .join('\n')
  throw new Error(
    `Timed out waiting for bot message containing "${text}" in thread ${threadId}. Recent messages:\n${recent}`,
  )
}

function isFooterMessage({
  message,
  botUserId,
}: {
  message: APIMessage
  botUserId: string
}): boolean {
  if (message.author.id !== botUserId) {
    return false
  }
  if (!message.content.startsWith('*')) {
    return false
  }
  return message.content.includes('⋅')
}

/**
 * Poll until a footer message appears, optionally after an anchor message.
 * Useful for stabilizing snapshots by waiting for run completion metadata.
 */
export async function waitForFooterMessage({
  discord,
  threadId,
  timeout,
  afterMessageIncludes,
  afterAuthorId,
}: {
  discord: DigitalDiscord
  threadId: string
  timeout: number
  afterMessageIncludes?: string
  afterAuthorId?: string
}): Promise<APIMessage[]> {
  const start = Date.now()
  let lastMessages: APIMessage[] = []
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    lastMessages = messages
    const afterIndex = afterMessageIncludes
      ? messages.findLastIndex((message) => {
          if (!message.content.includes(afterMessageIncludes)) {
            return false
          }
          if (!afterAuthorId) {
            return true
          }
          return message.author.id === afterAuthorId
        })
      : -1
    if (afterMessageIncludes && afterIndex === -1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      continue
    }
    const footer = messages.find((message, index) => {
      if (afterIndex >= 0 && index <= afterIndex) {
        return false
      }
      return isFooterMessage({ message, botUserId: discord.botUserId })
    })
    if (footer) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  const recent = lastMessages
    .slice(-12)
    .map((message) => {
      const role = message.author.id === discord.botUserId ? 'bot' : 'user'
      return `${role}: ${message.content.slice(0, 120)}`
    })
    .join('\n')
  const anchorText = afterMessageIncludes || 'start'
  throw new Error(
    `Timed out waiting for footer after "${anchorText}" in thread ${threadId}. Recent messages:\n${recent}`,
  )
}

// ── Thread state polling helpers ─────────────────────────────────
// Used by e2e tests to assert on session state transitions
// (phase changes, queue depth, abort, idle).

/**
 * Poll until thread derived phase matches one of the expected values.
 * Returns the full ThreadRunState snapshot when the condition is met.
 */
export async function waitForThreadPhase({
  threadId,
  phase,
  timeout,
}: {
  threadId: string
  phase: 'idle' | 'running' | Array<'idle' | 'running'>
  timeout: number
}): Promise<ThreadRunState> {
  const phases = Array.isArray(phase) ? phase : [phase]
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const state = getThreadState(threadId)
    const runtime = getRuntime(threadId)
    const currentPhase = runtime?.getDerivedPhase() || 'idle'
    if (state && phases.includes(currentPhase)) {
      return state
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  const finalState = getThreadState(threadId)
  const finalRuntime = getRuntime(threadId)
  const currentPhase = finalState
    ? (finalRuntime?.getDerivedPhase() || 'idle')
    : 'no-thread-state'
  throw new Error(
    `Timed out waiting for thread ${threadId} phase [${phases.join(', ')}]. Current phase: ${currentPhase}`,
  )
}

/**
 * Poll until thread has at least `count` items in its queue.
 */
export async function waitForThreadQueueLength({
  threadId,
  count,
  timeout,
}: {
  threadId: string
  count: number
  timeout: number
}): Promise<ThreadRunState> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const state = getThreadState(threadId)
    if (state && state.queueItems.length >= count) {
      return state
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  const finalState = getThreadState(threadId)
  const currentLength = finalState?.queueItems.length ?? 0
  throw new Error(
    `Timed out waiting for thread ${threadId} queue length >= ${count}. Current length: ${currentLength}`,
  )
}

/**
 * Poll until a custom predicate on ThreadRunState returns true.
 * Use this for compound assertions (e.g. phase === 'finished' AND queue empty)
 * to avoid matching transient states during phase transitions.
 */
export async function waitForThreadState({
  threadId,
  predicate,
  timeout,
  description,
}: {
  threadId: string
  predicate: (state: ThreadRunState) => boolean
  timeout: number
  /** Human-readable description for timeout error messages */
  description?: string
}): Promise<ThreadRunState> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const state = getThreadState(threadId)
    if (state && predicate(state)) {
      return state
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  const finalState = getThreadState(threadId)
  const desc = description ?? 'custom predicate'
  const finalRuntime = getRuntime(threadId)
  const phase = finalState
    ? (finalRuntime?.getDerivedPhase() || 'idle')
    : 'no-thread-state'
  const queueLen = finalState?.queueItems.length ?? 0
  throw new Error(
    `Timed out waiting for thread ${threadId} (${desc}). ` +
    `Current: phase=${phase}, queue=${queueLen}`,
  )
}
