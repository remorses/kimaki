// E2E test for the opencode2 (OpenCode v2) serve harness in opencode2.ts:
// spawn + Basic auth via env OPENCODE_PASSWORD, session CRUD with location in
// the create body, and SSE first event server.connected. No LLM prompting —
// no provider is configured in this phase.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  buildBasicAuthHeader,
  createOpencode2Client,
  startOpencode2Server,
  type Opencode2Server,
  type OpenCodeClient,
} from './opencode2.js'
import { createGlobalEventClient } from './session-handler/global-event-listener.js'

let server: Opencode2Server
let client: OpenCodeClient
let tempDir: string

beforeAll(async () => {
  // realpath: macOS mkdtemp returns /var/... but the server resolves /private/var/...
  tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode2-')),
  )
  execFileSync('git', ['init', '-q'], { cwd: tempDir })
  const started = await startOpencode2Server()
  if (started instanceof Error) {
    throw started
  }
  server = started
  client = createOpencode2Client({
    baseUrl: server.baseUrl,
    password: server.password,
  })
}, 60_000)

afterAll(async () => {
  server?.close()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('authenticated probe returns 200, wrong password gets 401', async () => {
  const ok = await fetch(`${server.baseUrl}/api/session/active`, {
    headers: {
      authorization: buildBasicAuthHeader({ password: server.password }),
    },
  })
  expect(ok.status).toBe(200)

  const wrong = await fetch(`${server.baseUrl}/api/session/active`, {
    headers: {
      authorization: buildBasicAuthHeader({ password: 'wrong-password' }),
    },
  })
  expect(wrong.status).toBe(401)
})

test('session create with location in body, then get and list', async () => {
  const created = await client.session.create({
    title: 'phase0 harness session',
    location: { directory: tempDir },
  })
  expect(created.id).toMatch(/^ses/)
  expect(created.location.directory).toBe(tempDir)

  const redacted = {
    ...created,
    id: '<id>',
    projectID: '<projectID>',
    time: '<time>',
    location: { ...created.location, directory: '<tempDir>' },
  }
  expect(redacted).toMatchInlineSnapshot(`
    {
      "cost": 0,
      "id": "<id>",
      "location": {
        "directory": "<tempDir>",
      },
      "projectID": "<projectID>",
      "time": "<time>",
      "title": "phase0 harness session",
      "tokens": {
        "cache": {
          "read": 0,
          "write": 0,
        },
        "input": 0,
        "output": 0,
        "reasoning": 0,
      },
    }
  `)

  const fetched = await client.session.get({ sessionID: created.id })
  expect(fetched.id).toBe(created.id)
  expect(fetched.title).toBe('phase0 harness session')

  const list = await client.session.list()
  expect(list.data.map((session) => session.id)).toContain(created.id)
})

test('event.subscribe yields server.connected first', async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)
  try {
    for await (const event of client.event.subscribe({
      signal: controller.signal,
    })) {
      expect(event.type).toBe('server.connected')
      break
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
})

test('global event client authenticates with the active server password', async () => {
  const globalClient = createGlobalEventClient({
    baseUrl: server.baseUrl,
    password: server.password,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    for await (const event of globalClient.event.subscribe({ signal: controller.signal })) {
      expect(event.type).toBe('server.connected')
      break
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
})
