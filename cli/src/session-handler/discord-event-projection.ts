import type { V2Event } from '@opencode/client'
import type { DiscordSessionPart } from '../message-formatting.js'
import type { VerbosityLevel } from '../schema.js'
import {
  asDiscordQuote,
  discordReasoningPartId,
  discordTextPartId,
  discordToolPartId,
  formatPart,
  formatTaskToolTitle,
  isEssentialToolPart,
  planAssistantTurnFlush,
  sessionPartKind,
  shouldLeadWithBlankLine,
  type AssistantTurnFlushMode,
  type SessionPartKind,
} from '../message-formatting.js'
import {
  compactSubagentRoutingEvidence,
  getDerivedSubtaskLabel,
  deriveNativeExecutionTerminalAnalytics,
  getAssistantMessageIdsForLatestExecution,
  getLatestAssistantMessageIdForLatestExecution,
  getPromptCacheClear,
  formatPromptCacheClearMessage,
  hasVisibleV2OutputSinceExecutionStart,
  isDerivedChildSession,
  type EventBufferEntry,
  type NativeExecutionUsage,
} from './event-stream-state.js'

export type ProjectedQuestion = {
  question: string
  header: string
  key: string
  options: Array<{ label: string; description: string; value: string }>
  multiple: boolean
}

export type ProjectedForm = {
  formId: string
  sessionId: string
  messageId?: string
  questions: ProjectedQuestion[]
}

export type TerminalAnalytics = {
  sessionId: string
  outcome: 'succeeded' | 'failed' | 'interrupted'
  durationSec: number
  usage: NativeExecutionUsage
  isMainSession: boolean
  isSubagent: boolean
}

export type DiscordAction =
  | { type: 'store-part'; part: DiscordSessionPart }
  | {
      type: 'render-part'
      partId: string
      deliveryId: string
      destination: { type: 'main'; label: 'main' } | { type: 'subagent'; label: string }
      content: string
      kind: SessionPartKind
      leadWithBlankLine: boolean
      repulseTyping: boolean
    }
  | { type: 'hold-part'; partId: string; destination: 'main'; reason: 'open-text' }
  | { type: 'skip-part'; partId: string; destination: 'main' | 'subagent'; reason: string }
  | { type: 'show-large-output'; partId: string; content: string }
  | { type: 'show-action-buttons'; sessionId: string; partId: string }
  | { type: 'show-form'; form: ProjectedForm }
  | { type: 'defer-form'; form: ProjectedForm }
  | { type: 'settle-form'; formId: string; sessionId: string }
  | { type: 'start-typing'; immediate?: boolean }
  | { type: 'stop-typing' }
  | { type: 'show-context-usage'; sessionId: string }
  | { type: 'show-prompt-cache-clear'; message: string }
  | { type: 'unquote-final-text'; partId: string; content: string }
  | { type: 'send-footer'; completedAt: number; startedAt: number }
  | { type: 'send-error'; message: string }
  | { type: 'record-terminal-analytics'; analytics: TerminalAnalytics }
  | { type: 'complete-scheduled-task'; sessionId: string }
  | { type: 'fail-scheduled-task'; sessionId: string; error: string }
  | { type: 'discard-open-text' }
  | { type: 'reset-run' }
  | { type: 'drain-queue' }

export type DiscordProjectionState = {
  parts: readonly DiscordSessionPart[]
  pendingForms: readonly ProjectedForm[]
  shownFormIds: readonly string[]
}

export function createDiscordProjectionState(): DiscordProjectionState {
  return { parts: [], pendingForms: [], shownFormIds: [] }
}

function replacePart(
  parts: readonly DiscordSessionPart[],
  part: DiscordSessionPart,
): DiscordSessionPart[] {
  const index = parts.findIndex((candidate) => candidate.id === part.id)
  if (index < 0) return [...parts, part]
  return parts.map((candidate, candidateIndex) => {
    return candidateIndex === index ? part : candidate
  })
}

