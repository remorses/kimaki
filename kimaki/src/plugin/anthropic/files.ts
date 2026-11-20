// Claude subscription requests upload each image and PDF once to the Anthropic
// Files API and reference it by file_id afterwards. OpenCode inlines every image
// as base64 in every request, so a session with screenshots uploads megabytes per step.
//
// Verified 2026-11-20 with a Claude Max OAuth token:
// - upload, metadata, delete and `source: { type: 'file' }` work, in tool results too.
//   Uploads need `anthropic-version`, no beta header.
// - the prompt cache keys on the file content, not on the id: base64 then file_id reads
//   the same cache entry. Uploading an expired file again costs no cache miss.
// - a missing, deleted or expired file_id fails the request before inference with
//   404 not_found_error "File `file_...` not found.".
// Docs: https://platform.claude.com/docs/en/build-with-claude/files

import crypto from 'node:crypto'
import * as errore from 'errore'

const API_URL = 'https://api.anthropic.com'
const DEFAULT_API_VERSION = '2023-06-01'
// Files expire on their own, so the user's file storage stays clean. A session that
// outlives a file uploads it again, which keeps the prompt cache (see above).
const FILE_TTL_SECONDS = 7 * 24 * 60 * 60
// A file that expires sooner is uploaded again, so a request and its retries never see it expire.
const REUSE_MARGIN_MS = 60 * 60 * 1000
// Smaller blocks are not worth an upload round trip.
const MIN_BASE64_LENGTH = 16 * 1024
// After a failed upload (storage quota, outage), send base64 for a while instead of failing again on every request.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000
const UPLOAD_TIMEOUT_MS = 60_000
const PROFILE_TIMEOUT_MS = 10_000
const STORAGE_PREFIX = 'file/'

export class AnthropicFilesError extends errore.createTaggedError({
  name: 'AnthropicFilesError',
  message: 'Anthropic Files API: $reason',
}) {}

type Source = { type: string; media_type?: string; data?: string; file_id?: string }
type InlineSource = { data: string; media_type: string }
type Block = { type?: string; source?: Source; content?: unknown }
export type MessagesPayload = { messages?: Array<{ content?: unknown }> }
type StoredFile = { id: string; expiresAt: number }

export interface FileStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: StoredFile): Promise<void>
  remove(key: string): Promise<void>
  scan(input: { prefix: string; after?: string }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }>; next?: string }>
}

// Base64 image and PDF blocks of the messages, also inside tool results.
export function inlineMedia(payload: MessagesPayload): Array<{ block: Block; source: InlineSource }> {
  const found: Array<{ block: Block; source: InlineSource }> = []
  const visit = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const block of content as Block[]) {
      if (block?.type === 'tool_result') visit(block.content)
      const source = block?.source
      const media = block?.type === 'image' || (block?.type === 'document' && source?.media_type === 'application/pdf')
      if (!media || source?.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') continue
      if (source.data.length < MIN_BASE64_LENGTH) continue
      found.push({ block, source: { data: source.data, media_type: source.media_type } })
    }
  }
  for (const message of payload.messages ?? []) visit(message?.content)
  return found
}

// File ids of a request that failed because Anthropic no longer has them.
export function missingFileIds(error: { status?: number; message: string; response?: { body: string } }): string[] {
  if (error.status !== 404) return []
  const text = `${error.message} ${error.response?.body ?? ''}`
  return [...new Set([...text.matchAll(/File `(file_[A-Za-z0-9_-]+)` not found/g)].map((match) => match[1]!))]
}

function isStoredFile(value: unknown): value is StoredFile {
  return typeof value === 'object' && value !== null && typeof (value as StoredFile).id === 'string' && typeof (value as StoredFile).expiresAt === 'number'
}

export type FileCache = ReturnType<typeof createFileCache>

