// Connection to the user's OpenCode V2 service (spec 28.2). Kimaki never
// spawns OpenCode itself: it discovers the service registration file, or asks
// Service.ensure() to start `<bin> serve --service` without a version pin
// (a version pin would replace a running server and kill TUI sessions).
//
// Service.ensure() defaults to `opencode` from PATH. While V2 is in beta it
// installs as `opencode2` and `opencode` is usually V1, which prints help for
// `serve --service` and exits. So the binary is resolved first: the first of
// `opencode2`, `opencode` on PATH whose `--version` is a supported V2.
// TODO: drop the lookup and use the Service.ensure() default once V2 ships as `opencode`.
//
// watchOpencode() owns the single /api/event subscription and implements the
// mini TUI connect protocol (stream-v2.transport.ts connect()):
//
//   loop:
//     resolve endpoint (re-read registration: port/password change on restart)
//     subscribe, first event must be server.connected
//     hold live events while onConnect() hydrates
//     deliver held events, then go live
//   on error: backoff 0.5s -> 30s, retry

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { OpenCode, type OpenCodeClient, type V2Event } from '@opencode/client'
import { Service } from '@opencode/client/service'
import * as errore from 'errore'

import { ConfigError, OpenCodeError, OpenCodeUnavailableError, OpenCodeVersionError } from './errors.ts'
import { createLogger } from './logger.ts'

export type { OpenCodeClient, V2Event }

const logger = createLogger('OPENCODE')

export const MIN_OPENCODE_VERSION = '2.0.19'

