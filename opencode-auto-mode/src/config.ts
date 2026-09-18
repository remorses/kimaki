// Config loading for opencode-auto-mode.
// Opt-in for npm users: no file and no env = plugin is a no-op.
// Kimaki always enables via autoModeInternal. Invalid JSON fails closed.

import fs from 'node:fs'
import path from 'node:path'

export const JEV_MODEL = 'typesafe-ai/jev' as const

export interface AutoModeConfig {
  model: 'main' | typeof JEV_MODEL
  timeoutMs: number
  allowProbability: number
}

export type ConfigLoad =
  | { kind: 'disabled' }
  | { kind: 'enabled'; config: AutoModeConfig }
  | { kind: 'invalid'; reason: string }

const DEFAULTS: AutoModeConfig = {
  model: JEV_MODEL,
  timeoutMs: 8000,
  allowProbability: 0.9,
}

const MIN_TIMEOUT_MS = 250
const MAX_TIMEOUT_MS = 60_000
const ALLOWED_KEYS = new Set(['model', 'timeoutMs', 'allowProbability'])

export function getDefaultConfig(): AutoModeConfig {
  return { ...DEFAULTS }
}

export function loadConfig({ projectDir }: { projectDir: string }): ConfigLoad {
  const fileConfig = findConfigFile({ startDir: projectDir })
  if (fileConfig.kind === 'invalid') return fileConfig
  const envConfig = loadEnvConfig()
  if (envConfig.kind === 'invalid') return envConfig
  if (fileConfig.kind === 'missing' && envConfig.kind === 'missing') {
    return { kind: 'disabled' }
  }
  const merged = {
    ...getDefaultConfig(),
    ...(fileConfig.kind === 'ok' ? fileConfig.value : {}),
    ...(envConfig.kind === 'ok' ? envConfig.value : {}),
  }
  const validated = validateConfig(merged)
  if (validated.kind === 'invalid') return validated
  return { kind: 'enabled', config: validated.config }
}

function validateConfig(
  value: unknown,
): { kind: 'invalid'; reason: string } | { kind: 'ok'; config: AutoModeConfig } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'auto-mode config must be an object' }
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { kind: 'invalid', reason: `Unknown auto-mode config key: ${key}` }
    }
  }
  const model = record.model
  if (model !== undefined && model !== 'main' && model !== JEV_MODEL) {
    return { kind: 'invalid', reason: `auto-mode model must be "main" or "${JEV_MODEL}"` }
  }
  const timeoutMs = record.timeoutMs
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
      return { kind: 'invalid', reason: 'auto-mode timeoutMs must be a number' }
    }
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      return {
        kind: 'invalid',
        reason: `auto-mode timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      }
    }
  }
  const allowProbability = record.allowProbability
  if (
    allowProbability !== undefined &&
    (typeof allowProbability !== 'number' ||
      !Number.isFinite(allowProbability) ||
      allowProbability < 0 ||
      allowProbability > 1)
  ) {
    return {
      kind: 'invalid',
      reason: 'auto-mode allowProbability must be a number between 0 and 1',
    }
  }
  return {
    kind: 'ok',
    config: {
      model: model === 'main' || model === JEV_MODEL ? model : DEFAULTS.model,
      timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : DEFAULTS.timeoutMs,
      allowProbability:
        typeof allowProbability === 'number' ? allowProbability : DEFAULTS.allowProbability,
    },
  }
}

type PartialLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; value: Partial<AutoModeConfig> }
  | { kind: 'invalid'; reason: string }

function parsePartial(value: unknown, source: string): PartialLoad {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: `${source} must be an object` }
  }
  const validated = validateConfig(value)
  if (validated.kind === 'invalid') return validated
  const record = value as {
    model?: AutoModeConfig['model']
    timeoutMs?: number
    allowProbability?: number
  }
  const config: Partial<AutoModeConfig> = {}
  if (record.model) config.model = record.model
  if (typeof record.timeoutMs === 'number') config.timeoutMs = record.timeoutMs
  if (typeof record.allowProbability === 'number') {
    config.allowProbability = record.allowProbability
  }
  return { kind: 'ok', value: config }
}

function findConfigFile({ startDir }: { startDir: string }): PartialLoad {
  let dir = path.resolve(startDir)
  const root = path.parse(dir).root
  while (true) {
    const configPath = path.join(dir, '.opencode', 'auto-mode.json')
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      return parsePartial(JSON.parse(raw), configPath)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        if (dir === root) return { kind: 'missing' }
        dir = path.dirname(dir)
        continue
      }
      const reason =
        error instanceof SyntaxError
          ? `Invalid JSON in ${configPath}`
          : `Failed to read ${configPath}`
      return { kind: 'invalid', reason }
    }
  }
}

function loadEnvConfig(): PartialLoad {
  const envValue = process.env.OPENCODE_AUTO_MODE
  if (!envValue) return { kind: 'missing' }
  try {
    return parsePartial(JSON.parse(envValue), 'OPENCODE_AUTO_MODE')
  } catch {
    return { kind: 'invalid', reason: 'OPENCODE_AUTO_MODE is not valid JSON' }
  }
}
