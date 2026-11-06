// Grok Bot client: logins and the GrokBotService API of the Cursor backend.
//
// Grok Bot has no public API. The protocol comes from the desktop app (Electron, the
// GrokBotService client in dist/electron-main/main-app.cjs and proto.cjs) and from
// github.com/ScriptedAlchemy/grok-bot-cli and github.com/JiminLee-way/GrokBotCLI.
// A Grok Bot account is a Cursor account:
//
//   account login: cursor.com/loginDeepControl (PKCE) ──▶ poll api2.cursor.sh/auth/poll ──▶ tokens
//   desktop login: sand-secrets.json ──(Keychain "Grok Bot Safe Storage")──▶ access token
//   POST api2.cursor.sh/aiserver.v1.GrokBotService/<Method>   Connect JSON calls
//
// Bots run on the server ("temporal" harness), so every call goes to the backend. The cloud
// box gateway (EnsureSandBox ──▶ {gateway}/api/sendPrompt) refuses user actions since Nov 2026
// with HTTP 502 "A Sand box session is not permitted on this endpoint", and its transcript no
// longer shows new turns. Desktop app 0.78.4 sends prompts with SendGrokBotUserMessage too.
//
// Enums use their full proto names in JSON. Unknown fields make the backend reject a request.
// The desktop app refreshes its access token itself, so every call reads the file again.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as errore from 'errore'
import type { Bot } from './bots.ts'
import type { CardAnswer, Entry } from './transcript.ts'

const execFileAsync = promisify(execFile)

const BACKEND_URL = 'https://api2.cursor.sh'
const WEBSITE_URL = 'https://cursor.com'
// Cursor's public OAuth client for its own CLIs and the Grok Bot app.
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const LOGIN_POLL_MAX_MS = 5_000
const LOGIN_TIMEOUT_MS = 12 * 60_000
const GROK_BOT_SERVICE_PATH = '/aiserver.v1.GrokBotService'
const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const DOWNLOAD_HASH_CHARS = 8
// Files a bot sends are content-addressed copies in its data folder, e.g.
// file:///home/box/agent-data/agents/<agent>/assets/<sha256-like hex>.csv (see T9e in the app's main-app.cjs).
const BOT_FILE_URL = /^file:\/\/\/home\/box\/(?:agent-data|sand-data)\/agents\/[^/]+\/[^/]+\/([0-9a-f]{64})\.[0-9a-z]{1,16}$/
const KEYCHAIN_SERVICE = 'Grok Bot Safe Storage'
// macOS shows an "allow access" dialog the first time; give the user time to answer it.
const KEYCHAIN_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 30_000
// Electron safeStorage on macOS: "v10" prefix, AES-128-CBC, PBKDF2-SHA1 with 1003 rounds.
const SAFE_STORAGE_PREFIX = 'v10'
const SAFE_STORAGE_ROUNDS = 1003
const SAFE_STORAGE_KEY_BYTES = 16
const HTTP_UNAUTHORIZED = 401
const APP_NAME = 'Grok Bot'
// The backend refuses client versions it considers outdated; used when the app is not installed.
const FALLBACK_CLIENT_VERSION = '0.78.4'

export class GrokBotAuthError extends errore.createTaggedError({
  name: 'GrokBotAuthError',
  message: 'Grok Bot login unavailable: $reason. Connect a Grok Bot account again with /connect.',
}) {}

export class GrokBotRequestError extends errore.createTaggedError({
  name: 'GrokBotRequestError',
  message: 'Grok Bot $method failed: $reason',
}) {}

export class GrokBotDownloadError extends errore.createTaggedError({
  name: 'GrokBotDownloadError',
  message: 'Could not save $file: $reason',
}) {}

export class GrokBotAbortError extends errore.createTaggedError({
  name: 'GrokBotAbortError',
  message: 'Grok Bot request aborted',
  extends: errore.AbortError,
}) {}

