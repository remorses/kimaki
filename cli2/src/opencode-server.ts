// Connection to the user's OpenCode V2 service (spec 28.2). Kimaki never
// spawns OpenCode itself: it discovers the service registration file, or asks
// Service.ensure() to start `opencode serve --service` without a version pin
// (a version pin would replace a running server and kill TUI sessions).
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

import { setTimeout as sleep } from 'node:timers/promises'
import { OpenCode, type OpenCodeClient, type V2Event } from '@opencode/client'
import { Service } from '@opencode/client/service'
import * as errore from 'errore'

import { OpenCodeError, OpenCodeUnavailableError, OpenCodeVersionError } from './errors.ts'
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
    logger.log('no OpenCode service found, starting it with Service.ensure()')
    return Service.ensure({ file: serviceFile }).catch(
      (e) => new OpenCodeUnavailableError({ reason: 'ensure failed', cause: e }),
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

  async function runAttempt({ endpoint, reconnect }: { endpoint: OpencodeEndpoint; reconnect: boolean }) {
    const attempt = new AbortController()
    const abortAttempt = () => attempt.abort()
    controller.signal.addEventListener('abort', abortAttempt, { once: true })
    const iterator = endpoint.client.event.subscribe({ signal: attempt.signal })[Symbol.asyncIterator]()
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
          if (phase.booting) {
            held.push(next.value)
            continue
          }
          onEvent(next.value)
        }
      })()
      const hydrated = await Promise.race([
        onConnect({ client: endpoint.client, reconnect, signal: attempt.signal }),
        consume,
      ])
      if (hydrated instanceof Error) return hydrated
      for (const event of held.splice(0)) {
        onEvent(event)
      }
      phase.booting = false
      state.connected = true
      state.endpoint = endpoint
      readyDeferred.resolve(endpoint)
      logger.log(`connected to OpenCode ${endpoint.version} at ${endpoint.url}`)
      return consume
    })()
    attempt.abort()
    controller.signal.removeEventListener('abort', abortAttempt)
    void iterator.return?.(undefined).catch(() => {})
    return result
  }

  void (async () => {
    const backoff = { ms: 500, everConnected: false }
    while (!controller.signal.aborted) {
      const endpoint = await resolveOpencode({ serviceFile, ensure })
      if (endpoint instanceof OpenCodeVersionError) {
        readyDeferred.resolve(endpoint)
        logger.error(endpoint.message)
        return
      }
      if (!(endpoint instanceof Error)) {
        const result = await runAttempt({ endpoint, reconnect: backoff.everConnected })
        if (state.connected) {
          backoff.everConnected = true
          backoff.ms = 500
          state.connected = false
          onDisconnect()
        }
        if (controller.signal.aborted) return
        logger.warn(`event stream ended: ${result.message}`)
      }
      if (endpoint instanceof Error) {
        logger.warn(`OpenCode not reachable: ${endpoint.message}`)
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
    stop: () => {
      controller.abort()
      readyDeferred.resolve(new OpenCodeUnavailableError({ reason: 'stopped' }))
    },
  }
}