export function createFileCache({ storage, apiURL = API_URL, now = Date.now }: { storage: FileStorage; apiURL?: string; now?: () => number }) {
  const memory = new Map<string, StoredFile>()
  const uploads = new Map<string, Promise<AnthropicFilesError | string>>()
  // Files belong to the account's workspace, so stored ids are keyed by organization and account.
  const accounts = new Map<string, Promise<AnthropicFilesError | string>>()
  const failedUntil = new Map<string, number>()

  const account = (headers: Record<string, string>) => {
    const cached = accounts.get(headers.authorization!)
    if (cached) return cached
    const lookup = (async () => {
      const response = await fetch(`${apiURL}/api/oauth/profile`, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) }).catch(
        (cause) => new AnthropicFilesError({ reason: 'profile request failed', cause }),
      )
      if (response instanceof Error) return response
      if (!response.ok) return new AnthropicFilesError({ reason: `profile returned ${response.status}` })
      const profile = (await response.json().catch(() => null)) as { organization?: { uuid?: string }; account?: { uuid?: string } } | null
      if (!profile?.organization?.uuid || !profile.account?.uuid) return new AnthropicFilesError({ reason: 'profile has no organization or account' })
      return `${profile.organization.uuid}/${profile.account.uuid}`
    })()
    // A refreshed token is a new key; drop old ones so the map stays small.
    if (accounts.size > 20) accounts.clear()
    accounts.set(headers.authorization!, lookup)
    void lookup.then((result) => {
      if (result instanceof Error) accounts.delete(headers.authorization!)
    })
    return lookup
  }

  const upload = async ({ key, source, headers }: { key: string; source: InlineSource; headers: Record<string, string> }) => {
    const form = new FormData()
    const name = `${key.slice(-16)}.${source.media_type.split('/')[1] ?? 'bin'}`
    form.append('file', new Blob([Buffer.from(source.data, 'base64')], { type: source.media_type }), name)
    form.append('expires_in_seconds', String(FILE_TTL_SECONDS))
    const response = await fetch(`${apiURL}/v1/files`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }).catch(
      (cause) => new AnthropicFilesError({ reason: 'upload request failed', cause }),
    )
    if (response instanceof Error) return response
    const text = await response.text().catch(() => '')
    if (!response.ok) return new AnthropicFilesError({ reason: `upload returned ${response.status}: ${text.slice(0, 300)}` })
    const json = errore.try(() => JSON.parse(text) as { id?: string; expires_at?: string | null })
    if (json instanceof Error || !json.id) return new AnthropicFilesError({ reason: 'upload response has no file id' })
    const expiresAt = json.expires_at ? Date.parse(json.expires_at) : now() + FILE_TTL_SECONDS * 1000
    const file = { id: json.id, expiresAt: Number.isNaN(expiresAt) ? now() + FILE_TTL_SECONDS * 1000 : expiresAt }
    memory.set(key, file)
    await storage.set(key, file)
    return file.id
  }

  const fileId = async ({ owner, source, headers }: { owner: string; source: InlineSource; headers: Record<string, string> }) => {
    const key = `${STORAGE_PREFIX}${owner}/${crypto.createHash('sha256').update(source.data).digest('hex')}`
    const stored = memory.get(key) ?? (await storage.get(key))
    if (isStoredFile(stored) && stored.expiresAt - now() > REUSE_MARGIN_MS) {
      memory.set(key, stored)
      return stored.id
    }
    const pending = uploads.get(key)
    if (pending) return pending
    const started = upload({ key, source, headers }).finally(() => uploads.delete(key))
    uploads.set(key, started)
    return started
  }

  const eachStored = async (visit: (entry: { key: string; value: unknown }) => Promise<void>) => {
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix: STORAGE_PREFIX, after })
      for (const entry of page.entries) await visit(entry)
      after = page.next
    } while (after)
  }

  return {
    // Replaces base64 images and PDFs with file ids, in place. A block whose upload fails stays base64.
    async swap({ payload, headers }: { payload: MessagesPayload; headers: Headers }): Promise<boolean> {
      const blocks = inlineMedia(payload)
      const authorization = headers.get('authorization')
      if (blocks.length === 0 || !authorization || (failedUntil.get(authorization) ?? 0) > now()) return false
      const apiHeaders = { authorization, 'anthropic-version': headers.get('anthropic-version') ?? DEFAULT_API_VERSION }
      const owner = await account(apiHeaders)
      if (owner instanceof Error) {
        failedUntil.set(authorization, now() + FAILURE_BACKOFF_MS)
        return false
      }
      const ids = await Promise.all(blocks.map(({ source }) => fileId({ owner, source, headers: apiHeaders })))
      if (ids.some((id) => id instanceof Error)) failedUntil.set(authorization, now() + FAILURE_BACKOFF_MS)
      let changed = false
      blocks.forEach(({ block }, index) => {
        const id = ids[index]
        if (typeof id !== 'string') return
        block.source = { type: 'file', file_id: id }
        changed = true
      })
      return changed
    },
    // Forgets files Anthropic no longer has (deleted by the user, or expired early), so the next request uploads them again.
    async forget(fileIds: readonly string[]) {
      for (const [key, file] of memory) if (fileIds.includes(file.id)) memory.delete(key)
      await eachStored(async ({ key, value }) => {
        if (isStoredFile(value) && fileIds.includes(value.id)) await storage.remove(key)
      })
    },
    // Removes stored ids of expired files.
    async prune() {
      await eachStored(async ({ key, value }) => {
        if (!isStoredFile(value) || value.expiresAt <= now()) await storage.remove(key)
      })
    },
  }
}
