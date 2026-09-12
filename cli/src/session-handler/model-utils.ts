// Model resolution utilities.
// getDefaultModel resolves the default model from OpenCode when no user preference is set.
// listModels wraps provider.list() with a per-directory memoized cache.

import fs from 'node:fs'
import path from 'node:path'
import { xdgState } from 'xdg-basedir'
import * as errore from 'errore'
import type { OpencodeClient } from '../opencode.js'
import type { ConfigEntry } from '@opencode/client'
import {
  formatCandidateRef,
  PROVIDER_ID as SUBROUTER_PROVIDER_ID,
  resolveLiveModel,
} from '@subrouter/cli'
import { InvalidModelError, OpenCodeSdkError } from '../errors.js'
import {
  initializeOpencodeForDirectory,
  subscribeOpencodeServerLifecycle,
} from '../opencode.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { ScheduledTaskScheduleKind } from '../database.js'

const sessionLogger = createLogger(LogPrefix.SESSION)

export type DefaultModelSource =
  | 'opencode-config'
  | 'opencode-recent'
  | 'opencode-provider-default'

export type SessionStartSourceContext = {
  scheduleKind: ScheduledTaskScheduleKind
  scheduledTaskId?: number
  scheduledTaskRunId?: number
}

/**
 * Read user's recent models from OpenCode TUI's state file.
 * Uses same path as OpenCode: path.join(xdgState, "opencode", "model.json")
 * Returns all recent models so we can iterate until finding a valid one.
 * See: opensrc/repos/github.com/sst/opencode/packages/opencode/src/global/index.ts
 */
function getRecentModelsFromTuiState(): Array<{
  providerID: string
  modelID: string
}> {
  if (!xdgState) {
    return []
  }
  // Same path as OpenCode TUI: path.join(Global.Path.state, "model.json")
  const modelJsonPath = path.join(xdgState, 'opencode', 'model.json')

  const result = errore.tryFn(() => {
    const content = fs.readFileSync(modelJsonPath, 'utf-8')
    const data = JSON.parse(content) as {
      recent?: Array<{ providerID: string; modelID: string }>
    }
    return data.recent ?? []
  })

  if (result instanceof Error) {
    // File doesn't exist or is invalid - this is normal for fresh installs
    return []
  }

  return result
}

/**
 * Parse a model string in format "provider/model" into providerID and modelID.
 */
export function parseModelId(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = model.split('/')
  const modelID = modelParts.join('/')
  if (!providerID || !modelID) {
    return undefined
  }
  return { providerID, modelID }
}

export function getConfiguredModel(
  entries: readonly ConfigEntry[],
): { providerID: string; modelID: string } | undefined {
  const entry = entries.findLast((candidate) => {
    return candidate.type === 'document' && candidate.info.model !== undefined
  })
  if (!entry || entry.type !== 'document' || !entry.info.model) return undefined
  if (typeof entry.info.model === 'string') return parseModelId(entry.info.model)
  return {
    providerID: entry.info.model.providerID,
    modelID: entry.info.model.model,
  }
}

/**
 * Validate that a model is available (provider connected + model exists).
 */
function isModelValid(
  model: { providerID: string; modelID: string },
  connected: string[],
  providers: Array<{ id: string; models?: Record<string, unknown> }>,
): boolean {
  const isConnected = connected.includes(model.providerID)
  const provider = providers.find((p) => {
    return p.id === model.providerID
  })
  const modelExists = provider?.models && model.modelID in provider.models
  return isConnected && !!modelExists
}

export type ListedModel = {
  providerID: string
  modelID: string
  name: string
  connected: boolean
}

type ProviderModelLookup = {
  id: string
  models?: Record<string, { name?: string } | undefined>
}

/** SDK display name from provider.list. */
export function getProviderModelName({
  providers,
  providerID,
  modelID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
}): string | undefined {
  if (!providerID || !modelID) return undefined
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  if (!model) return undefined
  if (typeof model.name === 'string' && model.name.trim()) return model.name
  return modelID
}

/** Use the SDK name only when it is the model id, or the model id plus `(live-model)`. */
export function displayedModelLabel({
  modelID,
  name,
}: {
  modelID: string
  name?: string
}): string {
  if (name && (name === modelID || name.startsWith(`${modelID} (`))) return name
  return modelID
}

export function formatDisplayedModelId({
  providerID,
  modelID,
  name,
}: {
  providerID?: string
  modelID?: string
  name?: string
}): string | undefined {
  if (!providerID || !modelID) return undefined
  return `${providerID}/${displayedModelLabel({ modelID, name })}`
}

