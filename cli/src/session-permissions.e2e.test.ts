// Real V2 session rules, saved approvals, forks, and file-tool protection in a git worktree.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildDeterministicOpencode2Config } from 'opencode-deterministic-provider'
import { buildSessionPermissions } from './opencode.js'
import { setDataDir } from './config.js'
import { createOpencode2Client, startOpencode2Server, type Opencode2Server, type OpenCodeClient } from './opencode2.js'
import { initTestGitRepo } from './test-utils.js'
import { execAsync } from './worktrees.js'

let root: string
let project: string
let worktree: string
let server: Opencode2Server
let client: OpenCodeClient
const sessions: string[] = []

beforeAll(async () => {
  const parent = path.resolve('tmp/session-permissions')
  fs.mkdirSync(parent, { recursive: true })
  root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'run-')))
  project = path.join(root, 'project')
  worktree = path.join(root, 'worktree')
  fs.mkdirSync(project)
  setDataDir(path.join(root, 'data'))
  initTestGitRepo(project)
  const created = await execAsync(`git worktree add --detach ${JSON.stringify(worktree)} HEAD`, { cwd: project })
  if (created instanceof Error) throw created
  fs.writeFileSync(path.join(project, 'protected.txt'), 'original content')
  const config = buildDeterministicOpencode2Config({
    model: 'deterministic-v2',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    settings: {
      strict: false,
      matchers: [
        {
          id: 'permission-file-probe',
          priority: 100,
          when: { lastMessageRole: 'user', latestUserTextIncludes: 'permission-file-probe' },
          then: {
            parts: [
              { type: 'stream-start', warnings: [] },
              ...[
                { path: path.join(project, 'protected.txt'), content: 'absolute overwrite' },
                { path: '../project/protected.txt', content: 'relative overwrite' },
                { path: 'allowed.txt', content: 'worktree content' },
              ].map((input, index) => ({
                type: 'tool-call' as const,
                toolCallId: `permission-write-${index}`,
                toolName: 'write',
                input: JSON.stringify(input),
              })),
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          },
        },
        {
          id: 'permission-file-probe-complete',
          priority: 100,
          when: { lastMessageRole: 'tool', latestUserTextIncludes: 'permission-file-probe' },
          then: {
            parts: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'complete' },
              { type: 'text-delta', id: 'complete', delta: 'permission-probe-complete' },
              { type: 'text-end', id: 'complete' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          },
        },
      ],
    },
  })
  for (const directory of [project, worktree]) {
    fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify(config))
  }
  const started = await startOpencode2Server()
  if (started instanceof Error) throw started
  server = started
  client = createOpencode2Client({ baseUrl: server.baseUrl, password: server.password, directory: worktree })
}, 60_000)

afterAll(async () => {
  for (const sessionID of sessions) await client.session.remove({ sessionID })
  server?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

test('blocks original-checkout writes by absolute and relative path but allows worktree writes', async () => {
  const permissions = buildSessionPermissions({ directory: worktree, originalRepoDirectory: project })
  const session = await client.session.create({ location: { directory: worktree }, permissions })
  sessions.push(session.id)
  await client.session.prompt({ sessionID: session.id, text: 'permission-file-probe' })
  await expect.poll(async () => {
    return JSON.stringify(await client.message.list({ sessionID: session.id }))
  }, { timeout: 8_000, interval: 100 }).toContain('permission-probe-complete')

  const messages = await client.message.list({ sessionID: session.id })
  expect({
    original: fs.readFileSync(path.join(project, 'protected.txt'), 'utf8'),
    worktree: fs.readFileSync(path.join(worktree, 'allowed.txt'), 'utf8'),
    deniedByEditPolicy: JSON.stringify(messages).includes('Permission denied:'),
    pending: (await client.permission.list({ sessionID: session.id })).length,
  }).toMatchInlineSnapshot(`
    {
      "deniedByEditPolicy": true,
      "original": "original content",
      "pending": 0,
      "worktree": "worktree content",
    }
  `)
  expect(fs.readFileSync(path.join(project, 'protected.txt'), 'utf8')).toBe('original content')
  expect(fs.readFileSync(path.join(worktree, 'allowed.txt'), 'utf8')).toBe('worktree content')
  expect(JSON.stringify(messages)).toContain('Permission denied: external_directory')

  const fork = await client.session.fork({ sessionID: session.id, boundary: { type: 'through' } })
  sessions.unshift(fork.id)
  expect(fork.permissions).toEqual(permissions)
  await client.permission.rules({ sessionID: session.id, permissions: [] })
  expect((await client.session.get({ sessionID: session.id })).permissions).toEqual([])
  expect((await client.session.get({ sessionID: fork.id })).permissions).toEqual(permissions)
}, 15_000)

test('saved approval satisfies ask but cannot override session deny', async () => {
  const session = await client.session.create({
    location: { directory: worktree },
    permissions: [{ action: 'permission-probe', resource: '*', effect: 'ask' }],
  })
  sessions.push(session.id)
  const asked = await client.permission.create({
    sessionID: session.id,
    action: 'permission-probe',
    resources: ['one'],
    save: ['one'],
  })
  expect(asked.effect).toBe('ask')
  await client.permission.reply({ sessionID: session.id, requestID: asked.id, reply: 'always' })
  expect((await client.permission.create({ sessionID: session.id, action: 'permission-probe', resources: ['one'] })).effect).toBe('allow')
  await client.permission.rules({
    sessionID: session.id,
    permissions: [{ action: 'permission-probe', resource: '*', effect: 'deny' }],
  })
  expect((await client.permission.create({ sessionID: session.id, action: 'permission-probe', resources: ['one'] })).effect).toBe('deny')
})
