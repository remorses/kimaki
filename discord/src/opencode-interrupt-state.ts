// Pure state reducer/helpers for queued-message interrupt handling.
// Keeps track of whether queued user messages have started (sent) based on
// OpenCode events, independent of timers and side effects.

import type { Plugin } from '@opencode-ai/plugin'

type PluginHooks = Awaited<ReturnType<Plugin>>

export type InterruptEvent = Parameters<
  NonNullable<PluginHooks['event']>
>[0]['event']

export type PendingInterruptMessage = {
  sessionID: string
  messageID: string
  sent: boolean
}

export type InterruptState = {
  pendingByMessageId: Record<string, PendingInterruptMessage>
}

export type InterruptAction =
  | { type: 'queue'; sessionID: string; messageID: string }
  | { type: 'event'; event: InterruptEvent }
  | { type: 'clear-message'; messageID: string }

export function createInterruptState(): InterruptState {
  return {
    pendingByMessageId: {},
  }
}

export function reduceInterruptState({
  state,
  action,
}: {
  state: InterruptState
  action: InterruptAction
}): InterruptState {
  if (action.type === 'queue') {
    if (state.pendingByMessageId[action.messageID]) {
      return state
    }
    return {
      pendingByMessageId: {
        ...state.pendingByMessageId,
        [action.messageID]: {
          sessionID: action.sessionID,
          messageID: action.messageID,
          sent: false,
        },
      },
    }
  }

  if (action.type === 'clear-message') {
    if (!state.pendingByMessageId[action.messageID]) {
      return state
    }
    const next = { ...state.pendingByMessageId }
    delete next[action.messageID]
    return {
      pendingByMessageId: next,
    }
  }

  const event = action.event
  if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
    const parentID = event.properties.info.parentID
    const pending = state.pendingByMessageId[parentID]
    if (!pending || pending.sent) {
      return state
    }
    return {
      pendingByMessageId: {
        ...state.pendingByMessageId,
        [parentID]: {
          ...pending,
          sent: true,
        },
      },
    }
  }

  if (event.type !== 'session.deleted') {
    return state
  }

  const sessionID = event.properties.info.id
  const remaining = Object.values(state.pendingByMessageId).filter((pending) => {
    return pending.sessionID !== sessionID
  })
  if (remaining.length === Object.keys(state.pendingByMessageId).length) {
    return state
  }
  const pendingByMessageId: Record<string, PendingInterruptMessage> = {}
  remaining.forEach((pending) => {
    pendingByMessageId[pending.messageID] = pending
  })
  return {
    pendingByMessageId,
  }
}

export function getPendingInterruptMessage({
  state,
  messageID,
}: {
  state: InterruptState
  messageID: string
}): PendingInterruptMessage | undefined {
  return state.pendingByMessageId[messageID]
}

export function listPendingMessageIdsForSession({
  state,
  sessionID,
}: {
  state: InterruptState
  sessionID: string
}): string[] {
  return Object.values(state.pendingByMessageId)
    .filter((pending) => {
      return pending.sessionID === sessionID
    })
    .map((pending) => {
      return pending.messageID
    })
}

export function hasUnsentPendingMessage({
  state,
  messageID,
}: {
  state: InterruptState
  messageID: string
}): boolean {
  const pending = getPendingInterruptMessage({ state, messageID })
  if (!pending) {
    return false
  }
  return !pending.sent
}

export function hasUnsentPendingForSession({
  state,
  sessionID,
}: {
  state: InterruptState
  sessionID: string
}): boolean {
  return listPendingMessageIdsForSession({ state, sessionID }).some((messageID) => {
    return hasUnsentPendingMessage({ state, messageID })
  })
}
