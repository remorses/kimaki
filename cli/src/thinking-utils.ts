// Utilities for extracting and matching model variant (thinking level) values
// from the provider.list() API response. Used by model selector and session handler
// to validate variant preferences against what the current model actually supports.

export type ThinkingProvider = {
  id: string
  name?: string
  models?: Record<string, {
    name?: string
    variants?: Record<string, unknown>
    limit?: { context?: number }
  } | undefined>
}

function getModelVariants(model: unknown): Record<string, unknown> | undefined {
  if (!model || typeof model !== 'object') {
    return undefined
  }

  const variants = (model as { variants?: unknown }).variants
  if (!variants || typeof variants !== 'object') {
    return undefined
  }

  return variants as Record<string, unknown>
}

export type ListedModelForThinking = {
  providerID: string
  modelID: string
  name?: string
  variants?: Array<{ id: string }>
  limit?: { context?: number }
}

export function thinkingProvidersFromListedModels({
  models,
}: {
  models: ListedModelForThinking[]
}): ThinkingProvider[] {
  const byProvider = new Map<string, ThinkingProvider>()
  for (const model of models) {
    const provider = byProvider.get(model.providerID) ?? {
      id: model.providerID,
      name: model.providerID,
      models: {},
    }
    const variants = Object.fromEntries(
      (model.variants ?? []).map((variant) => [variant.id, variant]),
    )
    provider.models = {
      ...provider.models,
      [model.modelID]: {
        name: model.name,
        variants,
        limit: model.limit,
      },
    }
    byProvider.set(model.providerID, provider)
  }
  return [...byProvider.values()]
}

export function getThinkingValuesForModel({
  providers,
  providerId,
  modelId,
}: {
  providers: ThinkingProvider[]
  providerId: string
  modelId: string
}): string[] {
  const provider = providers.find((candidateProvider) => {
    return candidateProvider.id === providerId
  })
  const model = provider?.models?.[modelId]
  const variants = getModelVariants(model)
  if (!variants) {
    return []
  }

  return Object.keys(variants).filter((variant) => {
    return variant.trim().length > 0
  })
}

export function matchThinkingValue({
  requestedValue,
  availableValues,
}: {
  requestedValue: string
  availableValues: string[]
}): string | undefined {
  const normalizedRequestedValue = requestedValue.trim().toLowerCase()
  if (!normalizedRequestedValue) {
    return undefined
  }

  return availableValues.find((availableValue) => {
    return availableValue.toLowerCase() === normalizedRequestedValue
  })
}

export function resolveRequestedThinkingVariant({
  requestedValue,
  providers,
  providerId,
  modelId,
}: {
  requestedValue: string
  providers: ThinkingProvider[]
  providerId: string
  modelId: string
}): string | undefined {
  return matchThinkingValue({
    requestedValue,
    availableValues: getThinkingValuesForModel({
      providers,
      providerId,
      modelId,
    }),
  })
}