export function applyDiscordProjectionActions({
  state,
  actions,
}: {
  state: DiscordProjectionState
  actions: readonly DiscordAction[]
}): DiscordProjectionState {
  return actions.reduce<DiscordProjectionState>((current, action) => {
    if (action.type === 'store-part') {
      return { ...current, parts: replacePart(current.parts, action.part) }
    }
    if (action.type === 'defer-form') {
      return {
        ...current,
        pendingForms: [
          ...current.pendingForms.filter((form) => form.formId !== action.form.formId),
          action.form,
        ],
      }
    }
    if (action.type === 'show-form') {
      return {
        ...current,
        pendingForms: current.pendingForms.filter((form) => form.formId !== action.form.formId),
        shownFormIds: current.shownFormIds.includes(action.form.formId)
          ? current.shownFormIds
          : [...current.shownFormIds, action.form.formId],
      }
    }
    if (action.type === 'settle-form') {
      return {
        ...current,
        pendingForms: current.pendingForms.filter((form) => form.formId !== action.formId),
        shownFormIds: current.shownFormIds.includes(action.formId)
          ? current.shownFormIds
          : [...current.shownFormIds, action.formId],
      }
    }
    if (action.type === 'discard-open-text') {
      return {
        ...current,
        parts: current.parts.filter((part) => part.type !== 'text' || part.time?.end),
      }
    }
    if (action.type === 'reset-run') return { ...current, parts: [] }
    return current
  }, state)
}

function partIdForEvent(event: Extract<V2Event, {
  type: 'session.tool.called' | 'session.tool.success' | 'session.tool.failed'
}>): string {
  return discordToolPartId({
    messageID: event.data.assistantMessageID,
    toolId: event.data.id,
  })
}

function findToolName({
  events,
  sessionId,
  assistantMessageId,
  toolId,
}: {
  events: readonly EventBufferEntry[]
  sessionId: string
  assistantMessageId: string
  toolId: string
}): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]?.event
    if (
      event?.type === 'session.tool.input.started'
      && event.data.sessionID === sessionId
      && event.data.assistantMessageID === assistantMessageId
      && event.data.id === toolId
    ) return event.data.name
  }
  return 'tool'
}

function getPart(
  parts: readonly DiscordSessionPart[],
  partId: string,
): DiscordSessionPart | undefined {
  return parts.find((part) => part.id === partId)
}

type ProjectionOutputOptions = {
  verbosity: VerbosityLevel
  deliveredPartIds: ReadonlySet<string>
  largeOutputThresholdTokens: number
  modelContextLimit?: number
}

function isVisiblePart({
  part,
  verbosity,
}: {
  part: DiscordSessionPart
  verbosity: VerbosityLevel
}): boolean {
  if (part.type === 'text') return true
  if (verbosity === 'text_only') return false
  if (verbosity === 'tools_and_text') return true
  return part.type === 'tool' && isEssentialToolPart(part)
}

function deliveryIdForPart(part: DiscordSessionPart): string {
  if (part.type !== 'tool') return part.id
  return `${part.id}:${part.state.status}`
}

function getLastDeliveredKind({
  parts,
  deliveredPartIds,
}: {
  parts: readonly DiscordSessionPart[]
  deliveredPartIds: ReadonlySet<string>
}): SessionPartKind | undefined {
  const part = parts.findLast((candidate) => {
    if (deliveredPartIds.has(candidate.id)) return true
    if (candidate.type !== 'tool') return false
    return ['running', 'completed', 'error'].some((status) => {
      return deliveredPartIds.has(`${candidate.id}:${status}`)
    })
  })
  return part ? sessionPartKind(part) : undefined
}

