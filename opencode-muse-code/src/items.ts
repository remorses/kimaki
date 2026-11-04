// Muse view items of one turn to AI SDK stream parts.
//
// Muse runs every tool itself, inside its OS sandbox, so OpenCode only shows them:
//
//   agentMessage (+ `text` deltas)        ──▶ text
//   reasoning (+ `summary.N` deltas)      ──▶ reasoning
//   toolCall, userShell, subagent, webSearch ──▶ provider-executed tool-call, then tool-result
//   tool calls of a subagent's own session ──▶ `subagent.<tool>` calls, before its result
//   userMessage, observers, hooks, ...    ──▶ nothing
//
// Items arrive once per revision and deltas arrive on their own stream, so the two can
// interleave in any order. Text comes from deltas, then the completed item adds what the
// deltas missed; the completed item is the authoritative text.

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { FoldedItem } from '@muse-code/sdk'

// Tool output that OpenCode stores and shows; the full output stays in the Muse session.
const MAX_TOOL_OUTPUT_CHARS = 20_000
const SUMMARY_FIELD_PREFIX = 'summary.'
const TOOL_KINDS = new Set(['toolCall', 'userShell', 'subagent', 'webSearch'])

export type Delta = { itemId: string; field?: string; delta: string }

type Block = { type: 'text' | 'reasoning'; text: string; started: boolean; summaryIndex: number }

export function isTerminal(item: FoldedItem) {
  return item.status !== 'inProgress'
}

// A subagent item stays `inProgress` until the lead closes the child, often after the turn
// ended; its result is final once `ResultReady` filled it in.
export function isDone(item: FoldedItem) {
  return isTerminal(item) || (item.kind === 'subagent' && item.result !== undefined)
}

function isFailed(item: FoldedItem) {
  if (isTerminal(item)) return item.status !== 'completed'
  return Boolean(item.result?.errorKind)
}

function blockType(kind: string) {
  if (kind === 'agentMessage') return 'text'
  if (kind === 'reasoning') return 'reasoning'
  return null
}

function blockText(item: FoldedItem) {
  if (item.kind === 'reasoning') return item.summary?.length ? item.summary.join('\n\n') : (item.text ?? '')
  return item.text ?? ''
}

export function toolName(item: FoldedItem) {
  if (item.kind === 'toolCall') return item.tool || 'tool'
  if (item.kind === 'userShell') return 'shell'
  if (item.kind === 'webSearch') return 'web_search'
  return 'subagent'
}

// The tool input as a JSON object string. Muse keeps the model's arguments verbatim, which can be almost-JSON.
export function toolInput(item: FoldedItem) {
  if (item.kind === 'toolCall') {
    const args = item.args ?? '{}'
    const parsed = (() => {
      try {
        return JSON.parse(args) as unknown
      } catch {
        return undefined
      }
    })()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? args : JSON.stringify({ arguments: args })
  }
  if (item.kind === 'userShell') return JSON.stringify({ command: item.commandText ?? '' })
  if (item.kind === 'subagent') return JSON.stringify({ ...(item.role ? { role: item.role } : {}), objective: item.objective ?? '' })
  return JSON.stringify({ query: item.fallbackText ?? '' })
}