/** Subrouter presets resolve to the live cooldown-aware candidate. */
export async function resolveDisplayedModelName({
  providers,
  providerID,
  modelID,
  sessionID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
  sessionID?: string
}): Promise<string | undefined> {
  if (providerID === SUBROUTER_PROVIDER_ID && modelID) {
    const candidate = await resolveLiveModel({ preset: modelID, sessionID }).catch((e) => {
      sessionLogger.warn(
        `[MODEL] Failed to resolve subrouter candidate for ${modelID}:`,
        e instanceof Error ? e.message : e,
      )
      return null
    })
    if (candidate) return `${modelID} (${formatCandidateRef(candidate)})`
  }
  return getProviderModelName({ providers, providerID, modelID })
}

export async function resolveDisplayedModelId({
  providers,
  providerID,
  modelID,
  sessionID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
  sessionID?: string
}): Promise<string | undefined> {
  return formatDisplayedModelId({
    providerID,
    modelID,
    name: await resolveDisplayedModelName({ providers, providerID, modelID, sessionID }),
  })
}

type ModelListCacheEntry =
  | { status: 'pending'; promise: Promise<ListedModel[] | OpenCodeSdkError> }
  | { status: 'ready'; value: ListedModel[] }

const modelListCache = new Map<string, ModelListCacheEntry>()

export function clearModelListCache() {
  modelListCache.clear()
}

subscribeOpencodeServerLifecycle(() => {
  clearModelListCache()
})

function flattenListedModels({
  models,
}: {
  models: Array<{
    providerID: string
    modelID: string
    name?: string
    enabled?: boolean
  }>
}): ListedModel[] {
  return models.map((model) => {
    return {
      providerID: model.providerID,
      modelID: model.modelID,
      name: model.name || model.modelID,
      connected: model.enabled !== false,
    }
  })
}

export async function listModels({
  getClient,
  directory,
}: {
  getClient: () => OpencodeClient
  directory?: string
}): Promise<ListedModel[] | OpenCodeSdkError> {
  const cacheKey = directory ?? ''
  const cached = modelListCache.get(cacheKey)
  if (cached?.status === 'ready') return cached.value
  if (cached?.status === 'pending') return cached.promise

  const promise = (async () => {
    const location = directory ? { location: { directory } } : undefined
    // model.list can return an empty snapshot before plugins settle.
    const activation = await getClient()
      .plugin.awaitActivation(location)
      .catch((e) => new OpenCodeSdkError({ operation: 'plugin.awaitActivation', cause: e }))
    if (activation instanceof Error) return activation
    const modelsResponse = await getClient()
      .model.list(location)
      .catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
    if (modelsResponse instanceof Error) return modelsResponse
    if (!modelsResponse.data) {
      return new OpenCodeSdkError({ operation: 'model.list' })
    }
    return flattenListedModels({ models: [...modelsResponse.data] })
  })()

  modelListCache.set(cacheKey, { status: 'pending', promise })
  const result = await promise
  const current = modelListCache.get(cacheKey)
  const ownsCacheEntry = current?.status === 'pending' && current.promise === promise
  if (result instanceof Error) {
    if (ownsCacheEntry) modelListCache.delete(cacheKey)
    return result
  }
  // An empty connected list is the pre-plugin snapshot, not a stable catalog.
  if (ownsCacheEntry && result.some((model) => model.connected)) {
    modelListCache.set(cacheKey, { status: 'ready', value: result })
  } else if (ownsCacheEntry) {
    modelListCache.delete(cacheKey)
  }
  return result
}

export function validateModelIdAgainstList({
  model,
  models,
}: {
  model: string
  models: ListedModel[]
}): { providerID: string; modelID: string } | InvalidModelError {
  const parsed = parseModelId(model)
  if (!parsed) {
    return new InvalidModelError({
      model,
      reason: 'expected provider/model, for example anthropic/claude-opus-4-6',
    })
  }

  const match = models.find((candidate) => {
    return (
      candidate.providerID === parsed.providerID &&
      candidate.modelID === parsed.modelID
    )
  })
  if (!match) {
    const siblings = models
      .filter((candidate) => candidate.providerID === parsed.providerID)
      .map((candidate) => `${candidate.providerID}/${candidate.modelID}`)
    if (siblings.length > 0) {
      return new InvalidModelError({
        model,
        reason: `unknown model. Similar: ${siblings.slice(0, 8).join(', ')}`,
      })
    }
    const connectedProviders = [
      ...new Set(
        models.filter((candidate) => candidate.connected).map((candidate) => {
          return candidate.providerID
        }),
      ),
    ]
    const connectedHint = connectedProviders.length
      ? ` Connected providers: ${connectedProviders.join(', ')}`
      : ''
    return new InvalidModelError({
      model,
      reason: `unknown provider ${parsed.providerID}.${connectedHint}`,
    })
  }
  if (!match.connected) {
    return new InvalidModelError({
      model,
      reason: `provider ${parsed.providerID} is not connected`,
    })
  }
  return parsed
}

