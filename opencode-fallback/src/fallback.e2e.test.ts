// Real `opencode serve` (pinned @opencode/cli) with this plugin loaded, against
// a fake OpenAI-compatible server that answers 429 per (model, API key).

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import dedent from 'string-dedent'
import { afterAll, beforeAll, expect, onTestFailed, test } from 'vitest'
import { formatModel, isBlock } from './fallback.ts'
import { FallbackRpc } from './index.ts'

// `note`: the request carried the model switch note in its system prompt.
const served: Array<{ model: string; key: string; status: number; note: boolean }> = []
let lastNote = ''
// Fake provider rules: which (model, key) pairs answer 429, and with which headers.
const limited = new Map<string, Record<string, string>>([
  ['alpha-big key-1', { 'retry-after': '3600' }],
  ['alpha-big key-2', { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '20m0s' }],
])

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

function sse({ model, delta, finish }: { model: string; delta: object; finish: 'stop' | 'tool_calls' }) {
  const chunk = (body: object) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model, ...body })}\n\n`
  return (
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) +
    'data: [DONE]\n\n'
  )
}

// beta answers each prompt with a `read` tool call first, so the follow-up step shows
// that the rest of the turn stays on the fallback model.
const provider = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const parsed: unknown = JSON.parse(body || '{}')
    const model = parsed && typeof parsed === 'object' && 'model' in parsed ? String(parsed.model) : ''
    const messages = parsed && typeof parsed === 'object' && 'messages' in parsed && Array.isArray(parsed.messages) ? parsed.messages : []
    const followUp = JSON.stringify(messages.at(-1) ?? {}).includes('"role":"tool"')
    const key = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const headers = limited.get(`${model} ${key}`)
    const system = messages.flatMap((message) => (message?.role === 'system' && typeof message.content === 'string' ? [message.content] : []))
    const note = /<model-fallback>[\s\S]*<\/model-fallback>/.exec(system.join('\n'))
    if (note) lastNote = note[0]
    served.push({ model, key, status: headers ? 429 : 200, note: Boolean(note) })
    if (headers) {
      response.writeHead(429, { 'content-type': 'application/json', ...headers })
      response.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Rate limit reached' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (model === 'beta-small' && !followUp) {
      const call = { index: 0, id: `call-${served.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: notes }) } }
      response.end(sse({ model, delta: { tool_calls: [call] }, finish: 'tool_calls' }))
      return
    }
    response.end(sse({ model, delta: { content: `answered by ${model}` }, finish: 'stop' }))
  })
})