function renderAction({
  part,
  destination,
  quoteText,
  repulseTyping,
  previousKind,
  deliveredPartIds,
  verbosity,
  contentOverride,
  deliveryIdOverride,
}: {
  part: DiscordSessionPart
  destination: { type: 'main'; label: 'main' } | { type: 'subagent'; label: string }
  quoteText: boolean
  repulseTyping: boolean
  previousKind: SessionPartKind | undefined
  deliveredPartIds: ReadonlySet<string>
  verbosity: VerbosityLevel
  contentOverride?: string
  deliveryIdOverride?: string
}): DiscordAction {
  const deliveryId = deliveryIdOverride ?? deliveryIdForPart(part)
  if (deliveredPartIds.has(deliveryId)) {
    return { type: 'skip-part', partId: part.id, destination: destination.type, reason: 'delivered' }
  }
  if (!isVisiblePart({ part, verbosity })) {
    return { type: 'skip-part', partId: part.id, destination: destination.type, reason: 'verbosity' }
  }
  if (
    part.type === 'tool'
    && part.state.status === 'completed'
    && deliveredPartIds.has(`${part.id}:running`)
  ) {
    return { type: 'skip-part', partId: part.id, destination: destination.type, reason: 'shown-running' }
  }
  const formatted = contentOverride ?? formatPart(
    part,
    destination.type === 'subagent' ? destination.label : undefined,
  )
  const content = quoteText ? asDiscordQuote(formatted) : formatted
  if (!content.trim()) {
    return { type: 'skip-part', partId: part.id, destination: destination.type, reason: 'empty' }
  }
  const kind = sessionPartKind(part)
  return {
    type: 'render-part',
    partId: part.id,
    deliveryId,
    destination,
    content,
    kind,
    leadWithBlankLine: shouldLeadWithBlankLine({ previousKind, nextKind: kind }),
    repulseTyping,
  }
}

function planMainPartActions({
  parts,
  historyParts = parts,
  mode,
  throughPartId,
  skipPartId,
  repulseTyping = true,
  output,
}: {
  parts: readonly DiscordSessionPart[]
  historyParts?: readonly DiscordSessionPart[]
  mode: AssistantTurnFlushMode
  throughPartId?: string
  skipPartId?: string
  repulseTyping?: boolean
  output: ProjectionOutputOptions
}): DiscordAction[] {
  const mainParts = [...parts]
  const planned = planAssistantTurnFlush({ parts: mainParts, mode, throughPartId })
  const actions: DiscordAction[] = planned.hold.map((entry) => ({
    type: 'hold-part', partId: entry.id, destination: 'main', reason: 'open-text',
  }))
  let previousKind = getLastDeliveredKind({
    parts: historyParts,
    deliveredPartIds: output.deliveredPartIds,
  })
  const emitted = new Set(output.deliveredPartIds)
  for (const { part, quoteText } of planned.sendParts) {
    const action = (() => {
      if (part.id === skipPartId) {
        return { type: 'skip-part', partId: part.id, destination: 'main', reason: 'interactive' } as const
      }
      if (part.type === 'tool' && part.state.status === 'pending') {
        return { type: 'skip-part', partId: part.id, destination: 'main', reason: 'pending' } as const
      }
      if (part.type === 'text' && !part.time?.end && mode === 'progress') {
        return { type: 'hold-part', partId: part.id, destination: 'main', reason: 'open-text' } as const
      }
      if (part.type === 'tool' && (part.tool === 'task' || part.tool === 'subagent')) {
        return { type: 'skip-part', partId: part.id, destination: 'main', reason: 'subagent-parent' } as const
      }
      return renderAction({
        part,
        destination: { type: 'main', label: 'main' },
        quoteText,
        repulseTyping: part.type === 'text' && part.ignored === true ? false : repulseTyping,
        previousKind,
        deliveredPartIds: emitted,
        verbosity: output.verbosity,
      })
    })()
    actions.push(action)
    if (action.type !== 'render-part') continue
    emitted.add(action.deliveryId)
    previousKind = action.kind
  }
  return actions
}

export function projectDiscordFlushActions({
  parts,
  mainSessionId,
  mode,
  repulseTyping,
  verbosity,
  deliveredPartIds,
}: {
  parts: readonly DiscordSessionPart[]
  mainSessionId: string
  mode: AssistantTurnFlushMode
  repulseTyping: boolean
  verbosity: VerbosityLevel
  deliveredPartIds: ReadonlySet<string>
}): DiscordAction[] {
  return planMainPartActions({
    parts: parts.filter((part) => part.sessionID === mainSessionId),
    historyParts: parts,
    mode,
    repulseTyping,
    output: {
      verbosity,
      deliveredPartIds,
      largeOutputThresholdTokens: 3_000,
    },
  })
}