export async function validateModelId({
  model,
  getClient,
  directory,
}: {
  model: string
  getClient: () => OpencodeClient
  directory?: string
}): Promise<
  { providerID: string; modelID: string } | InvalidModelError | OpenCodeSdkError
> {
  const models = await listModels({ getClient, directory })
  if (models instanceof Error) return models
  return validateModelIdAgainstList({ model, models })
}

export async function validateCliModelOption({
  model,
  directory,
}: {
  model: string | undefined
  directory?: string
}) {
  if (!model) return
  const parsed = parseModelId(model)
  if (!parsed) {
    return new InvalidModelError({
      model,
      reason: 'expected provider/model, for example anthropic/claude-opus-4-6',
    })
  }
  if (!directory) return parsed

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) return getClient
  return validateModelId({ model, getClient, directory })
}

/**
 * Get the default model from OpenCode when no user preference is set.
 * Priority (matches OpenCode TUI behavior):
 * 1. OpenCode config.model setting
 * 2. User's recent models from TUI state (~/.local/state/opencode/model.json)
 * 3. First connected provider's default model from API
 * Returns the model and its source.
 */
export async function getDefaultModel({
  getClient,
  directory,
}: {
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
  directory?: string
}): Promise<
  | { providerID: string; modelID: string; source: DefaultModelSource }
  | undefined
> {
  if (getClient instanceof Error) return undefined

  const listed = await listModels({ getClient, directory })
  if (listed instanceof Error) {
    sessionLogger.log(
      `[MODEL] Failed to fetch models for default model:`,
      listed.message,
    )
    return undefined
  }
  const connectedModels = listed.filter((model) => model.connected)
  if (connectedModels.length === 0) {
    sessionLogger.log(`[MODEL] No connected models found`)
    return undefined
  }

  const isListed = (model: { providerID: string; modelID: string }) => {
    return connectedModels.some((candidate) => {
      return candidate.providerID === model.providerID && candidate.modelID === model.modelID
    })
  }

  const configResponse = await getClient().config.get(
    directory ? { location: { directory } } : undefined,
  ).catch((e) => new OpenCodeSdkError({ operation: 'config.get', cause: e }))
  const configModel = configResponse instanceof Error
    ? undefined
    : getConfiguredModel(configResponse)
  if (configModel) {
    if (isListed(configModel)) {
      sessionLogger.log(
        `[MODEL] Using config model: ${configModel.providerID}/${configModel.modelID}`,
      )
      return { ...configModel, source: 'opencode-config' }
    }
    sessionLogger.log(
      `[MODEL] Config model ${configModel.providerID}/${configModel.modelID} not available, checking recent`,
    )
  }

  const recentModels = getRecentModelsFromTuiState()
  for (const recentModel of recentModels) {
    if (isListed(recentModel)) {
      sessionLogger.log(
        `[MODEL] Using recent TUI model: ${recentModel.providerID}/${recentModel.modelID}`,
      )
      return { ...recentModel, source: 'opencode-recent' }
    }
  }
  if (recentModels.length > 0) {
    sessionLogger.log(`[MODEL] No valid recent TUI models found`)
  }

  const defaultResponse = await getClient().model.default(
    directory ? { location: { directory } } : undefined,
  ).catch((e) => new OpenCodeSdkError({ operation: 'model.default', cause: e }))
  if (!(defaultResponse instanceof Error) && defaultResponse.data) {
    sessionLogger.log(
      `[MODEL] Using provider default: ${defaultResponse.data.providerID}/${defaultResponse.data.modelID}`,
    )
    return {
      providerID: defaultResponse.data.providerID,
      modelID: defaultResponse.data.modelID,
      source: 'opencode-provider-default',
    }
  }

  const first = connectedModels[0]
  if (!first) {
    return undefined
  }
  sessionLogger.log(
    `[MODEL] Using first listed model: ${first.providerID}/${first.modelID}`,
  )
  return {
    providerID: first.providerID,
    modelID: first.modelID,
    source: 'opencode-provider-default',
  }
}
