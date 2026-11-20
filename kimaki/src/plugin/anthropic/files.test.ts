import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createFileCache, inlineMedia, missingFileIds, type FileStorage } from './files.ts'

// A local stand-in for api.anthropic.com: profile and file upload, with a switch to fail uploads.
const calls: string[] = []
let failUploads = false
let uploaded = 0
const server = http.createServer((request, response) => {
  calls.push(`${request.method} ${request.url}`)
  request.resume()
  request.on('end', () => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/oauth/profile') return response.end(JSON.stringify({ organization: { uuid: 'org1' }, account: { uuid: 'acc1' } }))
    if (failUploads) return response.writeHead(400).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', details: { error_code: 'storage_quota_exceeded' } } }))
    uploaded++
    // No expires_at: the cache then counts the 7 day expiry from the test clock.
    response.end(JSON.stringify({ id: `file_${uploaded}`, expires_at: null }))
  })
})
let apiURL = ''
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  apiURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

function memoryStorage(): FileStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
    scan: async ({ prefix }) => ({ entries: [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  }
}

const image = (seed: string, length = 20_000) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: seed.repeat(length / seed.length) } })
const payload = () => ({
  messages: [
    { role: 'user', content: [image('a'), { type: 'text', text: 'hi' }, image('tiny', 400)] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [image('a'), { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'p'.repeat(20_000) } }] }] },
  ],
})
const sources = (body: ReturnType<typeof payload>) =>
  body.messages.flatMap((message) => (message.content as Array<{ type: string; source?: { type: string; file_id?: string }; content?: Array<{ source?: { type: string; file_id?: string } }> }>).flatMap((block) => [block, ...(block.content ?? [])]))
    .flatMap((block) => (block.source ? [block.source.file_id ?? block.source.type] : []))

test('images and PDFs upload once, are reused until near expiry, and failures keep base64', async () => {
  let now = Date.UTC(2026, 0, 1)
  const storage = memoryStorage()
  const headers = new Headers({ authorization: 'Bearer token-1', 'anthropic-version': '2023-06-01' })
  const files = createFileCache({ storage, apiURL, now: () => now })

  expect(inlineMedia(payload()).length).toBe(3)
  const first = payload()
  expect(await files.swap({ payload: first, headers })).toBe(true)
  // The same image in a tool result shares one upload; the tiny image stays inline.
  expect(sources(first)).toMatchInlineSnapshot(`
    [
      "file_1",
      "base64",
      "file_1",
      "file_2",
    ]
  `)
  expect(calls.splice(0)).toMatchInlineSnapshot(`
    [
      "GET /api/oauth/profile",
      "POST /v1/files",
      "POST /v1/files",
    ]
  `)

  // Stored ids survive a plugin reload.
  const reloaded = createFileCache({ storage, apiURL, now: () => now })
  const second = payload()
  expect(await reloaded.swap({ payload: second, headers })).toBe(true)
  expect(sources(second)).toEqual(sources(first))
  expect(calls.splice(0)).toEqual(['GET /api/oauth/profile'])

  // Less than an hour before expiry the files are uploaded again.
  now = Date.UTC(2026, 0, 7, 23, 30)
  const third = payload()
  await files.swap({ payload: third, headers })
  expect(sources(third)).toMatchInlineSnapshot(`
    [
      "file_3",
      "base64",
      "file_3",
      "file_4",
    ]
  `)

  // A 404 for a file makes the next request upload it again.
  const missing = missingFileIds({ status: 404, message: 'Not Found', response: { body: '{"type":"error","error":{"type":"not_found_error","message":"File `file_3` not found."}}' } })
  expect(missing).toEqual(['file_3'])
  expect(await files.forget(missing)).toBe(true)
  // Ids this cache never sent (API key or proxy requests) are not repaired by a retry.
  expect(await files.forget(['file_unknown'])).toBe(false)
  const fourth = payload()
  await files.swap({ payload: fourth, headers })
  expect(sources(fourth)).toEqual(['file_5', 'base64', 'file_5', 'file_4'])
  calls.splice(0)

  // A failed upload keeps base64 and pauses uploads, so later requests do not wait on a broken API.
  failUploads = true
  const fresh = payload()
  fresh.messages = [{ role: 'user', content: [image('b')] }]
  expect(await files.swap({ payload: fresh, headers })).toBe(false)
  expect(sources(fresh)).toEqual(['base64'])
  expect(await files.swap({ payload: { messages: [{ content: [image('c')] }] }, headers })).toBe(false)
  expect(calls.splice(0)).toEqual(['POST /v1/files'])
  failUploads = false
  now += 5 * 60 * 1000 + 1
  expect(await files.swap({ payload: fresh, headers })).toBe(true)

  // Expired entries are pruned from storage.
  now = Date.UTC(2026, 0, 20)
  await files.prune()
  expect(storage.data.size).toBe(0)
})

test('concurrent misses from two plugin instances upload once, and a broken storage keeps requests working', async () => {
  const storage = memoryStorage()
  const headers = new Headers({ authorization: 'Bearer token-2' })
  const first = { messages: [{ content: [image('d')] }] }
  const second = { messages: [{ content: [image('d')] }] }
  const before = uploaded
  await Promise.all([createFileCache({ storage, apiURL }).swap({ payload: first, headers }), createFileCache({ storage, apiURL }).swap({ payload: second, headers })])
  expect(uploaded - before).toBe(1)
  expect(JSON.stringify(first)).toBe(JSON.stringify(second))

  const broken: FileStorage = {
    get: async () => Promise.reject(new Error('SQLITE_BUSY')),
    set: async () => Promise.reject(new Error('SQLITE_BUSY')),
    remove: async () => Promise.reject(new Error('SQLITE_BUSY')),
    scan: async () => Promise.reject(new Error('SQLITE_BUSY')),
  }
  const files = createFileCache({ storage: broken, apiURL })
  const payload = { messages: [{ content: [image('e')] }] }
  expect(await files.swap({ payload, headers })).toBe(true)
  await files.prune()
})

test('missingFileIds only reads 404 file errors', () => {
  expect(missingFileIds({ status: 400, message: 'File `file_1` not found.' })).toEqual([])
  expect(missingFileIds({ status: 404, message: 'model: claude-x not found' })).toEqual([])
  expect(missingFileIds({ status: 404, message: 'File `file_01A` not found. File `file_02B` not found.' })).toEqual(['file_01A', 'file_02B'])
})