function routePartActions({
  part,
  events,
  mainSessionId,
  projectedParts,
  output,
}: {
  part: DiscordSessionPart
  events: EventBufferEntry[]
  mainSessionId: string
  projectedParts: readonly DiscordSessionPart[]
  output: ProjectionOutputOptions
}): DiscordAction[] {
  const nextParts = replacePart(projectedParts, part)
  if (part.sessionID === mainSessionId) {
    return [{ type: 'store-part', part }, ...projectMainPartActions({
      part,
      parts: nextParts.filter((candidate) => candidate.sessionID === mainSessionId),
      historyParts: nextParts,
      events,
      mainSessionId,
      output,
    })]
  }
  if (!isDerivedChildSession({
    events,
    mainSessionId,
    candidateSessionId: part.sessionID,
  })) return []
  const routed = routeStoredSubagentPart({
    part,
    events,
    mainSessionId,
    projectedParts: nextParts,
    output,
  })
  if (routed.length === 0) return [{ type: 'store-part', part }]
  return routed
}

function routeStoredSubagentPart({
  part,
  events,
  mainSessionId,
  projectedParts,
  output,
}: {
  part: DiscordSessionPart
  events: EventBufferEntry[]
  mainSessionId: string
  projectedParts: readonly DiscordSessionPart[]
  output: ProjectionOutputOptions
}): DiscordAction[] {
  const label = getDerivedSubtaskLabel({
    events,
    mainSessionId,
    candidateSessionId: part.sessionID,
  })
  if (!label) return []
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestExecution({
    events,
    sessionId: part.sessionID,
  })
  const destination = { type: 'subagent' as const, label }
  const action: DiscordAction = (() => {
    if (part.type === 'text') {
      return { type: 'skip-part', partId: part.id, destination: 'subagent', reason: 'subagent-text' }
    }
    if (part.type === 'tool' && part.state.status === 'pending') {
      return { type: 'skip-part', partId: part.id, destination: 'subagent', reason: 'pending' }
    }
    if (!latestAssistantMessageId || part.messageID !== latestAssistantMessageId) {
      return { type: 'skip-part', partId: part.id, destination: 'subagent', reason: 'old-message' }
    }
    return renderAction({
      part,
      destination,
      quoteText: false,
      repulseTyping: true,
      previousKind: getLastDeliveredKind({
        parts: projectedParts,
        deliveredPartIds: output.deliveredPartIds,
      }),
      deliveredPartIds: output.deliveredPartIds,
      verbosity: output.verbosity,
      deliveryIdOverride: part.id,
    })
  })()
  return [{ type: 'store-part', part }, action]
}

function routePendingSubagentParts({
  projectedParts,
  events,
  mainSessionId,
  childSessionId,
  output,
}: {
  projectedParts: readonly DiscordSessionPart[]
  events: EventBufferEntry[]
  mainSessionId: string
  childSessionId: string
  output: ProjectionOutputOptions
}): DiscordAction[] {
  return projectedParts.flatMap((part) => {
    if (part.sessionID !== childSessionId) return []
    return routeStoredSubagentPart({
      part, events, mainSessionId, projectedParts, output,
    }).filter((action) => {
      return action.type !== 'store-part'
    })
  })
}

function largeOutputAction({
  part,
  output,
}: {
  part: Extract<DiscordSessionPart, { type: 'tool' }>
  output: ProjectionOutputOptions
}): DiscordAction | undefined {
  if (!isVisiblePart({ part, verbosity: output.verbosity })) return undefined
  const outputTokens = Math.ceil((part.state.output || '').length / 4)
  if (outputTokens < output.largeOutputThresholdTokens) return undefined
  const formattedTokens = outputTokens >= 1_000
    ? `${(outputTokens / 1_000).toFixed(1)}k`
    : String(outputTokens)
  const percentage = output.modelContextLimit
    ? (outputTokens / output.modelContextLimit) * 100
    : 0
  const percentageSuffix = percentage >= 1 ? ` (${percentage.toFixed(1)}%)` : ''
  return {
    type: 'show-large-output',
    partId: part.id,
    content: `${part.tool} returned ${formattedTokens} tokens${percentageSuffix}`,
  }
}

