import type { OpencodeClient } from '@opencode-ai/sdk'
import * as yaml from 'js-yaml'
import { formatDateTime } from './utils.js'
import { extractNonXmlContent } from './xml.js'

export class ShareMarkdown {
  constructor(private client: OpencodeClient) {}

  /**
   * Generate a markdown representation of a session
   * @param options Configuration options
   * @returns Markdown string representation of the session
   */
  async generate(options: {
    sessionID: string
    includeSystemInfo?: boolean
    lastAssistantOnly?: boolean
  }): Promise<string> {
    const { sessionID, includeSystemInfo, lastAssistantOnly } = options

    // Get session info
    const sessionResponse = await this.client.session.get({
      path: { id: sessionID },
    })
    if (!sessionResponse.data) {
      throw new Error(`Session ${sessionID} not found`)
    }
    const session = sessionResponse.data

    // Get all messages
    const messagesResponse = await this.client.session.messages({
      path: { id: sessionID },
    })
    if (!messagesResponse.data) {
      throw new Error(`No messages found for session ${sessionID}`)
    }
    const messages = messagesResponse.data

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
