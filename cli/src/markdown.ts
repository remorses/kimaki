// Session-to-markdown renderer for sharing.
// Generates shareable markdown from OpenCode sessions, formatting
// user messages, assistant responses, tool calls, and reasoning blocks.
// Uses errore for type-safe error handling.

import type { OpencodeClient } from './opencode.js'
import type { SessionMessageInfo } from '@opencode/client'
import * as errore from 'errore'
import YAML from 'yaml'
import { formatDateTime } from './utils.js'
import { extractNonXmlContent } from './xml.js'
import { createLogger, LogPrefix } from './logger.js'
import { SessionNotFoundError, MessagesNotFoundError } from './errors.js'
import { sessionMessagesAscending } from './message-formatting.js'

// Generic error for unexpected exceptions in async operations
class UnexpectedError extends errore.createTaggedError({
  name: 'UnexpectedError',
}) {}

const markdownLogger = createLogger(LogPrefix.MARKDOWN)

const TOOL_OUTPUT_MAX_CHARS = 30_000
export const DEFAULT_TOOL_INPUT_MAX_CHARS = 80

export type SessionMarkdownOptions = {
  compactTools: boolean
  includeThinking: boolean
  toolInputMaxChars: number
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
type ToolInput = Record<string, JsonValue>

function stringifyToolValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function truncateChars(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (maxChars <= 0) return ''
  if (collapsed.length <= maxChars) return collapsed
  if (maxChars === 1) return '…'
  return `${collapsed.slice(0, maxChars - 1)}…`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function messageCreatedAt(message: { time?: { created?: number } }): number | undefined {
  const created = message.time?.created
  return typeof created === 'number' ? created : undefined
}

function messageEndedAt(message: {
  time?: { created?: number; completed?: number }
}): number | undefined {
  const completed = message.time?.completed
  if (typeof completed === 'number') return completed
  return messageCreatedAt(message)
}

/** User sent → last assistant finished, until the next user message. */
export function userPromptDurationMs({
  messages,
  userIndex,
}: {
  messages: Array<{ info: { role?: string; time?: { created?: number; completed?: number } } }>
  userIndex: number
}): number | undefined {
  const userCreated = messageCreatedAt(messages[userIndex]?.info ?? {})
  if (userCreated === undefined) return undefined

  let end = userCreated
  for (let i = userIndex + 1; i < messages.length; i++) {
    const info = messages[i]?.info
    if (info?.role === 'user') break
    if (info?.role !== 'assistant') continue
    const ended = messageEndedAt(info)
    if (ended !== undefined && ended > end) end = ended
  }
  const ms = end - userCreated
  return ms > 0 ? ms : undefined
}

export function fileBaseName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || filePath
}

function readTaskSessionId(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const sessionId = metadata.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

function taskChildSessionId({
  input,
  metadata,
}: {
  input?: ToolInput
  metadata?: JsonValue
}): string | undefined {
  const sessionId = readTaskSessionId(metadata)
  if (sessionId) return sessionId
  const taskId = input?.task_id
  if (typeof taskId === 'string' && taskId.startsWith('ses')) return taskId
  return undefined
}

/** Compact tool input for session markdown. Keep this greppable and short. */
export function formatCompactToolSummary({
  tool,
  input,
  maxChars = DEFAULT_TOOL_INPUT_MAX_CHARS,
  metadata,
}: {
  tool: string
  input?: ToolInput
  maxChars?: number
  metadata?: JsonValue
}): string {
  const record = input ?? {}
  if (tool === 'read') {
    const path = record.filePath ?? record.path
    return typeof path === 'string' && path.length > 0 ? fileBaseName(path) : ''
  }
  if (tool === 'task') {
    const description = typeof record.description === 'string' ? record.description : ''
    const sessionId = taskChildSessionId({ input: record, metadata })
    if (!sessionId) return truncateChars(description, maxChars)
    const separator = description.trim() ? 1 : 0
    const descBudget = Math.max(0, maxChars - sessionId.length - separator)
    const desc = truncateChars(description, descBudget)
    return [desc, sessionId].filter(Boolean).join(' ')
  }
  if (tool === 'bash') {
    const command = typeof record.command === 'string' ? record.command : ''
    const collapsedCommand = command.replace(/\s+/g, ' ').trim()
    if (collapsedCommand.length > 0 && collapsedCommand.length <= maxChars) {
      return collapsedCommand
    }
    const description = typeof record.description === 'string' ? record.description : ''
    return truncateChars(description || collapsedCommand, maxChars)
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    parts.push(`${key}=${stringifyToolValue(value)}`)
  }
  return truncateChars(parts.join(' '), maxChars)
}

function formatToolErrorText(error: unknown): string {
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  if (error === undefined || error === null) return 'Unknown error'
  return JSON.stringify(error)
}

function toGenericSessionMessage(message: SessionMessageInfo) {
  if (message.type === 'user') {
    return {
      info: { role: 'user' as const, id: message.id, time: message.time },
      parts: [{ type: 'text' as const, text: message.text }],
    }
  }
  if (message.type === 'assistant') {
    return {
      info: {
        role: 'assistant' as const,
        id: message.id,
        time: message.time,
        providerID: message.model.providerID,
        modelID: message.model.id,
      },
      parts: message.content.map((part, index) => {
        if (part.type === 'tool') {
          const input = (() => {
            if (typeof part.state.input === 'string') {
              const raw = part.state.input
              const parsed = errore.try(() => JSON.parse(raw) as Record<string, unknown>)
              if (parsed instanceof Error || !parsed || typeof parsed !== 'object') return {}
              return parsed
            }
            return part.state.input
          })()
          const output = part.state.status === 'completed'
            ? part.state.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n')
            : ''
          return {
            id: part.id,
            type: 'tool' as const,
            tool: part.name,
            state: {
              status: part.state.status === 'error' ? 'error' as const : part.state.status === 'completed' ? 'completed' as const : 'pending' as const,
              input,
              output,
              error: part.state.status === 'error' ? part.state.error : undefined,
            },
          }
        }
        return {
          id: `${message.id}:${index}`,
          type: part.type,
          text: part.text,
        }
      }),
    }
  }
  return {
    info: { role: message.type, id: message.id, time: message.time },
    parts: [],
  }
}

export class ShareMarkdown {
  constructor(private client: OpencodeClient) {}

  /**
   * Generate a markdown representation of a session
   * @param options Configuration options
   * @returns Error or markdown string
   */
  async generate(options: {
    sessionID: string
    includeSystemInfo?: boolean
    lastAssistantOnly?: boolean
    /** When true (default), tool calls show a compact one-liner with line count instead of full output. */
    compactTools?: boolean
    /** When true, include reasoning parts. Off by default. */
    includeThinking?: boolean
    /** Max characters for compact tool input. Default 80. */
    toolInputMaxChars?: number
  }): Promise<SessionNotFoundError | MessagesNotFoundError | string> {
    const {
      sessionID,
      includeSystemInfo,
      lastAssistantOnly,
      compactTools = true,
      includeThinking = false,
      toolInputMaxChars = DEFAULT_TOOL_INPUT_MAX_CHARS,
    } = options

    // Get session info
    const session = await this.client.session.get({
      sessionID,
    }).catch((error: unknown) => {
      return new SessionNotFoundError({ sessionId: sessionID, cause: error })
    })
    if (session instanceof Error) {
      return session
    }

    const messagesResponse = await this.client.message.list({
      sessionID,
      order: 'asc',
    }).catch((error: unknown) => {
      return new MessagesNotFoundError({ sessionId: sessionID, cause: error })
    })
    if (messagesResponse instanceof Error) {
      return messagesResponse
    }
    const messages = sessionMessagesAscending(messagesResponse.data).map(toGenericSessionMessage)

    // If lastAssistantOnly, filter to only the last assistant message
    const messagesToRender = lastAssistantOnly
      ? (() => {
          const assistantMessages = messages.filter(
            (m) => m.info.role === 'assistant',
          )
          return assistantMessages.length > 0
            ? [assistantMessages[assistantMessages.length - 1]]
            : []
        })()
      : messages

    // Build markdown
    const lines: string[] = []

    // Only include header and session info if not lastAssistantOnly
    if (!lastAssistantOnly) {
      // Header
      lines.push(`# ${session.title || 'Untitled Session'}`)
      lines.push('')

      // Session metadata
      if (includeSystemInfo === true) {
        lines.push('## Session Information')
        lines.push('')
        lines.push(
          `- **Created**: ${formatDateTime(new Date(session.time.created))}`,
        )
        lines.push(
          `- **Updated**: ${formatDateTime(new Date(session.time.updated))}`,
        )

        lines.push('')
      }

      // Process messages
      lines.push('## Conversation')
      lines.push('')
    }

    for (const [index, message] of messagesToRender.entries()) {
      const messageLines = this.renderMessage(message!.info, message!.parts, {
        compactTools,
        includeThinking,
        toolInputMaxChars,
      })
      lines.push(...messageLines)
      lines.push('')

      const nextRole = messagesToRender[index + 1]?.info.role
      if (message!.info.role !== 'assistant' || nextRole === 'assistant') continue

      for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
        if (messagesToRender[userIndex]?.info.role !== 'user') continue
        const durationMs = userPromptDurationMs({
          messages: messagesToRender,
          userIndex,
        })
        if (durationMs !== undefined) {
          lines.push(`duration: ${formatDuration(durationMs)}`)
          lines.push('')
        }
        break
      }
    }

    return lines.join('\n')
  }

  private renderMessage(message: any, parts: any[], opts: SessionMarkdownOptions): string[] {
    const lines: string[] = []

    if (message.role === 'user') {
      lines.push('### user')
      lines.push('')

      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          const cleanedText = extractNonXmlContent(part.text)
          if (cleanedText.trim()) {
            lines.push(cleanedText)
            lines.push('')
          }
        } else if (part.type === 'file') {
          lines.push(`file: ${part.filename || 'unnamed file'}`)
          if (part.url) {
            lines.push(`   - URL: ${part.url}`)
          }
          lines.push('')
        }
      }
    } else if (message.role === 'assistant') {
      const filteredParts = parts.filter((part) => {
        if (
          part.type === 'step-start' ||
          part.type === 'step-finish' ||
          part.type === 'snapshot' ||
          part.type === 'patch'
        )
          return false
        if (part.type === 'text' && (part.synthetic === true || !part.text)) return false
        if (part.type === 'tool' && part.tool === 'todoread') return false
        if (
          part.type === 'tool' &&
          (part.state.status === 'pending' || part.state.status === 'running')
        )
          return false
        return true
      })

      const body: string[] = []
      for (const part of filteredParts) {
        body.push(
          ...(opts.compactTools
            ? this.renderPartCompact(part, opts)
            : this.renderPart(part, opts)),
        )
      }
      if (body.length === 0) return lines

      const modelId =
        [message.providerID, message.modelID].filter(Boolean).join('/') ||
        'unknown model'
      lines.push(`### assistant (${modelId})`)
      lines.push('')
      lines.push(...body)
    }

    return lines
  }

  private renderPart(part: any, opts: SessionMarkdownOptions): string[] {
    const lines: string[] = []

    switch (part.type) {
      case 'text':
        if (part.text) {
          lines.push(part.text)
          lines.push('')
        }
        break

      case 'reasoning':
        if (opts.includeThinking && part.text) {
          lines.push('thinking:')
          lines.push('')
          lines.push(part.text)
          lines.push('')
        }
        break

      case 'tool':
        if (part.state.status === 'completed') {
          const output: string = part.state.output || ''
          const isOversized = output.length > TOOL_OUTPUT_MAX_CHARS

          if (isOversized) {
            lines.push(
              `> Large tool output (${output.length.toLocaleString()} chars, truncated to ${TOOL_OUTPUT_MAX_CHARS.toLocaleString()})`,
            )
            lines.push('')
          }

          lines.push(`#### tool: ${part.tool}`)
          lines.push('')

          // Render input parameters in YAML
          if (part.state.input && Object.keys(part.state.input).length > 0) {
            lines.push('**Input:**')
            lines.push('```yaml')
            lines.push(YAML.stringify(part.state.input, null, { lineWidth: 0 }))
            lines.push('```')
            lines.push('')
          }

          // Render output, truncated if too large
          if (output) {
            lines.push('**Output:**')
            lines.push('```')
            lines.push(
              isOversized
                ? output.slice(0, TOOL_OUTPUT_MAX_CHARS) +
                    '\n...(truncated)'
                : output,
            )
            lines.push('```')
            lines.push('')
          }
        } else if (part.state.status === 'error') {
          lines.push(`#### tool-error: ${part.tool}`)
          lines.push('')
          lines.push('```')
          lines.push(formatToolErrorText(part.state.error))
          lines.push('```')
          lines.push('')
        }
        break
    }

    return lines
  }

  /** Compact rendering: tool calls become a single line with line count instead of full output. */
  private renderPartCompact(part: any, opts: SessionMarkdownOptions): string[] {
    if (part.type !== 'tool') {
      return this.renderPart(part, opts)
    }

    const lines: string[] = []

    if (part.state.status === 'completed') {
      const output: string = part.state.output || ''
      const lineCount = output ? output.split('\n').length : 0
      const inputSummary = formatCompactToolSummary({
        tool: part.tool,
        input: part.state.input,
        maxChars: opts.toolInputMaxChars,
        metadata: part.state.metadata,
      })
      const outputLabel = lineCount > 0 ? `(${lineCount} lines)` : ''
      const parts = [inputSummary, outputLabel].filter(Boolean).join(' ')
      lines.push(`tool: ${part.tool}${parts ? ` ${parts}` : ''}`)
      lines.push('')
    } else if (part.state.status === 'error') {
      const errorText = (formatToolErrorText(part.state.error).split('\n')[0] ?? '').slice(0, 120)
      lines.push(`tool-error: ${part.tool} ${errorText}`)
      lines.push('')
    }

    return lines
  }
}

