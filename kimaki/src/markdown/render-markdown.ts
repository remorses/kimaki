// Model text -> typed Discord segments (spec section 8). Pure.
//
//   text ──splitCallouts (line level, fence aware)──▶ markdown | callout pieces
//        ──fromMarkdown(gfm)──▶ mdast
//        ├─ table                ──▶ table segment (Components V2 later)
//        ├─ heading depth > 3    ──▶ clamped to ###
//        ├─ list with code items ──▶ code lifted after its item
//        └─ other nodes          ──▶ original source slices, packed into ≤ limit
//
// Text is sliced from the original source by node offsets, never
// re-serialized, so the model's markdown reaches Discord unchanged. Only
// oversized nodes are split: code by lines (each piece a valid fence), lists
// by items, paragraphs by sentences, then words.

import type { Code, List, ListItem, Root, RootContent, Table } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export const DISCORD_TEXT_LIMIT = 2000

export type TextSegment = { kind: 'text'; markdown: string }
export type TableSegment = { kind: 'table'; header: string[]; rows: string[][] }
export type CalloutSegment = { kind: 'callout'; accent: number; segments: Array<TextSegment | TableSegment> }
export type Segment = TextSegment | TableSegment | CalloutSegment

type Piece = { kind: 'markdown'; text: string } | { kind: 'callout'; accent: number; text: string }

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

// CommonMark: a fence closes only with the same character, at least as many
// markers, and nothing else on the line.
function closesFence(line: string, open: string): boolean {
  const close = line.match(FENCE_CLOSE_RE)?.[1]
  return Boolean(close && close[0] === open[0] && close.length >= open.length)
}
const CALLOUT_OPEN_RE = /^\s*<callout(\s+[^>]*)?>/i
const CALLOUT_CLOSE_RE = /<\/callout>\s*$/i

export function parseAccent(attributes: string): number | null {
  const match = attributes.match(/accent\s*=\s*"([^"]*)"|accent\s*=\s*'([^']*)'/i)
  const value = (match?.[1] ?? match?.[2] ?? '').trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.slice(1), 16)
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value.slice(1).split('')
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16)
  }
  if (/^\d+$/.test(value) && Number(value) <= 0xffffff) return Number(value)
  return null
}

// Finds <callout accent="..."> ... </callout> blocks outside code fences.
// Malformed callouts (no closing tag, bad accent) stay plain text.
export function splitCallouts(text: string): Piece[] {
  const lines = text.split('\n')
  const pieces: Piece[] = []
  const pending: string[] = []
  const fence: { marker: string | null } = { marker: null }
  const flush = () => {
    if (pending.length === 0) return
    pieces.push({ kind: 'markdown', text: pending.join('\n') })
    pending.length = 0
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (fence.marker) {
      if (closesFence(line, fence.marker)) fence.marker = null
      pending.push(line)
      continue
    }
    const opening = line.match(FENCE_OPEN_RE)?.[1]
    if (opening) {
      fence.marker = opening
      pending.push(line)
      continue
    }
    const open = line.match(CALLOUT_OPEN_RE)
    const accent = open ? parseAccent(open[1] ?? '') : null
    if (!open || accent === null) {
      pending.push(line)
      continue
    }
    const afterOpen = line.slice(open[0].length)
    if (CALLOUT_CLOSE_RE.test(afterOpen)) {
      flush()
      pieces.push({ kind: 'callout', accent, text: afterOpen.replace(CALLOUT_CLOSE_RE, '').trim() })
      continue
    }
    const closeIndex = findCalloutClose(lines, index + 1)
    if (closeIndex === -1) {
      pending.push(line)
      continue
    }
    flush()
    const body = [afterOpen, ...lines.slice(index + 1, closeIndex), (lines[closeIndex] ?? '').replace(CALLOUT_CLOSE_RE, '')]
    pieces.push({ kind: 'callout', accent, text: body.join('\n').trim() })
    index = closeIndex
  }
  flush()
  return pieces
}

function findCalloutClose(lines: string[], from: number): number {
  const fence: { marker: string | null } = { marker: null }
  for (let index = from; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (fence.marker) {
      if (closesFence(line, fence.marker)) fence.marker = null
      continue
    }
    const opening = line.match(FENCE_OPEN_RE)?.[1]
    if (opening) {
      fence.marker = opening
      continue
    }
    if (CALLOUT_OPEN_RE.test(line)) return -1
    if (CALLOUT_CLOSE_RE.test(line)) return index
  }
  return -1
}

