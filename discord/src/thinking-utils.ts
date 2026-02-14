export type ThinkingProvider = {
  id: string
  models?: Record<string, unknown>
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
