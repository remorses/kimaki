// Muse Code runtime: Meta account logins, `muse serve` hosts and Muse sessions.
//
// Muse Code has an official, versioned session protocol (MSP over stdio of `muse serve`) and
// an official SDK (github.com/meta-models/muse-code-sdk). The model call never leaves the
// `muse` binary: OpenCode only drives its sessions.
//
//   Meta device login: auth.meta.com/oidc/device (Muse's own client) ──▶ access token
//   POST api.meta.ai/muse-code/key ──▶ the account's Muse Code key (bills its subscription)
//   one `muse serve` per account, META_API_KEY=<key> ──▶ Muse sessions of every OpenCode session
//
// Muse keeps its sessions in one Muse home shared by all hosts, so a session can move to
// another account's host (fallback plugin) with `session/resume` and keep its history.
// Device-flow constants match the `muse` launcher and github.com/TheStreamCode/opencode-muse-auth.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as errore from 'errore'
import { MuseClient, readSessionDurability, spawnMspConnection, type Connection, type FoldedItem, type Session } from '@muse-code/sdk'
import type { ApprovalMode, ApprovalRequestParams, ModelCatalogEntry, ReasoningEffort, SessionReadResult, TurnCompletedParams, TurnInputPart } from '@muse-code/sdk/dist/src/msp.js'
import { createTurnConverter, isDone } from './items.ts'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

const CLIENT_ID = '1031625952748946'
const DEVICE_URL = 'https://auth.meta.com/oidc/device/authorization/'
const TOKEN_URL = 'https://auth.meta.com/oidc/device/token/'
const KEY_URL = 'https://api.meta.ai/muse-code/key'
const API_HEADERS = { Accept: 'application/json', 'x-api-version': '1.0.0' }
const REQUEST_TIMEOUT_MS = 25_000
const SLOW_DOWN_STEP_MS = 5_000
const DEFAULT_POLL_MS = 5_000
const SECOND_MS = 1_000
// `muse serve` stays up this long after its last turn, so the next prompt skips the start.
const HOST_IDLE_MS = 10 * 60_000
const STDERR_TAIL_CHARS = 2_000
const INTERRUPT_TIMEOUT_MS = 10_000
// A Muse session is loaded by one host at a time; moving it to another account's host waits for the release.
const LEAVE_ATTEMPTS = 20
const LEAVE_RETRY_MS = 250
// MSP wants a machine identifier: ^[a-z0-9_]+$.
const CLIENT_INFO = { name: 'opencode_muse_code', version: '0.0.0' }

export class MuseLoginError extends errore.createTaggedError({
  name: 'MuseLoginError',
  message: 'Muse Code login failed: $reason. Connect the Muse account again with /connect.',
}) {}

export class MuseStartError extends errore.createTaggedError({
  name: 'MuseStartError',
  message: '`muse serve` did not start: $reason. Install Muse Code with `curl -fsSL https://dev.meta.ai/install.sh | bash`, or set the plugin `bin` option.',
}) {}

export class MuseSessionError extends errore.createTaggedError({
  name: 'MuseSessionError',
  message: 'Muse $operation failed: $reason',
}) {}

export class MuseAbortError extends errore.createTaggedError({
  name: 'MuseAbortError',
  message: 'Muse turn aborted',
  extends: errore.AbortError,
}) {}

// --- Meta device login ---------------------------------------------------------------------

export type DeviceLogin = { deviceCode: string; userCode: string; url: string; intervalMs: number; expiresAt: number }
export type MuseKey = { apiKey: string; accountId: string; email: string | null }

function sleep({ ms, signal }: { ms: number; signal: AbortSignal }) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })
}

async function postJson({ url, body, headers, signal }: { url: string; body: string; headers: Record<string, string>; signal: AbortSignal }) {
  const response = await fetch(url, { method: 'POST', headers: { ...API_HEADERS, ...headers }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) }).catch(
    (cause) => new MuseLoginError({ reason: `request to ${url} failed`, cause }),
  )
  if (response instanceof Error) return response
  const text = await response.text().catch((cause) => new MuseLoginError({ reason: `reading ${url} failed`, cause }))
  if (text instanceof Error) return text
  const json = errore.try(
    () => JSON.parse(text) as Record<string, unknown>,
    (cause) => new MuseLoginError({ reason: `HTTP ${response.status} ${text.slice(0, 200)}`, cause }),
  )
  if (json instanceof Error) return json
  return { status: response.status, ok: response.ok, json }
}