function projectMainPartActions({
  part,
  parts,
  historyParts,
  events,
  mainSessionId,
  output,
}: {
  part: DiscordSessionPart
  parts: readonly DiscordSessionPart[]
  historyParts: readonly DiscordSessionPart[]
  events: EventBufferEntry[]
  mainSessionId: string
  output: ProjectionOutputOptions
}): DiscordAction[] {
  if (part.type === 'tool' && part.state.status === 'running') {
    const flush = planMainPartActions({ parts, historyParts, mode: 'progress', output })
    if (flush.some((action) => action.type === 'hold-part' && action.partId === part.id)) {
      return flush
    }
    if (part.tool !== 'task' && part.tool !== 'subagent') return flush
    const title = formatTaskToolTitle(part)
    if (!title) return flush
    return [...flush, renderAction({
      part,
      destination: { type: 'main', label: 'main' },
      quoteText: false,
      repulseTyping: true,
      previousKind: getLastDeliveredKind({
        parts: historyParts,
        deliveredPartIds: output.deliveredPartIds,
      }),
      deliveredPartIds: output.deliveredPartIds,
      verbosity: output.verbosity,
      contentOverride: title,
      deliveryIdOverride: `${part.id}:running`,
    })]
  }
  if (part.type === 'tool' && part.state.status === 'error') {
    return [renderAction({
      part,
      destination: { type: 'main', label: 'main' },
      quoteText: false,
      repulseTyping: true,
      previousKind: getLastDeliveredKind({
        parts: historyParts,
        deliveredPartIds: output.deliveredPartIds,
      }),
      deliveredPartIds: output.deliveredPartIds,
      verbosity: output.verbosity,
    })]
  }
  if (
    part.type === 'tool'
    && part.state.status === 'completed'
    && part.tool.endsWith('kimaki_action_buttons')
  ) {
    return [
      ...planMainPartActions({
        parts,
        historyParts,
        mode: 'interactive',
        throughPartId: part.id,
        skipPartId: part.id,
        output,
      }),
      { type: 'show-action-buttons', sessionId: mainSessionId, partId: part.id },
    ]
  }
  if (part.type === 'tool' && part.state.status === 'completed') {
    const currentMessageIds = getAssistantMessageIdsForLatestExecution({
      events,
      sessionId: mainSessionId,
    })
    if (currentMessageIds.size > 0 && !currentMessageIds.has(part.messageID)) {
      return [{ type: 'skip-part', partId: part.id, destination: 'main', reason: 'old-message' }]
    }
    const large = largeOutputAction({ part, output })
    return large ? [large] : []
  }
  if (part.type === 'text' || part.type === 'reasoning') {
    return planMainPartActions({ parts, historyParts, mode: 'progress', output })
  }
  return []
}

function hasOpenTextForForm({
  parts,
  form,
}: {
  parts: readonly DiscordSessionPart[]
  form: ProjectedForm
}): boolean {
  return parts.some((part) => {
    if (part.type !== 'text' || part.time?.end) return false
    return !form.messageId || part.messageID === form.messageId
  })
}

function readyPendingFormActions({
  pendingForms,
  parts,
  shownFormIds,
  mainSessionId,
  output,
  precedingActions = [],
}: {
  pendingForms: readonly ProjectedForm[]
  parts: readonly DiscordSessionPart[]
  shownFormIds: ReadonlySet<string>
  mainSessionId: string
  output: ProjectionOutputOptions
  precedingActions?: readonly DiscordAction[]
}): DiscordAction[] {
  const deliveredPartIds = new Set(output.deliveredPartIds)
  for (const action of precedingActions) {
    if (action.type === 'render-part') deliveredPartIds.add(action.deliveryId)
  }
  const nextOutput = { ...output, deliveredPartIds }
  return pendingForms.flatMap((form): DiscordAction[] => {
    if (shownFormIds.has(form.formId) || hasOpenTextForForm({ parts, form })) return []
    return [
      ...planMainPartActions({
        parts: parts.filter((part) => part.sessionID === mainSessionId),
        historyParts: parts,
        mode: 'interactive',
        output: nextOutput,
      }),
      { type: 'show-form', form },
    ]
  })
}

