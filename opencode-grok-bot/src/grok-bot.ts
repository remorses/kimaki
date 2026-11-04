// Grok Bot client: logins, the cloud box gateway and its event stream.
//
// Grok Bot has no public API. The protocol comes from the desktop app (Electron) and
// from github.com/ScriptedAlchemy/grok-bot-cli, github.com/JiminLee-way/GrokBotCLI and
// github.com/Readtt/grokport. A Grok Bot account is a Cursor account:
//
//   account login: cursor.com/loginDeepControl (PKCE) ──▶ poll api2.cursor.sh/auth/poll ──▶ tokens
//   desktop login: sand-secrets.json ──(Keychain "Grok Bot Safe Storage")──▶ access token
//   POST api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox ──▶ gateway URL + tokens
//   POST {gateway}/api/<method>   JSON calls (listAgents, sendPrompt, getAgentTranscriptTail, ...)
//   GET  {gateway}/events         SSE, `data: {channel, payload}`
//
// The desktop app refreshes its access token itself, so every connect reads the file again.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as errore from 'errore'

const execFileAsync = promisify(execFile)

const BACKEND_URL = 'https://api2.cursor.sh'
const WEBSITE_URL = 'https://cursor.com'
// Cursor's public OAuth client for its own CLIs and the Grok Bot app.
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const LOGIN_POLL_MAX_MS = 5_000
const LOGIN_TIMEOUT_MS = 12 * 60_000
const ENSURE_SANDBOX_PATH = '/aiserver.v1.GrokBotService/EnsureSandBox'
const KEYCHAIN_SERVICE = 'Grok Bot Safe Storage'
// macOS shows an "allow access" dialog the first time; give the user time to answer it.
const KEYCHAIN_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 30_000
// Electron safeStorage on macOS: "v10" prefix, AES-128-CBC, PBKDF2-SHA1 with 1003 rounds.
const SAFE_STORAGE_PREFIX = 'v10'
const SAFE_STORAGE_ROUNDS = 1003
const SAFE_STORAGE_KEY_BYTES = 16
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
// The box answers 417 while it hibernates; EnsureSandBox with `wake` starts it again.
const HTTP_BOX_ASLEEP = 417
const HTTP_BAD_GATEWAY = 502
const WAKE_ATTEMPTS = 40
const WAKE_RETRY_MS = 3_000
const APP_NAME = 'Grok Bot'

export class GrokBotAuthError extends errore.createTaggedError({
  name: 'GrokBotAuthError',
  message: 'Grok Bot login unavailable: $reason. Connect a Grok Bot account again with /connect.',
}) {}

export class GrokBotGatewayError extends errore.createTaggedError({
  name: 'GrokBotGatewayError',
  message: 'Grok Bot $method failed: $reason',
}) {}

export class GrokBotAbortError extends errore.createTaggedError({
  name: 'GrokBotAbortError',
  message: 'Grok Bot request aborted',
  extends: errore.AbortError,
}) {}

export type Connection = {
  gatewayUrl: string
  gatewayToken: string
  networkToken?: string
}

export type GatewayEvent = { channel: string; payload: unknown }

export type Agent = {
  id: string
  name: string
  title?: string
  description?: string
  isGroup?: boolean
  isRunning?: boolean
  isRunningTurn?: boolean
  createdAt?: number
  awaitingUserResponse?: unknown
  currentActivity?: { kind?: string; tool?: string; detail?: string } | null
  // The turn that settled last; `clientNonce` is the turn's requestId.
  lastTurnSettlement?: { clientNonce?: string; outcome?: string; settledAtMs?: number } | null
}

function appDataDir() {
  if (process.env.GROK_BOT_APP_DATA_DIR) return process.env.GROK_BOT_APP_DATA_DIR
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), APP_NAME)
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME)
  return path.join(os.homedir(), 'Library/Application Support', APP_NAME)
}

function readJson(file: string) {
  return errore.try(
    () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>,
    (cause) => new GrokBotAuthError({ reason: `cannot read ${file}`, cause }),
  )
}

function appVersion() {
  const status = readJson(path.join(appDataDir(), 'desktop-status.json'))
  if (status instanceof Error) return null
  return typeof status.appVersion === 'string' ? status.appVersion : null
}

