// Pure formatting of every non-model line the bot posts: banner, footer,
// errors, retries and tool lines (spec 7.1, V2 tool names from 29.2 #2).
// Everything non-text is Discord subtext (`-# `). Model text goes through
// markdown/ instead.

import path from 'node:path'
import type { JsonValue } from '@opencode/client'
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
} from 'discord.js'
import { z } from 'zod'

import type { Verbosity } from './db.ts'

// Bot messages never show link previews. Only messages that need the user
// (errors, prompts, the end of a turn) skip SuppressNotifications.
export const SILENT_MESSAGE_FLAGS = MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications
export const NOTIFY_MESSAGE_FLAGS = MessageFlags.SuppressEmbeds

export function asSubtext(text: string): string {
  return `-# ${text}`
}

// --- Interactive messages (queue acks, question dropdowns, permission buttons, selects).

export type UiMessage = {
  content: string
  components: ReadonlyArray<APIActionRowComponent<APIComponentInMessageActionRow>>
}

export function textOnly(content: string): UiMessage {
  return { content, components: [] }
}

export function button({
  customId,
  label,
  style = ButtonStyle.Secondary,
}: {
  customId: string
  label: string
  style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
}): APIButtonComponentWithCustomId {
  return { type: ComponentType.Button, custom_id: customId, label, style }
}

export function buttonRow(
  buttons: readonly APIButtonComponentWithCustomId[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components: [...buttons] }
}

const MAX_SELECT_OPTIONS = 25

export function selectRow({
  customId,
  placeholder,
  options,
}: {
  customId: string
  placeholder: string
  options: ReadonlyArray<{ label: string; value: string; description?: string; default?: boolean }>
}) {
  return {
    type: ComponentType.ActionRow as const,
    components: [
      {
        type: ComponentType.StringSelect as const,
        custom_id: customId,
        placeholder,
        options: options.slice(0, MAX_SELECT_OPTIONS).map((option) => ({
          label: option.label.slice(0, 100) || '-',
          value: option.value,
          ...(option.description && { description: option.description.slice(0, 100) }),
          ...(option.default && { default: true }),
        })),
      },
    ],
  }
}

type SelectOption = { label: string; value: string; description?: string }

const PAGE_PREFIX = '__page:'
// 23 items plus previous/next entries fit Discord's 25 options.
export const SELECT_PAGE_SIZE = 23

// One page of select options with previous/next entries when they do not fit.
export function paginate(options: readonly SelectOption[], page: number): SelectOption[] {
  if (options.length <= MAX_SELECT_OPTIONS) return [...options]
  const pages = Math.ceil(options.length / SELECT_PAGE_SIZE)
  const current = Math.max(0, Math.min(page, pages - 1))
  return [
    ...(current > 0 ? [{ label: `← Previous page (${current}/${pages})`, value: `${PAGE_PREFIX}${current - 1}` }] : []),
    ...options.slice(current * SELECT_PAGE_SIZE, (current + 1) * SELECT_PAGE_SIZE),
    ...(current < pages - 1 ? [{ label: `Next page → (${current + 2}/${pages})`, value: `${PAGE_PREFIX}${current + 1}` }] : []),
  ]
}

// The page a previous/next entry of paginate() points to; null for a real option.
export function selectedPage(value: string): number | null {
  if (!value.startsWith(PAGE_PREFIX)) return null
  return Number(value.slice(PAGE_PREFIX.length)) || 0
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export type ModelRef = { providerID: string; id: string }

export function formatBanner({ model, agent }: { model: ModelRef; agent: string }): string {
  return asSubtext(`*using ${model.providerID}/${model.id} ⋅ ${agent}*`)
}

export function formatFooter({
  folder,
  branch,
  durationMs,
  contextPercent,
  model,
  agent,
}: {
  folder: string
  branch: string | null
  durationMs: number
  contextPercent: number | null
  model: ModelRef | null
  agent: string | null
}): string {
  const parts = [
    folder,
    branch,
    formatDuration(durationMs),
    contextPercent === null ? null : `${contextPercent}%`,
    model?.id ?? null,
    agent && agent !== 'build' ? agent : null,
  ].filter((part): part is string => Boolean(part))
  return asSubtext(`*${parts.join(' ⋅ ')}*`)
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function formatError(message: string): string {
  return `✗ ${truncate(message.trim() || 'unknown error', 400)}`
}

// The provider error is the whole point: "retrying" alone says nothing.
export function formatRetry({ attempt, delayMs, message }: { attempt: number; delayMs: number; message: string }): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1_000))
  return asSubtext(`⬦ retrying in ${seconds}s (attempt ${attempt}): ${inline(message, 200)}`)
}

