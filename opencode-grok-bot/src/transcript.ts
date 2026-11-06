// Grok Bot transcript entries and bot activity to AI SDK stream parts, and OpenCode replies
// to card answers.
//
// What the backend shows of a turn (verified on the "temporal" harness, desktop app 0.78):
// - transcript entries (`ListGrokBotTranscriptEntries`) with the turn's `requestId`: the
//   chat messages and cards the user sees;
// - the bot's live `activity` (`ListGrokBotAgentStatuses`): `{ kind: "tool", tool, detail }`
//   while a tool runs, `{ kind: "thinking" }` otherwise. That is the only trace of tool
//   calls; their arguments and output stay on the bot's computer.
//
//   send-message text                ──▶ text
//   send-message cards               ──▶ text that says what the card asks and how to answer it
//   attachments and images           ──▶ text with the local path the file is saved to (`saved`)
//   message (assistant, streams)     ──▶ text that grows
//   thinking / reasoning entries     ──▶ reasoning
//   notice, event                    ──▶ text in italics
//   activity tool ▶ next one         ──▶ provider-executed tool-call, then tool-result
//
// Grok Bot runs every tool on its own computer, so OpenCode only shows them (providerExecuted).

import path from 'node:path'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

export type Entry = {
  id: string
  kind: string
  seq?: number
  timestampMs?: number
  role?: string
  content?: unknown
  text?: string
  isStreaming?: boolean
  streaming?: boolean
  name?: string
  status?: string
  summary?: string
  clientNonce?: string
  fromAgent?: { id?: string; name?: string }
  toAgent?: { id?: string; name?: string }
  author?: { id?: string; name?: string; kind?: string }
  message?: SendMessage
  images?: Array<{ url?: string; alt?: string }>
  respondedValue?: string | null
  widgetDismissed?: boolean
  widgetSkipped?: boolean
  formResolution?: string
  secretProvided?: boolean
  hidden?: boolean
  [key: string]: unknown
}

export type Card = {
  status?: string
  requestId?: string
  reason?: string
  command?: string
  summary?: string
  action?: string
  description?: string
  target?: string
  workingDirectory?: string
  serverId?: string
  serverName?: string
}

export type Widget = {
  prompt?: string
  helpText?: string
  options?: Array<{ label?: string; value?: string; description?: string }>
  multiSelect?: boolean
  allowCustom?: boolean
}

export type SendMessage = {
  type?: string
  content?: string
  text?: string
  title?: string
  body?: string
  url?: string
  name?: string
  file_name?: string
  // Where the file was on the bot's computer when it sent it.
  source_path?: string
  images?: Array<{ url?: string; alt?: string }>
  widget?: Widget
  formRequest?: { title?: string; instruction?: string; reason?: string; fields?: Array<{ id?: string; label?: string; type?: string; required?: boolean }> }
  secretRequest?: { label?: string; description?: string }
  draft?: Record<string, unknown>
  approval?: Card
  ask?: Card
}

const TOOL_CALL_SUFFIX = 'ToolCall'
// Tool output that OpenCode stores and shows; the full output stays in Grok Bot.
const MAX_TOOL_OUTPUT_CHARS = 20_000

export function isPending(entry: Entry) {
  return entry.isStreaming === true || entry.streaming === true || (entry.kind === 'tool-call' && (entry.status === 'pending' || entry.status === 'running' || entry.status === 'in-progress'))
}

// Entries the user or OpenCode wrote: the prompt echo, attachments, other people in a group.
export function isFromUser(entry: Entry) {
  if (entry.kind === 'user-attachment') return true
  if (entry.kind !== 'message') return false
  return entry.role !== 'assistant' && !entry.fromAgent
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  if (content && typeof content === 'object') {
    const value = content as { text?: unknown; content?: unknown }
    if (typeof value.text === 'string') return value.text
    if (value.content !== undefined) return contentText(value.content)
  }
  return ''
}

function firstText(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '') ?? ''
}

function quote(text: string) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

export function toolName(entry: Entry) {
  const name = (entry.name ?? 'tool').replace(new RegExp(`${TOOL_CALL_SUFFIX}$`), '')
  return name || 'tool'
}

const TOOL_META_KEYS = new Set(['id', 'kind', 'seq', 'timestampMs', 'name', 'status', 'isStreaming', 'streaming', 'result', 'output', 'error', 'hidden'])

// Everything the entry says about the call, minus bookkeeping fields.
export function toolInput(entry: Entry) {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (TOOL_META_KEYS.has(key) || value === undefined || value === null || value === '') continue
    input[key] = value
  }
  return input
}