// Decrypts one Electron safeStorage value. Only macOS is supported for now.
// TODO: Linux (secret-tool) and Windows (DPAPI Local State key), see grok-bot-cli src/core/app-session.js.
export function decryptSafeStorage({ encrypted, password }: { encrypted: string; password: string }) {
  const buffer = Buffer.from(encrypted, 'base64')
  if (buffer.subarray(0, SAFE_STORAGE_PREFIX.length).toString('latin1') !== SAFE_STORAGE_PREFIX) {
    return new GrokBotAuthError({ reason: 'unsupported safe storage format' })
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', SAFE_STORAGE_ROUNDS, SAFE_STORAGE_KEY_BYTES, 'sha1')
  return errore.try(
    () => {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
      return Buffer.concat([decipher.update(buffer.subarray(SAFE_STORAGE_PREFIX.length)), decipher.final()]).toString('utf8')
    },
    (cause) => new GrokBotAuthError({ reason: 'cannot decrypt the desktop login (wrong Keychain password?)', cause }),
  )
}

// The Keychain password never changes, so one successful read lasts for the process.
let keychainPassword: string | undefined

async function readKeychainPassword({ signal }: { signal: AbortSignal }) {
  if (keychainPassword) return keychainPassword
  if (process.platform !== 'darwin') return new GrokBotAuthError({ reason: `${process.platform} is not supported yet, only macOS` })
  const result = await execFileAsync('/usr/bin/security', ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE], {
    timeout: KEYCHAIN_TIMEOUT_MS,
    signal,
  }).catch((cause) => new GrokBotAuthError({ reason: `macOS Keychain did not give access to "${KEYCHAIN_SERVICE}". Click Always Allow in the Keychain dialog`, cause }))
  if (result instanceof Error) return result
  keychainPassword = result.stdout.trimEnd()
  return keychainPassword
}

export type Login = { accessToken: string; teamId: string | null }
export type TokenSource = (input: { signal: AbortSignal }) => Promise<Login | GrokBotAuthError | GrokBotAbortError>

export function jwtClaims(token: string) {
  const claims = errore.try(() => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; email?: string; exp?: number })
  return claims instanceof Error ? {} : claims
}

// Starts Cursor's browser sign-in. Open `url`, then wait with pollLogin.
export function startLogin() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const uuid = crypto.randomUUID()
  const params = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' })
  return { url: `${WEBSITE_URL}/loginDeepControl?${params}`, uuid, verifier }
}

