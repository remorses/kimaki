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

import type {
  FormInfo,
  JsonValue,
  PermissionRequest,
  SessionInboxInfo,
  SessionMessageInfo,
  V2Event,
} from '@opencode/client'

import type { Verbosity } from './db.ts'
import {
  asSubtext,
  formatBanner,
  type ToolInput,
  formatError,
  formatFooter,
  formatRetry,
  formatShellEnded,
  formatShellStarted,
  formatSubagentFinished,
  formatToolFailed,
  formatToolLine,
  isToolVisible,
  type ModelRef,
} from './format-parts.ts'
import { hydratePermissions, reducePermissions, type PendingPermission } from './permissions.ts'
import { hydrateForms, reduceForms, type PendingForm } from './questions.ts'
import { hydrateQueue, reduceQueue, type QueuedItem } from './queue.ts'
import type { UiEffect } from './effects.ts'
import { reduceAgentUi, type AgentPrompt, type AgentUiEvent } from './agent-ui.ts'

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
  shellCalls: Readonly<Record<string, { sessionId: string }>>
  agentUi: readonly AgentPrompt[]
  // Parent subagent calls whose child session is not known yet.
  subagentCalls: Readonly<Record<string, { agent: string; description: string; background: boolean }>>
  children: Readonly<Record<string, Child>>
  // Blank line between text and tool blocks.
  lastKind: 'text' | 'tool' | null
  lastRetryAt: number | null
  // Root inbox: user items not delivered yet, and the queued ones among them.
  inputs: readonly string[]
  queue: readonly QueuedItem[]
  // Questions and permission requests waiting for the user (root and children).
  forms: Readonly<Record<string, PendingForm>>
  permissions: Readonly<Record<string, PendingPermission>>
}

export type Effect =
  // Bot-formatted Discord content (tool lines, banner, footer, errors).
  | { type: 'send'; text: string }
  // Model markdown, rendered and split by the executor.
  | { type: 'markdown'; text: string; blankLineBefore: boolean }
  | { type: 'typing'; on: boolean }
  | { type: 'attachments'; files: readonly { path: string; name: string }[] }
  | UiEffect

// Internal events produced by the event loop, folded through the same path.
export type KimakiEvent = AgentUiEvent
  | { type: 'kimaki.upload'; files: readonly { path: string; name: string }[] }
  | { type: 'kimaki.branch'; branch: string | null }
  // After a (re)connect: which sessions of this thread run right now.
  | { type: 'kimaki.synced'; activeSessionIds: readonly string[]; at: number }
  // A session found by walking parentID after a bot restart.
  | { type: 'kimaki.child'; sessionId: string; agent: string }
  // An action failed after it returned (a `!cmd` request): shown as an error line.
  | { type: 'kimaki.error'; message: string }
  // History of a resumed or forked session, oldest first, then a closing note.
  | { type: 'kimaki.replay'; messages: readonly SessionMessageInfo[]; note: string }
  // After a (re)connect: what one session of the thread waits on right now.
  // `inbox` only for the root session.
  | {
      type: 'kimaki.hydrated'
      sessionId: string
      inbox: readonly SessionInboxInfo[] | null
      forms: readonly FormInfo[]
      permissions: readonly PermissionRequest[]
    }

export type ThreadEvent = V2Event | KimakiEvent

const KIMAKI_EVENT_TYPES: ReadonlySet<string> = new Set<KimakiEvent['type']>([
  'kimaki.branch',
  'kimaki.synced',
  'kimaki.child',
  'kimaki.hydrated',
  'kimaki.error',
  'kimaki.replay',
  'kimaki.agent-ui',
  'kimaki.agent-ui-dismiss',
  'kimaki.upload',
])

function isKimakiEvent(event: ThreadEvent): event is KimakiEvent {
  return KIMAKI_EVENT_TYPES.has(event.type)
}

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
    shellCalls: {},
    agentUi: [],
    subagentCalls: {},
    children: {},
    lastKind: null,
    lastRetryAt: null,
    inputs: [],
    queue: [],
    forms: {},
    permissions: {},
  }
}

export function isBusy(view: ThreadView): boolean {
  return view.turn !== null || Object.values(view.children).some((child) => child.running)
}

// Typing stops while the agent waits for the user (spec 6.6).
function isTyping(view: ThreadView): boolean {
  return isBusy(view) && Object.keys(view.forms).length === 0 && Object.keys(view.permissions).length === 0
}

export function eventSessionId(event: V2Event): string | null {
  if (event.type === 'form.created') return event.data.form.sessionID
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
      view = name === 'shell' ? { ...view, shellCalls: { ...view.shellCalls, [toolKey(event.data)]: { sessionId: event.data.sessionID } } } : view
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
          shellCalls: withoutKey(view.shellCalls, toolKey(event.data)),
          subagentCalls: withoutKey(view.subagentCalls, toolKey(event.data)),
        },
        effects: [],
      }
    case 'session.tool.failed': {
      const name = view.toolNames[toolKey(event.data)] ?? 'tool'
      const next = {
        ...view,
        toolNames: withoutKey(view.toolNames, toolKey(event.data)),
        shellCalls: withoutKey(view.shellCalls, toolKey(event.data)),
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
  // No model step ran (a compaction-only execution): nothing to summarize.
  if (!turn?.model) return { view: next, effects: [] }
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
        effects: [
          {
            type: 'send',
            text: formatRetry({
              attempt: event.data.attempt,
              delayMs: event.data.at - event.created,
              message: event.data.error.message,
            }),
          },
        ],
      }
    }
    // User `!cmd` (session.shell): shown at every verbosity.
    case 'session.shell.started':
      return toolLine({ view, text: formatShellStarted(event.data.shell.command) })
    case 'session.shell.ended':
      return {
        view: { ...view, lastKind: 'tool' },
        effects: [
          {
            type: 'send',
            text: formatShellEnded({
              output: event.data.output.output,
              truncated: event.data.output.truncated,
              status: event.data.shell.status,
              exit: event.data.shell.exit ?? null,
            }),
          },
        ],
      }
    // `/compact` or automatic compaction when the context is full.
    case 'session.compaction.ended':
      return toolLine({ view, text: asSubtext('⬦ context compacted') })
    case 'session.compaction.failed':
      return toolLine({ view, text: formatError(`compaction failed: ${event.data.error.message}`) })
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
      return reduceQueue({ view, event, busy: isBusy(view) }) ?? reduceTool({ view, event, prefs, label: undefined }) ?? none
  }
}

