// Debugging support: every event folded into a thread is appended to
// <dataDir>/session-events/<threadId>.jsonl, exactly as the reducer saw it
// (root + subagent sessions + kimaki.* internal events, in order).
//
// Why Kimaki records them: OpenCode 2.0.19 keeps no event history
// (`session.log` only answers log.synced, spec 29.2 #10), and message.list
// drops transient events like session.retry.scheduled. A recorded file is also
// a reducer fixture: replay it with test/replay.ts to reproduce a bug.
//
//   kimaki session events <sessionId|threadId>   print the JSONL
//   kimaki session read <sessionId|threadId>     print the messages from OpenCode

import fs from 'node:fs'
import path from 'node:path'
import type { OpenCodeClient } from '@opencode/client'

import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, OpenCodeError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { ThreadEvent } from './thread-reducer.ts'

const logger = createLogger('EVENTS')

// Streaming deltas are the bulk of the traffic; the *.ended events carry the full text.
const SKIPPED_TYPES = new Set([
  'session.text.delta',
  'session.reasoning.delta',
  'session.tool.input.delta',
  'session.step.streamed',
])
const MAX_STRING = 10_000
// Per thread file. Older lines are dropped by starting a new file.
const MAX_FILE_BYTES = 20 * 1024 * 1024

export function sessionEventsDir({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'session-events')
}

export function sessionEventsFile({ dataDir, threadId }: { dataDir: string; threadId: string }): string {
  return path.join(sessionEventsDir({ dataDir }), `${threadId}.jsonl`)
}

function truncateStrings(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= MAX_STRING) return value
  return `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} chars truncated]`
}

export function createEventRecorder({ dataDir }: { dataDir: string }) {
  const streams = new Map<string, { stream: fs.WriteStream; bytes: number }>()
  const created = { dir: false }

  function open(threadId: string) {
    const existing = streams.get(threadId)
    if (existing && existing.bytes < MAX_FILE_BYTES) return existing
    existing?.stream.end()
    if (!created.dir) {
      fs.mkdirSync(sessionEventsDir({ dataDir }), { recursive: true })
      created.dir = true
    }
    const file = sessionEventsFile({ dataDir, threadId })
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    // Over the limit: start over rather than grow forever.
    const flags = size >= MAX_FILE_BYTES ? 'w' : 'a'
    const stream = fs.createWriteStream(file, { flags })
    stream.on('error', (error) => logger.warn(`cannot write ${file}: ${error.message}`))
    const entry = { stream, bytes: flags === 'w' ? 0 : size }
    streams.set(threadId, entry)
    return entry
  }

  return {
    record(threadId: string, event: ThreadEvent): void {
      if (SKIPPED_TYPES.has(event.type)) return
      const entry = open(threadId)
      const line = `${JSON.stringify({ at: Date.now(), event }, truncateStrings)}\n`
      entry.bytes += Buffer.byteLength(line)
      entry.stream.write(line)
    },
    async close(): Promise<void> {
      await Promise.all(
        [...streams.values()].map(({ stream }) => new Promise<void>((resolve) => stream.end(() => resolve()))),
      )
      streams.clear()
    },
  }
}

export type EventRecorder = ReturnType<typeof createEventRecorder>

export type ResolvedSession = { threadId: string; sessionId: string }

// Accepts a root session id or a Discord thread id (both are in thread_sessions).
export async function resolveSession({
  db,
  id,
}: {
  db: KimakiDb
  id: string
}): Promise<DbError | ConfigError | ResolvedSession> {
  const row = await db.query.thread_sessions
    .findFirst({ where: { OR: [{ thread_id: id }, { session_id: id }] }, orderBy: { updated_at: 'desc' } })
    .catch((e) => new DbError({ operation: 'read thread_sessions', cause: e }))
  if (row instanceof Error) return row
  if (!row) return new ConfigError({ reason: `No Kimaki thread for ${id}. Pass a root session id or thread id.` })
  return { threadId: row.thread_id, sessionId: row.session_id }
}

type Message = Awaited<ReturnType<OpenCodeClient['message']['list']>>['data'][number]

function renderMessage(message: Message): string {
  const time = new Date(message.time.created).toISOString()
  if (message.type === 'user') return `## user ${time}\n\n${message.text}`
  if (message.type !== 'assistant') return `## ${message.type} ${time}\n\n${JSON.stringify(message)}`
  const header = `## assistant ${time} (${message.agent}, ${message.model.providerID}/${message.model.id})`
  const parts = message.content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'tool') {
      const state = part.state
      const input = JSON.stringify(state.input ?? {}).slice(0, 500)
      const error = state.status === 'error' ? `\nerror: ${JSON.stringify(state).slice(0, 500)}` : ''
      return `tool ${part.name} [${state.status}] ${input}${error}`
    }
    return `[${part.type}]`
  })
  const finish = message.finish ? `\n\nfinish: ${message.finish}` : ''
  return `${header}\n\n${parts.join('\n\n')}${finish}`
}

// Oldest first, as markdown. OpenCode returns the newest first.
export async function readSessionMarkdown({
  client,
  sessionId,
}: {
  client: OpenCodeClient
  sessionId: string
}): Promise<OpenCodeError | string> {
  const session = await client.session
    .get({ sessionID: sessionId })
    .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
  if (session instanceof Error) return session
  const messages = await client.message
    .list({ sessionID: sessionId })
    .catch((e) => new OpenCodeError({ operation: 'message.list', cause: e }))
  if (messages instanceof Error) return messages
  const title = `# ${session.title} (${session.id})\n\ndirectory: ${session.location.directory}`
  return [title, ...[...messages.data].reverse().map(renderMessage)].join('\n\n')
}
