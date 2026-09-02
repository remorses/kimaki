// Config loading for opencode-auto-mode.
// Opt-in for npm users: no file and no env = plugin is a no-op.
// Kimaki always enables via autoModeInternal. Invalid JSON fails closed.

import fs from 'node:fs'
import path from 'node:path'

export interface AutoModeConfig {
  model: string
  timeoutMs: number
}

export type ConfigLoad =
  | { kind: 'disabled' }
  | { kind: 'enabled'; config: AutoModeConfig }
  | { kind: 'invalid'; reason: string }

export const MODEL_PRIORITY: string[] = [
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4-5-20251001',
  'openai/gpt-5.4-mini',
  'openai/gpt-4.1-mini',
  'google/gemini-2.5-flash',
]

const DEFAULTS: Omit<AutoModeConfig, 'model'> = {
  timeoutMs: 8000,
}

const MIN_TIMEOUT_MS = 250
const MAX_TIMEOUT_MS = 60_000
const ALLOWED_KEYS = new Set(['model', 'timeoutMs'])

export function getDefaultConfig(): AutoModeConfig {
  return {
    model: MODEL_PRIORITY[0]!,
    ...DEFAULTS,
  }
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

export function resolveModel({
  config,
  availableModels,
}: {
  config: AutoModeConfig
  availableModels: Set<string>
}) {
  if (availableModels.has(config.model)) return config.model
  for (const model of MODEL_PRIORITY) {
    if (availableModels.has(model)) return model
  }
  return config.model
}

export function parseModelId(model: string) {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) {
    return { providerID: 'openai', modelID: model }
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  }
}

function validateConfig(value: unknown): { kind: 'invalid'; reason: string } | { kind: 'ok'; config: AutoModeConfig } {
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
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    return { kind: 'invalid', reason: 'auto-mode model must be a non-empty string' }
  }
  const timeoutMs = record.timeoutMs
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
      return { kind: 'invalid', reason: 'auto-mode timeoutMs must be a number' }
    }
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      return { kind: 'invalid', reason: `auto-mode timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` }
    }
  }
  return {
    kind: 'ok',
    config: {
      model: typeof model === 'string' ? model : getDefaultConfig().model,
      timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : DEFAULTS.timeoutMs,
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
  const record = value as { model?: string; timeoutMs?: number }
  return {
    kind: 'ok',
    value: {
      ...(typeof record.model === 'string' ? { model: record.model } : {}),
      ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
    },
  }
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
      const reason = error instanceof SyntaxError
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
