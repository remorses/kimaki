// Real `opencode serve` (pinned @opencode/cli) with this plugin, against a real `muse serve`.
// Muse's `echo` provider answers `echo: <prompt>` with no model call and no Meta login, so the
// whole path (plugin, host, MSP session, resume, agent prompt) runs without an account.
// Needs the Muse Code CLI: curl -fsSL https://dev.meta.ai/install.sh | MUSE_NO_MODIFY_PATH=1 bash

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { afterAll, beforeAll, expect, onTestFailed, test } from 'vitest'
import { ACCOUNT_METHOD_ID } from './index.ts'

const TURN_TIMEOUT_MS = 60_000
const MUSE_BIN = process.env.MUSE_BIN ?? path.join(os.homedir(), '.local', 'bin', 'muse')
const AGENT_MARKER = 'SANDBOX-TESTER-RULES'

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

let root = ''
let child: ChildProcess | undefined
let client: OpenCodeClient

beforeAll(async () => {
  if (!fs.existsSync(MUSE_BIN)) throw new Error(`muse not found at ${MUSE_BIN}. Install Muse Code or set MUSE_BIN.`)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-muse-code-')))
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  const shim = path.join(root, 'plugin')
  fs.mkdirSync(shim)
  fs.writeFileSync(path.join(shim, 'index.js'), `export { default } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href)}\n`)
  const dirs = { HOME: 'home', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache' }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_') && !key.endsWith('_API_KEY')))
  const env = {
    ...inherited,
    ...Object.fromEntries(Object.entries(dirs).map(([key, dir]) => [key, path.join(root, dir)])),
    // The launcher would check for updates under the temporary HOME.
    MUSE_NO_AUTO_UPDATE: '1',
    OPENCODE_PASSWORD: 'e2e',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: 'muse/muse-spark-1.3',
      default_agent: 'tester',
      agents: {
        tester: { mode: 'primary', model: 'muse/muse-spark-1.3', system: `${AGENT_MARKER}: run the tests in your sandbox.`, request: { settings: { approvalMode: 'allowAll' } } },
      },
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      plugins: [{ package: shim, options: { bin: MUSE_BIN, provider: 'echo' } }],
    }),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(path.join(root, dir), { recursive: true })

  const require = createRequire(import.meta.url)
  const [command = '', ...prefix] = process.env.OPENCODE_E2E_COMMAND?.split(' ') ?? [path.join(path.dirname(require.resolve('@opencode/cli/package.json')), 'bin/opencode.exe')]
  const port = await freePort()
  const log = fs.openSync(path.join(root, 'opencode.log'), 'w')
  child = spawn(command, [...prefix, 'serve', '--port', String(port), '--hostname', '127.0.0.1'], { env, stdio: ['ignore', log, log] })
  const baseUrl = `http://127.0.0.1:${port}`
  const headers = { authorization: `Basic ${Buffer.from('opencode:e2e').toString('base64')}` }
  const deadline = Date.now() + 60_000
  while (!(await fetch(`${baseUrl}/api/info`, { headers }).then((response) => response.ok, () => false))) {
    if (Date.now() > deadline) throw new Error('opencode serve did not start')
    await sleep(100)
  }
  client = OpenCode.make({ baseUrl, headers })
  // Same as finishing "Meta account" in /connect. The echo provider ignores the key.
  await client.credential.create({
    integrationID: 'muse',
    label: 'e2e@example.com',
    value: { type: 'oauth', methodID: ACCOUNT_METHOD_ID, access: 'e2e-key', refresh: '', expires: Date.now() + 3_600_000, metadata: { email: 'e2e@example.com' } },
  })
}, 120_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5_000).then(() => child?.kill('SIGKILL'))])
  }
  if (root && !process.env.KEEP_E2E_ROOT) fs.rmSync(root, { recursive: true, force: true })
}, 60_000)

async function turn(sessionID: string, text: string) {
  await client.session.prompt({ sessionID, text })
  await client.session.wait({ sessionID })
  const session = await client.session.get({ sessionID })
  const messages = await client.message.list({ sessionID, type: 'assistant' })
  // Newest first.
  const last = messages.data.at(0)
  const parts = last?.type === 'assistant' ? last.content : []
  if (session.outcome !== 'succeeded') console.error('turn failed:', JSON.stringify(last, null, 2))
  return { outcome: session.outcome, text: parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n') }
}

test(
  'a session runs on one Muse session and the agent prompt reaches it once',
  async () => {
    onTestFailed(() => {
      console.error(fs.readFileSync(path.join(root, 'opencode.log'), 'utf8').split('\n').filter((line) => /error|muse|plugin|fail/i.test(line)).slice(-80).join('\n'))
    })
    const session = await client.session.create({ title: 'muse e2e', location: { directory: path.join(root, 'project') } })

    const first = await turn(session.id, 'PING-1')
    expect(first.outcome).toBe('succeeded')
    expect(first.text).toContain(AGENT_MARKER)
    expect(first.text).toContain('PING-1')

    const second = await turn(session.id, 'PING-2')
    expect(second.outcome).toBe('succeeded')
    expect(second.text).toBe('echo: PING-2')

    // What the fallback plugin does on a used-up plan: another account, so another `muse serve`.
    // The new host resumes the same Muse session, so no agent prompt is sent again.
    const other = await client.credential.create({
      integrationID: 'muse',
      label: 'second@example.com',
      value: { type: 'oauth', methodID: ACCOUNT_METHOD_ID, access: 'e2e-key-2', refresh: '', expires: Date.now() + 3_600_000, metadata: { email: 'second@example.com' } },
    })
    await client.credential.activate({ credentialID: other.id })
    const third = await turn(session.id, 'PING-3')
    expect(third.outcome).toBe('succeeded')
    expect(third.text).toBe('echo: PING-3')
  },
  TURN_TIMEOUT_MS,
)