export function formatCacheMiss({ read, expected, idleMs }: { read: number; expected: number; idleMs: number }): string {
  const k = (tokens: number) => (tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`)
  return asSubtext(`⬦ prompt cache miss: ${k(read)} of ${k(expected)} tokens cached, ${formatDuration(idleMs)} after the last request`)
}

// One line, no markdown control characters, so `_x_` and `*x*` stay intact.
function inline(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return truncate(flat, max).replace(/([\\_*`~|])/g, '\\$1')
}

function stringField(input: ToolInput, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value : null
}

// Lines added/removed after dropping the common leading and trailing lines.
export function editStats({ oldString, newString }: { oldString: string; newString: string }) {
  const before = oldString.split('\n')
  const after = newString.split('\n')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  return { added: after.length - start - end, removed: before.length - start - end }
}

// apply_patch style text: "*** Add|Update|Delete File: path" headers, +/- lines.
export function patchStats(patchText: string): Array<{ file: string; added: number; removed: number }> {
  const files: Array<{ file: string; added: number; removed: number }> = []
  for (const line of patchText.split('\n')) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (header) {
      files.push({ file: header[1]!.trim(), added: 0, removed: 0 })
      continue
    }
    const current = files[files.length - 1]
    if (!current || line.startsWith('***')) continue
    if (line.startsWith('+')) current.added++
    if (line.startsWith('-')) current.removed++
  }
  return files
}

function fileName(value: string): string {
  return inline(path.basename(value))
}

const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'patch'])
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep'])

export type ToolInput = { readonly [key: string]: JsonValue }

export type ToolCall = { name: string; input: ToolInput }

// Tools with dedicated UI or no user value never get a line.
export function hasNoLine(name: string): boolean {
  return name === 'question' || name.startsWith('kimaki_')
}

export function isToolVisible({ name, input }: ToolCall, verbosity: Verbosity): boolean {
  if (hasNoLine(name)) return false
  if (FILE_EDIT_TOOLS.has(name)) return true
  if (verbosity === 'text') return false
  if (READ_ONLY_TOOLS.has(name)) return false
  // A background shell gets a finished line later: its start must show too.
  if (name === 'shell' && input['hasSideEffect'] === false && input['background'] !== true) return false
  return true
}

function toolBody({ name, input }: ToolCall): { glyph: '┣' | '◼︎'; text: string } {
  if (name === 'shell') {
    const detail = stringField(input, 'description') ?? stringField(input, 'command')
    const background = input['background'] === true ? ' (background)' : ''
    return { glyph: '┣', text: `${detail ? `shell _${inline(detail)}_` : 'shell'}${background}` }
  }
  if (name === 'edit') {
    const { added, removed } = editStats({
      oldString: stringField(input, 'oldString') ?? '',
      newString: stringField(input, 'newString') ?? '',
    })
    return { glyph: '◼︎', text: `edit *${fileName(stringField(input, 'path') ?? '')}* (+${added}-${removed})` }
  }
  if (name === 'write') {
    const content = typeof input['content'] === 'string' ? input['content'] : ''
    const lines = content === '' ? 0 : content.split('\n').length
    return { glyph: '◼︎', text: `write *${fileName(stringField(input, 'path') ?? '')}* (${lines} lines)` }
  }
  if (name === 'patch') {
    const files = patchStats(stringField(input, 'patchText') ?? '')
    const summary = files.map((file) => `*${fileName(file.file)}* (+${file.added}-${file.removed})`).join(', ')
    return { glyph: '◼︎', text: `patch${summary ? ` ${summary}` : ''}` }
  }
  if (name === 'subagent') {
    const background = input['background'] === true ? ' (background)' : ''
    return {
      glyph: '┣',
      text: `${inline(stringField(input, 'agent') ?? 'subagent')} **${inline(stringField(input, 'description') ?? '')}**${background}`,
    }
  }
  if (name === 'skill') {
    const id = stringField(input, 'id')
    return { glyph: '┣', text: id ? `skill _${inline(id)}_` : 'skill' }
  }
  if (name === 'execute') {
    const description = stringField(input, 'description')
    return { glyph: '┣', text: description ? `execute _${inline(description)}_` : 'execute' }
  }
  const detail = ['path', 'pattern', 'url', 'query', 'command', 'name', 'directory', 'title']
    .map((key) => stringField(input, key))
    .find((value) => value !== null)
  if (detail) return { glyph: '┣', text: `${inline(name)} _${inline(detail)}_` }
  const fields = inputFields(input)
  return { glyph: '┣', text: `${inline(name)}${fields ? ` (${inline(fields, 200)})` : ''}` }
}

