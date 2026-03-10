// HTML action registry for rendered Discord components.
// Stores short-lived button callbacks by generated id so HTML-backed UI can
// attach interactions without leaking closures across rerenders.

import crypto from 'node:crypto'
import { PLATFORM_COMPONENT_TYPE } from './platform/components-v2.js'
import { PLATFORM_MESSAGE_FLAGS } from './platform/message-flags.js'
import { createLogger } from './logger.js'
import { notifyError } from './sentry.js'
import type { ButtonEvent } from './platform/types.js'

const logger = createLogger('HTML_ACT')
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

type PendingHtmlAction = {
  actionId: string
  ownerKey: string
  threadId?: string
  resolved: boolean
  timer: ReturnType<typeof setTimeout>
  run: ({ interaction }: { interaction: ButtonEvent }) => Promise<void>
}

export const pendingHtmlActions = new Map<string, PendingHtmlAction>()
const actionIdsByOwner = new Map<string, Set<string>>()

export function buildHtmlActionCustomId(actionId: string): string {
  return `html_action:${actionId}`
}

export function registerHtmlAction({
  ownerKey,
  threadId,
  run,
  ttlMs = DEFAULT_TTL_MS,
}: {
  ownerKey: string
  threadId?: string
  run: ({ interaction }: { interaction: ButtonEvent }) => Promise<void>
  ttlMs?: number
}): string {
  const actionId = crypto.randomBytes(8).toString('hex')
  const timer = setTimeout(() => {
    resolveHtmlAction({ actionId })
  }, ttlMs)

  pendingHtmlActions.set(actionId, {
    actionId,
    ownerKey,
    threadId,
    resolved: false,
    timer,
    run,
  })

  const ownerActionIds = actionIdsByOwner.get(ownerKey) ?? new Set<string>()
  ownerActionIds.add(actionId)
  actionIdsByOwner.set(ownerKey, ownerActionIds)
  return actionId
}

export function cancelHtmlActionsForOwner(ownerKey: string): number {
  const actionIds = actionIdsByOwner.get(ownerKey)
  if (!actionIds) {
    return 0
  }

  let cancelled = 0
  for (const actionId of actionIds) {
    const resolved = resolveHtmlAction({ actionId })
    if (!resolved) {
      continue
    }
    cancelled++
  }

  return cancelled
}

export function cancelHtmlActionsForThread(threadId: string): number {
  let cancelled = 0

  for (const [actionId, action] of pendingHtmlActions) {
    if (action.threadId !== threadId) {
      continue
    }

    const resolved = resolveHtmlAction({ actionId })
    if (!resolved) {
      continue
    }
    cancelled++
  }

  return cancelled
}

export async function handleHtmlActionButton(
  interaction: ButtonEvent,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('html_action:')) {
    return
  }

  const actionId = customId.slice('html_action:'.length)
  if (!actionId) {
    await interaction.reply({
      content: 'Invalid action button.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  const action = pendingHtmlActions.get(actionId)
  if (!action || action.resolved) {
    await interaction.reply({
      content: 'This action is no longer available.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  await interaction.deferUpdate()
  const resolvedAction = resolveHtmlAction({ actionId })
  if (!resolvedAction) {
    return
  }

  try {
    await resolvedAction.run({ interaction })
  } catch (error) {
    logger.error('[HTML_ACTION] Failed to run action:', error)
    void notifyError(error, 'HTML action button failed')
    await interaction
      .editReply({
        components: [
          {
            type: PLATFORM_COMPONENT_TYPE.TEXT_DISPLAY,
            content: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        flags: PLATFORM_MESSAGE_FLAGS.IS_COMPONENTS_V2,
      })
      .catch(() => {
        return undefined
      })
  }
}

function resolveHtmlAction({
  actionId,
}: {
  actionId: string
}): PendingHtmlAction | undefined {
  const action = pendingHtmlActions.get(actionId)
  if (!action || action.resolved) {
    return undefined
  }

  action.resolved = true
  clearTimeout(action.timer)
  pendingHtmlActions.delete(actionId)

  const ownerActionIds = actionIdsByOwner.get(action.ownerKey)
  ownerActionIds?.delete(actionId)
  if (ownerActionIds && ownerActionIds.size === 0) {
    actionIdsByOwner.delete(action.ownerKey)
  }

  return action
}
