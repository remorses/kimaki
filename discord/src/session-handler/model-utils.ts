// Model resolution utilities.
// getDefaultModel resolves the default model from OpenCode when no user preference is set.
// Extracted from session-handler.ts during Phase 5 migration.

import fs from 'node:fs'
import path from 'node:path'
import { xdgState } from 'xdg-basedir'
import * as errore from 'errore'
import { type initializeOpencodeForDirectory } from '../opencode.js'
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
function parseModelString(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = model.split('/')
  const modelID = modelParts.join('/')
  if (!providerID || !modelID) {
    return undefined
  }
  return { providerID, modelID }
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
}: {
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
}): Promise<
  | { providerID: string; modelID: string; source: DefaultModelSource }
  | undefined
> {
  if (getClient instanceof Error) {
    return undefined
  }

  // Fetch connected providers to validate any model we return
  const providersResponse = await errore.tryAsync(() => {
    return getClient().provider.list({})
  })
  if (providersResponse instanceof Error) {
    sessionLogger.log(
      `[MODEL] Failed to fetch providers for default model:`,
      providersResponse.message,
    )
    return undefined
  }
  if (!providersResponse.data) {
    return undefined
  }

  const {
    connected,
    default: defaults,
    all: providers,
  } = providersResponse.data
  if (connected.length === 0) {
    sessionLogger.log(`[MODEL] No connected providers found`)
    return undefined
  }

  // 1. Check OpenCode config.model setting (highest priority after user preference)
  const configResponse = await errore.tryAsync(() => {
    return getClient().config.get({})
  })
  if (!(configResponse instanceof Error) && configResponse.data?.model) {
    const configModel = parseModelString(configResponse.data.model)
    if (configModel && isModelValid(configModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using config model: ${configModel.providerID}/${configModel.modelID}`,
      )
      return { ...configModel, source: 'opencode-config' }
    }
    if (configModel) {
      sessionLogger.log(
        `[MODEL] Config model ${configResponse.data.model} not available, checking recent`,
      )
    }
  }

  // 2. Try to use user's recent models from TUI state (iterate until finding valid one)
  const recentModels = getRecentModelsFromTuiState()
  for (const recentModel of recentModels) {
    if (isModelValid(recentModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using recent TUI model: ${recentModel.providerID}/${recentModel.modelID}`,
      )
      return { ...recentModel, source: 'opencode-recent' }
    }
  }
  if (recentModels.length > 0) {
    sessionLogger.log(`[MODEL] No valid recent TUI models found`)
  }

  // 3. Fall back to first connected provider's default model
  const firstConnected = connected[0]
  if (!firstConnected) {
    return undefined
  }
  const defaultModelId = defaults[firstConnected]
  if (!defaultModelId) {
    sessionLogger.log(`[MODEL] No default model for provider ${firstConnected}`)
    return undefined
  }

  sessionLogger.log(
    `[MODEL] Using provider default: ${firstConnected}/${defaultModelId}`,
  )
  return {
    providerID: firstConnected,
    modelID: defaultModelId,
    source: 'opencode-provider-default',
  }
}
