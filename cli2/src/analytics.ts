// Anonymous product analytics via Strada (docs/strada-product-analytics.md).
// Install-level only: no Discord IDs, paths, prompts or secrets. The install
// ID is a random UUID in <dataDir>/install-id, the same file V1 used, so an
// upgraded install keeps its identity.
//
//   bot_started         main.ts, once Discord and OpenCode are ready
//   project_registered  onboarding (default channel) and `project add`
//   session_created     actions.startSession
//   turn_started        root session execution.started      ┐ foldAnalytics(),
//   turn_completed      root session execution.succeeded    │ fed by the event
//   tokens_used         every execution end, root and child ┘ loop
//
// tokens_used sums the durable session.step.ended usage of one execution, so
// a bot restart never double counts. session.usage.updated is cumulative and
// live-only, so a delta needs a baseline the bot does not have after a restart.
//
// Off with --no-analytics or KIMAKI_STRADA_ENABLED=0, and under vitest unless
// a test passes its own endpoint.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { flush, initStrada, track } from '@strada.sh/sdk'
import * as errore from 'errore'

import { ConfigError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { V2Event } from './opencode-server.ts'

const logger = createLogger('ANALYTICS')

// Public write-only ingest token of the production project `kimaki`.
const DEFAULT_PROJECT_ID = '01KYX3X6FEBBV5JV6Q8M97988C'
const DEFAULT_TOKEN = 'str_9eee60d24a444da78107f8780fe965c5f8cae422def44dcb9ee94d8035a5a14f'
const SCHEMA_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AnalyticsEventName =
  | 'bot_started'
  | 'project_registered'
  | 'session_created'
  | 'turn_started'
  | 'turn_completed'
  | 'tokens_used'

export type AnalyticsProps = Record<string, string | number | boolean>
export type AnalyticsEvent = { name: AnalyticsEventName; properties: AnalyticsProps }

// --- pure fold over OpenCode events of Kimaki sessions ---

type ExecutionUsage = {
  startedAt: number
  steps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  model: string | null
  provider: string | null
}

export type UsageState = Readonly<Record<string, ExecutionUsage>>

function without(state: UsageState, sessionId: string): UsageState {
  const { [sessionId]: _removed, ...rest } = state
  return rest
}

export function foldAnalytics({
  state,
  event,
  isRoot,
}: {
  state: UsageState
  event: V2Event
  // The thread's own session; false for subagent children.
  isRoot: boolean
}): { state: UsageState; events: AnalyticsEvent[] } {
  switch (event.type) {
    case 'session.execution.started': {
      const usage: ExecutionUsage = { startedAt: event.created, steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, model: null, provider: null }
      const next = { ...state, [event.data.sessionID]: usage }
      return { state: next, events: isRoot ? [{ name: 'turn_started', properties: {} }] : [] }
    }
    case 'session.step.started': {
      const current = state[event.data.sessionID]
      if (!current) return { state, events: [] }
      const usage = { ...current, model: event.data.model.id, provider: event.data.model.providerID }
      return { state: { ...state, [event.data.sessionID]: usage }, events: [] }
    }
    // A failed step (abort, provider error) is billed too.
    case 'session.step.ended':
    case 'session.step.failed': {
      const current = state[event.data.sessionID]
      const { tokens, cost = 0 } = event.data
      if (!current || !tokens) return { state, events: [] }
      const usage: ExecutionUsage = {
        ...current,
        steps: current.steps + 1,
        input: current.input + tokens.input,
        output: current.output + tokens.output,
        reasoning: current.reasoning + tokens.reasoning,
        cacheRead: current.cacheRead + tokens.cache.read,
        cacheWrite: current.cacheWrite + tokens.cache.write,
        cost: current.cost + cost,
      }
      return { state: { ...state, [event.data.sessionID]: usage }, events: [] }
    }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const usage = state[event.data.sessionID]
      const next = without(state, event.data.sessionID)
      // Not seen from the start (bot restarted mid-run), or no model step (compaction).
      if (!usage || usage.steps === 0) return { state: next, events: [] }
      // OpenCode reports output without reasoning, but bills both.
      const total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
      const tokensUsed: AnalyticsEvent = {
        name: 'tokens_used',
        properties: {
          tokens_input: usage.input,
          tokens_output: usage.output,
          tokens_reasoning: usage.reasoning,
          tokens_cache_read: usage.cacheRead,
          tokens_cache_write: usage.cacheWrite,
          tokens_total: total,
          cost: usage.cost,
          assistant_message_count: usage.steps,
          is_subagent: !isRoot,
          ...(usage.model && { model: usage.model }),
          ...(usage.provider && { provider: usage.provider }),
        },
      }
      const completed: AnalyticsEvent[] =
        isRoot && event.type === 'session.execution.succeeded'
          ? [{ name: 'turn_completed', properties: { duration_sec: Math.round((event.created - usage.startedAt) / 1000) } }]
          : []
      // Zero-token executions are skipped, like V1.
      return { state: next, events: [...(total > 0 || usage.cost > 0 ? [tokensUsed] : []), ...completed] }
    }
    default:
      return { state, events: [] }
  }
}

