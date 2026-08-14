// Anonymous product analytics via Strada (OpenTelemetry).
// Tracks install-level usage only: no Discord IDs, paths, prompts, or secrets.
// A random install id is stored in {dataDir}/install-id for DAU-style queries.
//
// Metrics are "active installs", not people. Multiple --data-dir values count
// as separate installs. Query with ServiceName = 'kimaki-cli' and
// LogAttributes['custom.install_id'] / LogAttributes['event.name'].

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { initStrada, track, flush } from '@strada.sh/sdk'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import { store } from './store.js'

const logger = createLogger(LogPrefix.CLI)

// Public Strada project for production kimaki usage (write-only ingest token).
// Override with KIMAKI_STRADA_* for local/dev against kimaki-local.
// Disable with --no-analytics or KIMAKI_STRADA_ENABLED=0.
const DEFAULT_STRADA_PROJECT_ID = '01KYX3X6FEBBV5JV6Q8M97988C'
const DEFAULT_STRADA_TOKEN =
  'str_9eee60d24a444da78107f8780fe965c5f8cae422def44dcb9ee94d8035a5a14f'

const INSTALL_ID_FILENAME = 'install-id'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCHEMA_VERSION = 1

const INSTALL_ID_FILENAME_EXPORT = INSTALL_ID_FILENAME

let initialized = false
let identityFailed = false
let installIdCache: string | null = null
let botModeOverride: 'gateway' | 'self_hosted' | null = null

/** Captured events when tests call _enableAnalyticsTestCapture(). */
let testCapture: Array<{ name: string; properties: AnalyticsProps }> | null =
  null

export type AnalyticsEventName =
  | 'bot_started'
  | 'project_registered'
  | 'session_created'
  | 'turn_started'
  | 'turn_completed'
  | 'tokens_used'

export type AnalyticsBotMode = 'gateway' | 'self_hosted'

export type AnalyticsProjectKind = 'user' | 'default'

export type AnalyticsProjectSource =
  | 'onboarding'
  | 'discord_command'
  | 'cli'
  | 'send_auto_create'

export type AnalyticsTurnSource = 'discord' | 'cli' | 'scheduled' | 'retry'

export type AnalyticsTurnInputKind = 'prompt' | 'command'

export type AnalyticsIngressMode = 'direct' | 'local_queue'

export type AnalyticsProps = Record<string, string | number | boolean>

function isAnalyticsDisabled() {
  if (testCapture) return false
  if (process.env.KIMAKI_VITEST) return true
  if (process.env.KIMAKI_STRADA_ENABLED === '0') return true
  if (process.env.KIMAKI_STRADA_ENABLED === 'false') return true
  return false
}

function getKimakiVersion() {
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version: string }
  return pkg.version
}

function isValidInstallId(value: string) {
  return UUID_RE.test(value)
}

function resolveBotMode(): AnalyticsBotMode {
  if (botModeOverride) return botModeOverride
  if (store.getState().discordBaseUrl !== 'https://discord.com') {
    return 'gateway'
  }
  return 'self_hosted'
}

/**
 * Set bot mode once credentials are known (gateway vs self-hosted).
 * Applied as a common property on every subsequent event.
 */
export function setAnalyticsBotMode(mode: AnalyticsBotMode): void {
  botModeOverride = mode
}

/**
 * Stable anonymous id for this data dir. Created once and reused forever.
 * Returns null when the id cannot be read or persisted (fail closed).
 */
export function getInstallId(): string | null {
  if (identityFailed) return null
  if (installIdCache) return installIdCache

  const filePath = path.join(getDataDir(), INSTALL_ID_FILENAME)
  const existing = (() => {
    try {
      if (!fs.existsSync(filePath)) return null
      const value = fs.readFileSync(filePath, 'utf8').trim()
      if (!value || !isValidInstallId(value)) return null
      return value
    } catch {
      return null
    }
  })()
  if (existing) {
    installIdCache = existing
    return existing
  }

  const id = crypto.randomUUID()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Use plain write so a corrupt/non-uuid file is replaced. Concurrent
    // writers may race; we re-read and only accept a valid uuid afterward.
    fs.writeFileSync(filePath, `${id}\n`, { encoding: 'utf8' })
    const verified = fs.readFileSync(filePath, 'utf8').trim()
    if (!isValidInstallId(verified)) {
      identityFailed = true
      logger.warn('analytics disabled: install-id file is not a valid uuid')
      return null
    }
    installIdCache = verified
    return verified
  } catch {
    identityFailed = true
    logger.warn(
      'analytics disabled: could not persist install-id (data dir not writable?)',
    )
    return null
  }
}

