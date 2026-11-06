// Real `opencode serve` (pinned @opencode/cli) with this plugin, against a real Grok Bot account.
// The first run prints a cursor.com sign-in URL and waits for approval; the tokens are kept in
// GROK_BOT_E2E_LOGIN (default <repo>/tmp/grok-bot-login.json). It creates a throwaway bot and
// deletes it at the end.

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
import { agentState, createAgent, createGrokBotClient, jwtClaims, listAgents, pollLogin, refreshLogin, sendMessage, startLogin, transcriptTail } from './grok-bot.ts'

const BOT_NAME = 'OpenCode E2E'
const BOT_SLUG = 'opencode-e2e'
// Only listed in the config, so the plugin creates it on the first turn.
const NEW_BOT_SLUG = 'opencode-e2e-created'
const NEW_BOT_NAME = 'OpenCode E2E Created'
const TURN_TIMEOUT_MS = 360_000

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

const LOGIN_FILE = process.env.GROK_BOT_E2E_LOGIN ?? path.join(import.meta.dirname, '../../tmp/grok-bot-login.json')
const LOGIN_WAIT_MS = 12 * 60_000

type Tokens = { accessToken: string; refreshToken: string }

// A fresh access token for the test account, signing in through the browser the first time.
async function testLogin(): Promise<Tokens> {
  const signal = AbortSignal.timeout(LOGIN_WAIT_MS)
  const saved = fs.existsSync(LOGIN_FILE) ? (JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8')) as Tokens) : null
  const tokens = await (async () => {
    if (saved) return refreshLogin({ refreshToken: saved.refreshToken, signal })
    const login = startLogin()
    console.log(`Open this URL to sign in to Grok Bot for the e2e test:\n${login.url}`)
    return pollLogin({ ...login, signal })
  })()
  if (tokens instanceof Error) throw tokens
  fs.mkdirSync(path.dirname(LOGIN_FILE), { recursive: true })
  fs.writeFileSync(LOGIN_FILE, JSON.stringify(tokens), { mode: 0o600 })
  return tokens
}

let tokens: Tokens = { accessToken: '', refreshToken: '' }
const grok = createGrokBotClient({ token: async () => ({ accessToken: tokens.accessToken, teamId: null }) })
let botId = ''
let root = ''
let child: ChildProcess | undefined
let client: OpenCodeClient

beforeAll(async () => {
  tokens = await testLogin()
  const signal = AbortSignal.timeout(150_000)
  const created = await createAgent({
    client: grok,
    name: BOT_NAME,
    description: 'Test bot for the OpenCode Grok Bot provider. Answer in one short sentence. When asked to run a shell command, run it.',
    signal,
  })
  if (created instanceof Error) throw created
  botId = created

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-grok-bot-')))
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
    GROK_BOT_APP_DATA_DIR: path.join(os.homedir(), 'Library/Application Support/Grok Bot'),
    GROK_BOT_DOWNLOAD_DIR: path.join(root, 'downloads'),
    OPENCODE_PASSWORD: 'e2e',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: `grok-bot/${BOT_SLUG}`,
      providers: { 'grok-bot': { models: { [NEW_BOT_SLUG]: { name: NEW_BOT_NAME } } } },
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      plugins: [{ package: shim }],
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
  // Same as finishing "Grok Bot account (browser sign-in)" in /connect.
  await client.credential.create({
    integrationID: 'grok-bot',
    label: jwtClaims(tokens.accessToken).email ?? 'e2e',
    value: { type: 'oauth', methodID: ACCOUNT_METHOD_ID, access: tokens.accessToken, refresh: tokens.refreshToken, expires: (jwtClaims(tokens.accessToken).exp ?? 0) * 1_000 },
  })
  // The new credential makes the plugin list the account's bots as models.
  const listed = Date.now() + 60_000
  while (!JSON.stringify(await client.model.list().catch(() => null)).includes(`"${BOT_SLUG}"`)) {
    if (Date.now() > listed) throw new Error('the test bot never showed up as a grok-bot model')
    await sleep(500)
  }
}, LOGIN_WAIT_MS + 200_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5_000).then(() => child?.kill('SIGKILL'))])
  }
  // The test bot and the one the plugin created from the config.
  const agents = await listAgents({ client: grok, signal: AbortSignal.timeout(30_000) })
  const created = agents instanceof Error ? [] : agents.filter((agent) => agent.name === NEW_BOT_NAME).map((agent) => agent.id)
  const ids = [botId, ...created].filter(Boolean)
  for (const id of ids) await grok.call({ method: 'DeleteGrokBotAgent', body: { id }, signal: AbortSignal.timeout(30_000) })
  if (root && !process.env.KEEP_E2E_ROOT) fs.rmSync(root, { recursive: true, force: true })
}, 60_000)

const seenMessages = new Set<string>()

// Parts of the assistant messages this turn added.
async function turn(sessionID: string, text: string) {
  await client.session.prompt({ sessionID, text })
  await client.session.wait({ sessionID })
  const session = await client.session.get({ sessionID })
  const messages = await client.message.list({ sessionID, type: 'assistant' })
  const added = messages.data.filter((message) => !seenMessages.has(message.id))
  for (const message of added) seenMessages.add(message.id)
  const parts = added.flatMap((message) => (message.type === 'assistant' ? message.content : []))
  return { outcome: session.outcome, parts }
}