function parseVersion(version: string): number[] {
  return version
    .split('-')[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

// Dev builds report 0.0.0-dev-<n> and are always accepted.
export function isSupportedVersion(version: string): boolean {
  if (version.startsWith('0.0.0-')) return true
  const current = parseVersion(version)
  const minimum = parseVersion(MIN_OPENCODE_VERSION)
  for (let index = 0; index < 3; index++) {
    const a = current[index] ?? 0
    const b = minimum[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

const execFileAsync = promisify(execFile)

function errorText(error: Error): string {
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error.message}${cause}`
}

const BINARY_CANDIDATES = ['opencode2', 'opencode']

// "opencode v2.0.19" -> "2.0.19"
export function parseVersionOutput(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1] ?? null
}

export async function resolveOpencodeBinary(): Promise<OpenCodeUnavailableError | string> {
  const found: string[] = []
  for (const candidate of BINARY_CANDIDATES) {
    const result = await execFileAsync(candidate, ['--version'], { timeout: 10_000 }).catch(() => null)
    const version = result ? parseVersionOutput(result.stdout) : null
    if (!version) continue
    if (isSupportedVersion(version)) return candidate
    found.push(`${candidate} ${version}`)
  }
  const seen = found.length > 0 ? `found ${found.join(', ')}` : 'no opencode binary on PATH'
  return new OpenCodeUnavailableError({ reason: `no OpenCode >= ${MIN_OPENCODE_VERSION}: ${seen}` })
}

// Kimaki plugin registration. OpenCode auto-loads every entry of
// `<config dir>/plugins/` (packages/core/src/plugin/source-directory.ts); a
// folder entry resolves `server`, then `index` (Host.resolve). So the bot
// writes `plugins/kimaki/index.js`, which re-exports the plugin of the
// running Kimaki install. No opencode.json edit and no consent: the plugin
// only acts on sessions with metadata.kimaki.
//
// The plugins folder is watched and any change reloads every location, which
// cancels pending forms and permissions everywhere. So the shim is written
// only when its content differs (first start, or another Kimaki install).

// Same rule as OpenCode's global config dir (packages/util/src/global-roots.ts).
export function opencodeConfigDir(): string {
  const explicit = process.env['OPENCODE_CONFIG_DIR']
  if (explicit) return path.resolve(explicit)
  const xdg = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config')
  return path.join(xdg, 'opencode')
}

// Shim folder under plugins/ -> module in src/plugin/ (dist/plugin/ when built).
// `kimaki` acts only on marked sessions; `kimaki-anthropic` is provider auth for every session.
const PLUGIN_SHIMS = [
  { name: 'kimaki', module: 'index' },
  { name: 'kimaki-anthropic', module: 'anthropic' },
] as const

export function kimakiPluginEntry(module: string = 'index'): string {
  const self = fileURLToPath(import.meta.url)
  return path.join(path.dirname(self), 'plugin', `${module}${path.extname(self)}`)
}

export function pluginShimSource({ entry }: { entry: string }): string {
  return `// Generated by Kimaki on bot start. Loads the plugin of the running Kimaki install.\nexport { default } from ${JSON.stringify(pathToFileURL(entry).href)}\n`
}

async function installShim({ configDir, name, entry }: { configDir: string; name: string; entry: string }) {
  const directory = path.join(configDir, 'plugins', name)
  const file = path.join(directory, 'index.js')
  const source = pluginShimSource({ entry })
  const names = await fs.promises.readdir(directory).catch((): string[] => [])
  const current = await fs.promises.readFile(file, 'utf8').catch(() => null)
  // Any other file (server.*, index.ts, package.json of an older layout)
  // could win the entry resolution over index.js.
  const extra = names.filter((child) => child !== 'index.js')
  if (current === source && extra.length === 0) return { file, written: false }
  const written = await (async () => {
    await fs.promises.mkdir(directory, { recursive: true })
    for (const child of extra) await fs.promises.rm(path.join(directory, child), { recursive: true, force: true })
    await fs.promises.writeFile(file, source)
  })().catch((cause) => new ConfigError({ reason: `Cannot write the Kimaki OpenCode plugin to ${file}. Check permissions of ${configDir}`, cause }))
  if (written instanceof Error) return written
  logger.log(`installed OpenCode plugin shim ${file} -> ${entry}`)
  return { file, written: true }
}

export async function installPluginShim({ configDir }: { configDir: string }): Promise<ConfigError | { written: boolean }> {
  const results = await Promise.all(PLUGIN_SHIMS.map((shim) => installShim({ configDir, name: shim.name, entry: kimakiPluginEntry(shim.module) })))
  const failed = results.find((result) => result instanceof Error)
  if (failed instanceof Error) return failed
  return { written: results.some((result) => !(result instanceof Error) && result.written) }
}

export type OpencodeEndpoint = {
  client: OpenCodeClient
  url: string
  version: string
}

export async function resolveOpencode({
  serviceFile,
  ensure,
}: {
  serviceFile?: string
  ensure: boolean
}): Promise<OpenCodeUnavailableError | OpenCodeVersionError | OpenCodeError | OpencodeEndpoint> {
  const discovered = await Service.discover({ file: serviceFile }).catch(
    (e) => new OpenCodeUnavailableError({ reason: 'discover failed', cause: e }),
  )
  if (discovered instanceof Error) return discovered
  const endpoint = await (async () => {
    if (discovered) return discovered
    if (!ensure) return new OpenCodeUnavailableError({ reason: 'no running service' })
    const binary = await resolveOpencodeBinary()
    if (binary instanceof Error) return binary
    logger.log(`no OpenCode service found, starting \`${binary} serve --service --hostname 127.0.0.1\``)
    return Service.ensure({ file: serviceFile, command: [binary, 'serve', '--service', '--hostname', '127.0.0.1'] }).catch(
      (e) => new OpenCodeUnavailableError({ reason: `${binary} serve --service failed: ${errorText(e)}`, cause: e }),
    )
  })()
  if (endpoint instanceof Error) return endpoint

  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const info = await client.server
    .info({ signal: AbortSignal.timeout(5_000) })
    .catch((e) => new OpenCodeError({ operation: 'server.info', cause: e }))
  if (info instanceof Error) return info
  if (!isSupportedVersion(info.version)) {
    return new OpenCodeVersionError({ version: info.version, minimum: MIN_OPENCODE_VERSION })
  }
  return { client, url: endpoint.url, version: info.version }
}

export type ConnectContext = {
  client: OpenCodeClient
  reconnect: boolean
  signal: AbortSignal
}

export type OpencodeConnection = {
  readonly connected: boolean
  readonly endpoint: OpencodeEndpoint | null
  // Resolves on the first successful connect, or with the fatal error.
  readonly ready: Promise<Error | OpencodeEndpoint>
  // Live events after hydration, in addition to the onEvent callback. Returns the unsubscribe.
  subscribe: (listener: (event: V2Event) => void) => () => void
  stop: () => void
}

class StreamClosedError extends errore.createTaggedError({
  name: 'StreamClosedError',
  message: 'OpenCode event stream closed: $reason',
}) {}

async function nextEvent(iterator: AsyncIterator<V2Event>) {
  return iterator.next().catch((e) => new StreamClosedError({ reason: 'read failed', cause: e }))
}

export function watchOpencode({
  serviceFile,
  ensure,
  onConnect,
  onEvent,
  onDisconnect,
}: {
  serviceFile?: string
  ensure: boolean
  // Awaited while live events are held (hydration). Return an Error to retry.
  onConnect: (context: ConnectContext) => Promise<Error | void>
  onEvent: (event: V2Event) => void
  onDisconnect: () => void
}): OpencodeConnection {
  const controller = new AbortController()
  const state: { connected: boolean; endpoint: OpencodeEndpoint | null } = { connected: false, endpoint: null }
  const readyDeferred = Promise.withResolvers<Error | OpencodeEndpoint>()
  const listeners = new Set<(event: V2Event) => void>()
  const emit = (event: V2Event) => {
    onEvent(event)
    for (const listener of listeners) listener(event)
  }

  // One subscription attempt. Its signal aborts on stop() and when the attempt
  // ends, so a stale hydration can never publish into a newer connection.
  async function runAttempt({ endpoint, reconnect }: { endpoint: OpencodeEndpoint; reconnect: boolean }) {
    const attempt = new AbortController()
    const signal = AbortSignal.any([controller.signal, attempt.signal])
    const iterator = endpoint.client.event.subscribe({ signal })[Symbol.asyncIterator]()
    const hydrating = { started: false }
    const result = await (async () => {
      const first = await nextEvent(iterator)
      if (first instanceof Error) return first
      if (first.done || first.value.type !== 'server.connected') {
        return new StreamClosedError({ reason: 'first event was not server.connected' })
      }
      const held: V2Event[] = []
      const phase = { booting: true }
      const consume = (async (): Promise<Error> => {
        while (true) {
          const next = await nextEvent(iterator)
          if (next instanceof Error) return next
          if (next.done) return new StreamClosedError({ reason: 'stream ended' })
          if (signal.aborted) return new StreamClosedError({ reason: 'stopped' })
          if (phase.booting) {
            held.push(next.value)
            continue
          }
          emit(next.value)
        }
      })()
      hydrating.started = true
      const hydrated = await Promise.race([onConnect({ client: endpoint.client, reconnect, signal }), consume])
      if (hydrated instanceof Error) return hydrated
      if (signal.aborted) return new StreamClosedError({ reason: 'stopped' })
      for (const event of held.splice(0)) {
        emit(event)
      }
      phase.booting = false
      state.connected = true
      state.endpoint = endpoint
      readyDeferred.resolve(endpoint)
      logger.log(`connected to OpenCode ${endpoint.version} at ${endpoint.url}`)
      return consume
    })()
    attempt.abort()
    void iterator.return?.(undefined).catch(() => {})
    state.connected = false
    // Hydration may have published the client before failing: always undo it.
    if (hydrating.started) onDisconnect()
    return result
  }

  void (async () => {
    const backoff = { ms: 500 }
    while (!controller.signal.aborted) {
      const endpoint = await resolveOpencode({ serviceFile, ensure })
      if (controller.signal.aborted) return
      // Wrong version, or no service at startup: fatal, the user must act.
      // After a first connect, failures are restarts and upgrades: retry.
      if (endpoint instanceof OpenCodeVersionError || (endpoint instanceof Error && state.endpoint === null)) {
        readyDeferred.resolve(endpoint)
        logger.error(endpoint.message)
        return
      }
      if (endpoint instanceof Error) logger.warn(`OpenCode not reachable: ${endpoint.message}`)
      if (!(endpoint instanceof Error)) {
        const result = await runAttempt({ endpoint, reconnect: state.endpoint !== null })
        if (controller.signal.aborted) return
        // This attempt connected: start the backoff over.
        if (state.endpoint === endpoint) backoff.ms = 500
        logger.warn(`event stream ended: ${result.message}`)
      }
      await sleep(backoff.ms, undefined, { signal: controller.signal }).catch(() => undefined)
      backoff.ms = Math.min(backoff.ms * 2, 30_000)
    }
  })()

  return {
    get connected() {
      return state.connected
    },
    get endpoint() {
      return state.endpoint
    },
    ready: readyDeferred.promise,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    stop: () => {
      controller.abort()
      readyDeferred.resolve(new OpenCodeUnavailableError({ reason: 'stopped' }))
    },
  }
}