function normalizeQuestionForm(
  form: Extract<V2Event, { type: 'form.created' }>['data']['form'],
): ProjectedForm | undefined {
  if (form.metadata?.kind !== 'question') return undefined
  const questions = form.fields.flatMap((field): ProjectedQuestion[] => {
    if (field.type !== 'string' && field.type !== 'multiselect') return []
    return [{
      question: field.description || field.title || field.key,
      header: field.title || field.key,
      key: field.key,
      options: (field.options ?? []).map((option) => ({
        label: option.label,
        description: option.description || '',
        value: option.value,
      })),
      multiple: field.type === 'multiselect',
    }]
  })
  if (questions.length === 0) return undefined
  const tool = form.metadata.tool
  const messageId = tool && typeof tool === 'object'
    && typeof Reflect.get(tool, 'messageID') === 'string'
    ? String(Reflect.get(tool, 'messageID'))
    : undefined
  return { formId: form.id, sessionId: form.sessionID, messageId, questions }
}

function promptCacheClearActions({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string | undefined
}): DiscordAction[] {
  if (!messageId) return []
  const clear = getPromptCacheClear({ events, sessionId, currentMessageId: messageId })
  if (!clear) return []
  return [{ type: 'show-prompt-cache-clear', message: formatPromptCacheClearMessage(clear) }]
}

// Short text is quoted as soon as it ends. When it turns out to be the last
// visible part of a successful turn, the executor edits it back to full width.
function unquoteFinalTextActions(parts: readonly DiscordSessionPart[]): DiscordAction[] {
  const finalPart = parts.findLast((part) => {
    return (part.type === 'text' && part.text.trim()) || part.type === 'tool'
  })
  if (finalPart?.type !== 'text') return []
  const content = formatPart(finalPart)
  if (!content) return []
  return [{ type: 'unquote-final-text', partId: finalPart.id, content }]
}

type TerminalEvent = Extract<V2Event, {
  type:
    | 'session.execution.succeeded'
    | 'session.execution.failed'
    | 'session.execution.interrupted'
}>

function deriveTerminalAnalytics({
  event,
  events,
  mainSessionId,
}: {
  event: TerminalEvent
  events: EventBufferEntry[]
  mainSessionId: string
}): TerminalAnalytics {
  const terminal = deriveNativeExecutionTerminalAnalytics({ events, event })
  return {
    sessionId: event.data.sessionID,
    outcome: terminal.outcome,
    durationSec: terminal.durationSec,
    usage: terminal.usage,
    isMainSession: event.data.sessionID === mainSessionId,
    isSubagent: isDerivedChildSession({
      events,
      mainSessionId,
      candidateSessionId: event.data.sessionID,
    }),
  }
}