/**
 * Generate compact session context for voice transcription.
 * Includes system prompt (optional), user messages, assistant text,
 * and tool calls in compact form (name + params only, no output).
 */
export async function getCompactSessionContext({
  client,
  sessionId,
  includeSystemPrompt = false,
  maxMessages = 20,
}: {
  client: OpencodeClient
  sessionId: string
  includeSystemPrompt?: boolean
  maxMessages?: number
}): Promise<UnexpectedError | string> {
  const messagesResponse = await client.message
    .list({
      sessionID: sessionId,
      order: 'asc',
    })
    .catch((e: unknown) => {
      markdownLogger.error('Failed to get compact session context:', e)
      return new UnexpectedError({
        message: 'Failed to get compact session context',
        cause: e,
      })
    })
  if (messagesResponse instanceof Error) return messagesResponse
  const messages = sessionMessagesAscending(messagesResponse.data).map(toGenericSessionMessage)

  const lines: string[] = []

  // Get system prompt if requested
  // Note: OpenCode SDK doesn't expose system prompt directly. We try multiple approaches:
  // 1. session.system field (if available in future SDK versions)
  // 2. synthetic text part in first assistant message (current approach)
  if (includeSystemPrompt && messages.length > 0) {
    const firstAssistant = messages.find((m) => m.info.role === 'assistant')
    if (firstAssistant) {
      // look for text part marked as synthetic (system prompt)
      const systemPart = (firstAssistant.parts || []).find(
        (p) => p.type === 'text' && 'synthetic' in p && p.synthetic === true,
      )
      if (systemPart?.type === 'text' && systemPart.text) {
        lines.push('[System Prompt]')
        const truncated = systemPart.text.slice(0, 3000)
        lines.push(truncated)
        if (systemPart.text.length > 3000) {
          lines.push('...(truncated)')
        }
        lines.push('')
      }
    }
  }

  // Process recent messages
  const recentMessages = messages.slice(-maxMessages)

  for (const msg of recentMessages) {
    if (msg.info.role === 'user') {
      const textParts = (msg.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? extractNonXmlContent(p.text || '') : ''))
        .filter(Boolean)
      if (textParts.length > 0) {
        lines.push(`[User]: ${textParts.join(' ').slice(0, 1000)}`)
        lines.push('')
      }
    } else if (msg.info.role === 'assistant') {
      // Get assistant text parts (non-synthetic, non-empty)
      const textParts = (msg.parts || [])
        .filter(
          (p) => p.type === 'text' && Boolean(p.text),
        )
        .map((p) => (p.type === 'text' ? p.text : ''))
        .filter(Boolean)
      if (textParts.length > 0) {
        lines.push(`[Assistant]: ${textParts.join(' ').slice(0, 1000)}`)
        lines.push('')
      }

      // Get tool calls in compact form (name + params only)
      const toolParts = (msg.parts || []).filter(
        (p) =>
          p.type === 'tool' &&
          p.state?.status === 'completed',
      )
      for (const part of toolParts) {
        if (part.type === 'tool') {
          const toolName = part.tool
          // skip noisy tools
          if (toolName === 'todoread' || toolName === 'todowrite') {
            continue
          }
          const input = part.state?.input || {}
          const normalize = (value: string) =>
            value.replace(/\s+/g, ' ').trim()
          // compact params: just key=value on one line
          const params = Object.entries(input)
            .map(([k, v]) => {
              const val =
                    typeof v === 'string'
                      ? v.slice(0, 100)
                      : (JSON.stringify(v) ?? String(v)).slice(0, 100)
              return `${k}=${normalize(val)}`
            })
            .join(', ')
          lines.push(`[Tool ${toolName}]: ${params}`)
        }
      }
    }
  }

  return lines.join('\n').slice(0, 8000)
}

/**
 * Get the last session for a directory (excluding the current one).
 */
export async function getLastSessionId({
  client,
  excludeSessionId,
  directory,
}: {
  client: OpencodeClient
  excludeSessionId?: string
  directory?: string
}): Promise<UnexpectedError | (string | null)> {
  const requestedDirectory = directory || await (async () => {
    if (!excludeSessionId) return null
    const session = await client.session.get({ sessionID: excludeSessionId }).catch(() => null)
    return session?.location.directory || null
  })()
  if (!requestedDirectory) {
    return new UnexpectedError({ message: 'A project directory is required to list sessions' })
  }
  const sessionsResponse = await client.session.list({ directory: requestedDirectory }).catch((e: unknown) => {
    markdownLogger.error('Failed to get last session:', e)
    return new UnexpectedError({
      message: 'Failed to get last session',
      cause: e,
    })
  })
  if (sessionsResponse instanceof Error) return sessionsResponse
  const sessions = sessionsResponse.data || []

  // Sessions are sorted by time, get the most recent one that isn't the current
  const lastSession = sessions.find((s) => s.id !== excludeSessionId)
  return lastSession?.id || null
}
