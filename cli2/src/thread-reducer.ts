// Pure fold of OpenCode V2 events into one Discord thread view (spec 27.3).
// reduce() never touches Discord, OpenCode, SQLite or the clock: timestamps
// come from event envelopes. It returns the next view plus the Discord
// effects to run. The event loop is the only caller in production; tests
// replay recorded fixtures through it.
//
// Inside, every handler edits an immer draft and calls emit(); the caller
// still gets a new immutable view. Never emit a draft object: emit plain
// strings or objects built from the event.
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

import { ButtonStyle } from 'discord.js'
import { produce, type Draft } from 'immer'
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
  button,
  executeCalls,
  formatExecuteFailures,
  buttonRow,
  formatBanner,
  formatError,
  formatRetry,
  formatShellEnded,
  formatShellStarted,
  formatSubagentFinished,
  formatToolFailed,
  formatToolLine,
  isToolVisible,
  textOnly,
  type ModelRef,
  type ToolInput,
  type UiMessage,
} from './format-parts.ts'
import { closePermission, hydratePermissions, showPermission, STATUS, type PendingPermission } from './permissions.ts'
import { closeForm, formatAnswer, hydrateForms, showForm, withAnswer, type PendingForm } from './questions.ts'
import { cancelQueued, deliverQueued, enqueueInput, hydrateQueue, promoteQueued, type PendingInput } from './queue.ts'

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

// Buttons and upload requests from `kimaki buttons` / `kimaki upload-request` (agent-ui.ts).
export type AgentButton = { label: string; command?: string; color: 'white' | 'blue' | 'green' | 'red' }
export type AgentPrompt = { id: string; sessionId: string; buttons?: AgentButton[]; prompt?: string; maxFiles?: number }

// A tool call between session.tool.input.started and its success or failure.
export type ToolCall = {
  // session.tool.called has no name: it comes from input.started.
  name: string
  // 'called' after session.tool.called, when its tool line was posted.
  phase: 'input' | 'called'
  // A subagent call whose child session is not linked yet.
  subagent: { agent: string; description: string; background: boolean } | null
  // Code Mode `execute`: inner tool calls that already got a line.
  innerCalls: number
}

export type ThreadView = {
  sessionId: string
  // Project channel of the thread: its verbosity applies.
  channelId: string
  // Current working directory of the root session (session.moved changes it).
  directory: string
  // True only for sessions this bot created: the first step shows a banner.
  bannerPending: boolean
  // Root execution in progress.
  turn: Turn | null
  // Running tool calls of root and children by "assistantMessageID:toolID".
  tools: Readonly<Record<string, ToolCall>>
  agentUi: readonly AgentPrompt[]
  children: Readonly<Record<string, Child>>
  // Blank line between text and tool blocks.
  lastKind: 'text' | 'tool' | null
  lastRetryAt: number | null
  // Root inbox: user items not delivered yet, in order (queuedItems() for the queue).
  inbox: readonly PendingInput[]
  // Questions and permission requests waiting for the user (root and children).
  forms: Readonly<Record<string, PendingForm>>
  permissions: Readonly<Record<string, PendingPermission>>
}

export type Effect =
  // Bot-formatted Discord content (tool lines, banner, errors).
  | { type: 'send'; text: string }
  // Model markdown, rendered and split by the executor.
  | { type: 'markdown'; text: string; blankLineBefore: boolean }
  | { type: 'typing'; on: boolean }
  // Files from `kimaki upload-to-discord` (never from the reducer).
  | { type: 'attachments'; files: readonly { path: string; name: string }[] }
  // The executor adds folder and git branch of `directory` when it posts.
  | { type: 'footer'; directory: string; durationMs: number; contextPercent: number | null; model: ModelRef; agent: string | null }
  // Posts the messages in order; the first replies to `replyTo` when set.
  | { type: 'show'; key: string; messages: readonly UiMessage[]; replyTo: string | null }
  // Edits the messages `show` posted under `key` (by index; the last one covers the rest).
  | { type: 'edit'; key: string; messages: readonly UiMessage[] }

export type Emit = (effect: Effect) => void

