// Phase 2: prove v2 inbox delivery (steer/queue/cancel) and interrupt against
// real opencode2. Discord runtime stays on v1 until later phases.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { V2Event } from '@opencode-ai/client'
import {
  buildDeterministicOpencode2Config,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'

import {
  createOpencode2Client,
  startOpencode2Server,
  type Opencode2Server,
  type OpenCodeClient,
} from './opencode2.js'

function buildMatchers(): DeterministicMatcher[] {
  const busyMatcher: DeterministicMatcher = {
    id: 'v2-busy-tool',
    priority: 30,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'busy-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'det-busy-shell-1',
          toolName: 'shell',
          input: JSON.stringify({ command: 'sleep 1; echo busy-tool-ok' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  const followMatcher: DeterministicMatcher = {
    id: 'v2-follow-text',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'follow-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'v2-follow' },
        { type: 'text-delta', id: 'v2-follow', delta: 'steered reply' },
        { type: 'text-end', id: 'v2-follow' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  const queueMatcher: DeterministicMatcher = {
    id: 'v2-queue-text',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'queue-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'v2-queue' },
        { type: 'text-delta', id: 'v2-queue', delta: 'queued reply' },
        { type: 'text-end', id: 'v2-queue' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  return [busyMatcher, followMatcher, queueMatcher]
}

let server: Opencode2Server
let client: OpenCodeClient
let tempDir: string
const events: V2Event[] = []
const subscribeController = new AbortController()
const createdSessionIds: string[] = []

function eventSessionId(event: V2Event): string | undefined {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('sessionID' in data)) {
    return undefined
  }
  return typeof data.sessionID === 'string' ? data.sessionID : undefined
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}. Collected event types: ${events
      .map((event) => event.type)
      .join(', ')}`,
  )
}

function sessionEvents(sessionId: string): V2Event[] {
  return events.filter((event) => eventSessionId(event) === sessionId)
}

function hasType(sessionId: string, type: V2Event['type']): boolean {
  return sessionEvents(sessionId).some((event) => event.type === type)
}

async function replyPendingPermissions(sessionId: string): Promise<void> {
  for (const event of events) {
    if (event.type !== 'permission.asked' || event.data.sessionID !== sessionId) {
      continue
    }
    await client.permission.reply({
      sessionID: sessionId,
      requestID: event.data.id,
      reply: 'once',
    }).catch(() => undefined)
  }
}

beforeAll(async () => {
  tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode2-inbox-')),
  )
  execFileSync('git', ['init', '-q'], { cwd: tempDir })
  fs.writeFileSync(
    path.join(tempDir, 'opencode.json'),
    JSON.stringify(
      buildDeterministicOpencode2Config({
        model: 'deterministic-v2',
        settings: { strict: false, matchers: buildMatchers() },
        permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
      }),
      null,
      2,
    ),
  )

  const started = await startOpencode2Server()
  if (started instanceof Error) {
    throw started
  }
  server = started
  client = createOpencode2Client({
    baseUrl: server.baseUrl,
    password: server.password,
    directory: tempDir,
  })
  void (async () => {
    try {
      for await (const event of client.event.subscribe({
        signal: subscribeController.signal,
      })) {
        events.push(event)
      }
    } catch {
      // aborted during teardown
    }
  })()
  await waitFor(() => events.some((event) => event.type === 'server.connected'), {
    label: 'server.connected',
  })
}, 120_000)

afterAll(async () => {
  for (const sessionId of createdSessionIds) {
    await client.session.remove({ sessionID: sessionId }).catch(() => undefined)
  }
  subscribeController.abort()
  server?.close()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

async function createSession(title: string) {
  const session = await client.session.create({
    title,
    location: { directory: tempDir },
  })
  createdSessionIds.push(session.id)
  return session
}

test('steer admits a follow-up while busy and delivers it after the step boundary', async () => {
  const session = await createSession('inbox steer')
  const busy = await client.session.prompt({
    sessionID: session.id,
    text: 'start work busy-marker',
  })
  expect(busy.delivery).toBe('steer')

  await waitFor(() => hasType(session.id, 'session.tool.called'), {
    label: 'busy tool.called',
  })
  await replyPendingPermissions(session.id)

  const follow = await client.session.prompt({
    sessionID: session.id,
    text: 'interrupt with follow-marker',
    delivery: 'steer',
  })
  expect(follow.delivery).toBe('steer')
  expect(follow.id).not.toBe(busy.id)

  await waitFor(
    async () => {
      await replyPendingPermissions(session.id)
      return sessionEvents(session.id).some((event) => {
        return (
          event.type === 'session.text.ended' &&
          event.data.text === 'steered reply'
        )
      })
    },
    { label: 'steered reply text.ended' },
  )

  const deliveredIds = sessionEvents(session.id)
    .filter((event) => event.type === 'session.inbox.delivered')
    .map((event) => event.type === 'session.inbox.delivered' ? event.data.inboxID : '')
  expect(deliveredIds).toContain(busy.id)
  expect(deliveredIds).toContain(follow.id)
  await waitFor(() => hasType(session.id, 'session.execution.succeeded'), {
    label: 'steer session execution.succeeded',
  })
}, 30_000)

test('queue waits until idle, cancel drops a queued item, interrupt has no succeeded', async () => {
  const queuedSession = await createSession('inbox queue')
  const busy = await client.session.prompt({
    sessionID: queuedSession.id,
    text: 'start work busy-marker',
  })
  await waitFor(() => hasType(queuedSession.id, 'session.tool.called'), {
    label: 'queue busy tool.called',
  })
  await replyPendingPermissions(queuedSession.id)

  const queued = await client.session.prompt({
    sessionID: queuedSession.id,
    text: 'later queue-marker',
    delivery: 'queue',
  })
  expect(queued.delivery).toBe('queue')

  const pending = await client.session.inbox.list({ sessionID: queuedSession.id })
  expect(pending.map((item) => item.id)).toContain(queued.id)

  await waitFor(
    async () => {
      await replyPendingPermissions(queuedSession.id)
      return sessionEvents(queuedSession.id).some((event) => {
        return (
          event.type === 'session.text.ended' &&
          event.data.text === 'queued reply'
        )
      })
    },
    { label: 'queued reply after idle' },
  )
  const queueDelivered = sessionEvents(queuedSession.id).some((event) => {
    return event.type === 'session.inbox.delivered' && event.data.inboxID === queued.id
  })
  expect(queueDelivered).toBe(true)
  expect(busy.id).not.toBe(queued.id)

  const cancelSession = await createSession('inbox cancel')
  await client.session.prompt({
    sessionID: cancelSession.id,
    text: 'start work busy-marker',
  })
  await waitFor(() => hasType(cancelSession.id, 'session.tool.called'), {
    label: 'cancel busy tool.called',
  })
  const toCancel = await client.session.prompt({
    sessionID: cancelSession.id,
    text: 'drop me queue-marker',
    delivery: 'queue',
  })
  await client.session.inbox.cancel({
    sessionID: cancelSession.id,
    inboxID: toCancel.id,
  })
  await waitFor(() => hasType(cancelSession.id, 'session.inbox.cancelled'), {
    label: 'inbox.cancelled',
  })
  const cancelled = sessionEvents(cancelSession.id).find((event) => {
    return event.type === 'session.inbox.cancelled'
  })
  expect(cancelled && cancelled.type === 'session.inbox.cancelled' && cancelled.data.inboxID)
    .toBe(toCancel.id)
  await waitFor(
    async () => {
      await replyPendingPermissions(cancelSession.id)
      return hasType(cancelSession.id, 'session.execution.succeeded')
    },
    { label: 'cancel session drain end' },
  )
  const queuedReplyAfterCancel = sessionEvents(cancelSession.id).some((event) => {
    return event.type === 'session.text.ended' && event.data.text === 'queued reply'
  })
  expect(queuedReplyAfterCancel).toBe(false)

  const interruptSession = await createSession('inbox interrupt')
  await client.session.prompt({
    sessionID: interruptSession.id,
    text: 'start work busy-marker',
  })
  await waitFor(() => hasType(interruptSession.id, 'session.execution.started'), {
    label: 'interrupt execution.started',
  })
  const interruptResult = await client.session.interrupt({
    sessionID: interruptSession.id,
  })
  expect(interruptResult.interrupted).toBe(true)
  await waitFor(() => hasType(interruptSession.id, 'session.execution.interrupted'), {
    label: 'execution.interrupted',
  })
  expect(hasType(interruptSession.id, 'session.execution.succeeded')).toBe(false)

  const idleInterrupt = await client.session.interrupt({
    sessionID: interruptSession.id,
  })
  expect(idleInterrupt.interrupted).toBe(false)
}, 45_000)

test('reusing the same inbox item id is idempotent', async () => {
  const session = await createSession('inbox idempotent')
  const first = await client.session.prompt({
    sessionID: session.id,
    id: 'msg_kimaki_idempotent_1',
    text: 'first hello-marker follow-marker',
  })
  const second = await client.session.prompt({
    sessionID: session.id,
    id: 'msg_kimaki_idempotent_1',
    text: 'ignored second payload queue-marker',
    delivery: 'queue',
  })
  expect(second.id).toBe(first.id)
  await waitFor(() => {
    return sessionEvents(session.id).some((event) => {
      return event.type === 'session.inbox.enqueued' && event.data.inboxID === first.id
    })
  }, { label: 'idempotent inbox.enqueued' })
  // Retry HTTP body can echo the second delivery; first admission still wins.
  const enqueued = sessionEvents(session.id).filter((event) => {
    return event.type === 'session.inbox.enqueued' && event.data.inboxID === first.id
  })
  expect(enqueued).toHaveLength(1)
  expect(first.payload.text).toContain('follow-marker')
}, 15_000)
