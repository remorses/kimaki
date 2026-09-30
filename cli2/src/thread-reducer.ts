// Pure fold of OpenCode V2 events into one Discord thread view (spec 27.3).
// reduce() never touches Discord, OpenCode, SQLite or the clock: timestamps
// come from event envelopes. It returns the next view plus the Discord
// effects to run. The event loop is the only caller in production; tests
// replay recorded fixtures through it.

import type { V2Event } from '@opencode/client'

import type { Verbosity } from './db.ts'
import { formatBanner, formatError, formatFooter, type ModelRef } from './format-parts.ts'

export type Turn = {
  startedAt: number
  model: ModelRef | null
  agent: string | null
  // Tokens of the last finished step: the context size the model saw.
  tokens: number
}

export type ThreadView = {
  threadId: string
  sessionId: string
  folder: string
  branch: string | null
  // True only for sessions this bot created: the first step shows a banner.
  bannerPending: boolean
  turn: Turn | null
}

export type Effect =
  | { type: 'send'; text: string }
  | { type: 'typing'; on: boolean }

// Internal events produced by the event loop, folded through the same path.
export type KimakiEvent =
  | { type: 'kimaki.branch'; branch: string | null }
  // After a (re)connect: whether the root session is running right now.
  | { type: 'kimaki.synced'; active: boolean; at: number }

export type ThreadEvent = V2Event | KimakiEvent

export type Prefs = {
  verbosity: Verbosity
  // "providerID/modelID" -> context window size in tokens.
  contextLimits: Readonly<Record<string, number>>
}

export function emptyView({
  threadId,
  sessionId,
  folder,
  isNew,
}: {
  threadId: string
  sessionId: string
  folder: string
  isNew: boolean
}): ThreadView {
  return { threadId, sessionId, folder, branch: null, bannerPending: isNew, turn: null }
}

export function isBusy(view: ThreadView): boolean {
  return view.turn !== null
}

function contextPercent({ turn, prefs }: { turn: Turn; prefs: Prefs }): number | null {
  if (!turn.model || turn.tokens <= 0) return null
  const limit = prefs.contextLimits[`${turn.model.providerID}/${turn.model.id}`]
  if (!limit || limit <= 0) return null
  return Math.round((turn.tokens / limit) * 100)
}

type Result = { view: ThreadView; effects: Effect[] }

function reduceRoot(view: ThreadView, event: V2Event, prefs: Prefs): Result {
  const none = { view, effects: [] }
  switch (event.type) {
    case 'session.execution.started': {
      if (view.turn) return none
      return {
        view: { ...view, turn: { startedAt: event.created, model: null, agent: null, tokens: 0 } },
        effects: [{ type: 'typing', on: true }],
      }
    }
    case 'session.step.started': {
      const model = { providerID: event.data.model.providerID, id: event.data.model.id }
      const turn = view.turn ?? { startedAt: event.created, model: null, agent: null, tokens: 0 }
      const next = { ...view, bannerPending: false, turn: { ...turn, model, agent: event.data.agent } }
      if (!view.bannerPending) return { view: next, effects: [] }
      return { view: next, effects: [{ type: 'send', text: formatBanner({ model, agent: event.data.agent }) }] }
    }
    case 'session.step.ended': {
      if (!view.turn) return none
      const { tokens } = event.data
      const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
      return { view: { ...view, turn: { ...view.turn, tokens: total } }, effects: [] }
    }
    case 'session.text.ended': {
      const text = event.data.text.trim()
      if (!text) return none
      return { view, effects: [{ type: 'send', text }] }
    }
    case 'session.execution.succeeded': {
      const turn = view.turn
      if (!turn) return none
      const footer = formatFooter({
        folder: view.folder,
        branch: view.branch,
        durationMs: event.created - turn.startedAt,
        contextPercent: contextPercent({ turn, prefs }),
        model: turn.model,
        agent: turn.agent,
      })
      return {
        view: { ...view, turn: null },
        effects: [
          { type: 'typing', on: false },
          { type: 'send', text: footer },
        ],
      }
    }
    case 'session.execution.failed': {
      return {
        view: { ...view, turn: null },
        effects: [
          { type: 'typing', on: false },
          { type: 'send', text: formatError(event.data.error.message) },
        ],
      }
    }
    case 'session.execution.interrupted': {
      return { view: { ...view, turn: null }, effects: [{ type: 'typing', on: false }] }
    }
    default:
      return none
  }
}

function reduceKimaki(view: ThreadView, event: KimakiEvent): Result {
  switch (event.type) {
    case 'kimaki.branch':
      return { view: { ...view, branch: event.branch }, effects: [] }
    case 'kimaki.synced': {
      if (event.active && !view.turn) {
        return {
          view: { ...view, turn: { startedAt: event.at, model: null, agent: null, tokens: 0 } },
          effects: [{ type: 'typing', on: true }],
        }
      }
      // The execution ended while we were disconnected: its footer is lost.
      if (!event.active && view.turn) {
        return { view: { ...view, turn: null }, effects: [{ type: 'typing', on: false }] }
      }
      return { view, effects: [] }
    }
  }
}

export function eventSessionId(event: V2Event): string | null {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('sessionID' in data)) return null
  return typeof data.sessionID === 'string' ? data.sessionID : null
}

function isKimakiEvent(event: ThreadEvent): event is KimakiEvent {
  return event.type === 'kimaki.branch' || event.type === 'kimaki.synced'
}

export function reduce(view: ThreadView, event: ThreadEvent, prefs: Prefs): Result {
  if (isKimakiEvent(event)) return reduceKimaki(view, event)
  if (eventSessionId(event) !== view.sessionId) return { view, effects: [] }
  return reduceRoot(view, event, prefs)
}
