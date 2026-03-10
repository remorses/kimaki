// Encodes and decodes component metadata into Slack action_id values.

import { ComponentType } from 'discord-api-types/v10'

const ACTION_PREFIX = 'dsbcmp'

export function encodeComponentActionId({
  componentType,
  customId,
}: {
  componentType: ComponentType
  customId: string
}): string {
  return `${ACTION_PREFIX}:${componentType}:${customId}`
}

export function decodeComponentActionId(actionId: string): {
  componentType?: ComponentType
  customId: string
} {
  const parts = actionId.split(':')
  if (parts.length < 3 || parts[0] !== ACTION_PREFIX) {
    return { customId: actionId }
  }

  const componentType = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(componentType)) {
    return { customId: actionId }
  }

  return {
    componentType: componentType as ComponentType,
    customId: parts.slice(2).join(':'),
  }
}