function toolOutput(entry: Entry) {
  const raw = entry.result ?? entry.output ?? entry.error ?? entry.summary ?? entry.status ?? ''
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)` : text
}

function isToolError(entry: Entry) {
  return entry.status === 'failed' || entry.status === 'error' || entry.status === 'errored' || entry.error !== undefined
}

function speaker(entry: Entry) {
  if (entry.fromAgent?.name && entry.toAgent?.name) return `${entry.fromAgent.name} → ${entry.toAgent.name}`
  return entry.fromAgent?.name ?? entry.author?.name
}

export type BotFile = { url: string; name: string }
// Local path of a file the bot sent, or null when it is not saved on this computer.
export type SavedPath = (file: BotFile) => string | null

const notSaved: SavedPath = () => null

function fileLine({ label, file, saved }: { label: string; file: BotFile; saved: SavedPath }) {
  const local = saved(file)
  return local ? `**${label}:** saved to \`${local}\`` : `**${label}:** ${file.name}`
}

function imageLines({ images, saved }: { images: SendMessage['images']; saved: SavedPath }) {
  return (images ?? []).flatMap((image) => {
    if (!image.url) return []
    const local = saved({ url: image.url, name: path.posix.basename(image.url) })
    return [local ? `**Image:** saved to \`${local}\`` : `![${image.alt ?? 'image'}](${image.url})`]
  })
}

// Markdown for a send-message entry: the bot's chat messages and its interactive cards.
export function renderSendMessage(entry: Entry, saved: SavedPath = notSaved): string {
  const message = entry.message
  if (!message) return ''
  const type = message.type ?? 'message'
  if (type === 'text') return [firstText(message.content, message.text), ...imageLines({ images: message.images, saved })].filter(Boolean).join('\n')
  if (type === 'attachment') {
    const name = firstText(message.file_name, message.name, message.url)
    return message.url ? fileLine({ label: 'File', file: { url: message.url, name }, saved }) : `**File:** ${name}`
  }
  if (type === 'connector') {
    const connector = message as SendMessage & { connector?: string }
    return `**Connect app:** ${connector.connector ?? 'an app'}. Connect it in the Grok Bot app.`
  }
  if (type === 'widget' && message.widget) return renderWidget(entry, message.widget)
  if ((type === 'auto-review-approval' || type === 'local-tool-permission') && (message.approval ?? message.ask)) {
    const card = (message.approval ?? message.ask)!
    const details = [
      card.command ? `\`\`\`\n${card.command}\n\`\`\`` : '',
      firstText(card.summary, card.action, card.description, card.reason),
      card.workingDirectory ? `in \`${card.workingDirectory}\`` : '',
    ].filter(Boolean)
    const answer = card.status === 'pending' ? 'Reply **approve**, **always** or **deny**.' : `Status: ${card.status}`
    return [`**Approval needed**`, ...details, answer].join('\n\n')
  }
  if (type === 'connector-grant' && message.ask) {
    const answer = message.ask.status === 'pending' ? 'Reply **allow**, **allow always** or **skip**.' : `Status: ${message.ask.status}`
    return `**App access:** ${message.ask.serverName ?? message.ask.serverId ?? 'an app'} wants access.\n\n${answer}`
  }
  if (type === 'user-form' && message.formRequest) {
    const form = message.formRequest
    const fields = (form.fields ?? []).map((field) => `- ${field.label ?? field.id}${field.required ? ' (required)' : ''}`)
    const state = entry.formResolution ? `Status: ${entry.formResolution}` : 'Fill this form in the Grok Bot app.'
    return [`**Form:** ${form.title ?? ''}`, firstText(form.instruction, form.reason), ...fields, state].filter(Boolean).join('\n')
  }
  if (type === 'secret-request' && message.secretRequest) {
    const state = entry.secretProvided ? 'Provided.' : 'Enter it in the Grok Bot app, never in this chat.'
    return [`**Secret requested:** ${message.secretRequest.label ?? ''}`, message.secretRequest.description ?? '', state].filter(Boolean).join('\n\n')
  }
  if (type.endsWith('-draft') && message.draft) {
    const draft = message.draft as { subject?: unknown; to?: unknown; body?: unknown; text?: unknown; content?: unknown }
    const lines = [
      `**Draft (${type.replace(/-draft$/, '')})**`,
      draft.to ? `To: ${Array.isArray(draft.to) ? draft.to.join(', ') : String(draft.to)}` : '',
      draft.subject ? `Subject: ${String(draft.subject)}` : '',
      quote(contentText(draft.body ?? draft.text ?? draft.content)),
      'Send or edit it in the Grok Bot app.',
    ]
    return lines.filter(Boolean).join('\n')
  }
  const text = firstText(message.content, message.text, message.body, message.title)
  return [text ? `**${type}:** ${text}` : `**${type}**`, ...imageLines({ images: message.images, saved })].join('\n')
}

