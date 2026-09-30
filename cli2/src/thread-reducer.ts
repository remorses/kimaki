// Pure fold of OpenCode V2 events into one Discord thread view (spec 27.3).
// reduce() never touches Discord, OpenCode, SQLite or the clock: timestamps
// come from event envelopes. It returns the next view plus the Discord
// effects to run. The event loop is the only caller in production; tests
// replay recorded fixtures through it.
//
// A thread shows its root session plus the subagent sessions it spawned:
//
//   root   text, tool lines, banner, footer, retries, errors
//   child  foreground: tool lines labelled "┣ general ⋅ glob ..."
//          background: no tool lines, one "⬦ general finished: ..." line
//          never text, banner or footer
//
// busy = root execution running OR any child running (29.2 #3). Typing
// follows busy; the footer waits until nothing runs.

import type { JsonValue, V2Event } from '@opencode/client'

import type { Verbosity } from './db.ts'
import {
  formatBanner,
  type ToolInput,
  formatError,
  formatFooter,
  formatRetry,
  formatSubagentFinished,
  formatToolFailed,
  formatToolLine,
  isToolVisible,
  type ModelRef,
} from './format-parts.ts'

export type Turn = {
  startedAt: number
  model: ModelRef | null
  agent: string | null
  // Tokens of the last finished step: the context size the model saw.
  tokens: number
}

export type Child = {
  agent: string
  description: string
  background: boolean
  running: boolean
}

export type ThreadView = {
  threadId: string
  sessionId: string
  folder: string
  branch: string | null
  // True only for sessions this bot created: the first step shows a banner.
  bannerPending: boolean
  // Root execution in progress.
  turn: Turn | null
  // Tool names by "assistantMessageID:toolID": session.tool.called has none.
  toolNames: Readonly<Record<string, string>>
  // Parent subagent calls whose child session is not known yet.
  subagentCalls: Readonly<Record<string, { agent: string; description: string; background: boolean }>>
  children: Readonly<Record<string, Child>>
  // Blank line between text and tool blocks.
  lastKind: 'text' | 'tool' | null
  lastRetryAt: number | null
}

export type Effect =
  // Bot-formatted Discord content (tool lines, banner, footer, errors).
  | { type: 'send'; text: string }
  // Model markdown, rendered and split by the executor.
  | { type: 'markdown'; text: string; blankLineBefore: boolean }
  | { type: 'typing'; on: boolean }

// Internal events produced by the event loop, folded through the same path.
export type KimakiEvent =
  | { type: 'kimaki.branch'; branch: string | null }
  // After a (re)connect: which sessions of this thread run right now.
  | { type: 'kimaki.synced'; activeSessionIds: readonly string[]; at: number }
  // A session found by walking parentID after a bot restart.
  | { type: 'kimaki.child'; sessionId: string; agent: string }

export type ThreadEvent = V2Event | KimakiEvent

export type Prefs = {
  verbosity: Verbosity
  // "providerID/modelID" -> context window size in tokens.
  contextLimits: Readonly<Record<string, number>>
}

const RETRY_NOTICE_INTERVAL_MS = 10_000

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
  return {
    threadId,
    sessionId,
    folder,
    branch: null,
    bannerPending: isNew,
    turn: null,
    toolNames: {},
    subagentCalls: {},
    children: {},
    lastKind: null,
    lastRetryAt: null,
  }
}

export function isBusy(view: ThreadView): boolean {
  return view.turn !== null || Object.values(view.children).some((child) => child.running)
}

export function eventSessionId(event: V2Event): string | null {
  // Global events (project.updated, shell.created, ...) have no sessionID.
  const data: { readonly [key: string]: JsonValue | undefined } = event.data
  return typeof data['sessionID'] === 'string' ? data['sessionID'] : null
}

type Result = { view: ThreadView; effects: Effect[] }

function toolKey(data: { assistantMessageID: string; id: string }): string {
  return `${data.assistantMessageID}:${data.id}`
}

function newTurn(at: number): Turn {
  return { startedAt: at, model: null, agent: null, tokens: 0 }
}

function contextPercent({ turn, prefs }: { turn: Turn; prefs: Prefs }): number | null {
  if (!turn.model || turn.tokens <= 0) return null
  const limit = prefs.contextLimits[`${turn.model.providerID}/${turn.model.id}`]
  if (!limit || limit <= 0) return null
  return Math.round((turn.tokens / limit) * 100)
}