/** Common low-cardinality props on every product event. */
export function commonAnalyticsProps(
  extra?: AnalyticsProps,
): AnalyticsProps | null {
  const installId = getInstallId()
  if (!installId) return null
  return {
    ...(extra ?? {}),
    install_id: installId,
    schema_version: SCHEMA_VERSION,
    bot_mode: resolveBotMode(),
    platform: process.platform,
    arch: process.arch,
  }
}

/**
 * Initialize Strada. Safe to call once from the bot or short-lived CLI paths
 * that emit product events. No-ops under tests and when disabled.
 */
export function initAnalytics(): void {
  if (initialized) return
  if (isAnalyticsDisabled() && !testCapture) {
    initialized = true
    return
  }

  if (testCapture) {
    initialized = true
    return
  }

  const installId = getInstallId()
  if (!installId) {
    initialized = true
    return
  }

  const projectId =
    process.env.KIMAKI_STRADA_PROJECT_ID || DEFAULT_STRADA_PROJECT_ID
  const token = process.env.KIMAKI_STRADA_TOKEN || DEFAULT_STRADA_TOKEN
  const environment =
    process.env.KIMAKI_STRADA_ENVIRONMENT ||
    process.env.NODE_ENV ||
    'production'

  try {
    initStrada({
      projectId,
      token,
      service: 'kimaki-cli',
      environment,
      version: getKimakiVersion(),
      userId: installId,
    })
    initialized = true
  } catch (error) {
    logger.warn(
      'Failed to init analytics:',
      error instanceof Error ? error.message : String(error),
    )
    initialized = true
  }
}

/**
 * Fire-and-forget product event. Never throws.
 * install_id / schema_version / bot_mode / platform / arch always win over
 * caller props so identity invariants cannot be overridden.
 */
export function trackEvent(
  name: AnalyticsEventName,
  properties?: AnalyticsProps,
): void {
  if (!initialized && !testCapture) return
  if (isAnalyticsDisabled() && !testCapture) return
  if (identityFailed) return

  const props = commonAnalyticsProps(properties)
  if (!props) return

  if (testCapture) {
    testCapture.push({ name, properties: props })
    return
  }

  try {
    track(name, props)
  } catch (error) {
    logger.warn(
      `trackEvent(${name}) failed:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Flush buffered telemetry. Call before process.exit on short CLI paths and
 * on graceful bot shutdown.
 */
export async function flushAnalytics(): Promise<void> {
  if (testCapture) return
  if (!initialized || isAnalyticsDisabled() || identityFailed) return
  try {
    await flush()
  } catch (error) {
    logger.warn(
      'flushAnalytics failed:',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** @deprecated Use commonAnalyticsProps / trackEvent common fields. */
export function baseRuntimeProps(extra?: AnalyticsProps): AnalyticsProps {
  return {
    version: getKimakiVersion(),
    ...extra,
  }
}

/** Test helper: reset module state between unit tests. */
export function _resetAnalyticsForTests(): void {
  initialized = false
  identityFailed = false
  installIdCache = null
  botModeOverride = null
  testCapture = null
}

/**
 * Test helper: enable in-process event capture instead of Strada export.
 * Returns the mutable capture array.
 */
export function _enableAnalyticsTestCapture(opts?: {
  installId?: string
  botMode?: AnalyticsBotMode
}): Array<{ name: string; properties: AnalyticsProps }> {
  testCapture = []
  initialized = true
  identityFailed = false
  installIdCache = opts?.installId ?? '11111111-1111-4111-8111-111111111111'
  botModeOverride = opts?.botMode ?? 'self_hosted'
  return testCapture
}

export { INSTALL_ID_FILENAME_EXPORT as INSTALL_ID_FILENAME }