export function toolOutput(item: FoldedItem) {
  const text = item.kind === 'subagent' ? (item.result?.text ?? item.result?.summary) : item.visibleOutput
  const failure = isTerminal(item) && item.status !== 'completed' ? item.failureReason : undefined
  const output = [text, failure].filter((part) => part !== undefined && part !== '').join('\n\n') || String(item.status)
  return output.length > MAX_TOOL_OUTPUT_CHARS ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)` : output
}

// Stateful per turn: feed every item revision and every delta, then `end()` once.
export function createTurnConverter() {
  const blocks = new Map<string, Block>()
  const finished = new Set<string>()
  const called = new Set<string>()
  // Tool calls shown without a result yet, latest revision.
  const open = new Map<string, FoldedItem>()

  const append = ({ id, block, text }: { id: string; block: Block; text: string }): LanguageModelV3StreamPart[] => {
    if (!text) return []
    const parts: LanguageModelV3StreamPart[] = []
    if (!block.started) {
      block.started = true
      parts.push({ type: `${block.type}-start`, id })
    }
    block.text += text
    parts.push({ type: `${block.type}-delta`, id, delta: text })
    return parts
  }

  const blockFor = ({ id, type }: { id: string; type: Block['type'] }) => {
    const existing = blocks.get(id)
    if (existing) return existing
    const block: Block = { type, text: '', started: false, summaryIndex: 0 }
    blocks.set(id, block)
    return block
  }

  const close = (id: string): LanguageModelV3StreamPart[] => {
    const block = blocks.get(id)
    finished.add(id)
    blocks.delete(id)
    return block?.started ? [{ type: `${block.type}-end`, id }] : []
  }

  const item = (item: FoldedItem): LanguageModelV3StreamPart[] => {
    const id = item.itemId
    if (finished.has(id)) return []
    const type = blockType(String(item.kind))
    if (type) {
      // Text streams from deltas only: a snapshot cannot tell which later deltas it already holds.
      if (!isTerminal(item)) return []
      const block = blockFor({ id, type })
      const text = blockText(item)
      const missing = (() => {
        if (text.startsWith(block.text)) return text.slice(block.text.length)
        // A text cut at Muse's display budget.
        if (block.text.startsWith(text)) return ''
        // A completed text that rewrites the streamed one shows as its own paragraph.
        return `\n\n${text}`
      })()
      return [...append({ id, block, text: missing }), ...close(id)]
    }
    if (!TOOL_KINDS.has(String(item.kind))) return []
    const parts: LanguageModelV3StreamPart[] = []
    if (!called.has(id)) {
      called.add(id)
      parts.push({ type: 'tool-call', toolCallId: id, toolName: toolName(item), input: toolInput(item), providerExecuted: true })
    }
    if (!isDone(item)) {
      open.set(id, item)
      return parts
    }
    open.delete(id)
    finished.add(id)
    parts.push({ type: 'tool-result', toolCallId: id, toolName: toolName(item), result: toolOutput(item), isError: isFailed(item) })
    return parts
  }

  // The finished tool calls of a subagent's own session, shown as `subagent.<tool>`.
  const children = (items: readonly FoldedItem[]): LanguageModelV3StreamPart[] =>
    items.flatMap((child): LanguageModelV3StreamPart[] => {
      if (!TOOL_KINDS.has(String(child.kind)) || !isDone(child) || called.has(child.itemId)) return []
      called.add(child.itemId)
      finished.add(child.itemId)
      const name = `subagent.${toolName(child)}`
      return [
        { type: 'tool-call', toolCallId: child.itemId, toolName: name, input: toolInput(child), providerExecuted: true },
        { type: 'tool-result', toolCallId: child.itemId, toolName: name, result: toolOutput(child), isError: isFailed(child) },
      ]
    })

  const delta = (delta: Delta): LanguageModelV3StreamPart[] => {
    if (finished.has(delta.itemId)) return []
    const field = delta.field ?? 'text'
    if (field === 'text') {
      // A delta can arrive before its item: only agent messages stream `text`.
      const block = blockFor({ id: delta.itemId, type: blocks.get(delta.itemId)?.type ?? 'text' })
      return append({ id: delta.itemId, block, text: delta.delta })
    }
    if (!field.startsWith(SUMMARY_FIELD_PREFIX)) return []
    const index = Number(field.slice(SUMMARY_FIELD_PREFIX.length))
    const block = blockFor({ id: delta.itemId, type: 'reasoning' })
    const separator = block.text && index > block.summaryIndex ? '\n\n' : ''
    block.summaryIndex = index
    return append({ id: delta.itemId, block, text: separator + delta.delta })
  }

  // A tool call without a result fails the OpenCode step, so calls still open get one.
  const end = (): LanguageModelV3StreamPart[] => {
    const results = [...open.values()].map((item): LanguageModelV3StreamPart => ({
      type: 'tool-result',
      toolCallId: item.itemId,
      toolName: toolName(item),
      result: 'Still running in Muse when the turn ended.',
    }))
    open.clear()
    return [...[...blocks.keys()].flatMap(close), ...results]
  }

  return { item, delta, children, end }
}