export function projectDiscordActions({
  event,
  events,
  projectedParts,
  pendingForms,
  shownFormIds,
  mainSessionId,
  verbosity,
  deliveredPartIds,
  largeOutputThresholdTokens,
  modelContextLimit,
}: {
  event: V2Event
  events: EventBufferEntry[]
  projectedParts: readonly DiscordSessionPart[]
  pendingForms: readonly ProjectedForm[]
  shownFormIds: readonly string[]
  mainSessionId: string
  verbosity: VerbosityLevel
  deliveredPartIds: ReadonlySet<string>
  largeOutputThresholdTokens: number
  modelContextLimit?: number
}): DiscordAction[] {
  const output: ProjectionOutputOptions = {
    verbosity,
    deliveredPartIds,
    largeOutputThresholdTokens,
    modelContextLimit,
  }
  if (event.type === 'session.text.started' || event.type === 'session.text.delta') {
    const partId = discordTextPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = getPart(projectedParts, partId)
    const text = event.type === 'session.text.delta'
      ? `${existing?.type === 'text' ? existing.text : ''}${event.data.delta}`
      : ''
    return [{
      type: 'store-part',
      part: {
        id: partId,
        type: 'text',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        text,
        time: {
          start: existing?.type === 'text'
            ? existing.time?.start ?? event.created
            : event.created,
        },
      },
    }]
  }
  if (event.type === 'session.text.ended') {
    const partId = discordTextPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = getPart(projectedParts, partId)
    const part: DiscordSessionPart = {
      id: partId,
      type: 'text',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      text: event.data.text,
      time: {
        start: existing?.type === 'text'
          ? existing.time?.start ?? event.created
          : event.created,
        end: event.created,
      },
    }
    const nextParts = replacePart(projectedParts, part)
    const partActions = routePartActions({
      part, events, mainSessionId, projectedParts, output,
    })
    return [
      ...partActions,
      ...readyPendingFormActions({
        pendingForms,
        parts: nextParts,
        shownFormIds: new Set(shownFormIds),
        mainSessionId,
        output,
        precedingActions: partActions,
      }),
    ]
  }
  if (event.type === 'session.reasoning.started' || event.type === 'session.reasoning.delta') {
    const partId = discordReasoningPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = getPart(projectedParts, partId)
    const text = event.type === 'session.reasoning.delta'
      ? `${existing?.type === 'reasoning' ? existing.text : ''}${event.data.delta}`
      : ''
    return [{
      type: 'store-part',
      part: {
        id: partId,
        type: 'reasoning',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        text,
        time: {
          start: existing?.type === 'reasoning'
            ? existing.time?.start ?? event.created
            : event.created,
        },
      },
    }]
  }
  if (event.type === 'session.reasoning.ended') {
    const partId = discordReasoningPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = getPart(projectedParts, partId)
    return routePartActions({
      events,
      mainSessionId,
      projectedParts,
      output,
      part: {
        id: partId,
        type: 'reasoning',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        text: event.data.text,
        time: {
          start: existing?.type === 'reasoning'
            ? existing.time?.start ?? event.created
            : event.created,
          end: event.created,
        },
      },
    })
  }
  if (event.type === 'session.tool.progress') {
    const childSessionId = compactSubagentRoutingEvidence(event)?.data.childSessionID
    if (!childSessionId) return []
    return routePendingSubagentParts({
      projectedParts,
      events,
      mainSessionId,
      childSessionId,
      output,
    })
  }
  if (event.type === 'session.tool.input.started') {
    // Child tool events are not retained in the event buffer, so the name must live on the part.
    return [{
      type: 'store-part',
      part: {
        id: discordToolPartId({ messageID: event.data.assistantMessageID, toolId: event.data.id }),
        type: 'tool',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        tool: event.data.name,
        state: { status: 'pending', input: {}, raw: '' },
      },
    }]
  }
  if (event.type === 'session.tool.called') {
    const partId = partIdForEvent(event)
    const existing = getPart(projectedParts, partId)
    const tool = existing?.type === 'tool'
      ? existing.tool
      : findToolName({
          events,
          sessionId: event.data.sessionID,
          assistantMessageId: event.data.assistantMessageID,
          toolId: event.data.id,
        })
    const input = tool === 'subagent' && typeof event.data.input.agent === 'string'
      ? { ...event.data.input, subagent_type: event.data.input.agent }
      : event.data.input
    return routePartActions({
      events,
      mainSessionId,
      projectedParts,
      output,
      part: {
        id: partId,
        type: 'tool',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        tool,
        state: { status: 'running', input, raw: '' },
      },
    })
  }
  if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
    const partId = partIdForEvent(event)
    const existing = getPart(projectedParts, partId)
    const tool = existing?.type === 'tool'
      ? existing.tool
      : findToolName({
          events,
          sessionId: event.data.sessionID,
          assistantMessageId: event.data.assistantMessageID,
          toolId: event.data.id,
        })
    const common = {
      id: partId,
      type: 'tool' as const,
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      tool,
    }
    const part: DiscordSessionPart = event.type === 'session.tool.success'
      ? {
          ...common,
          state: {
            status: 'completed',
            input: existing?.type === 'tool' ? existing.state.input : {},
            output: event.data.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n'),
            metadata: event.data.metadata ?? {},
            time: { start: event.created, end: event.created },
          },
        }
      : {
          ...common,
          state: {
            status: 'error',
            input: existing?.type === 'tool' ? existing.state.input : {},
            error: event.data.error.message || 'Tool failed',
            time: { start: event.created, end: event.created },
          },
        }
    const parentActions = routePartActions({
      part, events, mainSessionId, projectedParts, output,
    })
    const childSessionId = event.data.sessionID === mainSessionId
      && typeof event.data.metadata?.['sessionID'] === 'string'
      ? event.data.metadata['sessionID']
      : undefined
    if (!childSessionId) return parentActions
    return [
      ...parentActions,
      ...routePendingSubagentParts({
        projectedParts: replacePart(projectedParts, part),
        events,
        mainSessionId,
        childSessionId,
        output,
      }),
    ]
  }
  if (event.type === 'session.execution.started') {
    if (event.data.sessionID !== mainSessionId) return []
    return [{ type: 'start-typing' }]
  }
  if (event.type === 'session.step.started') {
    if (event.data.sessionID !== mainSessionId) return []
    return [
      { type: 'start-typing', immediate: true },
      { type: 'show-context-usage', sessionId: event.data.sessionID },
    ]
  }
  if (
    event.type === 'session.execution.succeeded'
    || event.type === 'session.execution.failed'
    || event.type === 'session.execution.interrupted'
  ) {
    const analytics = deriveTerminalAnalytics({ event, events, mainSessionId })
    const actions: DiscordAction[] = [
      event.type === 'session.execution.succeeded'
        ? { type: 'complete-scheduled-task', sessionId: event.data.sessionID }
        : event.type === 'session.execution.failed'
          ? { type: 'fail-scheduled-task', sessionId: event.data.sessionID, error: 'Session failed' }
          : { type: 'record-terminal-analytics', analytics },
    ]
    if (actions[0]?.type !== 'record-terminal-analytics') {
      actions.push({ type: 'record-terminal-analytics', analytics })
    }
    if (event.data.sessionID !== mainSessionId) return actions
    const mainParts = projectedParts.filter((part) => part.sessionID === mainSessionId)
    actions.push(
      { type: 'stop-typing' },
      ...planMainPartActions({
        parts: mainParts,
        historyParts: projectedParts,
        mode: 'final',
        repulseTyping: false,
        output,
      }),
    )
    if (event.type === 'session.execution.succeeded') {
      // Only the first step can hit a cold cache. Reported on success so failed runs stay quiet.
      const [firstMessageId] = getAssistantMessageIdsForLatestExecution({
        events,
        sessionId: mainSessionId,
      })
      actions.push(
        ...unquoteFinalTextActions(mainParts),
        ...promptCacheClearActions({ events, sessionId: mainSessionId, messageId: firstMessageId }),
      )
    }
    if (
      event.type === 'session.execution.succeeded'
      && hasVisibleV2OutputSinceExecutionStart({ events, sessionId: mainSessionId })
    ) {
      actions.push({
        type: 'send-footer',
        completedAt: event.created,
        startedAt: analytics.usage.startedAt ?? event.created,
      })
    }
    if (event.type === 'session.execution.failed') {
      actions.push({
        type: 'send-error',
        message: event.data.error.message.trim() || 'Session failed',
      })
    }
    actions.push({ type: 'reset-run' })
    if (event.type !== 'session.execution.interrupted') actions.push({ type: 'drain-queue' })
    return actions
  }
  if (event.type === 'form.created') {
    const form = normalizeQuestionForm(event.data.form)
    if (!form || form.sessionId !== mainSessionId || shownFormIds.includes(form.formId)) return []
    if (hasOpenTextForForm({ parts: projectedParts, form })) {
      return [{ type: 'defer-form', form }]
    }
    return [
      ...planMainPartActions({
        parts: projectedParts.filter((part) => part.sessionID === mainSessionId),
        historyParts: projectedParts,
        mode: 'interactive',
        output,
      }),
      { type: 'show-form', form },
    ]
  }
  if (event.type === 'form.replied' || event.type === 'form.cancelled') {
    if (event.data.sessionID !== mainSessionId) return []
    return [{ type: 'settle-form', sessionId: event.data.sessionID, formId: event.data.id }]
  }
  if (event.type === 'session.status') {
    if (event.data.sessionID !== mainSessionId) return []
    if (event.data.status.type === 'idle') return [{ type: 'stop-typing' }]
    if (event.data.status.type === 'busy') return [{ type: 'start-typing' }]
  }
  return []
}
