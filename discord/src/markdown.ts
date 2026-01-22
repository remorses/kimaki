// Session-to-markdown renderer for sharing.
// Generates shareable markdown from OpenCode sessions, formatting
// user messages, assistant responses, tool calls, and reasoning blocks.
// Uses errore for type-safe error handling.

import type { OpencodeClient } from '@opencode-ai/sdk'
import * as errore from 'errore'
import { createTaggedError } from 'errore'
import * as yaml from 'js-yaml'
import { formatDateTime } from './utils.js'
import { extractNonXmlContent } from './xml.js'
import { createLogger } from './logger.js'
import { SessionNotFoundError, MessagesNotFoundError } from './errors.js'

// Generic error for unexpected exceptions in async operations
class UnexpectedError extends createTaggedError({
  name: 'UnexpectedError',
  message: '$message',
}) {}

const markdownLogger = createLogger('MARKDOWN')

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
  }): Promise<SessionNotFoundError | MessagesNotFoundError | string> {
    const { sessionID, includeSystemInfo, lastAssistantOnly } = options

    // Get session info
    const sessionResponse = await this.client.session.get({
      path: { id: sessionID },
    })
    if (!sessionResponse.data) {
      return new SessionNotFoundError({ sessionId: sessionID })
    }
    const session = sessionResponse.data

    // Get all messages
    const messagesResponse = await this.client.session.messages({
      path: { id: sessionID },
    })
    if (!messagesResponse.data) {
      return new MessagesNotFoundError({ sessionId: sessionID })
    }
    const messages = messagesResponse.data

    // If lastAssistantOnly, filter to only the last assistant message
    const messagesToRender = lastAssistantOnly
      ? (() => {
          const assistantMessages = messages.filter((m) => m.info.role === 'assistant')
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
        lines.push(`- **Created**: ${formatDateTime(new Date(session.time.created))}`)
        lines.push(`- **Updated**: ${formatDateTime(new Date(session.time.updated))}`)
        if (session.version) {
          lines.push(`- **OpenCode Version**: v${session.version}`)
        }
        lines.push('')
      }

      // Process messages
      lines.push('## Conversation')
      lines.push('')
    }

    for (const message of messagesToRender) {
      const messageLines = this.renderMessage(message!.info, message!.parts)
      lines.push(...messageLines)
      lines.push('')
    }

    return lines.join('\n')
  }

  private renderMessage(message: any, parts: any[]): string[] {
    const lines: string[] = []

    if (message.role === 'user') {
      lines.push('### 👤 User')
      lines.push('')

      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          const cleanedText = extractNonXmlContent(part.text)
          if (cleanedText.trim()) {
            lines.push(cleanedText)
            lines.push('')
          }
        } else if (part.type === 'file') {
          lines.push(`📎 **Attachment**: ${part.filename || 'unnamed file'}`)
          if (part.url) {
            lines.push(`   - URL: ${part.url}`)
          }
          lines.push('')
        }
      }
    } else if (message.role === 'assistant') {
      lines.push(`### 🤖 Assistant (${message.modelID || 'unknown model'})`)
      lines.push('')

      // Filter and process parts
      const filteredParts = parts.filter((part) => {
        if (part.type === 'step-start' && parts.indexOf(part) > 0) return false
        if (part.type === 'snapshot') return false
        if (part.type === 'patch') return false
        if (part.type === 'step-finish') return false
        if (part.type === 'text' && part.synthetic === true) return false
        if (part.type === 'tool' && part.tool === 'todoread') return false
        if (part.type === 'text' && !part.text) return false
        if (
          part.type === 'tool' &&
          (part.state.status === 'pending' || part.state.status === 'running')
        )
          return false
        return true
      })

      for (const part of filteredParts) {
        const partLines = this.renderPart(part, message)
        lines.push(...partLines)
      }

      // Add completion time if available
      if (message.time?.completed) {
        const duration = message.time.completed - message.time.created
        lines.push('')
        lines.push(`*Completed in ${this.formatDuration(duration)}*`)
      }
    }

    return lines
  }

  private renderPart(part: any, message: any): string[] {
    const lines: string[] = []

    switch (part.type) {
      case 'text':
        if (part.text) {
          lines.push(part.text)
          lines.push('')
        }
        break

      case 'reasoning':
        if (part.text) {
          lines.push('<details>')
          lines.push('<summary>💭 Thinking</summary>')
          lines.push('')
          lines.push(part.text)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        }
        break

      case 'tool':
        if (part.state.status === 'completed') {
          lines.push(`#### 🛠️ Tool: ${part.tool}`)
          lines.push('')

          // Render input parameters in YAML
          if (part.state.input && Object.keys(part.state.input).length > 0) {
            lines.push('**Input:**')
            lines.push('```yaml')
            lines.push(yaml.dump(part.state.input, { lineWidth: -1 }))
            lines.push('```')
            lines.push('')
          }

          // Render output
          if (part.state.output) {
            lines.push('**Output:**')
            lines.push('```')
            lines.push(part.state.output)
            lines.push('```')
            lines.push('')
          }

          // Add timing info if significant
          if (part.state.time?.start && part.state.time?.end) {
            const duration = part.state.time.end - part.state.time.start
            if (duration > 2000) {
              lines.push(`*Duration: ${this.formatDuration(duration)}*`)
              lines.push('')
            }
          }
        } else if (part.state.status === 'error') {
          lines.push(`#### ❌ Tool Error: ${part.tool}`)
          lines.push('')
          lines.push('```')
          lines.push(part.state.error || 'Unknown error')
          lines.push('```')
          lines.push('')
        }
        break

      case 'step-start':
        lines.push(`**Started using ${message.providerID}/${message.modelID}**`)
        lines.push('')
        break
    }

    return lines
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.floor((ms % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
}

/**
 * Generate compact session context for voice transcription.
 * Includes system prompt (optional), user messages, assistant text,
 * and tool calls in compact form (name + params only, no output).
 */
export function getCompactSessionContext({
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
  return errore.tryAsync({
    try: async () => {
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      })
      const messages = messagesResponse.data || []

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
            (p) => p.type === 'text' && (p as any).synthetic === true,
          )
          if (systemPart && 'text' in systemPart && systemPart.text) {
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
            .filter((p) => p.type === 'text' && 'text' in p)
            .map((p) => ('text' in p ? extractNonXmlContent(p.text || '') : ''))
            .filter(Boolean)
          if (textParts.length > 0) {
            lines.push(`[User]: ${textParts.join(' ').slice(0, 1000)}`)
            lines.push('')
          }
        } else if (msg.info.role === 'assistant') {
          // Get assistant text parts (non-synthetic, non-empty)
          const textParts = (msg.parts || [])
            .filter((p) => p.type === 'text' && 'text' in p && !p.synthetic && p.text)
            .map((p) => ('text' in p ? p.text : ''))
            .filter(Boolean)
          if (textParts.length > 0) {
            lines.push(`[Assistant]: ${textParts.join(' ').slice(0, 1000)}`)
            lines.push('')
          }

          // Get tool calls in compact form (name + params only)
          const toolParts = (msg.parts || []).filter(
            (p) => p.type === 'tool' && 'state' in p && p.state?.status === 'completed',
          )
          for (const part of toolParts) {
            if (part.type === 'tool' && 'tool' in part && 'state' in part) {
              const toolName = part.tool
              // skip noisy tools
              if (toolName === 'todoread' || toolName === 'todowrite') {
                continue
              }
              const input = part.state?.input || {}
              const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
              // compact params: just key=value on one line
              const params = Object.entries(input)
                .map(([k, v]) => {
                  const val =
                    typeof v === 'string' ? v.slice(0, 100) : JSON.stringify(v).slice(0, 100)
                  return `${k}=${normalize(val)}`
                })
                .join(', ')
              lines.push(`[Tool ${toolName}]: ${params}`)
            }
          }
        }
      }

      return lines.join('\n').slice(0, 8000)
    },
    catch: (e) => {
      markdownLogger.error('Failed to get compact session context:', e)
      return new UnexpectedError({ message: 'Failed to get compact session context', cause: e })
    },
  })
}

/**
 * Get the last session for a directory (excluding the current one).
 */
export function getLastSessionId({
  client,
  excludeSessionId,
}: {
  client: OpencodeClient
  excludeSessionId?: string
}): Promise<UnexpectedError | (string | null)> {
  return errore.tryAsync({
    try: async () => {
      const sessionsResponse = await client.session.list()
      const sessions = sessionsResponse.data || []

      // Sessions are sorted by time, get the most recent one that isn't the current
      const lastSession = sessions.find((s) => s.id !== excludeSessionId)
      return lastSession?.id || null
    },
    catch: (e) => {
      markdownLogger.error('Failed to get last session:', e)
      return new UnexpectedError({ message: 'Failed to get last session', cause: e })
    },
  })
}