function form(params: Record<string, string>) {
  return { body: new URLSearchParams(params).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
}

export async function startLogin({ signal }: { signal: AbortSignal }) {
  const response = await postJson({ url: DEVICE_URL, ...form({ client_id: CLIENT_ID }), signal })
  if (response instanceof Error) return response
  const { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in } = response.json
  if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
    return new MuseLoginError({ reason: `the device authorization answered HTTP ${response.status} without a code` })
  }
  const url = typeof verification_uri_complete === 'string' && verification_uri_complete ? verification_uri_complete : verification_uri
  const intervalMs = typeof interval === 'number' ? interval * SECOND_MS : DEFAULT_POLL_MS
  const expiresAt = Date.now() + (typeof expires_in === 'number' ? expires_in : 600) * SECOND_MS
  return { deviceCode: device_code, userCode: user_code, url, intervalMs, expiresAt } satisfies DeviceLogin
}

// Waits until the user approves the code, then returns the Meta access token.
export async function pollLogin({ login, signal }: { login: DeviceLogin; signal: AbortSignal }) {
  let intervalMs = login.intervalMs
  while (Date.now() < login.expiresAt) {
    await sleep({ ms: intervalMs, signal })
    if (signal.aborted) return new MuseLoginError({ reason: 'the login was cancelled', cause: signal.reason })
    const response = await postJson({
      url: TOKEN_URL,
      ...form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: login.deviceCode }),
      signal,
    })
    // A network blip is not a verdict: keep polling until the code expires.
    if (response instanceof Error) continue
    const { access_token, error } = response.json
    if (typeof access_token === 'string' && access_token) return access_token
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_MS
      continue
    }
    if (typeof error === 'string') return new MuseLoginError({ reason: error })
  }
  return new MuseLoginError({ reason: 'the code expired before it was approved' })
}

// The account's Muse Code key. The subscription applies to this key, and Meta allows it only in Muse Code.
export async function mintKey({ accessToken, signal }: { accessToken: string; signal: AbortSignal }) {
  const response = await postJson({ url: KEY_URL, body: JSON.stringify({ onboard: true }), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, signal })
  if (response instanceof Error) return response
  const { api_key, is_subs_active, require_payment, action_url, user_email, user_id } = response.json
  if (!response.ok) return new MuseLoginError({ reason: `the key exchange answered HTTP ${response.status}` })
  if (is_subs_active === false) return new MuseLoginError({ reason: 'this Meta account has no active Muse Code subscription' })
  if (typeof api_key !== 'string' || !api_key) {
    const action = typeof action_url === 'string' ? ` (${action_url})` : ''
    return new MuseLoginError({ reason: require_payment === true ? `this account needs a Muse Code subscription${action}` : 'the key response has no key' })
  }
  const email = typeof user_email === 'string' && user_email ? user_email.toLowerCase() : null
  const accountId = typeof user_id === 'string' || typeof user_id === 'number' ? String(user_id) : (email ?? '')
  if (!accountId) return new MuseLoginError({ reason: 'the key response names no account' })
  return { apiKey: api_key, accountId, email } satisfies MuseKey
}

// --- hosts and sessions ----------------------------------------------------------------------

// The `muse` launcher on PATH, else the installer's default location.
export function findMuse() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates = [...dirs.map((dir) => path.join(dir, 'muse')), path.join(os.homedir(), '.local', 'bin', 'muse')]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'muse'
}

export type HostOptions = {
  bin: string
  // `muse serve` flags fixed for the host's lifetime: provider, sandbox posture, workspace trust.
  args: readonly string[]
}

type OpenSession = { session: Session; model: string | null }