function stringInput(input: ToolInput, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

// Posts a tool-kind line, with a blank line when the previous block was text.
function toolLine({ view, text }: { view: ThreadView; text: string }): Result {
  const lead = view.lastKind === 'text' ? '\n' : ''
  return { view: { ...view, lastKind: 'tool' }, effects: [{ type: 'send', text: `${lead}${text}` }] }
}

function addChild({ view, sessionId, child }: { view: ThreadView; sessionId: string; child: Child }): ThreadView {
  return { ...view, children: { ...view.children, [sessionId]: child } }
}

// Tool events shared by root and children. `label` is set for children.
function reduceTool({
  view,
  event,
  prefs,
  label,
}: {
  view: ThreadView
  event: V2Event
  prefs: Prefs
  label: string | undefined
}): Result | null {
  switch (event.type) {
    case 'session.tool.input.started':
      return { view: { ...view, toolNames: { ...view.toolNames, [toolKey(event.data)]: event.data.name } }, effects: [] }
    case 'session.tool.called': {
      const name = view.toolNames[toolKey(event.data)] ?? 'tool'
      const input = event.data.input
      const next =
        name === 'subagent' && typeof input['sessionID'] !== 'string'
          ? {
              ...view,
              subagentCalls: {
                ...view.subagentCalls,
                [toolKey(event.data)]: {
                  agent: stringInput(input, 'agent') || 'subagent',
                  description: stringInput(input, 'description'),
                  background: input['background'] === true,
                },
              },
            }
          : view
      // Reusing a child session: its mode and label follow the new call.
      const reused =
        name === 'subagent' && typeof input['sessionID'] === 'string' && next.children[input['sessionID']]
          ? addChild({
              view: next,
              sessionId: input['sessionID'],
              child: {
                ...next.children[input['sessionID']]!,
                agent: stringInput(input, 'agent') || next.children[input['sessionID']]!.agent,
                background: input['background'] === true,
                description: stringInput(input, 'description'),
              },
            })
          : next
      if (!isToolVisible({ name, input }, prefs.verbosity)) return { view: reused, effects: [] }
      return toolLine({ view: reused, text: formatToolLine({ name, input }, { label }) })
    }
    case 'session.tool.progress': {
      const childId = event.data.metadata['sessionID']
      const call = view.subagentCalls[toolKey(event.data)]
      if (typeof childId !== 'string' || !call) return { view, effects: [] }
      const existing = view.children[childId]
      const linked = addChild({
        view,
        sessionId: childId,
        child: {
          agent: call.agent,
          description: call.description,
          background: call.background,
          running: existing?.running ?? false,
        },
      })
      return { view: { ...linked, subagentCalls: withoutKey(linked.subagentCalls, toolKey(event.data)) }, effects: [] }
    }
    case 'session.tool.success':
      return {
        view: {
          ...view,
          toolNames: withoutKey(view.toolNames, toolKey(event.data)),
          subagentCalls: withoutKey(view.subagentCalls, toolKey(event.data)),
        },
        effects: [],
      }
    case 'session.tool.failed': {
      const name = view.toolNames[toolKey(event.data)] ?? 'tool'
      const next = {
        ...view,
        toolNames: withoutKey(view.toolNames, toolKey(event.data)),
        subagentCalls: withoutKey(view.subagentCalls, toolKey(event.data)),
      }
      if (event.data.error.type === 'aborted' || name === 'question' || name.startsWith('kimaki_')) {
        return { view: next, effects: [] }
      }
      return toolLine({ view: next, text: formatToolFailed({ name, message: event.data.error.message, label }) })
    }
    default:
      return null
  }
}

function reduceChild({
  view,
  event,
  sessionId,
  prefs,
}: {
  view: ThreadView
  event: V2Event
  sessionId: string
  prefs: Prefs
}): Result {
  const child = view.children[sessionId]
  if (!child) return { view, effects: [] }
  switch (event.type) {
    case 'session.execution.started':
      return { view: addChild({ view, sessionId, child: { ...child, running: true } }), effects: [] }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const next = addChild({ view, sessionId, child: { ...child, running: false } })
      if (!child.background || event.type !== 'session.execution.succeeded') return { view: next, effects: [] }
      return toolLine({ view: next, text: formatSubagentFinished({ agent: child.agent, description: child.description }) })
    }
    default: {
      const result = reduceTool({ view, event, prefs, label: child.agent }) ?? { view, effects: [] }
      // Background children post no tool lines: they would interleave with later turns.
      if (child.background) return { view: { ...result.view, lastKind: view.lastKind }, effects: [] }
      return result
    }
  }
}