// What a bot is doing now (GrokBotAgentLiveState).
export type LiveState = {
  isRunning: boolean
  activity?: { kind?: string; tool?: string; detail?: string } | null
  // Set while the bot waits for the user, e.g. on a card.
  awaiting?: unknown
  // The turn that settled last; `turnId` is the `requestId` of the turn's entries.
  lastTurnSettlement?: { turnId?: string; outcome?: string; settledAtMs?: number } | null
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

// Connect errors answer `{ code, message }`.
function errorReason({ status, text }: { status: number; text: string }) {
  const body = errore.try(() => JSON.parse(text) as { code?: string; message?: string })
  const detail = body instanceof Error ? text.slice(0, 300) : [body.code, body.message].filter(Boolean).join(': ')
  return `HTTP ${status} ${detail}`.trim()
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

export function createGrokBotClient({ token }: { token: TokenSource }) {
  // One Connect JSON call to GrokBotService.
  async function call<T>({ method, body, signal }: { method: string; body: object; signal: AbortSignal }): Promise<T | GrokBotAuthError | GrokBotRequestError | GrokBotAbortError> {
    const login = await token({ signal })
    if (login instanceof Error) return login
    const response = await fetch(`${BACKEND_URL}${GROK_BOT_SERVICE_PATH}/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `Bearer ${login.accessToken}`,
        'x-cursor-client-type': 'sand',
        'x-cursor-client-version': appVersion() ?? FALLBACK_CLIENT_VERSION,
        'x-sand-box-namespace': 'prod',
        // The app sends the device time zone with prompts.
        'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(login.teamId ? { 'x-cursor-team-id': login.teamId } : {}),
      },
      body: JSON.stringify(body),
    }).catch((cause) => new GrokBotRequestError({ method, reason: 'request failed', cause }))
    if (signal.aborted) return new GrokBotAbortError({ cause: signal.reason })
    if (response instanceof Error) return response
    const text = await response.text().catch(() => '')
    if (response.status === HTTP_UNAUTHORIZED) return new GrokBotAuthError({ reason: 'the login expired' })
    if (!response.ok) return new GrokBotRequestError({ method, reason: errorReason({ status: response.status, text }) })
    const parsed = errore.try(() => JSON.parse(text) as T)
    if (parsed instanceof Error) return new GrokBotRequestError({ method, reason: 'response is not JSON', cause: parsed })
    return parsed
  }

  // Reads a bot file from the account storage, so it works while the box sleeps. An existing
  // `file` is kept: the folder name comes from the content hash.
  async function download({ url, file, signal }: { url: string; file: string; signal: AbortSignal }) {
    if (fs.existsSync(file)) return null
    const part = `${file}.${crypto.randomUUID()}.part`
    const opened = await fs.promises
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.open(part, 'w'))
      .catch((cause) => new GrokBotDownloadError({ file, reason: 'cannot write it', cause }))
    if (opened instanceof Error) return opened
    const copied = await (async () => {
      for (let offset = 0; ; ) {
        const chunk = await call<{ data?: string; totalSize?: string }>({
          method: 'ReadGrokBotAgentAttachmentChunk',
          body: { path: url, offset: String(offset), length: DOWNLOAD_CHUNK_BYTES },
          signal,
        })
        if (chunk instanceof Error) return chunk
        const bytes = Buffer.from(chunk.data ?? '', 'base64')
        const written = await opened.write(bytes).catch((cause) => new GrokBotDownloadError({ file, reason: 'cannot write it', cause }))
        if (written instanceof Error) return written
        offset += bytes.length
        const total = Number(chunk.totalSize ?? 0)
        if (offset >= total) return null
        if (bytes.length === 0) return new GrokBotDownloadError({ file, reason: `the bot storage returned ${offset} of ${total} bytes` })
      }
    })()
    await opened.close().catch(() => undefined)
    const done = copied ?? (await fs.promises.rename(part, file).catch((cause) => new GrokBotDownloadError({ file, reason: 'cannot write it', cause })))
    if (done instanceof Error) await fs.promises.rm(part, { force: true }).catch(() => undefined)
    return done ?? null
  }

  return { call, download }
}

// Where a file the bot sent is saved on this computer, or null for URLs that are not bot files.
export function downloadPath({ url, name }: { url: string; name: string }) {
  const hash = BOT_FILE_URL.exec(url)?.[1]
  if (!hash) return null
  const dir = process.env.GROK_BOT_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'grok-bot')
  const base = path.basename(name.replaceAll('\\', '/')).replaceAll('\0', '')
  const file = base && base !== '.' && base !== '..' ? base : path.basename(new URL(url).pathname)
  return path.join(dir, hash.slice(0, DOWNLOAD_HASH_CHARS), file)
}

export type GrokBotClient = ReturnType<typeof createGrokBotClient>

// Bot IDs are the UUID `agentId`, not the numeric `id` of GrokBotAgent.
type ServerAgent = { agentId?: string; name?: string; kind?: string; createdAtMs?: string }
const AGENT_KIND_ROOM = 'GROK_BOT_AGENT_KIND_ROOM'

export async function listAgents({ client, signal }: { client: GrokBotClient; signal: AbortSignal }) {
  const result = await client.call<{ agents?: ServerAgent[] }>({ method: 'ListGrokBotAgents', body: {}, signal })
  if (result instanceof Error) return result
  return (result.agents ?? []).flatMap((agent): Bot[] => {
    if (!agent.agentId || !agent.name) return []
    return [{ id: agent.agentId, name: agent.name, isGroup: agent.kind === AGENT_KIND_ROOM, createdAt: agent.createdAtMs ? Number(agent.createdAtMs) : undefined }]
  })
}

// Creates a bot without the first-run greeting, so it only speaks when prompted.
export async function createAgent({ client, name, description = '', signal }: { client: GrokBotClient; name: string; description?: string; signal: AbortSignal }) {
  const method = 'CreateGrokBotTemporalAgent'
  const agentId = crypto.randomUUID()
  const created = await client.call<{ agent?: ServerAgent }>({
    method,
    body: { agentId, name, description, title: '', avatarShape: '', avatarColor: '', harness: 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL', introductionSuppressed: true },
    signal,
  })
  if (created instanceof Error) return created
  if (created.agent?.agentId !== agentId) return new GrokBotRequestError({ method, reason: 'the server did not confirm the new bot' })
  return agentId
}

type Refusal = { failureCode?: string; message?: string }

function refused({ method, refusal }: { method: string; refusal: Refusal }) {
  return new GrokBotRequestError({ method, reason: refusal.message || refusal.failureCode || 'the bot refused it' })
}

const DELIVERED = new Set(['GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX', 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL', 'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE'])

// `messageId` becomes the `clientNonce` of the prompt entry. Sending the same ID again is a
// duplicate, never a second prompt.
export async function sendMessage({ client, agentId, text, messageId, signal }: { client: GrokBotClient; agentId: string; text: string; messageId: string; signal: AbortSignal }) {
  const method = 'SendGrokBotUserMessage'
  const now = String(Date.now())
  const sent = await client.call<{ delivery?: string; refusal?: Refusal }>({
    method,
    body: {
      agentId,
      messageId,
      text,
      sentAtMs: now,
      composedAtMs: now,
      source: 'GROK_BOT_CLIENT_SURFACE_DESKTOP',
      initiator: 'GROK_BOT_USER_MESSAGE_INITIATOR_USER',
      sendSource: 'GROK_BOT_SEND_SOURCE_CHAT',
    },
    signal,
  })
  if (sent instanceof Error) return sent
  if (sent.delivery && DELIVERED.has(sent.delivery)) return null
  return refused({ method, refusal: sent.refusal ?? { message: `the message was not delivered (${sent.delivery ?? 'no delivery status'})` } })
}

// A reply to a card (see cardAnswer in transcript.ts).
export async function answerCard({ client, answer, signal }: { client: GrokBotClient; answer: CardAnswer; signal: AbortSignal }) {
  const result = await client.call<{ refusal?: Refusal }>({ method: answer.method, body: answer.body, signal })
  if (result instanceof Error) return result
  return result.refusal ? refused({ method: answer.method, refusal: result.refusal }) : null
}

export async function interruptRun({ client, agentId, signal }: { client: GrokBotClient; agentId: string; signal: AbortSignal }) {
  const result = await client.call({ method: 'InterruptGrokBotAgentRun', body: { agentId, reason: 'user_interrupt' }, signal })
  return result instanceof Error ? result : null
}

// Each row's body is the entry JSON the app renders; `seq` is the row's place in the chat.
type TranscriptRow = { seq?: string; body?: string; bodyOmitted?: boolean }

// The newest transcript entries, oldest first.
export async function transcriptTail({ client, agentId, limit, signal }: { client: GrokBotClient; agentId: string; limit: number; signal: AbortSignal }) {
  const page = await client.call<{ entries?: TranscriptRow[] }>({ method: 'ListGrokBotTranscriptEntries', body: { agentId, limit }, signal })
  if (page instanceof Error) return page
  const entries = (page.entries ?? []).flatMap((row): Entry[] => {
    // TODO: rows with `bodyOmitted` only carry a blob hash; read the blob once its RPC is known.
    if (!row.body) return []
    const entry = errore.try(() => JSON.parse(Buffer.from(row.body ?? '', 'base64').toString('utf8')) as Entry)
    if (entry instanceof Error || typeof entry?.id !== 'string') return []
    return [{ ...entry, seq: Number(row.seq) }]
  })
  return entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

type ServerLiveState = {
  isRunning?: boolean
  isComposingMessage?: boolean
  activity?: LiveState['activity']
  awaiting?: unknown
  lastTurnSettlement?: { turnId?: string; outcome?: string; settledAtMs?: string }
}

export async function agentState({ client, agentId, signal }: { client: GrokBotClient; agentId: string; signal: AbortSignal }) {
  const result = await client.call<{ statuses?: Array<{ agentId?: string; isRunning?: boolean; live?: ServerLiveState }> }>({
    method: 'ListGrokBotAgentStatuses',
    body: { agentIds: [agentId] },
    signal,
  })
  if (result instanceof Error) return result
  const status = result.statuses?.find((candidate) => candidate.agentId === agentId)
  const live = status?.live
  const settlement = live?.lastTurnSettlement
  return {
    isRunning: status?.isRunning === true || live?.isRunning === true || live?.isComposingMessage === true,
    activity: live?.activity ?? null,
    awaiting: live?.awaiting,
    lastTurnSettlement: settlement ? { turnId: settlement.turnId, outcome: settlement.outcome, settledAtMs: Number(settlement.settledAtMs ?? 0) } : null,
  } satisfies LiveState
}