function parse(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

function slice(source: string, node: { position?: { start: { offset?: number }; end: { offset?: number } } }) {
  return source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
}

function fenceFor(source: string, code: Code): string {
  const firstLine = slice(source, code).split('\n')[0] ?? ''
  const marker = firstLine.trimStart().match(/^(`{3,}|~{3,})/)?.[1]
  if (marker) return marker
  const longestRun = Math.max(0, ...(code.value.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function codeBlock({ fence, lang, value }: { fence: string; lang: string; value: string }): string {
  return `${fence}${lang}\n${value}\n${fence}`
}

// Every piece is a complete fence. Lines longer than the budget are cut.
function codeBlocks({ fence, lang, value, limit }: { fence: string; lang: string; value: string; limit: number }) {
  const budget = Math.max(1, limit - codeBlock({ fence, lang, value: '' }).length)
  const lines = value.split('\n').flatMap((line) => {
    if (line.length <= budget) return [line]
    return Array.from({ length: Math.ceil(line.length / budget) }, (_, index) =>
      line.slice(index * budget, (index + 1) * budget),
    )
  })
  return pack(lines, budget, '\n').map((chunk) => codeBlock({ fence, lang, value: chunk }))
}

function codePieces(source: string, code: Code, limit: number): string[] {
  const text = slice(source, code)
  const fence = fenceFor(source, code)
  const lastLine = text.split('\n').pop() ?? ''
  // Unclosed fences (cut-off model output) get their closing fence back.
  const closed = text.split('\n').length > 1 && closesFence(lastLine, fence)
  if (closed && text.length <= limit) return [text]
  return codeBlocks({ fence, lang: code.lang ?? '', value: code.value, limit })
}

// Sentences first, then words, then a hard cut.
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const units = text.split(/(?<=[.!?])\s+/)
  const byWords = units.flatMap((unit) => (unit.length <= limit ? [unit] : unit.split(/(?<=\s)/)))
  const parts = byWords.flatMap((unit) => {
    if (unit.length <= limit) return [unit]
    return Array.from({ length: Math.ceil(unit.length / limit) }, (_, index) => unit.slice(index * limit, (index + 1) * limit))
  })
  return pack(parts, limit, ' ')
}

function pack(parts: string[], limit: number, separator: string): string[] {
  const out: string[] = []
  for (const part of parts) {
    const last = out[out.length - 1]
    if (last !== undefined && last.length + separator.length + part.length <= limit) {
      out[out.length - 1] = `${last}${separator}${part}`
      continue
    }
    out.push(part)
  }
  return out
}

function listItemMarker(list: List, index: number): string {
  return list.ordered ? `${(list.start ?? 1) + index}. ` : '- '
}

function hasCodeInItems(list: List): boolean {
  return list.children.some((item) => item.children.some((child) => child.type === 'code'))
}

// Discord cannot render fenced code inside list items: lift it after its item.
function unnestList(source: string, list: List, limit: number): string[] {
  return list.children.flatMap((item: ListItem, index) => {
    const text = item.children
      .filter((child) => child.type !== 'code')
      .map((child) => slice(source, child))
      .join('\n')
    const codes = item.children
      .filter((child): child is Code => child.type === 'code')
      .flatMap((code) => codeBlocks({ fence: fenceFor(source, code), lang: code.lang ?? '', value: code.value, limit }))
    return [...(text ? [`${listItemMarker(list, index)}${text}`] : []), ...codes]
  })
}

function nodePieces(source: string, node: RootContent, limit: number): string[] {
  if (node.type === 'heading' && node.depth > 3) {
    return splitText(slice(source, node).replace(/^\s*#{4,6}/, '###'), limit)
  }
  if (node.type === 'list' && hasCodeInItems(node)) {
    return unnestList(source, node, limit).flatMap((piece) => (piece.length <= limit ? [piece] : splitText(piece, limit)))
  }
  if (node.type === 'code') return codePieces(source, node, limit)
  const text = slice(source, node)
  if (text.length <= limit) return [text]
  if (node.type === 'list') {
    const items = node.children.map((item) => slice(source, item))
    return pack(
      items.flatMap((item) => (item.length <= limit ? [item] : splitText(item, limit))),
      limit,
      '\n',
    )
  }
  return splitText(text, limit)
}

function tableSegment(source: string, table: Table): TableSegment {
  const [head, ...body] = table.children
  // GFM: "\|" inside a cell (even in inline code) is a literal pipe.
  const cells = (row: typeof head) =>
    (row?.children ?? []).map((cell) =>
      slice(source, cell)
        .replace(/^\|?\s*|\s*\|?$/g, '')
        .replaceAll('\\|', '|')
        .trim(),
    )
  return { kind: 'table', header: cells(head), rows: body.map((row) => cells(row)) }
}

function markdownSegments(text: string, limit: number): Array<TextSegment | TableSegment> {
  const root = parse(text)
  const segments: Array<TextSegment | TableSegment> = []
  const chunk: { text: string } = { text: '' }
  const flush = () => {
    if (chunk.text.trim()) segments.push({ kind: 'text', markdown: chunk.text })
    chunk.text = ''
  }
  const previous: { end: number | null } = { end: null }
  for (const node of root.children) {
    const start = node.position?.start.offset ?? 0
    // Keep the original blank lines between nodes, e.g. "Steps:\n- a" stays tight.
    const between = previous.end === null ? '' : text.slice(previous.end, start)
    const gap = between.includes('\n') && !between.trim() ? between : '\n\n'
    previous.end = node.position?.end.offset ?? start
    if (node.type === 'table') {
      flush()
      segments.push(tableSegment(text, node))
      continue
    }
    nodePieces(text, node, limit).forEach((piece, index) => {
      const separator = index === 0 ? gap : '\n'
      const joined = chunk.text ? `${chunk.text}${separator}${piece}` : piece
      if (joined.length <= limit) {
        chunk.text = joined
        return
      }
      flush()
      chunk.text = piece
    })
  }
  flush()
  return segments
}

export function renderMarkdown(text: string, { limit = DISCORD_TEXT_LIMIT }: { limit?: number } = {}): Segment[] {
  return splitCallouts(text).flatMap((piece): Segment[] => {
    if (piece.kind === 'callout') {
      return [{ kind: 'callout', accent: piece.accent, segments: markdownSegments(piece.text, limit) }]
    }
    return markdownSegments(piece.text, limit)
  })
}