// Answers 404 until the user approves in the browser.
export async function pollLogin({ uuid, verifier, signal }: { uuid: string; verifier: string; signal: AbortSignal }) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const response = await fetch(`${BACKEND_URL}/auth/poll?${new URLSearchParams({ uuid, verifier })}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    }).catch((cause) => new GrokBotAuthError({ reason: 'login poll failed', cause }))
    if (signal.aborted) return new GrokBotAbortError({ cause: signal.reason })
    const body = response instanceof Error || !response.ok ? null : ((await response.json().catch(() => null)) as { accessToken?: string; refreshToken?: string } | null)
    if (body?.accessToken && body.refreshToken) return { accessToken: body.accessToken, refreshToken: body.refreshToken }
    const slept = await sleep({ ms: Math.min(1_000 * 1.2 ** attempt, LOGIN_POLL_MAX_MS), signal })
    if (slept instanceof Error) return slept
  }
  return new GrokBotAuthError({ reason: 'the browser sign-in timed out' })
}

export async function refreshLogin({ refreshToken, signal }: { refreshToken: string; signal: AbortSignal }) {
  const response = await fetch(`${BACKEND_URL}/oauth/token`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
  }).catch((cause) => new GrokBotAuthError({ reason: 'token refresh failed', cause }))
  if (response instanceof Error) return response
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; shouldLogout?: boolean }
  if (!response.ok || body.shouldLogout || !body.access_token) return new GrokBotAuthError({ reason: `token refresh returned HTTP ${response.status}` })
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken }
}

// The access token of the account selected in the desktop app.
export async function readDesktopLogin({ signal }: { signal: AbortSignal }) {
  const secrets = readJson(path.join(appDataDir(), 'sand-secrets.json'))
  if (secrets instanceof Error) return secrets
  const accounts = errore.try(
    () => JSON.parse(String(secrets['cursor-accounts'] ?? 'null')) as { active?: string; accounts?: Record<string, Record<string, string>> } | null,
    (cause) => new GrokBotAuthError({ reason: 'sand-secrets.json has no account list', cause }),
  )
  if (accounts instanceof Error) return accounts
  const account = accounts?.active ? accounts.accounts?.[accounts.active] : undefined
  const encryptedToken = account?.['cursor-access-token']
  if (!encryptedToken) return new GrokBotAuthError({ reason: 'no signed-in account' })
  const password = await readKeychainPassword({ signal })
  if (password instanceof Error) return password
  const accessToken = decryptSafeStorage({ encrypted: encryptedToken, password })
  if (accessToken instanceof Error) return accessToken
  const encryptedTeam = account['cursor-selected-team-id']
  const teamId = encryptedTeam ? decryptSafeStorage({ encrypted: encryptedTeam, password }) : null
  if (teamId instanceof Error) return teamId
  return { accessToken: accessToken.trim(), teamId }
}

function isAllowedGateway(url: string) {
  const parsed = errore.try(() => new URL(url))
  if (parsed instanceof Error) return false
  if (process.env.GROK_BOT_ALLOW_ANY_GATEWAY === '1') return true
  return parsed.protocol === 'https:' && ['.cursor.sh', '.cursor.com', '.cursorvm.com'].some((suffix) => parsed.hostname.endsWith(suffix))
}

async function ensureSandbox({ token, wake, signal }: { token: TokenSource; wake: boolean; signal: AbortSignal }) {
  const login = await token({ signal })
  if (login instanceof Error) return login
  const response = await fetch(BACKEND_URL + ENSURE_SANDBOX_PATH, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      authorization: `Bearer ${login.accessToken}`,
      'x-cursor-client-type': 'sand',
      // EnsureSandBox refuses client versions it considers outdated, so report the installed app.
      'x-cursor-client-version': appVersion() ?? '0.78.0',
      'x-sand-box-namespace': 'prod',
      ...(login.teamId ? { 'x-cursor-team-id': login.teamId } : {}),
    },
    body: JSON.stringify({ wake, supportsAsleepBox: true }),
  }).catch((cause) => new GrokBotGatewayError({ method: 'EnsureSandBox', reason: 'request failed', cause }))
  if (response instanceof Error) return response
  const text = await response.text().catch(() => '')
  if (response.status === HTTP_UNAUTHORIZED) return new GrokBotAuthError({ reason: 'the desktop login expired' })
  if (!response.ok) return new GrokBotGatewayError({ method: 'EnsureSandBox', reason: `HTTP ${response.status} ${text.slice(0, 300)}` })
  const body = errore.try(() => JSON.parse(text) as { gatewayUrl?: string; gatewayToken?: string; networkToken?: string; runState?: string })
  if (body instanceof Error) return new GrokBotGatewayError({ method: 'EnsureSandBox', reason: 'response is not JSON', cause: body })
  if (!body.gatewayUrl || !body.gatewayToken) return null
  if (!isAllowedGateway(body.gatewayUrl)) return new GrokBotGatewayError({ method: 'EnsureSandBox', reason: `unexpected gateway host ${body.gatewayUrl}` })
  return { gatewayUrl: body.gatewayUrl.replace(/\/$/, ''), gatewayToken: body.gatewayToken, networkToken: body.networkToken } satisfies Connection
}

function sleep({ ms, signal }: { ms: number; signal: AbortSignal }) {
  return new Promise<GrokBotAbortError | void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(new GrokBotAbortError({ cause: signal.reason }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function headers(connection: Connection) {
  return {
    authorization: `Bearer ${connection.gatewayToken}`,
    ...(connection.networkToken ? { 'x-anyrun-network-token': connection.networkToken } : {}),
    'x-sand-slim-avatars': '1',
  }
}

// One client per account: it keeps the gateway route until the box rejects it.
type ConnectResult = Connection | GrokBotAuthError | GrokBotGatewayError | GrokBotAbortError

export function createGrokBotClient({ token }: { token: TokenSource }) {
  let current: Promise<ConnectResult> | undefined

  async function wakeUp({ signal }: { signal: AbortSignal }): Promise<ConnectResult> {
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt++) {
      const connection = await ensureSandbox({ token, wake: true, signal })
      if (connection instanceof Error) return connection
      if (connection) return connection
      const slept = await sleep({ ms: WAKE_RETRY_MS, signal })
      if (slept instanceof Error) return slept
    }
    return new GrokBotGatewayError({ method: 'EnsureSandBox', reason: 'the cloud computer did not wake up. Open the Grok Bot app and try again' })
  }

  function connect({ signal, stale }: { signal: AbortSignal; stale?: Connection }): Promise<ConnectResult> {
    // Reuse the shared route unless the caller saw it fail.
    const reuse = current
    if (reuse) {
      return reuse.then((connection) => {
        if (connection instanceof Error || connection === stale) {
          if (current === reuse) current = undefined
          return connect({ signal })
        }
        return connection
      })
    }
    const next = wakeUp({ signal })
    current = next
    return next
  }

  async function call<T>({ method, body, signal }: { method: string; body: object; signal: AbortSignal }): Promise<T | GrokBotAuthError | GrokBotGatewayError | GrokBotAbortError> {
    // sendPrompt is not idempotent: only retry it when the box refused it before reading it.
    let stale: Connection | undefined
    for (let attempt = 0; ; attempt++) {
      const connection = await connect({ signal, stale })
      if (connection instanceof Error) return connection
      const response = await fetch(`${connection.gatewayUrl}/api/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: { 'content-type': 'application/json', ...headers(connection) },
        body: JSON.stringify(body),
      }).catch((cause) => new GrokBotGatewayError({ method, reason: 'request failed', cause }))
      if (signal.aborted) return new GrokBotAbortError({ cause: signal.reason })
      if (response instanceof Error) return response
      const text = await response.text().catch(() => '')
      const rejected = response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN || response.status === HTTP_BOX_ASLEEP
      if (rejected && attempt < 2) {
        stale = connection
        continue
      }
      // The box proxy answers 502 while the host on the box restarts; nothing read the request.
      const starting = response.status === HTTP_BAD_GATEWAY && text.includes('nothing is listening')
      if (starting && attempt < WAKE_ATTEMPTS) {
        const slept = await sleep({ ms: WAKE_RETRY_MS, signal })
        if (slept instanceof Error) return slept
        continue
      }
      if (!response.ok) return new GrokBotGatewayError({ method, reason: `HTTP ${response.status} ${text.slice(0, 300)}` })
      if (!text.trim()) return null as T
      const parsed = errore.try(() => JSON.parse(text) as T)
      if (parsed instanceof Error) return new GrokBotGatewayError({ method, reason: 'response is not JSON', cause: parsed })
      return parsed
    }
  }

  // Yields gateway events until the signal aborts or the stream ends (the caller reconnects).
  async function* events({ signal }: { signal: AbortSignal }): AsyncGenerator<GatewayEvent, GrokBotAuthError | GrokBotGatewayError | GrokBotAbortError | null> {
    const connection = await connect({ signal })
    if (connection instanceof Error) return connection
    const response = await fetch(`${connection.gatewayUrl}/events`, {
      redirect: 'error',
      signal,
      headers: { accept: 'text/event-stream', ...headers(connection) },
    }).catch((cause) => new GrokBotGatewayError({ method: 'events', reason: 'request failed', cause }))
    if (signal.aborted) return new GrokBotAbortError({ cause: signal.reason })
    if (response instanceof Error) return response
    if (!response.ok || !response.body) return new GrokBotGatewayError({ method: 'events', reason: `HTTP ${response.status}` })
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let data: string[] = []
    while (true) {
      const chunk = await reader.read().catch((cause) => new GrokBotGatewayError({ method: 'events', reason: 'stream failed', cause }))
      if (signal.aborted) return new GrokBotAbortError({ cause: signal.reason })
      if (chunk instanceof Error) return chunk
      if (chunk.done) return null
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (line.startsWith('data:')) {
          data.push(line.slice('data:'.length).replace(/^ /, ''))
          continue
        }
        if (line !== '' || data.length === 0) continue
        const event = errore.try(() => JSON.parse(data.join('\n')) as GatewayEvent)
        data = []
        if (event instanceof Error || typeof event?.channel !== 'string') continue
        yield event
      }
    }
  }

  return { call, events }
}

export type GrokBotClient = ReturnType<typeof createGrokBotClient>

// Creates a bot without the first-run greeting, so it only speaks when prompted.
export async function createAgent({ client, name, signal }: { client: GrokBotClient; name: string; signal: AbortSignal }) {
  const created = await client.call<{ agent?: { id?: string }; agentId?: string; id?: string } | null>({
    method: 'createAgent',
    body: { name, description: '', origin: 'user', isIntroductionSuppressed: true },
    signal,
  })
  if (created instanceof Error) return created
  const id = created?.agent?.id ?? created?.agentId ?? created?.id
  if (!id) return new GrokBotGatewayError({ method: 'createAgent', reason: 'the response has no bot ID' })
  return id
}

export async function listAgents({ client, signal }: { client: GrokBotClient; signal: AbortSignal }) {
  const result = await client.call<Agent[] | { agents?: Agent[] }>({ method: 'listAgents', body: {}, signal })
  if (result instanceof Error) return result
  return Array.isArray(result) ? result : (result?.agents ?? [])
}
