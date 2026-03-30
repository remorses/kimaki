// Shared e2e test utilities for session cleanup, server cleanup, and
// Discord message polling helpers.
// Uses directory + start timestamp double-filter to ensure we only
// delete sessions created by this specific test run, never real user sessions.
//
// Prefers using the existing opencode client (already running server) to avoid
// spawning a new server process during teardown. Falls back to initializing
// a new server only if no existing client is available.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { APIMessage } from 'discord.js'

/**
 * Deterministic port from a string key (channel ID, test file name, etc.).
 * Uses a hash to pick a stable port in range 53000-54999, avoiding overlap
 * with queue-advanced tests (51000-52999) and getLockPort (30000-39999).
 * Replaces the old TOCTOU-prone pattern of binding port 0, reading the
 * assigned port, closing, then rebinding — which races under parallel vitest.
 */
export function chooseLockPort({ key }: { key: string }): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return 53_000 + (Math.abs(hash) % 2_000)
}
/**
 * Initialize a git repo with a `main` branch and empty initial commit.
 * E2e tests create project directories under tmp/ which inherit the parent
 * repo's git state. On CI (detached HEAD), `git symbolic-ref --short HEAD`
 * returns empty, breaking footer snapshots that expect a branch name.
 * Calling this in each test project directory gives it its own repo on `main`.
 */
export function initTestGitRepo(directory: string): void {
  const isRepo = fs.existsSync(path.join(directory, '.git'))
  if (isRepo) {
    return
  }
  execSync('git init -b main', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: directory, stdio: 'pipe' })
  execSync('git commit --allow-empty -m "init"', { cwd: directory, stdio: 'pipe' })
}

import type { DigitalDiscord } from 'discord-digital-twin/src'
import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
} from './opencode.js'
import {
  getThreadState,
  type ThreadRunState,
} from './session-handler/thread-runtime-state.js'

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
  afterMessageId,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  userId?: string
  text: string
  afterUserMessageIncludes?: string
  afterMessageId?: string
  timeout: number
}): Promise<APIMessage[]> {
  const start = Date.now()
  let lastMessages: APIMessage[] = []
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    lastMessages = messages
    const afterIndex = (() => {
      if (afterMessageId) {
        return messages.findLastIndex((message) => {
          return message.id === afterMessageId
        })
      }
      if (afterUserMessageIncludes && userId) {
        return messages.findLastIndex((message) => {
          return (
            message.author.id === userId &&
            message.content.includes(afterUserMessageIncludes)
          )
        })
      }
      return -1
    })()
    // If the anchor user message hasn't appeared yet, skip this iteration
    // to avoid false-positives from old bot messages matching `text`.
    if ((afterUserMessageIncludes || afterMessageId) && afterIndex === -1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      continue
    }
    const match = messages.find((message, index) => {
      if ((afterUserMessageIncludes || afterMessageId) && afterIndex >= 0 && index <= afterIndex) {
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

/** Poll until a specific message id appears in thread history. */
export async function waitForMessageById({
  discord,
  threadId,
  messageId,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  messageId: string
  timeout: number
}): Promise<APIMessage> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const message = messages.find((candidate) => {
      return candidate.id === messageId
    })
    if (message) {
      return message
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  throw new Error(
    `Timed out waiting for message ${messageId} in thread ${threadId}`,
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
// Used by e2e tests to assert on queue and session-state snapshots.

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
 * Use this for compound assertions against thread state snapshots.
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
  const queueLen = finalState?.queueItems.length ?? 0
  const sessionId = finalState?.sessionId ?? 'none'
  throw new Error(
    `Timed out waiting for thread ${threadId} (${desc}). ` +
    `Current: queue=${queueLen}, sessionId=${sessionId}`,
  )
}