function renderWidget(entry: Entry, widget: Widget) {
  const options = (widget.options ?? []).map((option, index) => `${index + 1}. ${option.label ?? option.value}${option.description ? ` (${option.description})` : ''}`)
  const state = (() => {
    if (typeof entry.respondedValue === 'string') return `Answered: ${entry.respondedValue.replaceAll('\n', ', ')}`
    if (entry.widgetDismissed || entry.widgetSkipped) return 'Dismissed.'
    return widget.multiSelect ? 'Reply with one or more option numbers, separated by commas.' : 'Reply with an option number.'
  })()
  return [`**Question:** ${widget.prompt ?? ''}`, widget.helpText ?? '', options.join('\n'), state].filter(Boolean).join('\n\n')
}

// Text a non-tool entry shows in OpenCode, or null for entries with nothing to show.
export function entryText(entry: Entry, saved: SavedPath = notSaved): string | null {
  if (entry.kind === 'message') {
    const text = [contentText(entry.content) || (entry.text ?? ''), ...imageLines({ images: entry.images, saved })].filter(Boolean).join('\n')
    const from = entry.role === 'assistant' ? undefined : speaker(entry)
    return from ? `**${from}:** ${text}` : text
  }
  if (entry.kind === 'send-message') {
    const text = renderSendMessage(entry, saved)
    const from = speaker(entry)
    return from && text ? `**${from}:** ${text}` : text
  }
  if (entry.kind === 'notice' || entry.kind === 'event') {
    const text = firstText(entry.text, contentText(entry.content), entry.summary)
    return text ? `*${text}*` : null
  }
  if (entry.kind === 'mcp-app') return `**App:** ${firstText(entry.name, entry.summary, entry.text) || 'opened an app view'}`
  const text = firstText(entry.text, contentText(entry.content), entry.summary)
  return text ? `**${entry.kind}:** ${text}` : null
}

type Open = { id: string; type: 'text' | 'reasoning'; text: string }

// Stateful per turn. Items arrive again on every poll and grow while the bot writes them;
// each part is emitted once. The newest text item stays open until another item arrives.
export function createTurnConverter({ saved = notSaved }: { saved?: SavedPath } = {}) {
  const done = new Set<string>()
  const called = new Set<string>()
  let open: Open | null = null

  const close = (): LanguageModelV3StreamPart[] => {
    if (!open) return []
    const part: LanguageModelV3StreamPart = { type: `${open.type}-end`, id: open.id }
    done.add(open.id)
    open = null
    return [part]
  }

  const push = (entry: Entry): LanguageModelV3StreamPart[] => {
    if (isFromUser(entry) || entry.hidden === true) return []
    if (entry.kind === 'tool-call') {
      if (done.has(entry.id)) return []
      const parts = open?.id === entry.id ? [] : close()
      if (!called.has(entry.id)) {
        called.add(entry.id)
        parts.push({ type: 'tool-call', toolCallId: entry.id, toolName: toolName(entry), input: JSON.stringify(toolInput(entry)), providerExecuted: true })
      }
      if (isPending(entry)) return parts
      done.add(entry.id)
      parts.push({ type: 'tool-result', toolCallId: entry.id, toolName: toolName(entry), result: toolOutput(entry), isError: isToolError(entry) })
      return parts
    }
    if (done.has(entry.id)) return []
    // Cards change after an answer; only their final text is worth showing.
    if (isPending(entry) && entry.kind === 'send-message') return []
    const type = entry.kind === 'thinking' || entry.kind === 'reasoning' ? 'reasoning' : 'text'
    const text = type === 'reasoning' ? firstText(entry.text, contentText(entry.content)) : (entryText(entry, saved) ?? '')
    if (!text) return []
    const parts = open && open.id !== entry.id ? close() : []
    if (!open) {
      open = { id: entry.id, type, text: '' }
      parts.push({ type: `${type}-start`, id: entry.id })
    }
    const current = open
    // Text only grows while the bot writes it; a rewrite shows the new text as its own paragraph.
    const delta = text.startsWith(current.text) ? text.slice(current.text.length) : `\n\n${text}`
    if (delta) parts.push({ type: `${type}-delta`, id: entry.id, delta })
    current.text = text
    // A chat message or card is complete when it appears; narration may still grow.
    if (type === 'text' && !isPending(entry)) parts.push(...close())
    return parts
  }

  return { push, end: close }
}

export type Activity = { kind?: string; tool?: string; detail?: string } | null | undefined