function footerResult({ view, created, prefs }: { view: ThreadView; created: number; prefs: Prefs }): Result {
  const turn = view.turn
  const next = { ...view, turn: null, lastKind: null }
  if (!turn) return { view: next, effects: [] }
  // A child still runs: the answer comes in a later parent execution.
  if (Object.values(view.children).some((child) => child.running)) return { view: next, effects: [] }
  const footer = formatFooter({
    folder: view.folder,
    branch: view.branch,
    durationMs: created - turn.startedAt,
    contextPercent: contextPercent({ turn, prefs }),
    model: turn.model,
    agent: turn.agent,
  })
  return { view: next, effects: [{ type: 'send', text: footer }] }
}

function reduceRoot({ view, event, prefs }: { view: ThreadView; event: V2Event; prefs: Prefs }): Result {
  const none = { view, effects: [] }
  switch (event.type) {
    case 'session.execution.started':
      return view.turn ? none : { view: { ...view, turn: newTurn(event.created) }, effects: [] }
    case 'session.step.started': {
      const model = { providerID: event.data.model.providerID, id: event.data.model.id }
      const turn = view.turn ?? newTurn(event.created)
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
      return {
        view: { ...view, lastKind: 'text' },
        effects: [{ type: 'markdown', text, blankLineBefore: view.lastKind === 'tool' }],
      }
    }
    case 'session.retry.scheduled': {
      if (view.lastRetryAt !== null && event.created - view.lastRetryAt < RETRY_NOTICE_INTERVAL_MS) return none
      return {
        view: { ...view, lastRetryAt: event.created },
        effects: [{ type: 'send', text: formatRetry({ attempt: event.data.attempt, delayMs: event.data.at - event.created }) }],
      }
    }
    case 'session.execution.succeeded':
      return footerResult({ view, created: event.created, prefs })
    case 'session.execution.failed':
      return {
        view: { ...view, turn: null, lastKind: null },
        effects: [{ type: 'send', text: formatError(event.data.error.message) }],
      }
    case 'session.execution.interrupted':
      return { view: { ...view, turn: null, lastKind: null }, effects: [] }
    default:
      return reduceTool({ view, event, prefs, label: undefined }) ?? none
  }
}

function reduceKimaki({ view, event }: { view: ThreadView; event: KimakiEvent }): Result {
  switch (event.type) {
    case 'kimaki.branch':
      return { view: { ...view, branch: event.branch }, effects: [] }
    case 'kimaki.child': {
      if (view.children[event.sessionId]) return { view, effects: [] }
      const child = { agent: event.agent, description: '', background: false, running: false }
      return { view: addChild({ view, sessionId: event.sessionId, child }), effects: [] }
    }
    case 'kimaki.synced': {
      // Executions that started or ended while disconnected. Their footer is lost.
      const active = new Set(event.activeSessionIds)
      const children = Object.fromEntries(
        Object.entries(view.children).map(([id, child]) => [id, { ...child, running: active.has(id) }]),
      )
      const rootActive = active.has(view.sessionId)
      const turn = rootActive ? (view.turn ?? newTurn(event.at)) : null
      return { view: { ...view, children, turn }, effects: [] }
    }
  }
}

// A subagent session is created, then the parent's tool.progress (with
// metadata.sessionID) links it to the exact call, before any child tool event
// (29.2 #4, verified in task-subagent and task-parallel fixtures). Creation only
// registers the child; the progress event sets label and mode.
function registerChild({ view, event }: { view: ThreadView; event: V2Event }): ThreadView {
  if (event.type !== 'session.created') return view
  const parentId = event.data.parentID
  if (!parentId || view.children[event.data.sessionID]) return view
  if (parentId !== view.sessionId && !view.children[parentId]) return view
  const child = { agent: event.data.agent ?? 'subagent', description: '', background: false, running: false }
  return addChild({ view, sessionId: event.data.sessionID, child })
}

function reduceEvent({ view, event, prefs }: { view: ThreadView; event: ThreadEvent; prefs: Prefs }): Result {
  if (event.type === 'kimaki.branch' || event.type === 'kimaki.synced' || event.type === 'kimaki.child') {
    return reduceKimaki({ view, event })
  }
  if (event.type === 'session.created') return { view: registerChild({ view, event }), effects: [] }
  const sessionId = eventSessionId(event)
  if (sessionId === view.sessionId) return reduceRoot({ view, event, prefs })
  if (sessionId && view.children[sessionId]) return reduceChild({ view, event, sessionId, prefs })
  return { view, effects: [] }
}

export function reduce({ view, event, prefs }: { view: ThreadView; event: ThreadEvent; prefs: Prefs }): Result {
  const result = reduceEvent({ view, event, prefs })
  const wasBusy = isBusy(view)
  const busy = isBusy(result.view)
  if (wasBusy === busy) return result
  // Typing goes first: on before the banner, off before the footer.
  return { view: result.view, effects: [{ type: 'typing', on: busy }, ...result.effects] }
}
