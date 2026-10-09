// Connection to the user's OpenCode V2 service (spec 28.2). Kimaki never
// spawns OpenCode itself: it discovers the service registration file, or asks
// Service.ensure() to start `<bin> serve --service` without a version pin
// (a version pin would replace a running server and kill TUI sessions).
//
// Service.ensure() defaults to `opencode` from PATH. While V2 is in beta it
// installs as `opencode2` and `opencode` is usually V1, which prints help for
// `serve --service` and exits. So the binary is resolved first (findOpencodeBinary).
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
import { parse as parseJsonc } from 'jsonc-parser'

import { ConfigError, OpenCodeError, OpenCodeMissingError, OpenCodeUnavailableError, OpenCodeV1Error, OpenCodeVersionError } from './errors.ts'
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

// "opencode v2.0.19" -> "2.0.19"
export function parseVersionOutput(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1] ?? null
}

// The official V2 install script: puts `opencode` and an `opencode2` shim in
// ~/.opencode/bin and adds that folder to the shell config. Unix only.
export const OPENCODE_INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/v2/install | bash'

// Where OPENCODE_INSTALL_COMMAND puts the binary. Not on PATH until a new shell.
export function installedOpencodeBinary(): string {
  return path.join(os.homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
}

async function opencodeVersion(binary: string): Promise<string | null> {
  const result = await execFileAsync(binary, ['--version'], { timeout: 10_000 }).catch(() => null)
  return result ? parseVersionOutput(result.stdout) : null
}

// OPENCODE_PATH alone when set. Otherwise `opencode2` first (V2 while V1 still owns
// `opencode`), then `opencode`, then the install script location. The first
// binary that answers --version decides: an OpenCode 1 or an old V2 is an error,
// never a reason to install over it. null: no OpenCode at all.
export async function findOpencodeBinary({
  candidates = process.env['OPENCODE_PATH'] ? [process.env['OPENCODE_PATH']] : ['opencode2', 'opencode', installedOpencodeBinary()],
}: { candidates?: readonly string[] } = {}): Promise<OpenCodeV1Error | OpenCodeVersionError | string | null> {
  for (const binary of candidates) {
    const version = await opencodeVersion(binary)
    if (!version) continue
    if (isSupportedVersion(version)) return binary
    if ((parseVersion(version)[0] ?? 0) < 2) return new OpenCodeV1Error({ binary, version, install: OPENCODE_INSTALL_COMMAND })
    return new OpenCodeVersionError({ version, minimum: MIN_OPENCODE_VERSION })
  }
  return null
}

export async function resolveOpencodeBinary(): Promise<OpenCodeV1Error | OpenCodeVersionError | OpenCodeMissingError | string> {
  const binary = await findOpencodeBinary()
  return binary ?? new OpenCodeMissingError({ install: OPENCODE_INSTALL_COMMAND })
}

// Startup preflight, before Discord onboarding. 'missing': nothing runs and no
// binary exists, so the caller may install OpenCode 2.
export async function checkOpencode({ serviceFile }: { serviceFile?: string }): Promise<OpenCodeV1Error | OpenCodeVersionError | 'ready' | 'missing'> {
  const discovered = await Service.discover({ file: serviceFile }).catch(() => null)
  if (discovered) return 'ready'
  const binary = await findOpencodeBinary()
  if (binary === null) return 'missing'
  return binary instanceof Error ? binary : 'ready'
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

// Shim folder under plugins/ -> plugin directory under dist/plugin/, loaded
// through its index module. Always dist, also when the bot runs from src: OpenCode
// reloads the plugin when its files change, so a src target would reload half
// edited code on every save. dist only changes on `pnpm build`.
// `kimaki` acts only on marked sessions; `kimaki-anthropic` is provider auth for every session.
const PLUGIN_SHIMS = [
  { name: 'kimaki', directory: '' },
  { name: 'kimaki-anthropic', directory: 'anthropic' },
] as const

export function kimakiPluginEntry(directory: string = ''): string {
  // This module is <package>/src/opencode-server.ts or <package>/dist/opencode-server.js.
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  return path.join(root, 'dist', 'plugin', directory, 'index.js')
}

export function pluginShimSource({ entry }: { entry: string }): string {
  return `// Generated by Kimaki on bot start. Loads the plugin of the running Kimaki install.\nexport { default } from ${JSON.stringify(pathToFileURL(entry).href)}\n`
}

// Local plugin targets of the global opencode.json / opencode.jsonc, resolved
// like OpenCode does (config/plugin/source.ts scan): file:// URLs, paths
// relative to the config dir, absolute paths. npm names and `-id` removals are skipped.
async function configuredPluginTargets({ configDir }: { configDir: string }): Promise<string[]> {
  const files = await Promise.all(
    ['opencode.json', 'opencode.jsonc'].map(async (name) => {
      const text = await fs.promises.readFile(path.join(configDir, name), 'utf8').catch(() => null)
      if (text === null) return []
      // OpenCode reports an invalid config itself; nothing is configured here then.
      const config: unknown = parseJsonc(text, [], { allowTrailingComma: true })
      if (!config || typeof config !== 'object' || Array.isArray(config)) return []
      // `plugin` is the V1 key (string or [target, options]), `plugins` the V2 one (string or { package }).
      const entries: unknown[] = [Reflect.get(config, 'plugin'), Reflect.get(config, 'plugins')].flatMap((list) => (Array.isArray(list) ? list : []))
      return entries.flatMap((entry) => {
        const target: unknown = Array.isArray(entry) ? entry[0] : entry && typeof entry === 'object' ? Reflect.get(entry, 'package') : entry
        if (typeof target !== 'string' || target.startsWith('-')) return []
        if (target.startsWith('file://')) {
          const file = errore.try(() => fileURLToPath(target))
          return file instanceof Error ? [] : [file]
        }
        if (target.startsWith('./') || target.startsWith('../')) return [path.resolve(configDir, target)]
        return path.isAbsolute(target) ? [target] : []
      })
    }),
  )
  return files.flat()
}

// True when `target` is <kimaki package>/{src,dist}/plugin/<directory> of any
// Kimaki install (npm, a checkout, a worktree), so it is the same plugin ID.
async function isKimakiPluginDirectory({ target, directory }: { target: string; directory: string }): Promise<boolean> {
  const real = await fs.promises.realpath(target).catch(() => null)
  if (real === null) return false
  const roots = ['src', 'dist']
    .map((base) => path.join(base, 'plugin', directory))
    .filter((suffix) => real.endsWith(path.sep + suffix))
    .map((suffix) => real.slice(0, -(suffix.length + 1)))
  for (const root of roots) {
    const manifest = await fs.promises.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null)
    const parsed: unknown = manifest === null ? null : errore.try(() => JSON.parse(manifest))
    if (parsed && typeof parsed === 'object' && !(parsed instanceof Error) && Reflect.get(parsed, 'name') === 'kimaki') return true
  }
  return false
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

// A shim whose plugin the global config already lists would load one plugin ID
// twice. OpenCode keeps the first and reports the other as a failed plugin
// ("Duplicate plugin ID", plugin/supervisor.ts), so the shim is removed instead.
async function removeShim({ configDir, name }: { configDir: string; name: string }) {
  const directory = path.join(configDir, 'plugins', name)
  if (!fs.existsSync(directory)) return { file: directory, written: false }
  const removed = await fs.promises
    .rm(directory, { recursive: true, force: true })
    .catch((cause) => new ConfigError({ reason: `Cannot remove the Kimaki OpenCode plugin shim ${directory}. Check permissions of ${configDir}`, cause }))
  if (removed instanceof Error) return removed
  logger.log(`removed OpenCode plugin shim ${directory}: opencode.json already loads this plugin`)
  return { file: directory, written: true }
}

export async function installPluginShim({ configDir }: { configDir: string }): Promise<ConfigError | { written: boolean }> {
  const targets = await configuredPluginTargets({ configDir })
  const results = await Promise.all(
    PLUGIN_SHIMS.map(async (shim) => {
      const configured = await Promise.all(targets.map((target) => isKimakiPluginDirectory({ target, directory: shim.directory })))
      if (configured.includes(true)) return removeShim({ configDir, name: shim.name })
      return installShim({ configDir, name: shim.name, entry: kimakiPluginEntry(shim.directory) })
    }),
  )
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
}): Promise<OpenCodeUnavailableError | OpenCodeMissingError | OpenCodeV1Error | OpenCodeVersionError | OpenCodeError | OpencodeEndpoint> {
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
  // Live events after hydration, in addition to the onEvent callback. Each
  // (re)connect starts with server.connected. Returns the unsubscribe.
  subscribe: (listener: (event: V2Event) => void) => () => void
  stop: () => void
}

class StreamClosedError extends errore.createTaggedError({
  name: 'StreamClosedError',
  message: 'OpenCode event stream closed: $reason',
}) {}

// Same as the OpenCode web client (3 missed keepalives).
const STREAM_IDLE_TIMEOUT_MS = 45_000

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
    // The server writes a keepalive every 15s: a silent stream is half-open
    // (sleep/wake, hung server), so drop it and reconnect.
    const watchdog: { timer?: NodeJS.Timeout } = {}
    const touch = () => {
      clearTimeout(watchdog.timer)
      watchdog.timer = setTimeout(() => {
        logger.warn(`no OpenCode stream activity for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, reconnecting`)
        attempt.abort()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    touch()
    const iterator = endpoint.client.event.subscribe({ signal, onActivity: touch })[Symbol.asyncIterator]()
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
      // The endpoint switches before any event is delivered, so listeners
      // (and held events) read from the new server. server.connected tells
      // listeners to refetch: ephemeral events sent while disconnected are lost.
      state.connected = true
      state.endpoint = endpoint
      for (const listener of listeners) listener(first.value)
      for (const event of held.splice(0)) {
        emit(event)
      }
      phase.booting = false
      readyDeferred.resolve(endpoint)
      logger.info(`connected to OpenCode ${endpoint.version} at ${endpoint.url}`)
      return consume
    })()
    clearTimeout(watchdog.timer)
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
      if (endpoint instanceof OpenCodeVersionError || endpoint instanceof OpenCodeV1Error || (endpoint instanceof Error && state.endpoint === null)) {
        readyDeferred.resolve(endpoint)
        logger.error(endpoint)
        return
      }
      if (endpoint instanceof Error) logger.warn(`OpenCode not reachable`, endpoint)
      if (!(endpoint instanceof Error)) {
        const result = await runAttempt({ endpoint, reconnect: state.endpoint !== null })
        if (controller.signal.aborted) return
        // This attempt connected: start the backoff over.
        if (state.endpoint === endpoint) backoff.ms = 500
        logger.warn(`event stream ended`, result)
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
