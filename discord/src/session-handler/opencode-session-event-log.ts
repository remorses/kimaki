// Debug helper for writing raw OpenCode event stream entries as JSONL.
// When enabled, writes one file per session ID so event ordering and
// lifecycle behavior can be analyzed with jq.

import fs from 'node:fs'
import path from 'node:path'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import * as errore from 'errore'
import { getDataDir } from '../config.js'

let eventLogDirPromise: Promise<string> | null = null
let eventLogWriteDisabled = false

export function isOpencodeSessionEventLogEnabled(): boolean {
  return process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] === '1'
}

export function getOpencodeEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.updated':
      return event.properties.info.sessionID
    case 'message.part.updated':
      return event.properties.part.sessionID
    case 'message.part.delta':
    case 'message.part.removed':
    case 'session.status':
    case 'session.idle':
    case 'session.diff':
    case 'permission.asked':
    case 'permission.replied':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
      return event.properties.sessionID
    case 'session.error':
      return event.properties.sessionID
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id
    default:
      return undefined
  }
}

function sanitizeSessionIdForFilename(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function resolveEventLogDirectory(): Promise<string> {
  if (!eventLogDirPromise) {
    eventLogDirPromise = (async () => {
      const configuredEventLogDir = process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR']
      const baseDir = configuredEventLogDir || path.join(getDataDir(), 'opencode-session-events')
      await fs.promises.mkdir(baseDir, { recursive: true })
      return baseDir
    })()
  }
  return eventLogDirPromise
}

export type OpencodeEventLogEntry = {
  threadId: string
  projectDirectory: string
  sdkDirectory: string
  activeSessionId?: string
  eventSessionId?: string
  runPhase: 'idle' | 'running' | 'none'
  latestAssistantMessageId?: string
  assistantMessageCount: number
  event: OpenCodeEvent
}

export function buildOpencodeEventLogLine({
  timestampMs,
  entry,
}: {
  timestampMs: number
  entry: OpencodeEventLogEntry
}): {
  timestamp: string
  timestampMs: number
  threadId: string
  projectDirectory: string
  sdkDirectory: string
  activeSessionId?: string
  eventSessionId?: string
  runPhase: 'idle' | 'running' | 'none'
  latestAssistantMessageId?: string
  assistantMessageCount: number
  event: OpenCodeEvent
} {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    ...entry,
  }
}

export async function appendOpencodeSessionEventLog(
  entry: OpencodeEventLogEntry,
): Promise<Error | null> {
  if (!isOpencodeSessionEventLogEnabled() || eventLogWriteDisabled) {
    return null
  }

  const sessionId = entry.eventSessionId
  if (!sessionId) {
    return null
  }

  const logDirResult = await errore.tryAsync(() => {
    return resolveEventLogDirectory()
  })
  if (logDirResult instanceof Error) {
    eventLogWriteDisabled = true
    return logDirResult
  }

  const safeSessionId = sanitizeSessionIdForFilename(sessionId)
  const logFilePath = path.join(logDirResult, `${safeSessionId}.jsonl`)

  const now = Date.now()
  const line = `${JSON.stringify(buildOpencodeEventLogLine({
    timestampMs: now,
    entry,
  }))}\n`

  const appendResult = await errore.tryAsync(() => {
    return fs.promises.appendFile(logFilePath, line, 'utf8')
  })
  if (appendResult instanceof Error) {
    eventLogWriteDisabled = true
    return appendResult
  }

  return null
}
