// Tracks which OpenCode sessions last edited each file.
// Plugin appends JSONL events; CLI derives the per-file session list on read.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { FilesystemOperationError } from './errors.js'
import { extractPatchFilePaths } from './patch-text-parser.js'
import { createPluginLogger } from './plugin-logger.js'

const logger = createPluginLogger('FILEEDIT')

export const FILE_EDIT_EVENTS_FILENAME = 'file-edit-events.jsonl'
const DEFAULT_MAX_EVENTS = 10_000
const DEFAULT_COMPACT_AFTER_BYTES = 5 * 1024 * 1024

export type FileEditTool = 'edit' | 'write' | 'apply_patch'

export type FileEditEvent = {
  v: 1
  at: number
  sessionId: string
  file: string
  tool: FileEditTool
}

function isFileEditTool(tool: string): tool is FileEditTool {
  return tool === 'edit' || tool === 'write' || tool === 'apply_patch'
}

type ToolArgs = {
  filePath?: string
  patchText?: string
}

function getStringField({ args, key }: { args: ToolArgs; key: keyof ToolArgs }) {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

export function extractEditedFiles({
  tool,
  args,
  directory,
}: {
  tool: string
  args: ToolArgs
  directory: string
}) {
  const name = tool.toLowerCase()
  if (name === 'edit' || name === 'write') {
    const filePath = getStringField({ args, key: 'filePath' })
    if (!filePath) return []
    return [path.resolve(directory, filePath)]
  }
  if (name !== 'apply_patch') return []
  const patchText = getStringField({ args, key: 'patchText' })
  if (!patchText) return []
  return extractPatchFilePaths(patchText).map((filePath) => {
    return path.resolve(directory, filePath)
  })
}

export function editorsForFile({
  events,
  filePath,
  cwd,
}: {
  events: FileEditEvent[]
  filePath: string
  cwd: string
}) {
  const resolved = path.resolve(cwd, filePath)
  const latestBySession = new Map<string, number>()
  for (const event of events) {
    if (path.resolve(event.file) !== resolved) continue
    const previous = latestBySession.get(event.sessionId)
    if (previous === undefined || event.at > previous) {
      latestBySession.set(event.sessionId, event.at)
    }
  }
  return [...latestBySession.entries()]
    .map(([sessionId, at]) => {
      return { sessionId, at }
    })
    .sort((left, right) => {
      return right.at - left.at
    })
}

function parseFileEditEvent(line: string) {
  const parsed = errore.try(
    () => JSON.parse(line) as {
      v: number
      at: number
      sessionId: string
      file: string
      tool: string
    },
    (cause) => new FilesystemOperationError({ operation: 'parse file edit event', cause }),
  )
  if (parsed instanceof Error) return null
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.v !== 1) return null
  if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null
  if (typeof parsed.file !== 'string' || parsed.file.length === 0) return null
  if (typeof parsed.tool !== 'string' || !isFileEditTool(parsed.tool)) return null
  return {
    v: 1 as const,
    at: parsed.at,
    sessionId: parsed.sessionId,
    file: parsed.file,
    tool: parsed.tool,
  }
}

function nodeErrorCode(error: Error) {
  const cause = error.cause
  if (!cause || typeof cause !== 'object') return ''
  const code = Reflect.get(cause, 'code')
  return typeof code === 'string' ? code : ''
}

export async function loadFileEditEvents({ dataDir }: { dataDir: string }) {
  const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME)
  const raw = await fs.promises
    .readFile(logPath, 'utf8')
    .catch((cause) => new FilesystemOperationError({ operation: 'read file edit log', cause }))
  if (raw instanceof Error) {
    if (nodeErrorCode(raw) === 'ENOENT') return []
    return raw
  }
  const events: FileEditEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const event = parseFileEditEvent(line)
    if (event) events.push(event)
  }
  return events
}