const REPLAY_LIMIT = 30

// The last text and tool blocks of the assistant messages, like live output
// (V1 /resume and /fork showed the last 30 parts). User messages are skipped.
export function replayEffects({
  messages,
  prefs,
  note,
}: {
  messages: readonly SessionMessageInfo[]
  prefs: Prefs
  note: string
}): Effect[] {
  type Block = { kind: 'text' | 'tool'; text: string }
  const blocks = messages.flatMap((message): Block[] => {
    if (message.type !== 'assistant') return []
    return message.content.flatMap((part): Block[] => {
      if (part.type === 'text') return part.text.trim() ? [{ kind: 'text', text: part.text.trim() }] : []
      if (part.type !== 'tool' || typeof part.state.input === 'string') return []
      const call = { name: part.name, input: part.state.input }
      return isToolVisible(call, prefs.verbosity) ? [{ kind: 'tool', text: formatToolLine(call) }] : []
    })
  })
  const kept = blocks.slice(-REPLAY_LIMIT)
  const skipped = blocks.length - kept.length
  const effects = kept.map((block, index): Effect => {
    const previous = kept[index - 1]?.kind ?? null
    if (block.kind === 'text') return { type: 'markdown', text: block.text, blankLineBefore: previous === 'tool' }
    return { type: 'send', text: previous === 'text' ? `\n${block.text}` : block.text }
  })
  return [
    ...(skipped > 0 ? [{ type: 'send' as const, text: asSubtext(`Skipped ${skipped} older parts`) }] : []),
    ...effects,
    { type: 'send', text: note },
  ]
}

function reduceKimaki({ view, event, prefs }: { view: ThreadView; event: KimakiEvent; prefs: Prefs }): Result {
  switch (event.type) {
    case 'kimaki.upload':
      return { view, effects: [{ type: 'attachments', files: event.files }] }
    case 'kimaki.agent-ui':
    case 'kimaki.agent-ui-dismiss':
      return reduceAgentUi(view, event) ?? { view, effects: [] }
    case 'kimaki.replay':
      return { view: { ...view, lastKind: null }, effects: replayEffects({ messages: event.messages, prefs, note: event.note }) }
    case 'kimaki.error':
      return { view: { ...view, lastKind: null }, effects: [{ type: 'send', text: formatError(event.message) }] }
    case 'kimaki.hydrated': {
      const label = event.sessionId === view.sessionId ? null : (view.children[event.sessionId]?.agent ?? null)
      if (label === null && event.sessionId !== view.sessionId) return { view, effects: [] }
      const queued = event.inbox ? hydrateQueue({ view, inbox: event.inbox }) : { view, effects: [] }
      const forms = hydrateForms({ view: queued.view, sessionId: event.sessionId, forms: event.forms, label })
      const permissions = hydratePermissions({
        view: forms.view,
        sessionId: event.sessionId,
        requests: event.permissions,
        label,
      })
      return { view: permissions.view, effects: [...queued.effects, ...forms.effects, ...permissions.effects] }
    }
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
  if (isKimakiEvent(event)) return reduceKimaki({ view, event, prefs })
  if (event.type === 'session.created') return { view: registerChild({ view, event }), effects: [] }
  const sessionId = eventSessionId(event)
  if (!sessionId) return { view, effects: [] }
  const isRoot = sessionId === view.sessionId
  const child = view.children[sessionId]
  if (!isRoot && !child) return { view, effects: [] }
  // Questions and permissions of subagents show in this thread too.
  const label = child?.agent ?? null
  const interactive = reduceForms({ view, event, label }) ?? reducePermissions({ view, event, label })
  if (interactive) return interactive
  if (isRoot) return reduceRoot({ view, event, prefs })
  return reduceChild({ view, event, sessionId, prefs })
}

export function reduce({ view, event, prefs }: { view: ThreadView; event: ThreadEvent; prefs: Prefs }): Result {
  const ui = event.type === 'session.inbox.enqueued' ? reduceAgentUi(view, event) : null
  const folded = reduceEvent({ view: ui?.view ?? view, event, prefs })
  const result = { view: folded.view, effects: [...(ui?.effects ?? []), ...folded.effects] }
  const wasTyping = isTyping(view)
  const typing = isTyping(result.view)
  if (wasTyping === typing) return result
  // Typing goes first: on before the banner, off before the footer or a prompt.
  return { view: result.view, effects: [{ type: 'typing', on: typing }, ...result.effects] }
}
