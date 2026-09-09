// Debug helper for writing raw OpenCode event stream entries as JSONL.
// When enabled, writes one file per session ID so event ordering and
// lifecycle behavior can be analyzed with jq.

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from '../config.js'
import { FilesystemOperationError } from '../errors.js'

type LooseEvent = {
  type: string
  data?: unknown
  properties?: unknown
}

let eventLogDirPromise: Promise<string> | null = null
let eventLogWriteDisabled = false

export function isOpencodeSessionEventLogEnabled(): boolean {
  return process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] === '1'
}

export function getOpencodeEventSessionId(event: LooseEvent): string | undefined {
  if ('data' in event && event.data && typeof event.data === 'object') {
    const data = event.data as { sessionID?: unknown; form?: { sessionID?: unknown } }
    if (typeof data.sessionID === 'string') {
      return data.sessionID
    }
    if (data.form && typeof data.form === 'object' && typeof data.form.sessionID === 'string') {
      return data.form.sessionID
    }
  }
  const properties = 'properties' in event ? event.properties : undefined
  if (properties && typeof properties === 'object') {
    if ('sessionID' in properties && typeof properties.sessionID === 'string') {
      return properties.sessionID
    }
    if ('info' in properties && properties.info && typeof properties.info === 'object') {
      const info = properties.info as { id?: unknown; sessionID?: unknown }
      if (typeof info.sessionID === 'string') return info.sessionID
      if (typeof info.id === 'string' && event.type.startsWith('session.')) {
        return info.id
      }
    }
    if ('part' in properties && properties.part && typeof properties.part === 'object') {
      const part = properties.part as { sessionID?: unknown }
      if (typeof part.sessionID === 'string') return part.sessionID
    }
  }
  return undefined
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
  timestamp: number
  threadId: string
  projectDirectory: string
  event: LooseEvent
}

export function buildOpencodeEventLogLine({
  timestamp,
  threadId,
  projectDirectory,
  event,
}: {
  timestamp: number
  threadId: string
  projectDirectory: string
  event: LooseEvent
}): OpencodeEventLogEntry {
  return {
    timestamp,
    threadId,
    projectDirectory,
    event,
  }
}

export async function appendOpencodeSessionEventLog(
  entry: Omit<OpencodeEventLogEntry, 'timestamp'>,
): Promise<Error | null> {
  if (!isOpencodeSessionEventLogEnabled() || eventLogWriteDisabled) {
    return null
  }

  const sessionId = getOpencodeEventSessionId(entry.event)
  if (!sessionId) {
    return null
  }

  const logDirResult = await resolveEventLogDirectory()
    .catch((e) => new FilesystemOperationError({ operation: 'resolveEventLogDir', cause: e }))
  if (logDirResult instanceof Error) {
    eventLogWriteDisabled = true
    return logDirResult
  }

  const safeSessionId = sanitizeSessionIdForFilename(sessionId)
  const logFilePath = path.join(logDirResult, `${safeSessionId}.jsonl`)

  const now = Date.now()
  const line = `${JSON.stringify(
    buildOpencodeEventLogLine({
      timestamp: now,
      threadId: entry.threadId,
      projectDirectory: entry.projectDirectory,
      event: entry.event,
    }),
  )}\n`

  const appendResult = await fs.promises.appendFile(logFilePath, line, 'utf8')
    .catch((e) => new FilesystemOperationError({ operation: 'appendEventLog', cause: e }))
  if (appendResult instanceof Error) {
    eventLogWriteDisabled = true
    return appendResult
  }

  return null
}
