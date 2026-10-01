// Which sessions last edited each file. Same JSONL index as Kimaki v1
// (<dataDir>/file-edit-events.jsonl, v: 1): the plugin appends one event per
// edited file after each completed edit/write/patch tool call; `session
// editors` reads the file. v1 data keeps working. Plugin-safe: no logger import.

import fs from 'node:fs'
import path from 'node:path'

import { FilesystemError } from './errors.ts'

export const FILE_EDIT_EVENTS_FILENAME = 'file-edit-events.jsonl'
const DEFAULT_MAX_EVENTS = 10_000
const DEFAULT_COMPACT_AFTER_BYTES = 5 * 1024 * 1024

// v1 names the patch tool apply_patch; v2 names it patch. The file format keeps the v1 name.
export type FileEditTool = 'edit' | 'write' | 'apply_patch'

export type FileEditEvent = { v: 1; at: number; sessionId: string; file: string; tool: FileEditTool }

function fileEditTool(tool: string): FileEditTool | undefined {
  if (tool === 'edit' || tool === 'write') return tool
  if (tool === 'patch' || tool === 'apply_patch') return 'apply_patch'
  return undefined
}

// Absolute paths a tool call wrote. v2 inputs: edit/write `path`, patch `patchText`.
export function extractEditedFiles({ tool, input, directory }: { tool: string; input: unknown; directory: string }): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const fields = new Map(Object.entries(input))
  const name = fileEditTool(tool)
  if (name === 'edit' || name === 'write') {
    const file = fields.get('path')
    return typeof file === 'string' && file ? [path.resolve(directory, file)] : []
  }
  const patchText = fields.get('patchText')
  if (name !== 'apply_patch' || typeof patchText !== 'string') return []
  const headers = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm), ...patchText.matchAll(/^\*\*\* Move to:\s+(.+)$/gm)]
  return [...new Set(headers.map((match) => match[1]!.trim()).filter(Boolean))].map((file) => path.resolve(directory, file))
}

// Sessions that edited `filePath`, newest edit first.
export function editorsForFile({ events, filePath, cwd }: { events: FileEditEvent[]; filePath: string; cwd: string }) {
  const resolved = path.resolve(cwd, filePath)
  const latest = new Map<string, number>()
  for (const event of events) {
    if (path.resolve(event.file) !== resolved) continue
    const previous = latest.get(event.sessionId)
    if (previous === undefined || event.at > previous) latest.set(event.sessionId, event.at)
  }
  return [...latest.entries()].map(([sessionId, at]) => ({ sessionId, at })).sort((left, right) => right.at - left.at)
}

function parseEvent(line: string): FileEditEvent | undefined {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })()
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const fields = new Map(Object.entries(parsed))
  const at = fields.get('at')
  const sessionId = fields.get('sessionId')
  const file = fields.get('file')
  const tool = fields.get('tool')
  if (fields.get('v') !== 1 || typeof at !== 'number' || !Number.isFinite(at)) return undefined
  if (typeof sessionId !== 'string' || !sessionId || typeof file !== 'string' || !file) return undefined
  if (tool !== 'edit' && tool !== 'write' && tool !== 'apply_patch') return undefined
  return { v: 1, at, sessionId, file, tool }
}

export async function loadFileEditEvents({ dataDir }: { dataDir: string }): Promise<FilesystemError | FileEditEvent[]> {
  const raw = await fs.promises
    .readFile(path.join(dataDir, FILE_EDIT_EVENTS_FILENAME), 'utf8')
    .catch((cause: NodeJS.ErrnoException) => (cause.code === 'ENOENT' ? '' : new FilesystemError({ operation: 'read file edit log', cause })))
  if (raw instanceof Error) return raw
  return raw.split('\n').flatMap((line) => (line.trim() ? [parseEvent(line)].filter((event) => event !== undefined) : []))
}

// Keeps the newest event per (session, file), then the newest `maxEvents`.
async function compact({ dataDir, maxEvents }: { dataDir: string; maxEvents: number }) {
  const loaded = await loadFileEditEvents({ dataDir })
  if (loaded instanceof Error) return loaded
  const latest = new Map<string, FileEditEvent>()
  for (const event of loaded) {
    const key = `${event.sessionId}\0${event.file}`
    const previous = latest.get(key)
    if (!previous || event.at >= previous.at) latest.set(key, event)
  }
  const kept = [...latest.values()].sort((left, right) => left.at - right.at).slice(-maxEvents)
  const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME)
  const tempPath = `${logPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const written = await fs.promises
    .writeFile(tempPath, kept.map((event) => `${JSON.stringify(event)}\n`).join(''))
    .then(() => fs.promises.rename(tempPath, logPath))
    .catch((cause) => new FilesystemError({ operation: 'compact file edit log', cause }))
  if (written instanceof Error) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
  return written
}

// Appends and compactions of one process run one at a time.
let pendingWrite: Promise<unknown> = Promise.resolve()

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
}): Promise<FilesystemError | void> {
  if (events.length === 0) return
  const task = async () => {
    const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME)
    const appended = await fs.promises
      .mkdir(dataDir, { recursive: true })
      .then(() => fs.promises.appendFile(logPath, events.map((event) => `${JSON.stringify(event)}\n`).join('')))
      .catch((cause) => new FilesystemError({ operation: 'append file edit log', cause }))
    if (appended instanceof Error) return appended
    const stats = await fs.promises.stat(logPath).catch((cause) => new FilesystemError({ operation: 'stat file edit log', cause }))
    if (stats instanceof Error) return stats
    if (stats.size >= compactAfterBytes) return compact({ dataDir, maxEvents })
  }
  const next = pendingWrite.then(task)
  pendingWrite = next
  return next
}

// Records the files a completed tool call edited. Other tools are ignored.
export async function recordToolEdits({ dataDir, directory, sessionId, tool, input }: { dataDir: string; directory: string; sessionId: string; tool: string; input: unknown }) {
  const name = fileEditTool(tool)
  if (!name) return
  const at = Date.now()
  const events = extractEditedFiles({ tool, input, directory }).map((file): FileEditEvent => ({ v: 1, at, sessionId, file, tool: name }))
  return appendFileEditEvents({ dataDir, events })
}
