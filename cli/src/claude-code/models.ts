// Claude Code model catalog exposed through OpenCode's provider surface.
//
// Kimaki's /model picker works off provider.list() ({ all, connected,
// default }). The router merges the provider built here into the upstream
// opencode response, so Claude Code shows up as just another provider —
// selecting one of its models routes new sessions to the Claude backend.
//
// Model variants map to Claude Code effort levels, so kimaki's existing
// thinking-variant picker doubles as the effort selector.

import type { Model, Provider } from '@opencode-ai/sdk/v2'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_PROVIDER_NAME = 'Claude Code'

export const DEFAULT_CLAUDE_MODEL_ID = 'claude-opus-4-8'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type StaticModel = {
  id: string
  name: string
  releaseDate: string
  effortLevels: readonly string[]
}

// Fallback catalog used until (or if) live enumeration via the SDK succeeds.
// Kept intentionally small: the live list from supportedModels() replaces it.
const STATIC_MODELS: StaticModel[] = [
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    releaseDate: '2026-05-01',
    effortLevels: EFFORT_LEVELS,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    releaseDate: '2026-03-01',
    effortLevels: EFFORT_LEVELS,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    releaseDate: '2025-10-01',
    effortLevels: [],
  },
]

function buildModel({
  id,
  name,
  releaseDate,
  effortLevels,
}: {
  id: string
  name: string
  releaseDate: string
  effortLevels: readonly string[]
}): Model {
  const variants: Record<string, Record<string, unknown>> = {}
  for (const level of effortLevels) {
    variants[level] = { effort: level }
  }
  return {
    id,
    providerID: CLAUDE_CODE_PROVIDER_ID,
    api: { id, url: '', npm: '@anthropic-ai/claude-agent-sdk' },
    name,
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 64_000 },
    status: 'active',
    options: {},
    headers: {},
    release_date: releaseDate,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  }
}

let liveModels: Model[] | null = null

/**
 * Replace the static catalog with the live list reported by the Claude Code
 * runtime (Query.supportedModels()). Called opportunistically whenever a
 * session initializes, so the picker converges on the real model list.
 */
export function updateLiveModels(models: ModelInfo[]): void {
  if (models.length === 0) {
    return
  }
  const seen = new Set<string>()
  const mapped: Model[] = []
  for (const info of models) {
    // Alias rows (e.g. "sonnet" → claude-sonnet-5) duplicate their resolved
    // model; keep the canonical id only once.
    const id = info.resolvedModel || info.value
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    mapped.push(
      buildModel({
        id,
        name: info.displayName || id,
        releaseDate: '',
        effortLevels:
          info.supportsEffort && info.supportedEffortLevels ? info.supportedEffortLevels : [],
      }),
    )
  }
  if (mapped.length > 0) {
    liveModels = mapped
  }
}

export function getClaudeCodeModels(): Model[] {
  if (liveModels) {
    return liveModels
  }
  return STATIC_MODELS.map(buildModel)
}

export function getClaudeCodeProvider(): Provider {
  const models: Record<string, Model> = {}
  for (const model of getClaudeCodeModels()) {
    models[model.id] = model
  }
  return {
    id: CLAUDE_CODE_PROVIDER_ID,
    name: CLAUDE_CODE_PROVIDER_NAME,
    source: 'custom',
    env: [],
    options: {},
    models,
  }
}

export function isClaudeCodeModel(modelString: string | undefined | null): boolean {
  return typeof modelString === 'string' && modelString.startsWith(`${CLAUDE_CODE_PROVIDER_ID}/`)
}

/** Effort levels supported by the given model id, for variant validation. */
export function getEffortLevelsForModel(modelId: string): string[] {
  const model = getClaudeCodeModels().find((candidate) => {
    return candidate.id === modelId
  })
  if (!model?.variants) {
    return []
  }
  return Object.keys(model.variants)
}