// What one session of the thread runs and waits on now, read after a (re)connect.
export type SessionSnapshot = {
  sessionId: string
  // Only for the root session.
  inbox: readonly SessionInboxInfo[] | null
  forms: readonly FormInfo[]
  permissions: readonly PermissionRequest[]
}

// Internal events produced by the event loop, folded through the same path.
export type KimakiEvent =
  | { type: 'kimaki.agent-ui'; prompt: AgentPrompt }
  | { type: 'kimaki.agent-ui-dismiss'; id: string }
  // A session found by walking parentID after a bot restart.
  | { type: 'kimaki.child'; sessionId: string; agent: string }
  // History of a resumed or forked session, oldest first, then a closing note.
  | { type: 'kimaki.replay'; messages: readonly SessionMessageInfo[]; note: string }
  // After a (re)connect: which sessions of the thread run, and what they wait on.
  // `directory`: the root session's location now, null when it could not be read.
  | { type: 'kimaki.snapshot'; at: number; directory: string | null; activeSessionIds: readonly string[]; sessions: readonly SessionSnapshot[] }

export type ThreadEvent = V2Event | KimakiEvent

export function isKimakiEvent(event: ThreadEvent): event is KimakiEvent {
  return event.type.startsWith('kimaki.')
}

export type Prefs = {
  verbosity: Verbosity
  // "providerID/modelID" -> context window size in tokens.
  contextLimits: Readonly<Record<string, number>>
}

const RETRY_NOTICE_INTERVAL_MS = 10_000
const REPLAY_LIMIT = 30

