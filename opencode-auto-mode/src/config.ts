// Config loading for opencode-auto-mode.
// Opt-in for npm users: no file and no env = plugin is a no-op.
// Kimaki always enables via autoModeInternal.

import fs from 'node:fs'
import path from 'node:path'

export interface AutoModeConfig {
  model: string
  timeoutMs: number
}

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

export function getDefaultConfig(): AutoModeConfig {
  return {
    model: MODEL_PRIORITY[0]!,
    ...DEFAULTS,
  }
}

export function loadConfig({ projectDir }: { projectDir: string }): AutoModeConfig | null {
  const fileConfig = findConfigFile({ startDir: projectDir })
  const envConfig = loadEnvConfig()
  if (!fileConfig && !envConfig) return null
  return {
    ...getDefaultConfig(),
    ...fileConfig,
    ...envConfig,
  }
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

function findConfigFile({ startDir }: { startDir: string }): Partial<AutoModeConfig> | null {
  let dir = path.resolve(startDir)
  const root = path.parse(dir).root
  while (true) {
    const configPath = path.join(dir, '.opencode', 'auto-mode.json')
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      return JSON.parse(raw) as Partial<AutoModeConfig>
    } catch {
      // keep searching
    }
    if (dir === root) return null
    dir = path.dirname(dir)
  }
}

function loadEnvConfig(): Partial<AutoModeConfig> | null {
  const envValue = process.env.OPENCODE_AUTO_MODE
  if (!envValue) return null
  try {
    return JSON.parse(envValue) as Partial<AutoModeConfig>
  } catch {
    return null
  }
}