// MCP and plugin tools have arbitrary keys: "server: docs, uri: file://a.md".
function inputFields(input: ToolInput): string {
  return Object.entries(input)
    .flatMap(([key, value]) => {
      if (value === null || value === '') return []
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return [`${key}: ${truncate(text.replace(/\s+/g, ' ').trim(), 50)}`]
    })
    .join(', ')
}

// Child session lines carry the agent label: "┣ general ⋅ glob _*.md_".
export function formatToolLine(call: ToolCall, { label }: { label?: string } = {}): string {
  const { glyph, text } = toolBody(call)
  return asSubtext(`${glyph} ${label ? `${inline(label)} ⋅ ` : ''}${text}`)
}

// Code Mode `execute` runs tools inside its JS runtime. They never get tool
// events: `metadata.toolCalls` lists them in start order, as `{ tool, status, input }`.
// A row starts as `running` and changes status in place. A code error still
// ends with session.tool.success, marked by `error: true`.
const ExecuteMetadata = z.object({
  toolCalls: z.array(z.object({
    tool: z.string(),
    status: z.enum(['running', 'completed', 'error']),
    input: z.record(z.string(), z.json()).optional(),
  })),
  error: z.literal(true).optional(),
})

export function executeCalls(metadata: Readonly<Record<string, unknown>> | undefined): ToolCall[] {
  const parsed = ExecuteMetadata.safeParse(metadata)
  if (!parsed.success) return []
  return parsed.data.toolCalls.map((call) => ({ name: `execute.${call.tool}`, input: call.input ?? {} }))
}

// Failure lines once `execute` ends: one per failed inner call, then the code error.
export function formatExecuteFailures({
  metadata,
  content,
  label,
}: {
  metadata: Readonly<Record<string, unknown>> | undefined
  content: ReadonlyArray<{ readonly type: 'text'; readonly text: string } | { readonly type: 'file' }> | undefined
  label?: string
}): string[] {
  const parsed = ExecuteMetadata.safeParse(metadata)
  if (!parsed.success) return []
  const failed = parsed.data.toolCalls
    .filter((call) => call.status === 'error')
    .map((call) => formatToolFailed({ name: `execute.${call.tool}`, message: 'failed', label }))
  if (!parsed.data.error) return failed
  const message = (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  return [...failed, formatToolFailed({ name: 'execute', message, label })]
}

export function formatToolFailed({ name, message, label }: { name: string; message: string; label?: string }): string {
  const firstLine = message.split('\n').find((line) => line.trim()) ?? 'failed'
  const prefix = label ? `${inline(label)} ⋅ ` : ''
  return asSubtext(`⨯ ${prefix}${inline(name)} _${inline(firstLine, 150)}_`)
}

export function formatSubagentFinished({ agent, description }: { agent: string; description: string }): string {
  return asSubtext(`⬦ ${inline(agent)} finished: ${inline(description)}`)
}

// `state` is OpenCode's job state; any value other than "completed" is shown.
export function formatShellFinished({
  description,
  state,
  exit,
  label,
}: {
  description: string | null
  state: string | null
  exit: number | null
  label?: string
}): string {
  const prefix = label ? `${inline(label)} ⋅ ` : ''
  const notes = [
    state && state !== 'completed' ? inline(state) : null,
    exit !== null && exit !== 0 ? `exit ${exit}` : null,
  ].filter((note) => note !== null)
  return asSubtext(`⬦ ${prefix}background shell finished${description ? `: _${inline(description)}_` : ''}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`)
}

const SHELL_OUTPUT_LIMIT = 1_800

export function formatShellStarted(command: string): string {
  return asSubtext(`$ ${inline(command, 200)}`)
}

// Output of a user `!cmd`: the tail in a code block, then exit status. Bot
// line, not markdown: backtick fences in the output are neutralized.
export function formatShellEnded({
  output,
  truncated,
  status,
  exit,
}: {
  output: string
  truncated: boolean
  status: string
  exit: number | null
}): string {
  const body = output.trimEnd()
  const tail = body.length > SHELL_OUTPUT_LIMIT ? `…${body.slice(-SHELL_OUTPUT_LIMIT)}` : body
  const notes = [
    status === 'killed' ? 'killed' : null,
    status === 'timeout' ? 'timed out' : null,
    exit !== null && exit !== 0 ? `exit ${exit}` : null,
    truncated || tail !== body ? 'output truncated' : null,
  ].filter((note) => note !== null)
  const block = tail ? `\`\`\`\n${tail.replaceAll('```', 'ʼʼʼ')}\n\`\`\`` : asSubtext('(no output)')
  return notes.length > 0 ? `${block}\n${asSubtext(notes.join(' ⋅ '))}` : block
}