export function emptyView({
  sessionId,
  channelId,
  directory,
  isNew,
}: {
  sessionId: string
  channelId: string
  directory: string
  isNew: boolean
}): ThreadView {
  return {
    sessionId,
    channelId,
    directory,
    bannerPending: isNew,
    turn: null,
    tools: {},
    agentUi: [],
    children: {},
    lastKind: null,
    lastRetryAt: null,
    inbox: [],
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

export function reduce({ view, event, prefs }: { view: ThreadView; event: ThreadEvent; prefs: Prefs }): {
  view: ThreadView
  effects: Effect[]
} {
  const effects: Effect[] = []
  const emit: Emit = (effect) => void effects.push(effect)
  const next = produce(view, (draft) => {
    if (isKimakiEvent(event)) applyKimaki({ draft, event, prefs, emit })
    else applyOpencode({ draft, event, prefs, emit })
  })
  const typing = isTyping(next)
  // Typing goes first: on before the banner, off before the footer or a prompt.
  if (isTyping(view) !== typing) effects.unshift({ type: 'typing', on: typing })
  return { view: next, effects }
}

type Context = { draft: Draft<ThreadView>; prefs: Prefs; emit: Emit }

function toolKey(data: { assistantMessageID: string; id: string }): string {
  return `${data.assistantMessageID}:${data.id}`
}

function stringInput(input: ToolInput, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

// Posts a tool-kind line, with a blank line when the previous block was text.
function toolLine({ draft, emit }: Context, text: string) {
  emit({ type: 'send', text: draft.lastKind === 'text' ? `\n${text}` : text })
  draft.lastKind = 'tool'
}

function contextPercent({ turn, prefs }: { turn: Draft<Turn>; prefs: Prefs }): number | null {
  if (!turn.model || turn.tokens <= 0) return null
  const limit = prefs.contextLimits[`${turn.model.providerID}/${turn.model.id}`]
  if (!limit || limit <= 0) return null
  return Math.round((turn.tokens / limit) * 100)
}

function applyOpencode({ draft, event, prefs, emit }: Context & { event: V2Event }) {
  // A subagent session is created, then the parent's tool.progress (with
  // metadata.sessionID) links it to the exact call, before any child tool
  // event (29.2 #4). Creation only registers the child; progress sets label and mode.
  if (event.type === 'session.created') {
    const { sessionID, parentID } = event.data
    if (!parentID || draft.children[sessionID]) return
    if (parentID !== draft.sessionId && !draft.children[parentID]) return
    draft.children[sessionID] = { agent: event.data.agent ?? 'subagent', description: '', background: false, running: false }
    return
  }
  // A new user message dismisses the agent's pending buttons and upload requests.
  if (event.type === 'session.inbox.enqueued' && event.data.item.type === 'user') {
    dismissAgentPrompts({ draft, emit, ids: draft.agentUi.filter((prompt) => prompt.sessionId === event.data.sessionID).map((prompt) => prompt.id) })
  }
  const sessionId = eventSessionId(event)
  if (!sessionId) return
  const child = draft.children[sessionId]
  if (sessionId !== draft.sessionId && !child) return
  // Questions and permissions of subagents show in this thread too.
  const label = child?.agent ?? null
  switch (event.type) {
    case 'form.created':
      return showForm({ draft, emit, form: event.data.form, label })
    case 'form.replied':
      return closeForm({ draft, emit, formID: event.data.id, render: (field, text) => withAnswer({ header: text, answer: formatAnswer(event.data.answer[field.key]) }) })
    case 'form.cancelled':
      return closeForm({ draft, emit, formID: event.data.id, render: (_field, text) => `${text}\n✗ _cancelled_` })
    case 'permission.asked':
      return showPermission({ draft, emit, request: event.data, label })
    case 'permission.replied':
      return closePermission({ draft, emit, requestID: event.data.requestID, status: STATUS[event.data.reply] })
  }
  if (child) return applyChild({ draft, prefs, emit, event, child })
  applyRoot({ draft, prefs, emit, event })
}

function applyRoot(context: Context & { event: V2Event }) {
  const { draft, event, prefs, emit } = context
  switch (event.type) {
    case 'session.moved':
      draft.directory = event.data.location.directory
      emit({ type: 'send', text: asSubtext(`Working directory changed to ${event.data.location.directory}`) })
      return
    case 'session.execution.started':
      draft.turn ??= { startedAt: event.created, model: null, agent: null, tokens: 0 }
      return
    case 'session.step.started': {
      const model = { providerID: event.data.model.providerID, id: event.data.model.id }
      draft.turn ??= { startedAt: event.created, model: null, agent: null, tokens: 0 }
      draft.turn.model = model
      draft.turn.agent = event.data.agent
      if (draft.bannerPending) emit({ type: 'send', text: formatBanner({ model, agent: event.data.agent }) })
      draft.bannerPending = false
      return
    }
    case 'session.step.ended': {
      if (!draft.turn) return
      const { tokens } = event.data
      draft.turn.tokens = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
      return
    }
    case 'session.text.ended': {
      const text = event.data.text.trim()
      if (!text) return
      emit({ type: 'markdown', text, blankLineBefore: draft.lastKind === 'tool' })
      draft.lastKind = 'text'
      return
    }
    case 'session.retry.scheduled':
      if (draft.lastRetryAt !== null && event.created - draft.lastRetryAt < RETRY_NOTICE_INTERVAL_MS) return
      draft.lastRetryAt = event.created
      emit({ type: 'send', text: formatRetry({ attempt: event.data.attempt, delayMs: event.data.at - event.created, message: event.data.error.message }) })
      return
    // User `!cmd` (session.shell): shown at every verbosity.
    case 'session.shell.started':
      return toolLine(context, formatShellStarted(event.data.shell.command))
    case 'session.shell.ended':
      emit({
        type: 'send',
        text: formatShellEnded({
          output: event.data.output.output,
          truncated: event.data.output.truncated,
          status: event.data.shell.status,
          exit: event.data.shell.exit ?? null,
        }),
      })
      draft.lastKind = 'tool'
      return
    // `/compact` or automatic compaction when the context is full.
    case 'session.compaction.ended':
      return toolLine(context, asSubtext('⬦ context compacted'))
    case 'session.compaction.failed':
      return toolLine(context, formatError(`compaction failed: ${event.data.error.message}`))
    case 'session.execution.succeeded': {
      const turn = draft.turn
      draft.turn = null
      draft.lastKind = null
      // No model step ran (a compaction-only execution): nothing to summarize.
      if (!turn?.model) return
      // A child still runs: the answer comes in a later parent execution.
      if (Object.values(draft.children).some((child) => child.running)) return
      emit({
        type: 'footer',
        directory: draft.directory,
        durationMs: event.created - turn.startedAt,
        contextPercent: contextPercent({ turn, prefs }),
        model: { providerID: turn.model.providerID, id: turn.model.id },
        agent: turn.agent,
      })
      return
    }
    case 'session.execution.failed':
      draft.turn = null
      draft.lastKind = null
      emit({ type: 'send', text: formatError(event.data.error.message) })
      return
    case 'session.execution.interrupted':
      draft.turn = null
      draft.lastKind = null
      return
    case 'session.inbox.enqueued':
      return enqueueInput({ draft, emit, data: event.data, busy: isBusy(draft) })
    case 'session.inbox.delivered':
      return deliverQueued({ draft, emit, inboxID: event.data.inboxID })
    case 'session.inbox.cancelled':
      return cancelQueued({ draft, emit, inboxID: event.data.inboxID })
    case 'session.inbox.delivery.changed':
      if (event.data.delivery === 'steer') promoteQueued({ draft, emit, inboxID: event.data.inboxID })
      return
    default:
      return applyTool({ ...context, label: undefined, render: true })
  }
}

function applyChild({
  draft,
  prefs,
  emit,
  event,
  child,
}: Context & { event: V2Event; child: Draft<Child> }) {
  switch (event.type) {
    case 'session.execution.started':
      child.running = true
      return
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      child.running = false
      if (child.background && event.type === 'session.execution.succeeded') {
        toolLine({ draft, prefs, emit }, formatSubagentFinished({ agent: child.agent, description: child.description }))
      }
      return
  }
  // Background children post no tool lines: they would interleave with later turns.
  applyTool({ draft, prefs, emit, event, label: child.agent, render: !child.background })
}

// Tool events shared by root and children. `label` is set for children.
// `render: false` keeps the bookkeeping and posts nothing.
function applyTool(context: Context & { event: V2Event; label: string | undefined; render: boolean }) {
  const { draft, event, prefs, label, render } = context
  switch (event.type) {
    case 'session.tool.input.started':
      draft.tools[toolKey(event.data)] = { name: event.data.name, phase: 'input', subagent: null, innerCalls: 0 }
      return
    case 'session.tool.called': {
      const key = toolKey(event.data)
      const name = draft.tools[key]?.name ?? 'tool'
      const input = event.data.input
      const tool: ToolCall = { name, phase: 'called', subagent: null, innerCalls: 0 }
      if (name === 'subagent') {
        const reused = typeof input['sessionID'] === 'string' ? draft.children[input['sessionID']] : undefined
        const call = { agent: stringInput(input, 'agent'), description: stringInput(input, 'description'), background: input['background'] === true }
        if (typeof input['sessionID'] !== 'string') tool.subagent = { ...call, agent: call.agent || 'subagent' }
        // Reusing a child session: its mode and label follow the new call.
        if (reused) Object.assign(reused, { ...call, agent: call.agent || reused.agent })
      }
      draft.tools[key] = tool
      if (render && isToolVisible({ name, input }, prefs.verbosity)) toolLine(context, formatToolLine({ name, input }, { label }))
      return
    }
    case 'session.tool.progress': {
      const tool = draft.tools[toolKey(event.data)]
      if (tool?.name === 'execute') return showInnerCalls({ ...context, tool, metadata: event.data.metadata })
      const childId = event.data.metadata['sessionID']
      if (typeof childId !== 'string' || !tool?.subagent) return
      draft.children[childId] = { ...tool.subagent, running: draft.children[childId]?.running ?? false }
      tool.subagent = null
      return
    }
    case 'session.tool.success':
    case 'session.tool.failed': {
      const key = toolKey(event.data)
      const tool = draft.tools[key]
      const name = tool?.name ?? 'tool'
      if (tool?.name === 'execute') {
        // The final metadata has the full list: rows whose progress was missed, then failures.
        const { metadata } = event.data
        showInnerCalls({ ...context, tool, metadata })
        if (render && event.type === 'session.tool.success') {
          for (const line of formatExecuteFailures({ metadata, content: event.data.content, label })) toolLine(context, line)
        }
      }
      delete draft.tools[key]
      if (event.type === 'session.tool.success' || !render) return
      if (event.data.error.type === 'aborted' || name === 'question' || name.startsWith('kimaki_')) return
      toolLine(context, formatToolFailed({ name, message: event.data.error.message, label }))
      return
    }
  }
}

// Each update carries the whole `toolCalls` list; post the calls that are new.
function showInnerCalls({
  tool,
  metadata,
  label,
  render,
  ...context
}: Context & { tool: Draft<ToolCall>; metadata: Readonly<Record<string, unknown>> | undefined; label: string | undefined; render: boolean }) {
  const calls = executeCalls(metadata).slice(tool.innerCalls)
  tool.innerCalls += calls.length
  if (!render) return
  for (const call of calls) {
    if (isToolVisible(call, context.prefs.verbosity)) toolLine(context, formatToolLine(call, { label }))
  }
}

const BUTTON_STYLES = { white: ButtonStyle.Secondary, blue: ButtonStyle.Primary, green: ButtonStyle.Success, red: ButtonStyle.Danger } as const

function showAgentPrompt({ draft, emit, prompt }: Pick<Context, 'draft' | 'emit'> & { prompt: AgentPrompt }) {
  const buttons = prompt.buttons?.map((item, index) => button({ customId: `action_button:${prompt.id}:${index}`, label: item.label, style: BUTTON_STYLES[item.color] }))
    ?? [button({ customId: `file_upload_btn:${prompt.id}`, label: 'Upload files' })]
  const commands = prompt.buttons?.flatMap((item) => (item.command ? [`${item.label}: \`${item.command}\``] : [])) ?? []
  draft.agentUi.push(prompt)
  emit({ type: 'show', key: `agent:${prompt.id}`, replyTo: null, messages: [{ content: prompt.prompt ?? commands.join('\n'), components: [buttonRow(buttons)] }] })
}

function dismissAgentPrompts({ draft, emit, ids }: Pick<Context, 'draft' | 'emit'> & { ids: readonly string[] }) {
  if (ids.length === 0) return
  draft.agentUi = draft.agentUi.filter((prompt) => !ids.includes(prompt.id))
  for (const id of ids) emit({ type: 'edit', key: `agent:${id}`, messages: [textOnly('Dismissed')] })
}

function applyKimaki({ draft, event, prefs, emit }: Context & { event: KimakiEvent }) {
  switch (event.type) {
    case 'kimaki.agent-ui':
      return showAgentPrompt({ draft, emit, prompt: event.prompt })
    case 'kimaki.agent-ui-dismiss':
      return dismissAgentPrompts({ draft, emit, ids: [event.id] })
    case 'kimaki.replay':
      for (const effect of replayEffects({ messages: event.messages, prefs, note: event.note })) emit(effect)
      draft.lastKind = null
      return
    case 'kimaki.child':
      draft.children[event.sessionId] ??= { agent: event.agent, description: '', background: false, running: false }
      return
    case 'kimaki.snapshot': {
      // A move while disconnected: no notice, only the new location.
      if (event.directory) draft.directory = event.directory
      // Executions that started or ended while disconnected. Their footer is lost.
      const active = new Set(event.activeSessionIds)
      for (const [id, child] of Object.entries(draft.children)) child.running = active.has(id)
      if (!active.has(draft.sessionId)) draft.turn = null
      else draft.turn ??= { startedAt: event.at, model: null, agent: null, tokens: 0 }
      // Nothing runs: tool calls whose end was missed while disconnected are over.
      if (!isBusy(draft)) draft.tools = {}
      for (const session of event.sessions) {
        const isRoot = session.sessionId === draft.sessionId
        const child = draft.children[session.sessionId]
        if (!isRoot && !child) continue
        const label = child?.agent ?? null
        if (session.inbox) hydrateQueue({ draft, emit, inbox: session.inbox })
        hydrateForms({ draft, emit, sessionId: session.sessionId, forms: session.forms, label })
        hydratePermissions({ draft, emit, sessionId: session.sessionId, requests: session.permissions, label })
      }
      return
    }
  }
}

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
      if (part.type !== 'tool' || part.state.status === 'streaming') return []
      const { input, metadata } = part.state
      const isExecute = part.name === 'execute'
      const lines = [{ name: part.name, input }, ...(isExecute ? executeCalls(metadata) : [])]
        .filter((call) => isToolVisible(call, prefs.verbosity))
        .map((call) => formatToolLine(call))
      const failures = isExecute && part.state.status === 'completed' ? formatExecuteFailures({ metadata, content: part.state.content }) : []
      return [...lines, ...failures].map((text): Block => ({ kind: 'tool', text }))
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