// One tool call per distinct `activity` tool; it ends when the activity changes.
export function createActivityTracker({ prefix }: { prefix: string }) {
  let open: { id: string; name: string; key: string } | null = null
  let count = 0

  const settle = (): LanguageModelV3StreamPart[] => {
    if (!open) return []
    const part: LanguageModelV3StreamPart = { type: 'tool-result', toolCallId: open.id, toolName: open.name, result: 'done' }
    open = null
    return [part]
  }

  const update = (activity: Activity): LanguageModelV3StreamPart[] => {
    if (activity?.kind !== 'tool' || !activity.tool) return settle()
    const key = `${activity.tool}\n${activity.detail ?? ''}`
    if (open?.key === key) return []
    const parts = settle()
    // SetStatus is the bot announcing what it does ("is running shell commands").
    const name = activity.tool === 'SetStatus' ? 'activity' : activity.tool
    open = { id: `${prefix}-${++count}`, name, key }
    parts.push({ type: 'tool-call', toolCallId: open.id, toolName: name, input: JSON.stringify(activity.detail ? { detail: activity.detail } : {}), providerExecuted: true })
    return parts
  }

  return { update, end: settle }
}

// A reply to a pending card answers the card instead of sending a new prompt: one
// GrokBotService call, like clicking the card in the app.
export type CardAnswer =
  | { method: 'RespondGrokBotWidget'; body: { agentId: string; entryId: string; value: string } }
  | { method: 'ResolveGrokBotAutoReviewApproval'; body: { agentId: string; requestId: string; resolution: string; approvalPlatform: 'desktop' } }
  | { method: 'ResolveGrokBotLocalToolPermission'; body: { agentId: string; entryId: string; requestId: string; resolution: string } }
  | { method: 'ResolveGrokBotConnectorGrant'; body: { agentId: string; entryId: string; requestId: string; resolution: string } }

export function pendingCard(entry: Entry) {
  const message = entry.message
  if (entry.kind !== 'send-message' || !message) return null
  if (message.type === 'widget' && message.widget && typeof entry.respondedValue !== 'string' && !entry.widgetDismissed && !entry.widgetSkipped) return entry
  const card = message.approval ?? message.ask
  if (card?.status === 'pending' && card.requestId) return entry
  return null
}

export function cardAnswer({ entry, agentId, reply }: { entry: Entry; agentId: string; reply: string }): CardAnswer | null {
  const message = entry.message
  const text = reply.trim()
  const word = text.toLowerCase().replace(/[.!]+$/, '')
  if (!message || !text) return null
  const card = message.approval ?? message.ask
  if (message.type === 'auto-review-approval' && card?.requestId) {
    const resolution = ({ approve: 'APPROVED', yes: 'APPROVED', always: 'ALWAYS', deny: 'DENIED', no: 'DENIED' } as const)[word]
    if (!resolution) return null
    return { method: 'ResolveGrokBotAutoReviewApproval', body: { agentId, requestId: card.requestId, resolution: `GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_${resolution}`, approvalPlatform: 'desktop' } }
  }
  if (message.type === 'local-tool-permission' && card?.requestId) {
    const resolution = ({ approve: 'ALLOW_ONCE', yes: 'ALLOW_ONCE', always: 'ALWAYS', deny: 'DENY', no: 'DENY' } as const)[word]
    if (!resolution) return null
    return { method: 'ResolveGrokBotLocalToolPermission', body: { agentId, entryId: entry.id, requestId: card.requestId, resolution: `GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_${resolution}` } }
  }
  if (message.type === 'connector-grant' && card?.requestId) {
    const resolution = ({ allow: 'ALLOWED', 'allow always': 'ALWAYS_THIS_BOT', skip: 'SKIPPED' } as const)[word]
    if (!resolution) return null
    return { method: 'ResolveGrokBotConnectorGrant', body: { agentId, entryId: entry.id, requestId: card.requestId, resolution: `GROK_BOT_CONNECTOR_GRANT_RESOLUTION_${resolution}` } }
  }
  if (message.type !== 'widget' || !message.widget) return null
  const options = message.widget.options ?? []
  const picks = text.split(',').map((part) => part.trim())
  const answers = picks.map((pick) => {
    const index = Number(pick)
    const option = Number.isInteger(index) && index >= 1 ? options[index - 1] : options.find((candidate) => candidate.label?.toLowerCase() === pick.toLowerCase() || candidate.value === pick)
    return option ? (option.value ?? option.label ?? null) : null
  })
  // Anything that is not an option goes to the bot as a normal message, like typing in the app.
  if (!answers.every((answer) => answer !== null)) return null
  if (answers.length > 1 && !message.widget.multiSelect) return null
  return { method: 'RespondGrokBotWidget', body: { agentId, entryId: entry.id, value: answers.join('\n') } }
}