function collapseFileEditEvents(events: FileEditEvent[]) {
  const latest = new Map<string, FileEditEvent>()
  for (const event of events) {
    const key = `${event.sessionId}\0${event.file}`
    const previous = latest.get(key)
    if (!previous || event.at >= previous.at) latest.set(key, event)
  }
  return [...latest.values()].sort((left, right) => {
    return left.at - right.at
  })
}

async function compactFileEditLog({
  dataDir,
  maxEvents,
}: {
  dataDir: string
  maxEvents: number
}) {
  const loaded = await loadFileEditEvents({ dataDir })
  if (loaded instanceof Error) return loaded
  const collapsed = collapseFileEditEvents(loaded)
  const kept = collapsed.length > maxEvents ? collapsed.slice(-maxEvents) : collapsed
  const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME)
  const tempPath = `${logPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const body = kept.map((event) => `${JSON.stringify(event)}\n`).join('')
  const written = await fs.promises
    .writeFile(tempPath, body)
    .then(() => fs.promises.rename(tempPath, logPath))
    .catch((cause) => new FilesystemOperationError({ operation: 'compact file edit log', cause }))
  if (written instanceof Error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
    return written
  }
}

// Serializes appends and compactions inside one process. Plugin instances for
// different directories share this module and write the same log file.
let pendingWrite: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>) {
  const next = pendingWrite.then(task)
  pendingWrite = next.catch(() => undefined)
  return next
}

async function appendAndMaybeCompact({
  dataDir,
  events,
  maxEvents,
  compactAfterBytes,
}: {
  dataDir: string
  events: FileEditEvent[]
  maxEvents: number
  compactAfterBytes: number
}) {
  const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME)
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('')
  const appended = await fs.promises
    .mkdir(dataDir, { recursive: true })
    .then(() => fs.promises.appendFile(logPath, body))
    .catch((cause) => new FilesystemOperationError({ operation: 'append file edit log', cause }))
  if (appended instanceof Error) return appended
  const stats = await fs.promises
    .stat(logPath)
    .catch((cause) => new FilesystemOperationError({ operation: 'stat file edit log', cause }))
  if (stats instanceof Error) return stats
  if (stats.size < compactAfterBytes) return
  return compactFileEditLog({ dataDir, maxEvents })
}

export async function appendFileEditEvents({
  dataDir,
  events,
  maxEvents = DEFAULT_MAX_EVENTS,
  compactAfterBytes = DEFAULT_COMPACT_AFTER_BYTES,
}: {
  dataDir: string
  events: FileEditEvent[]
  maxEvents?: number
  compactAfterBytes?: number
}) {
  if (events.length === 0) return
  return enqueueWrite(() => {
    return appendAndMaybeCompact({ dataDir, events, maxEvents, compactAfterBytes })
  })
}

async function recordToolEdits({
  dataDir,
  directory,
  sessionId,
  tool,
  args,
}: {
  dataDir: string
  directory: string
  sessionId: string
  tool: string
  args: ToolArgs
}) {
  const name = tool.toLowerCase()
  if (!isFileEditTool(name)) return
  const files = extractEditedFiles({ tool: name, args, directory })
  if (files.length === 0) return
  const at = Date.now()
  const events = files.map((file) => {
    return {
      v: 1 as const,
      at,
      sessionId,
      file,
      tool: name,
    }
  })
  const result = await appendFileEditEvents({ dataDir, events })
  if (result instanceof Error) {
    logger.warn('Failed to record file edit', result.message)
  }
}

export function createFileEditHooks({
  dataDir,
  directory,
}: {
  dataDir: string
  directory: string
}) {
  return {
    'tool.execute.after': async (input: {
      tool: string
      sessionID: string
      args: ToolArgs
    }) => {
      await recordToolEdits({
        dataDir,
        directory,
        sessionId: input.sessionID,
        tool: input.tool,
        args: input.args,
      })
    },
  }
}
