// Session search helpers for kimaki CLI commands.
// Parses string/regex queries and builds readable snippets from matched content.

import type { Part } from '@opencode-ai/sdk/v2'

export type SessionSearchPattern =
  | {
      mode: 'literal'
      raw: string
      normalizedNeedle: string
    }
  | {
      mode: 'regex'
      raw: string
      regex: RegExp
    }

export type SessionSearchHit = {
  index: number
  length: number
}

export function parseSessionSearchPattern(
  query: string,
): SessionSearchPattern | Error {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return new Error('Search query cannot be empty')
  }

  const regexMatch = trimmedQuery.match(/^\/([\s\S]+)\/([a-z]*)$/)
  if (!regexMatch) {
    return {
      mode: 'literal',
      raw: trimmedQuery,
      normalizedNeedle: trimmedQuery.toLowerCase(),
    }
  }

  const pattern = regexMatch[1] || ''
  const flags = regexMatch[2] || ''

  try {
    return {
      mode: 'regex',
      raw: trimmedQuery,
      regex: new RegExp(pattern, flags),
    }
  } catch (error) {
    return new Error(
      `Invalid regex query "${trimmedQuery}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function findFirstSessionSearchHit({
  text,
  searchPattern,
}: {
  text: string
  searchPattern: SessionSearchPattern
}): SessionSearchHit | undefined {
  if (searchPattern.mode === 'literal') {
    const index = text.toLowerCase().indexOf(searchPattern.normalizedNeedle)
    if (index < 0) {
      return undefined
    }
    return {
      index,
      length: searchPattern.raw.length,
    }
  }

  searchPattern.regex.lastIndex = 0
  const match = searchPattern.regex.exec(text)
  if (!match || match.index < 0) {
    return undefined
  }

  return {
    index: match.index,
    length: Math.max(match[0]?.length || 0, 1),
  }
}

export function buildSessionSearchSnippet({
  text,
  hit,
  contextLength = 90,
}: {
  text: string
  hit: SessionSearchHit
  contextLength?: number
}): string {
  const start = Math.max(0, hit.index - contextLength)
  const end = Math.min(text.length, hit.index + hit.length + contextLength)

  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  const body = text
    .slice(start, end)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return `${prefix}${body}${suffix}`
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function getPartSearchTexts(part: Part): string[] {
  switch (part.type) {
    case 'text':
      return part.text ? [part.text] : []
    case 'reasoning':
      return part.text ? [part.text] : []
    case 'tool': {
      const inputText = stringifyUnknown(part.state.input)
      const outputText =
        part.state.status === 'completed'
          ? stringifyUnknown(part.state.output)
          : part.state.status === 'error'
            ? part.state.error || ''
            : ''
      return [`tool:${part.tool}`, inputText, outputText].filter((entry) => {
        return entry.trim().length > 0
      })
    }
    case 'file':
      return [part.filename || '', part.url || ''].filter((entry) => {
        return entry.trim().length > 0
      })
    default:
      return []
  }
}
