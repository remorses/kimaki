// Process-wide thread ↔ session ↔ directory registry. Plugin.define stays in index.ts.

import type { Plugin } from '@opencode-ai/plugin'

export type ThreadRecord = {
  threadId: string
  sessionId: string
  directory: string
  userId: string
  username: string
  startedAt: number
}

type ThreadsHost = {
  byThread: Map<string, ThreadRecord>
  bySession: Map<string, ThreadRecord>
  channelDirectories: Map<string, string>
  contexts: Map<string, Plugin.Context>
}

declare global {
  var __kimaki2Threads: ThreadsHost | undefined
}

function threadsHost() {
  globalThis.__kimaki2Threads ??= {
    byThread: new Map(),
    bySession: new Map(),
    channelDirectories: new Map(),
    contexts: new Map(),
  }
  return globalThis.__kimaki2Threads
}

function remember(record: ThreadRecord) {
  const host = threadsHost()
  const previous = host.byThread.get(record.threadId)
  if (previous && previous.sessionId !== record.sessionId) {
    host.bySession.delete(previous.sessionId)
  }
  host.byThread.set(record.threadId, record)
  host.bySession.set(record.sessionId, record)
}

function parseRecord(value: unknown): ThreadRecord | null {
  if (!value || typeof value !== 'object') return null
  if (!('threadId' in value) || typeof value.threadId !== 'string') return null
  if (!('sessionId' in value) || typeof value.sessionId !== 'string') return null
  if (!('directory' in value) || typeof value.directory !== 'string') return null
  if (!('userId' in value) || typeof value.userId !== 'string') return null
  if (!('username' in value) || typeof value.username !== 'string') return null
  if (!('startedAt' in value) || typeof value.startedAt !== 'number') return null
  return {
    threadId: value.threadId,
    sessionId: value.sessionId,
    directory: value.directory,
    userId: value.userId,
    username: value.username,
    startedAt: value.startedAt,
  }
}

async function restoreDirectory({ directory, ctx }: { directory: string; ctx: Plugin.Context }) {
  let after: string | undefined
  for (;;) {
    const page = await ctx.storage.scan({ prefix: 'thread:', after })
    for (const entry of page.entries) {
      const record = parseRecord(entry.value)
      if (!record) continue
      if (record.directory !== directory) continue
      remember(record)
    }
    if (!page.next) return
    after = page.next
  }
}

export async function createThread(record: ThreadRecord) {
  remember(record)
  const ctx = getContext(record.directory)
  if (!ctx) return
  await ctx.storage.set(`thread:${record.threadId}`, {
    threadId: record.threadId,
    sessionId: record.sessionId,
    directory: record.directory,
    userId: record.userId,
    username: record.username,
    startedAt: record.startedAt,
  })
}

export function forgetSession(sessionId: string) {
  threadsHost().bySession.delete(sessionId)
}

export async function replaceThreadSession({
  threadId,
  sessionId,
}: {
  threadId: string
  sessionId: string
}) {
  const existing = findByThreadId(threadId)
  if (!existing) return null
  forgetSession(existing.sessionId)
  const record: ThreadRecord = {
    threadId: existing.threadId,
    sessionId,
    directory: existing.directory,
    userId: existing.userId,
    username: existing.username,
    startedAt: Date.now(),
  }
  await createThread(record)
  return record
}

export function findByThreadId(threadId: string) {
  return threadsHost().byThread.get(threadId) ?? null
}

export function findBySessionId(sessionId: string) {
  return threadsHost().bySession.get(sessionId) ?? null
}

export function getDirectoryForChannel(channelId: string) {
  return threadsHost().channelDirectories.get(channelId)
}

export function getContext(directory: string) {
  return threadsHost().contexts.get(directory)
}

export async function attachLocation({
  directory,
  ctx,
  channels,
}: {
  directory: string
  ctx: Plugin.Context
  channels: object | undefined
}) {
  const host = threadsHost()
  host.contexts.set(directory, ctx)
  if (channels) {
    for (const [channelId, mapped] of Object.entries(channels)) {
      if (typeof mapped !== 'string') continue
      if (mapped !== directory) continue
      host.channelDirectories.set(channelId, mapped)
    }
  }
  await restoreDirectory({ directory, ctx })
}

export function detachLocation(directory: string) {
  const host = threadsHost()
  host.contexts.delete(directory)
  for (const [channelId, mapped] of [...host.channelDirectories]) {
    if (mapped !== directory) continue
    host.channelDirectories.delete(channelId)
  }
}

export function resetThreads() {
  globalThis.__kimaki2Threads = undefined
}