type Host = {
  connection: Connection
  client: MuseClient
  sessions: Map<string, OpenSession>
  running: number
  idle: ReturnType<typeof setTimeout> | null
  closed: boolean
}

export type ApproveHandler = (input: { sessionID: string; request: ApprovalRequestParams }) => Promise<boolean>

export type TurnRequest = {
  // OpenCode session ID: the key of the Muse session record.
  sessionID: string
  // `null` uses the `muse login` of the machine.
  apiKey: string | null
  model: string
  effort: ReasoningEffort | null
  approvalMode: ApprovalMode | null
  permissionProfile: string | null
  input: TurnInputPart[]
  // Sent before the input, only when the Muse session is new.
  preamble: string
  displayText: string
  emit: (part: LanguageModelV3StreamPart) => void
  signal: AbortSignal
}

export type SessionRecord = { museSessionId: string }

type Storage = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: SessionRecord) => Promise<void>
}

// Every Muse entry point of the plugin. One per plugin location; hosts are per account.
export function createMuseRuntime({ host: options, directory, storage, approve }: { host: HostOptions; directory: string; storage: Storage; approve: ApproveHandler }) {
  const hosts = new Map<string, Promise<Host | MuseStartError>>()

  const accountKey = (apiKey: string | null) => apiKey ?? 'muse-login'

  const spawnHost = async (apiKey: string | null): Promise<Host | MuseStartError> => {
    // Muse would send its telemetry with the key to our OTEL endpoint; it refuses, but noisily.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_')))
    const env = apiKey ? { ...inherited, META_API_KEY: apiKey } : inherited
    let stderr = ''
    const handshake = spawnMspConnection({
      command: options.bin,
      args: ['serve', ...options.args],
      env,
      onStderr: (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
      },
    })
    const spawned = await handshake.initialize({ clientInfo: CLIENT_INFO }).catch((cause) => new MuseStartError({ reason: stderr.trim() || String(cause), cause }))
    if (spawned instanceof Error) {
      await handshake.close().catch(() => undefined)
      return spawned
    }
    const host: Host = {
      connection: spawned.connection,
      client: new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned }),
      sessions: new Map(),
      running: 0,
      idle: null,
      closed: false,
    }
    void spawned.exited.then(() => {
      host.closed = true
      if (host.idle) clearTimeout(host.idle)
      void forget({ key: accountKey(apiKey), host })
    })
    return host
  }

  // Drops the account's entry only while it still holds this host, not a newer one.
  const forget = async ({ key, host }: { key: string; host: Host }) => {
    const current = hosts.get(key)
    if (current && (await current) === host && hosts.get(key) === current) hosts.delete(key)
  }

  const hostFor = async (apiKey: string | null): Promise<Host | MuseStartError> => {
    const key = accountKey(apiKey)
    const pending = hosts.get(key) ?? spawnHost(apiKey)
    hosts.set(key, pending)
    const host = await pending
    if (host instanceof Error) {
      if (hosts.get(key) === pending) hosts.delete(key)
      return host
    }
    // An idle close or an exit won the race: start a new host.
    if (host.closed) {
      await forget({ key, host })
      return hostFor(apiKey)
    }
    return host
  }

  const release = ({ host, apiKey }: { host: Host; apiKey: string | null }) => {
    host.running--
    if (host.running > 0 || host.closed) return
    host.idle = setTimeout(() => {
      host.closed = true
      void forget({ key: accountKey(apiKey), host })
      void host.client.close().catch((cause) => console.warn('[muse-code] closing muse serve failed', cause))
    }, HOST_IDLE_MS)
  }

  const onApproval = (sessionID: string) => async (request: ApprovalRequestParams) => {
    const allowed = await approve({ sessionID, request }).catch(() => false)
    const decisions = allowed ? ['approved'] : ['denied', 'abort']
    const choice = request.availableChoices.find((candidate) => decisions.includes(candidate.decision) && candidate.scope === 'once') ?? request.availableChoices.find((candidate) => decisions.includes(candidate.decision))
    // A request without a matching choice is left to the server's own default-deny.
    if (!choice) throw new Error(`no ${allowed ? 'approve' : 'deny'} choice offered`)
    return { choiceId: choice.choiceId }
  }

  // Releases the Muse session from the hosts of other accounts. True when one held it.
  const leaveOtherHosts = async ({ host, museSessionId }: { host: Host; museSessionId: string }) => {
    const others = await Promise.all(hosts.values())
    const holders = others.filter((other): other is Host => !(other instanceof Error) && other !== host && other.sessions.has(museSessionId))
    for (const holder of holders) {
      holder.sessions.delete(museSessionId)
      await holder.connection
        .command('session/leave', { sessionId: museSessionId, stop: true })
        .catch((cause) => console.warn('[muse-code] session leave failed', cause))
    }
    return holders.length > 0
  }

  // The Muse session of an OpenCode session on this host: open, resumed, or new.
  const sessionFor = async ({ host, request }: { host: Host; request: TurnRequest }) => {
    const recordKey = `session/${request.sessionID}`
    const record = await storage.get(recordKey).catch(() => undefined)
    const museSessionId = record && typeof record === 'object' && 'museSessionId' in record && typeof record.museSessionId === 'string' ? record.museSessionId : null
    const open = museSessionId ? host.sessions.get(museSessionId) : undefined
    if (open) {
      if (open.model === request.model) return { session: open.session, fresh: false }
      const changed = await host.connection
        .command('session/setModel', { sessionId: open.session.sessionId, model: { modelId: request.model } })
        .catch((cause) => new MuseSessionError({ operation: 'model change', reason: String(cause), cause }))
      if (changed instanceof Error) return changed
      open.model = request.model
      return { session: open.session, fresh: false }
    }
    const profile = request.permissionProfile ? { permissionProfile: request.permissionProfile } : {}
    if (museSessionId) {
      // Another host (account) or an earlier OpenCode run created it; Muse keeps it on disk.
      const left = await leaveOtherHosts({ host, museSessionId })
      const resume = () =>
        host.client
          .resumeSession({ sessionId: museSessionId, excludeItems: true, modelId: request.model, onApproval: onApproval(request.sessionID), ...profile })
          .catch((cause) => new MuseSessionError({ operation: 'session resume', reason: String(cause), cause }))
      const resumed = await (async () => {
        // `session/leave` releases the session asynchronously; until then the resume says "already in use".
        for (let attempt = 1; ; attempt++) {
          const result = await resume()
          if (!(result instanceof Error) || !left || attempt >= LEAVE_ATTEMPTS) return result
          await sleep({ ms: LEAVE_RETRY_MS, signal: request.signal })
        }
      })()
      if (!(resumed instanceof Error)) {
        host.sessions.set(resumed.sessionId, { session: resumed, model: request.model })
        return { session: resumed, fresh: false }
      }
      console.warn(`[muse-code] starting a new Muse session: ${resumed.message}`)
    }
    const started = await host.client
      .startSession({ workspaceRoot: directory, modelId: request.model, ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}), ...profile })
      .catch((cause) => new MuseSessionError({ operation: 'session start', reason: String(cause), cause }))
    if (started instanceof Error) return started
    started.onApproval(onApproval(request.sessionID))
    host.sessions.set(started.sessionId, { session: started, model: request.model })
    await storage.set(recordKey, { museSessionId: started.sessionId })
    return { session: started, fresh: true }
  }

  // The items of a subagent's session. Its events never reach the lead's turn, so read its log once.
  const childItems = async ({ host, sessionId }: { host: Host; sessionId: string }): Promise<readonly FoldedItem[]> => {
    const read = await host.connection
      .request('session/read', { sessionId, excludeItems: false })
      .catch((cause) => new MuseSessionError({ operation: 'subagent read', reason: String(cause), cause }))
    if (read instanceof Error) {
      console.warn(`[muse-code] ${read.message}`)
      return []
    }
    const history = (read as Partial<SessionReadResult>).history
    return history?.items ?? []
  }

  // One OpenCode step = one Muse turn. Resolves with the terminal record, or an error.
  const run = async (request: TurnRequest) => {
    if (request.signal.aborted) return new MuseAbortError({ cause: request.signal.reason })
    const host = await hostFor(request.apiKey)
    if (host instanceof Error) return host
    if (host.idle) clearTimeout(host.idle)
    host.idle = null
    host.running++
    const result = await runOnHost({ host, request })
    release({ host, apiKey: request.apiKey })
    return result
  }

  const runOnHost = async ({ host, request }: { host: Host; request: TurnRequest }) => {
    const opened = await sessionFor({ host, request })
    if (opened instanceof Error) return opened
    const { session, fresh } = opened
    // Starting the host and the session can take seconds; a turn stopped meanwhile must not run.
    if (request.signal.aborted) return new MuseAbortError({ cause: request.signal.reason })
    const input: TurnInputPart[] = fresh && request.preamble ? [{ type: 'text', text: request.preamble }, ...request.input] : request.input
    const turn = await session
      .sendUserTurn({ input, displayText: request.displayText, ...(request.effort ? { reasoningEffort: request.effort } : {}) })
      .catch((cause) => new MuseSessionError({ operation: 'turn start', reason: String(cause), cause }))
    if (turn instanceof Error) return turn

    const convert = createTurnConverter()
    const readChildren = new Set<string>()
    // Both iterators end when the turn settles, after their last buffered event.
    const pump = Promise.all([
      (async () => {
        for await (const item of turn.items()) {
          if (item.kind === 'subagent' && item.childSessionId && isDone(item) && !readChildren.has(item.itemId)) {
            readChildren.add(item.itemId)
            for (const part of convert.children(await childItems({ host, sessionId: item.childSessionId }))) request.emit(part)
          }
          for (const part of convert.item(item)) request.emit(part)
        }
      })(),
      (async () => {
        for await (const delta of turn.deltas()) for (const part of convert.delta(delta)) request.emit(part)
      })(),
    ]).catch((cause) => console.warn('[muse-code] reading the turn failed', cause))
    const aborted = new Promise<'aborted'>((resolve) => {
      if (request.signal.aborted) resolve('aborted')
      request.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const outcome = await Promise.race([turn.completed.catch((cause) => new MuseSessionError({ operation: 'turn', reason: String(cause), cause })), aborted])
    if (outcome === 'aborted') {
      // Stop Muse only when OpenCode stopped the turn, not when it finished.
      await host.connection
        .command('turn/interrupt', { sessionId: session.sessionId, turnId: turn.turnId }, { maxAttempts: 1 })
        .then(() => undefined, (cause) => console.warn('[muse-code] interrupt failed', cause))
      // Wait for the cancelled terminal, so the next turn does not queue behind this one.
      await Promise.race([turn.completed.catch(() => undefined), sleep({ ms: INTERRUPT_TIMEOUT_MS, signal: new AbortController().signal })])
      for (const part of convert.end()) request.emit(part)
      return new MuseAbortError({ cause: request.signal.reason })
    }
    await pump
    for (const part of convert.end()) request.emit(part)
    if (outcome instanceof Error) return outcome
    if (outcome.kind !== 'completed') return new MuseSessionError({ operation: 'turn', reason: `the turn ended without a terminal record (${outcome.kind})` })
    return outcome.params satisfies TurnCompletedParams
  }

  // The models the account can use. Empty while `muse` has no login.
  const models = async ({ apiKey }: { apiKey: string | null }) => {
    const host = await hostFor(apiKey)
    if (host instanceof Error) return host
    host.running++
    const listed = await host.connection
      .request('model/list', {})
      .catch((cause) => new MuseSessionError({ operation: 'model list', reason: String(cause), cause }))
    release({ host, apiKey })
    if (listed instanceof Error) return listed
    const rows = Array.isArray(listed.models) ? (listed.models as ModelCatalogEntry[]) : []
    return rows
  }

  const close = async () => {
    const all = await Promise.all(hosts.values())
    hosts.clear()
    await Promise.all(all.map((host) => (host instanceof Error ? undefined : host.client.close().catch(() => undefined))))
  }

  return { run, models, close }
}

export type MuseRuntime = ReturnType<typeof createMuseRuntime>