// --- sink ---

export type Analytics = {
  // false: --no-analytics, KIMAKI_STRADA_ENABLED=0 or tests. `kimaki status` reports it.
  enabled: boolean
  track: (name: AnalyticsEventName, properties?: AnalyticsProps) => void
  // An OpenCode event of a Kimaki thread (event loop).
  observe: (event: V2Event, isRoot: boolean) => void
  flush: () => Promise<void>
}

export const disabledAnalytics: Analytics = {
  enabled: false,
  track: () => {},
  observe: () => {},
  flush: async () => {},
}

function readInstallId(dataDir: string): ConfigError | string {
  const file = path.join(dataDir, 'install-id')
  const existing = errore.try(
    () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''),
    (e) => new ConfigError({ reason: `Cannot read ${file}`, cause: e }),
  )
  if (existing instanceof Error) return existing
  if (UUID.test(existing)) return existing
  const id = crypto.randomUUID()
  const written = errore.try(
    () => fs.writeFileSync(file, `${id}\n`),
    (e) => new ConfigError({ reason: `Cannot write ${file}`, cause: e }),
  )
  if (written instanceof Error) return written
  return id
}

function kimakiVersion(): string {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  return pkg.version
}

export function createAnalytics({
  dataDir,
  botMode,
  enabled,
  endpoint,
}: {
  dataDir: string
  botMode: 'gateway' | 'self_hosted'
  // false: --no-analytics
  enabled: boolean
  // Tests: a local OTLP receiver.
  endpoint?: string
}): Analytics {
  const disabledByEnv = ['0', 'false'].includes(process.env['KIMAKI_STRADA_ENABLED'] ?? '')
  const underTest = process.env['KIMAKI_VITEST'] === '1' && !endpoint
  if (!enabled || disabledByEnv || underTest) return disabledAnalytics
  const installId = readInstallId(dataDir)
  if (installId instanceof Error) {
    logger.warn(`analytics off: ${installId.message}`)
    return disabledAnalytics
  }
  const initialized = initStrada({
    projectId: process.env['KIMAKI_STRADA_PROJECT_ID'] || DEFAULT_PROJECT_ID,
    token: process.env['KIMAKI_STRADA_TOKEN'] || DEFAULT_TOKEN,
    service: 'kimaki-cli',
    environment: process.env['KIMAKI_STRADA_ENVIRONMENT'] || process.env['NODE_ENV'] || 'production',
    version: kimakiVersion(),
    userId: installId,
    enabled: true,
    // The bot handles its own crashes; the SDK must never exit the process.
    captureUncaughtErrors: false,
    ...(endpoint && { endpoint }),
  })
  if (initialized instanceof Error) {
    logger.warn(`analytics off: ${initialized.message}`)
    return disabledAnalytics
  }
  const common = { install_id: installId, schema_version: SCHEMA_VERSION, bot_mode: botMode, platform: process.platform, arch: process.arch }
  const send = (name: AnalyticsEventName, properties: AnalyticsProps = {}) => {
    // Identity fields always win over caller props.
    const failed = track(name, { ...properties, ...common })
    if (failed instanceof Error) logger.warn(`track ${name}: ${failed.message}`)
  }
  const usage: { state: UsageState } = { state: {} }
  return {
    enabled: true,
    track: send,
    observe: (event, isRoot) => {
      const folded = foldAnalytics({ state: usage.state, event, isRoot })
      usage.state = folded.state
      for (const tracked of folded.events) send(tracked.name, tracked.properties)
    },
    flush: async () => {
      const failed = await flush()
      if (failed instanceof Error) logger.warn(`flush: ${failed.message}`)
    },
  }
}