let root = ''
let notes = ''
let child: ChildProcess | undefined
let client: OpenCodeClient

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const providerPort = await freePort()
  await new Promise<void>((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${providerPort}/v1`
  const fake = (models: string[]) => ({
    name: models[0],
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL },
    models: Object.fromEntries(models.map((id) => [id, { name: id }])),
  })

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-fallback-')))
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  notes = path.join(project, 'notes.txt')
  fs.writeFileSync(notes, 'notes')
  // OpenCode loads plugin directories, not files: a one-line shim loads src/index.ts.
  const shim = path.join(root, 'plugin')
  fs.mkdirSync(shim)
  fs.writeFileSync(
    path.join(shim, 'index.js'),
    `export { default } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href)}\n`,
  )
  // Use the same Effect failure as the Anthropic plugin, without an external token service.
  const oauth = path.join(root, 'oauth')
  fs.mkdirSync(oauth)
  fs.writeFileSync(
    path.join(oauth, 'index.js'),
    dedent`
      import { Effect } from 'effect'
      export default {
        id: 'expired-oauth-test',
        effect(ctx) {
          return ctx.integration.transform(editor => editor.method.update({
            integrationID: 'alpha',
            method: { id: 'expired-test', type: 'oauth', label: 'Expired test login' },
            authorize: () => Effect.die('Not used'),
            refresh: () => Effect.fail(new Error('Claude Pro/Max login failed: token endpoint returned 400: {"error":"invalid_grant","error_description":"Refresh token expired"}')),
          }))
        },
      }
    `,
  )
  const dirs = { HOME: 'home', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache' }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_') && !key.endsWith('_API_KEY')),
  )
  const env = {
    ...inherited,
    ...Object.fromEntries(Object.entries(dirs).map(([key, dir]) => [key, path.join(root, dir)])),
    OPENCODE_PASSWORD: 'e2e',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: 'alpha/alpha-big',
      providers: { alpha: fake(['alpha-big']), beta: fake(['beta-small']) },
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      plugins: [
        oauth,
        {
          package: shim,
          options: { models: ['alpha/alpha-big', 'beta/beta-small'] },
        },
      ],
    }),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(path.join(root, dir), { recursive: true })

  // OPENCODE_E2E_COMMAND runs an unreleased OpenCode, e.g. `bun /path/to/opencode/packages/cli/src/index.ts`.
  const [command = '', ...prefix] = process.env.OPENCODE_E2E_COMMAND?.split(' ') ?? [
    path.join(path.dirname(require.resolve('@opencode/cli/package.json')), 'bin/opencode.exe'),
  ]
  const port = await freePort()
  const log = fs.openSync(path.join(root, 'opencode.log'), 'w')
  child = spawn(command, [...prefix, 'serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    env,
    stdio: ['ignore', log, log],
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  const headers = { authorization: `Basic ${Buffer.from('opencode:e2e').toString('base64')}` }
  while (!(await fetch(`${baseUrl}/api/info`, { headers }).then((response) => response.ok, () => false))) {
    if (Date.now() > deadline) throw new Error('opencode serve did not start')
    await sleep(100)
  }
  client = OpenCode.make({ baseUrl, headers })

  // Created oldest first: key-1 starts active; fallback must skip both expired logins.
  await client.credential.create({ integrationID: 'beta', label: 'beta', value: { type: 'key', key: 'key-b' } })
  await client.credential.create({ integrationID: 'alpha', label: 'second', value: { type: 'key', key: 'key-2' } })
  await client.credential.create({
    integrationID: 'alpha',
    label: 'also expired',
    value: { type: 'oauth', methodID: 'expired-test', access: 'older-access', refresh: 'older-refresh', expires: 0 },
  })
  await client.credential.create({
    integrationID: 'alpha',
    label: 'expired',
    value: { type: 'oauth', methodID: 'expired-test', access: 'expired-access', refresh: 'expired-refresh', expires: 0 },
  })
  await client.credential.create({ integrationID: 'alpha', label: 'first', value: { type: 'key', key: 'key-1' } })
})

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5_000).then(() => child?.kill('SIGKILL'))])
  }
  provider.close()
  if (root && !process.env.KEEP_E2E_ROOT) fs.rmSync(root, { recursive: true, force: true })
})

async function turn(sessionID: string, text: string) {
  served.length = 0
  await client.session.prompt({ sessionID, text })
  await client.session.wait({ sessionID })
  const session = await client.session.get({ sessionID })
  const messages = await client.message.list({ sessionID, type: 'assistant' })
  const answer = messages.data.flatMap((message) =>
    message.type === 'assistant' ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])) : [],
  )
  return { outcome: session.outcome, model: formatModel(session.model!), answer: answer.at(-1), served: [...served] }
}

test('expired refresh and 429 rotate accounts, then fall back and continue the same session', async () => {
  onTestFailed(() => {
    console.error(fs.readFileSync(path.join(root, 'opencode.log'), 'utf8').split('\n').filter((line) => /error|fallback|retry|429|plugin/i.test(line)).slice(-60).join('\n'))
  })
  // A title skips title generation, so the fake provider only sees the agent loop.
  const session = await client.session.create({ title: 'fallback e2e', location: { directory: path.join(root, 'project') } })
  const startedAt = Date.now()

  // Same turn: key-1 429, two expired logins, key-2 429, then beta answers.
  expect(await turn(session.id, 'hello')).toMatchInlineSnapshot(`
    {
      "answer": "answered by beta-small",
      "model": "beta/beta-small#default",
      "outcome": "succeeded",
      "served": [
        {
          "key": "key-1",
          "model": "alpha-big",
          "note": false,
          "status": 429,
        },
        {
          "key": "key-2",
          "model": "alpha-big",
          "note": false,
          "status": 429,
        },
        {
          "key": "key-b",
          "model": "beta-small",
          "note": true,
          "status": 200,
        },
        {
          "key": "key-b",
          "model": "beta-small",
          "note": true,
          "status": 200,
        },
      ],
    }
  `)

  // The retried step on beta already carries the note, and the session metadata keeps it.
  expect(lastNote).toMatchInlineSnapshot(`
    "<model-fallback>
    This session ran on alpha/alpha-big. The fallback plugin moved it to beta/beta-small, the model you are now, because a request to the previous model failed: it hit a rate limit.
    Tools, input types (audio, video, images) and other abilities that alpha/alpha-big had may be missing on this model. Earlier messages may assume them.
    If the task needs an ability you do not have, tell the user plainly. Never claim you used a tool, heard audio or saw content that you cannot access.
    </model-fallback>"
  `)
  expect((await client.session.get({ sessionID: session.id })).metadata?.fallback).toMatchInlineSnapshot(`
    {
      "from": "alpha/alpha-big",
      "reason": "rate-limit",
      "to": "beta/beta-small",
    }
  `)

  const result = await client.rpc(FallbackRpc).blocks({})
  const blocks = result && typeof result === 'object' && 'blocks' in result && Array.isArray(result.blocks) ? result.blocks : []
  expect(blocks.filter(isBlock).map((block) => block.credentialID)).not.toContain('env')
  const minutes = blocks.filter(isBlock).map((block) => ({
    ...block,
    until: Math.round((block.until - startedAt) / 60_000),
    credentialID: '<credential>',
  }))
  expect(minutes).toMatchInlineSnapshot(`
    [
      {
        "credentialID": "<credential>",
        "modelID": "alpha-big",
        "providerID": "alpha",
        "reason": "rate-limit",
        "until": 20,
      },
      {
        "credentialID": "<credential>",
        "modelID": "*",
        "providerID": "alpha",
        "reason": "auth",
        "until": 1440,
      },
      {
        "credentialID": "<credential>",
        "modelID": "*",
        "providerID": "alpha",
        "reason": "auth",
        "until": 1440,
      },
      {
        "credentialID": "<credential>",
        "modelID": "alpha-big",
        "providerID": "alpha",
        "reason": "rate-limit",
        "until": 60,
      },
    ]
  `)

  // alpha works again, but the session keeps beta to keep its prompt cache.
  limited.clear()
  expect(await turn(session.id, 'hello again')).toMatchInlineSnapshot(`
    {
      "answer": "answered by beta-small",
      "model": "beta/beta-small#default",
      "outcome": "succeeded",
      "served": [
        {
          "key": "key-b",
          "model": "beta-small",
          "note": true,
          "status": 200,
        },
        {
          "key": "key-b",
          "model": "beta-small",
          "note": true,
          "status": 200,
        },
      ],
    }
  `)
}, 15_000)