test(
  'a session on a Grok Bot model streams the reply and the bot tool calls',
  async () => {
    onTestFailed(() => {
      console.error(fs.readFileSync(path.join(root, 'opencode.log'), 'utf8').split('\n').filter((line) => /error|grok|plugin|fail/i.test(line)).slice(-80).join('\n'))
    })
    // /connect offers both logins; starting the account login gives a Cursor sign-in URL.
    const integration = await client.integration.get({ integrationID: 'grok-bot' })
    expect(integration.data.methods.map((method) => ('label' in method ? method.label : method.type))).toMatchInlineSnapshot(`
      [
        "Grok Bot account (browser sign-in)",
        "Grok Bot desktop app (macOS, reads its login from the Keychain)",
      ]
    `)
    const attempt = await client.integration.oauth.connect({ integrationID: 'grok-bot', methodID: ACCOUNT_METHOD_ID })
    const url = new URL(attempt.data.url)
    expect(url.origin + url.pathname).toBe('https://cursor.com/loginDeepControl')
    await client.integration.oauth.cancel({ integrationID: 'grok-bot', attemptID: attempt.data.attemptID })

    const session = await client.session.create({ title: 'grok bot e2e', location: { directory: path.join(root, 'project') } })

    const first = await turn(session.id, 'Reply with exactly the word PONG and nothing else.')
    expect(first.outcome).toBe('succeeded')
    const firstText = first.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    expect(firstText).toContain('PONG')

    const second = await turn(session.id, 'Use your shell tool to run `echo grok-e2e-$((40+2))` on your computer, then reply with its output.')
    expect(second.outcome).toBe('succeeded')
    const tools = second.parts.filter((part) => part.type === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    // Grok Bot ran them on its own computer: OpenCode shows them as finished hosted calls.
    expect(tools.map((part) => part.type === 'tool' && { executed: part.executed, status: part.state.status })).toContainEqual({ executed: true, status: 'completed' })
    const secondText = second.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    expect(secondText).toContain('grok-e2e-42')

    // A file the bot sends is downloaded from the bot storage and shown with its local path.
    const file = await turn(session.id, 'Use your shell tool to write the text grok-e2e-file-42 into a file named e2e.txt, then send me that file as an attachment.')
    expect(file.outcome).toBe('succeeded')
    const fileText = file.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    const saved = /\*\*File:\*\* saved to `([^`]+)`/.exec(fileText)?.[1] ?? ''
    expect(path.relative(path.join(root, 'downloads'), saved).startsWith('..')).toBe(false)
    expect(fs.readFileSync(saved, 'utf8')).toContain('grok-e2e-file-42')

    // A message the bot answers outside OpenCode (another device, a routine) shows up on the next turn.
    const outside = await sendMessage({ client: grok, agentId: botId, text: 'Reply with exactly the word LATER and nothing else.', messageId: crypto.randomUUID(), signal: AbortSignal.timeout(30_000) })
    if (outside instanceof Error) throw outside
    // Wait for the bot's reply and for the bot to go idle, so the OpenCode turn starts after it.
    const waitUntil = Date.now() + 120_000
    while (!(await answeredOutside())) {
      if (Date.now() > waitUntil) throw new Error('the bot never answered the outside prompt')
      await sleep(1_000)
    }
    const third = await turn(session.id, 'Reply with exactly the word AGAIN and nothing else.')
    const thirdText = third.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    expect(thirdText).toContain('Sent by the bot since the last message')
    expect(thirdText).toContain('LATER')
    expect(thirdText).toContain('AGAIN')
  },
  TURN_TIMEOUT_MS,
)

async function answeredOutside() {
  const signal = AbortSignal.timeout(30_000)
  const [tail, state] = await Promise.all([transcriptTail({ client: grok, agentId: botId, limit: 20, signal }), agentState({ client: grok, agentId: botId, signal })])
  if (tail instanceof Error) throw tail
  if (state instanceof Error) throw state
  const replied = tail.some((entry) => entry.kind === 'send-message' && JSON.stringify(entry.message).includes('LATER'))
  return replied && !state.isRunning
}

test(
  'a model only listed in opencode.json creates its bot on the first turn',
  async () => {
    const session = await client.session.create({
      title: 'grok bot create e2e',
      location: { directory: path.join(root, 'project') },
      model: { providerID: 'grok-bot', id: NEW_BOT_SLUG },
    })
    const reply = await turn(session.id, 'Reply with exactly the word CREATED and nothing else.')
    expect(reply.outcome).toBe('succeeded')
    expect(reply.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')).toContain('CREATED')
    const agents = await listAgents({ client: grok, signal: AbortSignal.timeout(30_000) })
    if (agents instanceof Error) throw agents
    expect(agents.filter((agent) => agent.name === NEW_BOT_NAME)).toHaveLength(1)
  },
  TURN_TIMEOUT_MS,
)
